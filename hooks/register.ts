import type { Register } from 'claude-code'

// all-clear: Claude clears its own context when a finished task no longer needs the chat.
//
// Flow: Claude calls clear_context with a short handoff -> the current answer finishes ->
// /clear runs -> the handoff is put in front of the next prompt (next_prompt is submitted
// right away, or the handoff waits for the next prompt the user types).
//
// Nudge: once the chat has grown by NUDGE_TOKENS since the last clear, every prompt carries a
// hidden one-line reminder, so Claude checks whether the chat is still needed.
//
// Skipped question: if the user left Claude's question unanswered and moved on to another
// topic or task, the question no longer blocks a clear. Claude may pass it as open_question;
// it rides along with the handoff, and Claude raises it once more after the next answer.

const TOOL = 'clear_context'
const HANDOFF_KEY = 'handoff'
const MAX_HANDOFF = 400
const MAX_QUESTION = 200
const NUDGE_TOKENS = 20_000
// A drop below this share of the last reading means the chat was cleared or compacted.
const DROP_RATIO = 0.7

type Pending = { note: string; nextPrompt?: string }
type Reading = { base?: number; last?: number }

export const register: Register = on => {
  let pending: Pending | undefined
  const reading: Reading = {}

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Clears the conversation context (/clear) after the current answer is shown. ' +
        'Call it only when the finished task is done and the next task does not need ' +
        'the earlier chat. Never call it in the middle of a task, while you wait for the ' +
        "user's answer, or when the user may still refer back to earlier details. If the " +
        'user skipped your question and started another topic or task, the question no ' +
        'longer blocks: judge whether to clear now, and if the skipped question matters, ' +
        'pass it as open_question. ' +
        'handoff: as short as possible, terse keywords, no sentences, no history: only ' +
        'facts the next step cannot get from files or memory (paths, decisions, open ' +
        `items), max ${MAX_HANDOFF} chars; it is put in front of the next prompt. next_prompt: ` +
        'optional task to start right after the clear; leave it out to wait for the user. ' +
        `open_question: optional, the skipped question in one line, max ${MAX_QUESTION} chars; ` +
        'only when it is important, since you will raise it once more after the clear.',
      inputSchema: {
        type: 'object',
        properties: {
          handoff: { type: 'string', description: `Terse keyword facts, max ${MAX_HANDOFF} chars.` },
          next_prompt: { type: 'string', description: 'Task to run right after the clear.' },
          open_question: {
            type: 'string',
            description: `Important question the user skipped, max ${MAX_QUESTION} chars.`,
          },
        },
        required: ['handoff'],
      },
    })
    return started
  })

  on('tool.call', { tool: 'mcp__all-clear__clear_context' }, async ($, e) => {
    const input = e as unknown as { handoff?: unknown; next_prompt?: unknown; open_question?: unknown }
    const handoff = typeof input.handoff === 'string' ? input.handoff.trim() : ''
    if (!handoff) return { deny: 'handoff is required (may be one line).' }
    if (handoff.length > MAX_HANDOFF)
      return { deny: `handoff has ${handoff.length} chars, max ${MAX_HANDOFF}: cut to terse keywords.` }
    const nextPrompt = optionalText(input.next_prompt)
    const question = optionalText(input.open_question)
    if (question && question.length > MAX_QUESTION)
      return { deny: `open_question has ${question.length} chars, max ${MAX_QUESTION}: one short line.` }
    pending = { note: noteBlock(handoff, question), nextPrompt }
    return {
      result:
        'Context will be cleared after this answer. Finish with one short line; do not start new work.',
    }
  }).catch(() => ({ deny: 'all-clear: the tool failed; context was not cleared.' }))

  // After the main turn ends, run /clear outside the turn, then hand off.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !pending) return done
    const job = pending
    pending = undefined
    if (e.reason !== 'answer') return done
    $.clock.after(100, async () => {
      try {
        // A prompt submitted by the mod does not pass the prompt.submit hook,
        // so next_prompt carries the handoff itself; only a typed prompt uses the store.
        if (!job.nextPrompt) await $.store.set(HANDOFF_KEY, job.note)
        await $.command.run({ command: 'clear' })
        if (job.nextPrompt) await $.prompt.submit({ text: withNote(job.note, job.nextPrompt) })
        else $.ui.toast('All clear. Your next prompt starts with the handoff note.')
      } catch (err) {
        await $.store.delete(HANDOFF_KEY)
        $.ui.toast(`all-clear: /clear failed (${String(err)})`)
      }
    })
    return done
  })

  // Put the stored handoff in front of the first prompt after the clear,
  // and remind Claude once the chat has grown large.
  on('prompt.submit', async ($, e, next) => {
    if (e.text.trim().startsWith('/')) return next(e)
    let out = e
    const note = await $.store.get(HANDOFF_KEY)
    if (typeof note === 'string' && note) {
      await $.store.delete(HANDOFF_KEY)
      // A note stored by version 1.0 is the bare handoff text.
      const block = note.startsWith('[Handoff]') ? note : noteBlock(note)
      out = { ...out, text: withNote(block, e.text) }
    }
    const grown = growthSinceClear(reading, (await $.session.usage()).context.tokens)
    if (grown !== undefined && grown >= NUDGE_TOKENS) {
      const k = Math.round(grown / 1000)
      out = {
        ...out,
        context: [
          ...(out.context ?? []),
          `all-clear: the chat grew ~${k}k tokens since the last clear. If the finished task is ` +
            `done and the next one does not need this chat, call ${TOOL}. A question the user ` +
            'skipped by moving on does not block this.',
        ],
      }
    }
    return next(out)
  }).catch(($, e, next) => next(e))
}

const optionalText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

// The block that goes in front of the next prompt: the handoff, plus a skipped question if any.
const noteBlock = (handoff: string, question?: string) =>
  `[Handoff]\n${handoff}` +
  (question
    ? `\n\n[Skipped question]\n${question}\n(The user moved on without answering. Do the task ` +
      'first, then raise this once in one short line, only if it still matters.)'
    : '')

const withNote = (note: string, task: string) => `${note}\n\n[Task]\n${task}`

// Tokens the context grew since the last clear or compaction, or undefined before a reading.
function growthSinceClear(r: Reading, tokens: number | undefined) {
  if (tokens === undefined) return undefined
  if (r.base === undefined || r.last === undefined || tokens < r.last * DROP_RATIO) r.base = tokens
  r.last = tokens
  return tokens - r.base
}
