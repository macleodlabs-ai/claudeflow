import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Workflow } from '../../types'
import { afterTaskNotice, agentEnded, agentSeen, fromJournal, fromRunFile, launched, metaOf, ownerOf, phasesOf, runFileOf, workflowLines, workflowView, type Workflows } from '../../hooks/streams/workflows'
import { statusOf } from '../../hooks/status'

// The workflow tests' run, journal and session, shared with the phone add-on's run tests.

export const ENGINE = { timeoutMs: 20_000 }
export const T = 1_791_600_000_000
export const SESSION_DIR = '/Users/me/.claude/projects/p/sess'
export const DIR = `${SESSION_DIR}/subagents/workflows/wf_abc-123`
export const SCRIPT_PATH = `${SESSION_DIR}/workflows/scripts/audit-wf_abc-123.js`

export const SCRIPT = `export const meta = {
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

export const run = (extra: Partial<Workflow> = {}): Workflows =>
  launched({}, { taskId: 'w1', name: 'audit', streamId: 'audit', phases: ['Map', 'Verify', 'Fix'], startedAt: T, runId: 'wf_abc-123', transcriptDir: DIR, scriptPath: SCRIPT_PATH, ...extra })
export const live = (m: Workflows, ids: string[], at: number) => ids.reduce((x, id) => agentSeen(x, 'w1', id, at, true), m)

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

export const JOURNAL = [
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

export const RECORD = JSON.stringify({
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

/** A session with a Workflow tool that answers like the real one, and a journal the test writes. */
export function session(on: On, files: Record<string, string>, o: { now?: number; store?: Record<string, unknown> } = {}) {
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

export const PANE = (bodyColumns: number) => ({ title: 'Streams', isFocused: false, bodyColumns, placement: 'dock' }) as never
export const drawn = async ($: Engine, width: number, match: RegExp) => {
  const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE(width) })
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text).filter(t => match.test(t))
  await pane.unmount()
  return texts
}
