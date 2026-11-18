import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { gradientBar } from './register'

const TOOL = 'mcp__progress-eta__set_progress'
const MINUTE = 60_000

const BAND = {
  plugin: 'progress-eta',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const engine = (on: On) => {
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'progress-clear' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: 'ok' }))
}

test('the orchestrator sets the bar and it draws with its ETA on every surface', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const set = await $.tool.call({ tool: TOOL, percent: 40, eta_minutes: 30, label: 'Migrate threads', note: '3 of 8 done' })
  expect(set.deny).toBeUndefined()
  expect(String(set.result)).toContain('40%')

  await clock.advance(10 * MINUTE)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /3 of 8/ }))?.text).toBe('3 of 8 done')
    expect((await ui.find({ type: 'Text', text: /%$/ }))?.text).toBe('60%')
    expect((await ui.find({ type: 'Text', text: /left$/ }))?.text).toBe('00:20:00 left')
    expect(await ui.find({ key: 'clear' })).toBeDefined()
    await ui.unmount()
  }

  // Keeping the ETA when it is omitted; the label carries over too.
  const kept = await $.tool.call({ tool: TOOL, percent: 60 })
  expect(String(kept.result)).toContain('Migrate threads, 60%, ~20m left')
})

test('a stale bar adds one reminder to a main-agent tool result, not more often', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, percent: 10, eta_minutes: 60, label: 'Build' })

  await clock.advance(5 * MINUTE)
  const early = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(early.context ?? []).toHaveLength(0)

  await clock.advance(6 * MINUTE)
  const stale = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(stale.context?.[0]).toContain('last updated 11m ago')

  // Right after a reminder, none again.
  const again = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(again.context ?? []).toHaveLength(0)

  // A subagent's calls never carry it.
  await clock.advance(20 * MINUTE)
  const sub = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  expect(sub.context ?? []).toHaveLength(0)

  // An update resets the wait.
  await $.tool.call({ tool: TOOL, percent: 50 })
  const fresh = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(fresh.context ?? []).toHaveLength(0)
})

test('an overdue ETA reminds sooner, and clear removes the bar', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  // Stands for the engine's own empty band once the mod hands it back.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, percent: 80, eta_minutes: 2, label: 'Deploy' })

  await clock.advance(6 * MINUTE)
  const late = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(late.context?.[0]).toContain('ETA passed 4m ago')

  // Done: no "overdue" and no more reminders.
  const done = await $.tool.call({ tool: TOOL, percent: 100 })
  expect(String(done.result)).toContain('100%, done')
  await clock.advance(30 * MINUTE)
  const after = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(after.context ?? []).toHaveLength(0)

  const bad = await $.tool.call({ tool: TOOL, percent: 'lots' })
  expect(bad.deny).toContain('needs percent')

  // The × removes it.
  const before = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await before.press({ key: 'clear' })
  await before.unmount()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /%$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('the bar fills its width exactly, with a smooth edge', () => {

  for (const percent of [0, 1, 37.5, 45, 99.9, 100]) {
    const segments = gradientBar(percent, 59, ['#000000', '#ffffff'])
    expect(segments.map(s => s.text).join('')).toHaveLength(59)
  }
  expect(gradientBar(0, 20, ['#000000', '#ffffff']).every(s => s.isTrack)).toBe(true)
  expect(gradientBar(100, 20, ['#000000', '#ffffff']).some(s => s.isTrack)).toBe(false)
})

test('the countdown ticks live, to the second, then counts overtime', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, percent: 10, eta_minutes: 1, label: 'Tick' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /left$/ }))?.text).toBe('00:01:00 left')
  await clock.advance(1_000)
  expect((await ui.find({ type: 'Text', text: /left$/ }))?.text).toBe('00:00:59 left')
  await clock.advance(62_000)
  expect((await ui.find({ type: 'Text', text: /over$/ }))?.text).toBe('+00:00:03 over')
  await ui.unmount()
})

test('the bar keeps pace with the countdown between updates', async ($, on) => {
  const clock = mock.clock(on)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: TOOL, percent: 0, eta_minutes: 14, label: 'Pace' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /%$/ }))?.text).toBe('0%')
  await clock.advance(7 * MINUTE)
  expect((await ui.find({ type: 'Text', text: /%$/ }))?.text).toBe('50%')
  // Past the ETA it holds short of done until the agent says so.
  await clock.advance(10 * MINUTE)
  expect((await ui.find({ type: 'Text', text: /%$/ }))?.text).toBe('99%')
  await ui.unmount()

  // A new report restarts the pace from there: 60% with 4 minutes left reads 80% at 2.
  await $.tool.call({ tool: TOOL, percent: 60, eta_minutes: 4 })
  await clock.advance(2 * MINUTE)
  const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await again.find({ type: 'Text', text: /%$/ }))?.text).toBe('80%')
  await again.unmount()
})
