import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Workflow } from '../types'
import { afterTaskNotice, agentEnded, agentSeen, fromJournal, fromRunFile, launched, metaOf, ownerOf, phasesOf, runFileOf, workflowLines, workflowView, type Workflows } from '../hooks/streams/workflows'
import { commandOf, snapshotOf, summaryOf, type SnapshotInput } from '../hooks/remote/snapshot'
import { statusOf } from '../hooks/status'
import { STORE, TICK_MS } from '../hooks/remote/index'
import { RELAY, SESSION, T0, account, phone, room } from './room'

// A Workflow run is many agents the session's agent list never names: without this, every one of them was filed in
// whatever stream happened to be current, and the run showed as nothing but noise. These tests pin that a run is its
// own stream, with a skeleton of its phases filled as its agents go, and that its end is read from its own record.

const ENGINE = { timeoutMs: 20_000 }
const T = 1_791_600_000_000
const SESSION_DIR = '/Users/me/.claude/projects/p/sess'
const DIR = `${SESSION_DIR}/subagents/workflows/wf_abc-123`
const SCRIPT_PATH = `${SESSION_DIR}/workflows/scripts/audit-wf_abc-123.js`

const SCRIPT = `export const meta = {
  name: 'audit',
  description: "Audit the plugin, then fix what is confirmed", // a comment
  phases: [
    { title: 'Map', detail: 'find every $ use' },
    { title: 'Verify', detail: 'each finding, twice' },
    { title: 'Fix' },
  ],
}
phase('Map')
const found = await parallel(files.map(f => agent(\`map \${f}\`)))`

describe("reading the script's meta", () => {
  // The run's stream is named for meta.name and its skeleton is meta.phases: the tool requires a pure literal, so it
  // is read, never run.
  test('names and phases come from the literal, comments, quotes and trailing commas and all', () => {
    expect(metaOf(SCRIPT)).toEqual({ name: 'audit', description: 'Audit the plugin, then fix what is confirmed', phases: ['Map', 'Verify', 'Fix'] })
  })
  test('a meta that is not a plain literal, or has no name, is not guessed at', () => {
    expect(metaOf("export const meta = { name: `audit-${n}`, phases: [] }")).toBeUndefined()
    expect(metaOf('export const meta = { name: NAME }')).toBeUndefined()
    expect(metaOf("export const meta = { description: 'x' }")).toBeUndefined()
    expect(metaOf('agent("no meta here")')).toBeUndefined()
  })
})

const run = (extra: Partial<Workflow> = {}): Workflows =>
  launched({}, { taskId: 'w1', name: 'audit', streamId: 'audit', phases: ['Map', 'Verify', 'Fix'], startedAt: T, runId: 'wf_abc-123', transcriptDir: DIR, scriptPath: SCRIPT_PATH, ...extra })
const live = (m: Workflows, ids: string[], at: number) => ids.reduce((x, id) => agentSeen(x, 'w1', id, at, true), m)

describe('a run as its agents go', () => {
  test('an agent no stream knows is taken for the running run; a known subagent and a quiet session are left alone', () => {
    expect(ownerOf(run(), 'wfa', false)?.taskId).toBe('w1')
    expect(ownerOf(run(), 'sub', true)).toBeUndefined()
    expect(ownerOf({}, 'wfa', false)).toBeUndefined()
    const ended = afterTaskNotice(run(), '<task-id>w1</task-id><status>completed</status>', T).runs
    expect(ownerOf(ended, 'late', false)).toBeUndefined()
  })
  test('before the run names its phases, agents are grouped into waves by start time, and called waves', () => {
    // Two parallel bursts a minute apart: calling them Map and Verify would be a guess.
    const m = live(live(run(), ['a1', 'a2', 'a3'], T + 10), ['b1', 'b2'], T + 60_000)
    const ended = agentEnded(agentEnded(m, 'w1', 'a1', true, T + 30_000), 'w1', 'a2', false, T + 31_000)
    expect(phasesOf(ended.w1 as Workflow)).toEqual([
      { title: 'wave 1', done: 1, total: 3, err: 1 },
      { title: 'wave 2', done: 0, total: 2, err: 0 },
    ])
    expect(workflowView(ended.w1 as Workflow)).toMatchObject({ agents: { run: 3, done: 1, err: 1 }, inferred: true })
  })
  test('with no agent started yet, the skeleton is the meta phases', () => {
    expect(phasesOf(run().w1 as Workflow).map(p => [p.title, p.total])).toEqual([['Map', 0], ['Verify', 0], ['Fix', 0]])
  })
})

const JOURNAL = [
  '{"type":"launched"}',
  '{"type":"started","key":"k1","agentId":"a1","label":"map-hooks","phase":"Map"}',
  '{"type":"started","key":"k2","agentId":"a2","label":"map-ui","phase":"Map"}',
  '{"type":"result","key":"k1","agentId":"a1","result":"mapped"}',
  '{"type":"started","key":"k3","agentId":"a3","label":"verify-1","phase":"Verify"}',
  '{"type":"failed","key":"k2","agentId":"a2"}',
  '{"type":"result","key":"k3","agentId":"a3","result":{"verdict":"Confirmed","why":"x"}}',
  '{"type":"started","key":"k4","agentId":"a4","label":"verify-2","phase":"Verify"}',
].join('\n')

describe("the run's journal", () => {
  // The journal is written live in the run's transcript dir: the run's own word on labels, phases and ends.
  test('names each agent and its phase, so the waves become the real phases, failures and verdicts counted', () => {
    const m = live(run(), ['a1', 'a2', 'a3', 'a4'], T + 10)
    const read = fromJournal(m.w1 as Workflow, JOURNAL, T + 90_000)
    expect(read.inferred).toBe(false)
    expect(phasesOf(read)).toEqual([
      { title: 'Map', done: 1, total: 2, err: 1 },
      { title: 'Verify', done: 1, total: 2, err: 0, verdicts: { confirmed: 1 } },
      { title: 'Fix', done: 0, total: 0, err: 0 },
    ])
  })
  test('read again unchanged, it is the same run: the phone is not told of nothing', () => {
    const once = fromJournal(run().w1 as Workflow, JOURNAL, T + 1000)
    expect(fromJournal(once, JOURNAL, T + 5000)).toBe(once)
  })
})

const RECORD = JSON.stringify({
  runId: 'wf_abc-123',
  taskId: 'w1',
  status: 'completed',
  startTime: T,
  durationMs: 250_000,
  phases: [{ title: 'Map' }, { title: 'Verify' }, { title: 'Fix' }],
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Map' },
    { type: 'workflow_agent', label: 'map-hooks', phaseTitle: 'Map', agentId: 'a1', state: 'done', startedAt: T + 10, toolCalls: 17, durationMs: 1000 },
    { type: 'workflow_agent', label: 'verify-1', phaseTitle: 'Verify', agentId: 'a3', state: 'done', startedAt: T + 20, toolCalls: 4, durationMs: 1000, resultPreview: '{"verdict":"refuted","notes":"the call is in the same fi…' },
    { type: 'workflow_agent', label: 'fix', phaseTitle: 'Fix', agentId: 'a5', state: 'failed', startedAt: T + 30, toolCalls: 2, durationMs: 1000 },
  ],
})

describe('the end of a run', () => {
  test('its notice ends it, and agents still counted running end with it', () => {
    const m = live(run(), ['a1'], T + 10)
    const { runs, ended } = afterTaskNotice(m, '<task-notification><task-id>w1</task-id><status>killed</status></task-notification>', T + 5000)
    expect(ended).toBe('w1')
    expect(runs.w1).toMatchObject({ status: 'killed', endedAt: T + 5000, agents: { a1: { status: 'error' } } })
    expect(afterTaskNotice(m, '<task-id>other</task-id><status>completed</status>', T).ended).toBeUndefined()
  })
  test('its record, beside its script, is the final word: labels, phases, verdicts, how it ended', () => {
    expect(runFileOf(run().w1 as Workflow)).toBe(`${SESSION_DIR}/workflows/wf_abc-123.json`)
    expect(runFileOf({ runId: 'abc', transcriptDir: DIR })).toBe(`${SESSION_DIR}/workflows/wf_abc.json`)
    const done = fromRunFile(run().w1 as Workflow, RECORD)
    expect(done).toMatchObject({ status: 'completed', endedAt: T + 250_000, inferred: false })
    expect(phasesOf(done)).toEqual([
      { title: 'Map', done: 1, total: 1, err: 0 },
      { title: 'Verify', done: 1, total: 1, err: 0, verdicts: { refuted: 1 } },
      { title: 'Fix', done: 0, total: 1, err: 1 },
    ])
  })
  test('an unreadable record leaves the live counts as they were, still marked inferred', () => {
    const m = live(run(), ['a1'], T + 10)
    expect(fromRunFile(m.w1 as Workflow, 'not json')).toBe(m.w1)
  })
})

describe('the run in the terminal', () => {
  const view = () => {
    const m = fromJournal(live(run(), ['a1', 'a2', 'a3', 'a4'], T + 10).w1 as Workflow, JOURNAL, T + 1000)
    return workflowView(m)
  }
  test('a parent row with a bar and the agents finished, then its phases, failures marked, at 90, 60 and 40 columns', () => {
    const now = T + 252_000
    expect(workflowLines(view(), now, 90)).toEqual(['⚙ RUNNING 4:12 audit ▰▰▰▰▰▰▰▰▱▱ 3/4 ✗1 agents', '  ✗ Map 1/2 ✗1 · ● Verify 1/2 confirmed 1 · ○ Fix'])
    expect(workflowLines(view(), now, 60)).toEqual(['⚙ RUNNING 4:12 audit ▰▰▰▰▰▰▰▰▱▱ 3/4 ✗1 agents', '  ✗ Map 1/2 ✗1 · ● Verify 1/2 confirmed 1 · ○ Fix'])
    expect(workflowLines(view(), now, 40)).toEqual(['⚙ RUNNING 4:12 audit ▰▰▰▱ 3/4 ✗1 agents', '  ✗ Map 1/2 ✗1', '  ● Verify 1/2 confirmed 1 · ○ Fix'])
    for (const w of [40, 60, 90]) for (const line of workflowLines(view(), now, w)) expect(line.length).toBeLessThanOrEqual(w)
  })
  test('counts the plugin only saw are marked ≈, until the run confirms them', () => {
    expect(workflowLines(workflowView(live(run(), ['a1'], T).w1 as Workflow), T + 1000, 60)[0]).toBe('⚙ RUNNING 0:01 audit ▱▱▱▱▱▱▱▱▱▱ ≈0/1 agents')
  })
})

describe('the run on the phone', () => {
  const stream = { id: 'audit', name: 'audit', summary: '', createdAt: T, lastAt: T, rows: 0, agents: 4, loops: 0 }
  const input = (now: number, workflows: Workflows): SnapshotInput => ({
    session: { id: 's', account: 'a', project: 'p', busy: false },
    lines: [statusOf({ stream, health: 'running', running: [] })],
    streams: [stream],
    colorOf: () => '#fff',
    agents: [],
    rows: [],
    status: [],
    limits: [],
    updates: [],
    workflows,
    now,
  })
  const m = { w1: fromJournal(live(run(), ['a1', 'a2', 'a3', 'a4'], T + 10).w1 as Workflow, JOURNAL, T + 1000) }
  // Each phase lists its agents with times, not clocks, failures first: the phone's phase list pins what broke.
  test('the card carries the run as counts and times, each phase its agents failures first, and the summary counts runs, agents and failures', () => {
    const snap = snapshotOf(input(T + 60_000, m))
    const ended = { tools: 1, startedAt: T + 10, endedAt: T + 1000 }
    expect(snap.streams[0]?.workflow).toEqual({
      name: 'audit',
      taskId: 'w1',
      status: 'running',
      startedAt: T,
      agents: { run: 1, done: 2, err: 1 },
      phases: [
        { title: 'Map', done: 1, total: 2, err: 1, agents: [{ id: 'a2', label: 'map-ui', status: 'error', ...ended }, { id: 'a1', label: 'map-hooks', status: 'done', ...ended }] },
        {
          title: 'Verify', done: 1, total: 2, err: 0, verdicts: { confirmed: 1 },
          agents: [{ id: 'a3', label: 'verify-1', status: 'done', ...ended, verdict: 'confirmed' }, { id: 'a4', label: 'verify-2', status: 'running', tools: 1, startedAt: T + 10 }],
        },
        { title: 'Fix', done: 0, total: 0, err: 0, agents: [] },
      ],
      inferred: false,
    })
    expect(snap.summary).toEqual({ workflows: 1, agentsRunning: 1, failures: 1 })
  })
  test('a minute passing changes nothing on the wire', () => {
    const { at: _a, ...first } = snapshotOf(input(T + 60_000, m))
    const { at: _b, ...later } = snapshotOf(input(T + 120_000, m))
    expect(later).toEqual(first)
  })
  test('the summary names the soonest loop tick', () => {
    const loop = (nextAt: number) => ({ kind: 'wakeup' as const, nextAt, noopStreak: 0 })
    const card = (nextAt: number) => ({ ...(snapshotOf(input(T, {})).streams[0] as never as object), loop: loop(nextAt) }) as never
    expect(summaryOf([card(T + 9000), card(T + 4000)], []).nextTickAt).toBe(T + 4000)
  })
})

describe('commands from the phone', () => {
  // The phone is a remote: anything not exactly one of these shapes is dropped before it reaches the session.
  test('stopTask, stopLoop and runTick are taken only well formed, with only their own fields', () => {
    expect(commandOf({ id: 'c', kind: 'stopTask', taskId: 'w1', extra: 'x' })).toEqual({ id: 'c', kind: 'stopTask', taskId: 'w1' })
    expect(commandOf({ id: 'c', kind: 'stopLoop', streamId: 'ci' })).toEqual({ id: 'c', kind: 'stopLoop', streamId: 'ci' })
    expect(commandOf({ id: 'c', kind: 'runTick', streamId: 'ci' })).toEqual({ id: 'c', kind: 'runTick', streamId: 'ci' })
    for (const bad of [
      { id: 'c', kind: 'stopTask' },
      { id: 'c', kind: 'stopTask', taskId: 'w1; rm -rf /' },
      { id: 'c', kind: 'stopTask', taskId: { $ne: '' } },
      { id: 'c', kind: 'stopLoop', streamId: '' },
      { id: 'c', kind: 'runTick', streamId: 'x'.repeat(81) },
      { kind: 'runTick', streamId: 'ci' },
    ])
      expect(commandOf(bad)).toBeUndefined()
  })
})

/** A session with a Workflow tool that answers like the real one, and a journal the test writes. */
function session(on: On, files: Record<string, string>, o: { now?: number; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: o.now ?? T })
  mock.store(on, o.store)
  on('session.cwd', async () => ({ value: '/project' }))
  const submitted: string[] = []
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('fs.read', async (_$, e) => {
    if (files[e.path] === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: files[e.path] } as never
  })
  const calls: Record<string, unknown>[] = []
  on('tool.call', async (_$, e) => {
    calls.push(e as never)
    if (e.tool === 'Workflow')
      return { result: { status: 'async_launched', taskId: 'w1', runId: 'wf_abc-123', workflowName: 'audit', transcriptDir: DIR, scriptPath: SCRIPT_PATH } } as never
    return { result: 'ok' } as never
  })
  return { clock, calls, submitted }
}

const PANE = (bodyColumns: number) => ({ title: 'Streams', isFocused: false, bodyColumns, placement: 'dock' }) as never
const drawn = async ($: Engine, width: number, match: RegExp) => {
  const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE(width) })
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).filter(t => match.test(t))
  await pane.unmount()
  return texts
}

describe('a run in the session', () => {
  test("is filed as its own stream, and its agents' calls land there, not in the stream that was current", ENGINE, async ($, on) => {
    const files: Record<string, string> = {}
    const { clock } = session(on, files)
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Workflow', tool_use_id: 'u1', script: SCRIPT } as never)
    // An agent of the run: an id no stream knows, calling tools while the run goes.
    await $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: 'a.ts', agentId: 'a1' } as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'u3', file_path: 'b.ts', agentId: 'a2' } as never)
    await clock.advance(2000)
    expect(await drawn($, 60, /^⚙|^ {2}[●✓✗○] (Map|Verify|Fix|wave)/)).toEqual(['⚙ RUNNING 0:02 audit ▱▱▱▱▱▱▱▱▱▱ ≈0/2 agents', '  ● wave 1 0/2'])
    // The run's stream runs with its two agents; billing, current all along, got none of them.
    const cards = await drawn($, 60, /^(RUNNING|DONE) · /)
    expect(cards.sort()).toEqual(['DONE · 0 rows · 0 agents · 2s ago', 'RUNNING · 0 rows · 2 agents · 2s ago'])
    // The journal appears: labels and phases replace the waves on the next read.
    files[`${DIR}/journal.jsonl`] = JOURNAL.split('\n').slice(0, 4).join('\n')
    await clock.advance(3000)
    expect(await drawn($, 60, /^ {2}[●✓✗○] (Map|Verify|Fix|wave)/)).toEqual(['  ● Map 1/2 · ○ Verify · ○ Fix'])
    // The end notice, then the record: the final word. An agent the run ended as completed while still counted
    // running (a2 here) is done with it.
    files[`${SESSION_DIR}/workflows/wf_abc-123.json`] = RECORD
    await $.prompt.submit({ text: '<task-notification><task-id>w1</task-id><status>completed</status></task-notification>', wait: false, origin: { kind: 'task-notification' } })
    expect(await drawn($, 60, /^⚙|^ {2}[●✓✗○] (Map|Verify|Fix|wave)/)).toEqual(['⚙ DONE 4:10 audit ▰▰▰▰▰▰▰▰▰▰ 4/4 ✗1 agents', '  ✓ Map 2/2 · ✓ Verify 1/1 refuted 1 · ✗ Fix 0/1 ✗1'])
  })
})

/** A session with one phone paired and unlocked through the relay, recording the commands and prompts it runs. */
async function withPhone($: Engine, on: On) {
  const me = account()
  const a = phone(me, 'iPhone')
  const relay = room([a])
  const { clock, calls, submitted } = session(on, {}, { now: T0, store: { [STORE.identity]: me, [STORE.devices]: [a.stored()] } })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/Users/me/.claude' })
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  const ran: string[] = []
  on('command.run', async (_$, e) => {
    ran.push(`/${e.command} ${e.args}`)
    return { text: '' } as never
  })
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('http.fetch', async (_$, e) => {
    relay.deliver(JSON.parse(String(e.init?.body)).frames)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(relay.answer()) } } as never
  })
  relay.from(a, a.hello({ now: T0 }))
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true } as never)
  await clock.advance(TICK_MS)
  expect(a.isUnlocked()).toBe(true)
  return { a, relay, clock, calls, submitted, ran }
}

describe('commands from the phone, in the session', () => {
  test('stopTask stops only a run this session shows running; runTick submits the loop prompt; stopLoop ends it as the model would', { ...ENGINE, options: { relayUrl: RELAY } }, async ($, on) => {
    const { a, relay, clock, calls, submitted, ran } = await withPhone($, on)

    await $.prompt.submit({ text: '#ci watch the PR', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w', delaySeconds: 60, reason: 'CI running', prompt: '/loop watch the PR', noop: false } as never)
    await $.tool.call({ tool: 'Workflow', tool_use_id: 'u1', script: SCRIPT } as never)
    calls.length = 0
    submitted.length = 0

    // A task this session does not show is not stopped, however well formed the command.
    relay.from(a, a.command({ id: 'c1', kind: 'stopTask', taskId: 'someone-elses' }))
    relay.from(a, a.command({ id: 'c2', kind: 'stopTask', taskId: 'w1' }))
    relay.from(a, a.command({ id: 'c3', kind: 'runTick', streamId: 'ci' }))
    relay.from(a, a.command({ id: 'c4', kind: 'stopLoop', streamId: 'ci' }))
    relay.from(a, a.command({ id: 'c5', kind: 'stopLoop', streamId: 'no-loop-here' }))
    await clock.advance(TICK_MS)
    expect(calls.map(c => ({ tool: c.tool, task_id: c.task_id, stop: c.stop }))).toEqual([
      { tool: 'TaskStop', task_id: 'w1', stop: undefined },
      { tool: 'ScheduleWakeup', task_id: undefined, stop: true },
    ])
    // The tick is the loop's own /loop, run as a command (the engine refuses a plugin's prompt that starts with /).
    expect(ran).toEqual(['/loop watch the PR'])
    expect(submitted).toEqual([])
    // Its own call skips its own hooks, so the session cleared the loop itself: a second stop finds nothing to end.
    relay.from(a, a.command({ id: 'c6', kind: 'stopLoop', streamId: 'ci' }))
    await clock.advance(TICK_MS)
    expect(calls).toHaveLength(2)
  })

  test('Run now is filed as the loop’s tick in its stream, never as the person’s prompt, and repeated taps run it once', { ...ENGINE, options: { relayUrl: RELAY } }, async ($, on) => {
    // Filed as a prompt, it would close every open question (a person's prompt answers them) and be routed by Haiku
    // away from its loop; and each tap is a model turn the person pays for.
    const routed: string[] = []
    on('model.complete', async (_$, e) => {
      routed.push(String(e.prompt))
      return { value: { isAnswered: true, text: '{"new":"Elsewhere","summary":"not the loop"}', usage: { inputTokens: 0, outputTokens: 0 } } } as never
    })
    const { a, relay, clock, submitted } = await withPhone($, on)
    await $.prompt.submit({ text: '#ci watch the PR', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w', delaySeconds: 60, reason: 'CI running', prompt: 'check the PR checks', noop: false } as never)
    submitted.length = 0
    relay.from(a, a.command({ id: 'c1', kind: 'runTick', streamId: 'ci' }))
    relay.from(a, a.command({ id: 'c2', kind: 'runTick', streamId: 'ci' }))
    await clock.advance(TICK_MS)
    expect(submitted).toEqual(['check the PR checks'])
    // Filed by its loop's stream, as a scheduled tick is: Haiku was never asked where it belongs.
    expect(routed).toEqual([])
  })
})
