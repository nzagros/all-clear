import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// all-clear: Claude clears its own context when a finished task no longer needs the chat.
//
// Flow: Claude calls clear_context with a short handoff -> the current answer finishes ->
// /clear runs -> the last answer is shown in a box (display only, never sent to Claude) ->
// the handoff is put in front of the next prompt (next_prompt is submitted right away, or
// the handoff waits for the next prompt the user types).
//
// Nudge: once the chat has grown by NUDGE_TOKENS since the last clear, every prompt carries a
// hidden one-line reminder, so Claude checks whether the chat is still needed.
//
// Skipped question: if the user left Claude's question unanswered and moved on to another
// topic or task, the question no longer blocks a clear. Claude may pass it as open_question;
// it rides along with the handoff, and Claude raises it once more after the next answer.
//
// Ultra-clear (/ultra-clear): for tasks that run for hours inside one turn. Once the chat has
// grown by ULTRA_TOKENS, tool results carry a reminder: at the next clean checkpoint, save the
// state to a file and clear with next_prompt, so the task goes on by itself in a fresh chat.
// A reminder Claude passes by comes back after ULTRA_REPEAT more tokens, marked overdue.
// MAX_CHAIN automatic continues in a row stop the chain; a prompt the user types resets it.
// The mode lives in $.state: it survives a reload of this code and /clear, not a restart.
// The row above the prompt shows it while it is on.

const TOOL = 'clear_context'
const TOOL_ID = 'mcp__all-clear__clear_context'
const PLUGIN = 'all-clear'
const HANDOFF_KEY = 'handoff'
const MAX_HANDOFF = 400
const MAX_HANDOFF_ULTRA = 1200
const MAX_QUESTION = 200
const NUDGE_TOKENS = 20_000
const ULTRA_TOKENS = 60_000
// After an ultra reminder, the next one waits until the chat has grown this much more.
const ULTRA_REPEAT = 10_000
const MAX_CHAIN = 30
// Characters of the last answer the box shows.
const MAX_BOX = 8000
// A drop below this share of the last reading means the chat was cleared or compacted.
const DROP_RATIO = 0.7

type Pending = { note: string; nextPrompt?: string }
type Reading = { base?: number; last?: number; ultraAt?: number; ultraCount?: number }
type Message = { role: 'user' | 'assistant'; text: string; toolResults?: readonly unknown[] }

const ultraMode = atom({ plugin: 'all-clear', key: 'ultra' } as const, false)

export const register: Register = on => {
  let pending: Pending | undefined
  let chain = 0
  let boxes = 0
  const reading: Reading = {}
  const boxText = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: TOOL,
      isDeferred: false,
      description:
        'Clears the conversation context (/clear) after the current answer is shown. ' +
        'Call it only when the finished task is done and the next task does not need ' +
        'the earlier chat. Never call it in the middle of a task, while you wait for the ' +
        "user's answer, or when the user may still refer back to earlier details. If this " +
        'answer delivers something the user asked to see (a list, a draft, an answer to a ' +
        'question), they may follow up on it: prefer to clear at the end of a later turn. ' +
        'After a clear the user still sees your last answer in a box. If the ' +
        'user skipped your question and started another topic or task, the question no ' +
        'longer blocks: judge whether to clear now, and if the skipped question matters, ' +
        'pass it as open_question. Exception: when a reminder says ultra-clear mode is on, ' +
        'a clear at a clean checkpoint in the middle of a long task is allowed; then save ' +
        'the state to a file first and pass next_prompt so the task goes on by itself. ' +
        'handoff: as short as possible, terse keywords, no sentences, no history: only ' +
        'facts the next step cannot get from files or memory (paths, decisions, open ' +
        `items), max ${MAX_HANDOFF} chars (${MAX_HANDOFF_ULTRA} in ultra-clear mode); it is ` +
        'put in front of the next prompt. next_prompt: ' +
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
    await $.command.register({
      name: 'ultra-clear',
      description: 'all-clear: clear mid-task in long runs and continue by itself (on/off)',
    })
    return started
  })

  on('command.run', { command: 'ultra-clear' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const was = await read($, ultraMode)
    const ultra = arg === 'on' ? true : arg === 'off' ? false : !was
    await update($, ultraMode, () => ultra)
    chain = 0
    return {
      text: ultra
        ? `ultra-clear on: after ~${ULTRA_TOKENS / 1000}k tokens Claude saves its state at the ` +
          'next checkpoint, clears and goes on by itself. /ultra-clear off stops it.'
        : 'ultra-clear off.',
    }
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const input = e as unknown as { handoff?: unknown; next_prompt?: unknown; open_question?: unknown }
    const handoff = typeof input.handoff === 'string' ? input.handoff.trim() : ''
    if (!handoff) return { deny: 'handoff is required (may be one line).' }
    const max = (await read($, ultraMode)) ? MAX_HANDOFF_ULTRA : MAX_HANDOFF
    if (handoff.length > max)
      return { deny: `handoff has ${handoff.length} chars, max ${max}: cut to terse keywords.` }
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

  // Ultra-clear: remind Claude mid-turn, on tool results, once the chat has grown large.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || e.tool === TOOL_ID || 'deny' in ran) return ran
    if (!(await read($, ultraMode))) return ran
    const tokens = (await $.session.usage()).context.tokens
    const grown = growthSinceClear(reading, tokens)
    if (grown === undefined || grown < ULTRA_TOKENS) return ran
    if (reading.ultraAt !== undefined && grown - reading.ultraAt < ULTRA_REPEAT) return ran
    reading.ultraAt = grown
    reading.ultraCount = (reading.ultraCount ?? 0) + 1
    const note = ultraReminder(Math.round(grown / 1000), reading.ultraCount > 1)
    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  // After the main turn ends, run /clear outside the turn, show the last answer, then hand off.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || !pending) return done
    const job = pending
    pending = undefined
    if (e.reason !== 'answer') return done
    const answer = turnText((await $.session.messages()) as readonly Message[]) || e.answer
    $.clock.after(100, async () => {
      // A chain of automatic continues stops at MAX_CHAIN; the handoff then waits for the user.
      const auto = job.nextPrompt !== undefined && chain < MAX_CHAIN
      if (job.nextPrompt !== undefined && !auto) {
        job.note = withNote(job.note, job.nextPrompt).replace('[Task]', '[Planned next step]')
      }
      try {
        // A prompt submitted by the mod does not pass the prompt.submit hook,
        // so next_prompt carries the handoff itself; only a typed prompt uses the store.
        if (!auto) await $.store.set(HANDOFF_KEY, job.note)
        await $.command.run({ command: 'clear' })
        await showBox(answer)
        if (auto) {
          chain++
          await $.prompt.submit({ text: withNote(job.note, job.nextPrompt as string) })
        } else if (job.nextPrompt !== undefined) {
          $.ui.toast(`ultra-clear: ${MAX_CHAIN} automatic continues in a row, paused. Type "go on" to continue.`)
        } else $.ui.toast('All clear. Your next prompt starts with the handoff note.')
      } catch (err) {
        await $.store.delete(HANDOFF_KEY)
        $.ui.toast(`all-clear: /clear failed (${String(err)})`)
      }
    })
    return done

    async function showBox(text: string) {
      if (!text.trim()) return
      const id = `answer-${++boxes}`
      boxText.set(id, text.length > MAX_BOX ? `${text.slice(0, MAX_BOX)}\n[... cut]` : text)
      await $.ui.place({ id }).catch(() => undefined)
    }
  })

  // The box with the answer from before the clear. Display only: the model never reads it.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const text = e.props.plugin === PLUGIN ? boxText.get(e.props.id) : undefined
    if (text === undefined) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box>
          <Text dimColor>Last answer before the clear (Claude no longer sees it) </Text>
          <Button
            key={`copy-${e.props.id}`}
            label="Copy"
            onPress={press => $.ui.copy({ text, surface: press.surface })}
          />
        </Box>
        <Text>{text}</Text>
      </Box>
    )
  })

  // While ultra-clear is on, one row above the prompt says so.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, ultraMode))) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>ultra-clear on · /ultra-clear off to stop</Text>
  })

  // Put the stored handoff in front of the first prompt after the clear,
  // and remind Claude once the chat has grown large.
  on('prompt.submit', async ($, e, next) => {
    if (e.text.trim().startsWith('/')) return next(e)
    // Only a prompt the user typed passes this hook: the chain of automatic continues ends.
    chain = 0
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
            'skipped by moving on does not block this.' +
            ((await read($, ultraMode)) ? ` ultra-clear mode is on: ${ultraRule}` : ''),
        ],
      }
    }
    return next(out)
  }).catch(($, e, next) => next(e))
}

const optionalText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const ultraRule =
  'in a long task, at the next clean checkpoint (a step finished and saved, nothing half-done), ' +
  "write the original request's goal and constraints, what is done, decisions and the remaining " +
  "steps to a state file (the project's plan or TODO file if there is one), then call " +
  `${TOOL} with handoff = the state file's path + the next step, and next_prompt = ` +
  '"Continue the task from the handoff." The task then goes on by itself in a fresh chat; ' +
  'do not wait for the user.'

const ultraReminder = (k: number, isOverdue: boolean) =>
  `all-clear ultra-clear: the chat grew ~${k}k tokens since the last clear. ` +
  (isOverdue
    ? 'The checkpoint is overdue: take the very next safe point, do not start another big step first. '
    : '') +
  ultraRule

// The visible text Claude wrote since the last prompt the user typed, oldest first.
function turnText(messages: readonly Message[]) {
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (m.role === 'user') {
      if (m.toolResults?.length) continue
      break
    }
    if (m.text.trim()) parts.unshift(m.text.trim())
  }
  return parts.join('\n\n')
}

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
  if (r.base === undefined || r.last === undefined || tokens < r.last * DROP_RATIO) {
    r.base = tokens
    r.ultraAt = undefined
    r.ultraCount = undefined
  }
  r.last = tokens
  return tokens - r.base
}
