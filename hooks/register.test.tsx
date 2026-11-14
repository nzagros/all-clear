import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Hooks registered here stand for the engine beneath the plugin.
function engine(on: On, state: { tokens: number }) {
  const seen = { commands: [] as string[], prompts: [] as string[], placed: [] as string[] }
  on('tool.register', () => ({ value: undefined }) as never)
  on('command.register', (_, e) => ({ value: { command: e.name } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('session.usage', () => ({ value: { context: { tokens: state.tokens } } }) as never)
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'list 3 fruits', toolUses: [] },
      { role: 'assistant', text: '1. apple\n2. pear\n3. plum', toolUses: [{ name: 'x' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't' }] },
      { role: 'assistant', text: 'Clearing now.', toolUses: [] },
    ],
  }) as never)
  on('command.run', (_, e) => {
    seen.commands.push(e.command)
    return { text: '' } as never
  })
  on('ui.place', (_, e) => {
    seen.placed.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => {
    seen.prompts.push(e.text)
    return e as never
  })
  on('tool.call', () => ({ result: { ok: true } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  return seen
}

const PLACED = (id: string) =>
  ({ plugin: 'all-clear', component: 'Placed', requestId: id, props: { id, plugin: 'all-clear' } }) as const

test('after a clear the whole last answer is shown in a box', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = engine(on, { tokens: 1000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.tool.call({ tool: 'mcp__all-clear__clear_context', handoff: 'fruits listed' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'Clearing now.', durationMs: 1, isAborted: false } as never)
  await clock.advance(200)

  expect(seen.commands).toContain('clear')
  expect(seen.placed).toEqual(['answer-1'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PLACED('answer-1'), surface } as never)
    const row = await ui.find({ type: 'Text', text: /apple/ })
    expect(row?.text).toContain('3. plum')
    expect(row?.text).toContain('Clearing now.')
    expect(await ui.find({ key: 'copy-answer-1' } as never)).toBeDefined()
    await ui.unmount()
  }
})

test('ultra-clear reminds mid-turn on tool results once the chat has grown', async ($, on) => {
  mock.store(on)
  const state = { tokens: 10_000 }
  engine(on, state)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'ultra-clear', args: 'on' } as never)

  const first = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect('context' in first ? first.context : undefined).toBeUndefined()

  state.tokens = 80_000
  const grown = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(String('context' in grown ? grown.context : '')).toContain('ultra-clear')

  // No second reminder until the chat grows ULTRA_REPEAT more.
  state.tokens = 85_000
  const again = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect('context' in again ? again.context : undefined).toBeUndefined()

  // Passed by: it comes back marked overdue.
  state.tokens = 95_000
  const late = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(String('context' in late ? late.context : '')).toContain('overdue')
})

test('the row above the prompt shows ultra-clear while it is on', async ($, on) => {
  mock.store(on)
  engine(on, { tokens: 1000 })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const BAND = {
    plugin: 'all-clear',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 80 },
  } as const

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect(await ui.find({ type: 'Text', text: /ultra-clear/ })).toBeUndefined()
  await ui.unmount()

  await $.command.run({ command: 'ultra-clear', args: 'on' } as never)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
  expect((await ui.find({ type: 'Text', text: /ultra-clear/ }))?.text).toContain('ultra-clear on')
  await ui.unmount()
})

test('ultra-clear continues by itself with next_prompt', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const seen = engine(on, { tokens: 1000 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'ultra-clear', args: 'on' } as never)
  await $.tool.call({
    tool: 'mcp__all-clear__clear_context',
    handoff: 'state in plan.md · next: step 4',
    next_prompt: 'Continue the task from the handoff.',
  } as never)
  await $.turn.complete({ reason: 'answer', answer: 'Checkpoint.', durationMs: 1, isAborted: false } as never)
  await clock.advance(200)

  expect(seen.prompts.at(-1)).toContain('[Handoff]\nstate in plan.md')
  expect(seen.prompts.at(-1)).toContain('[Task]\nContinue the task from the handoff.')
})
