import { describe, expect, test } from 'bun:test'
import { initial, isArmed, keyOf, reduce, STOP_MS, streamKey, type Snapshot } from '../src/state'
import { summaryLine } from '../src/views/flows'
import { streamsView } from '../src/views/streams'

type Stream = Snapshot['streams'][number]
const sk = keyOf('r', 's1')
const AT = new Date(2026, 9, 10, 12, 4).getTime()

const run = (over: Partial<NonNullable<Stream['workflow']>> = {}): NonNullable<Stream['workflow']> => ({
  name: 'audit',
  taskId: 'wf1',
  status: 'running',
  startedAt: AT - 252_000,
  agents: { run: 1, done: 2, err: 1 },
  phases: [
    { title: 'Map', done: 2, total: 2, err: 0, agents: [{ id: 'a1', label: 'map-hooks', status: 'done', tools: 7, startedAt: AT - 250_000, endedAt: AT - 200_000 }, { id: 'a2', label: 'map-ui', status: 'done', tools: 3, startedAt: AT - 250_000, endedAt: AT - 210_000 }] },
    { title: 'Verify', done: 0, total: 2, err: 1, agents: [{ id: 'a3', label: 'verify-seal', status: 'error', tools: 2, startedAt: AT - 100_000, endedAt: AT - 60_000 }, { id: 'a4', label: 'verify-link', status: 'running', tools: 4, startedAt: AT - 100_000 }] },
    { title: 'Fix', done: 0, total: 0, err: 0, agents: [] },
  ],
  inferred: false,
  ...over,
})
const loop = (over: Partial<NonNullable<Stream['loop']>> = {}): NonNullable<Stream['loop']> => ({
  kind: 'wakeup', nextAt: AT + 250_000, reason: 'CI still running', noopStreak: 3, lastChange: { at: AT, text: 'PR merged' }, ...over,
})
const stream = (over: Partial<Stream>): Stream => ({ id: 'x', name: 'x', color: '#a5d8ff', kind: 'running', state: 'RUNNING', detail: 'status detail', agents: [], rows: [], ...over }) as Stream
const opened = (id: string) => reduce(initial(), { type: 'toggle', key: streamKey(sk, id) })

describe('a workflow run on its card', () => {
  const wf = stream({ id: 'wf', name: 'audit', workflow: run() })

  test('the closed card says which phase it is in, how far and what failed, so a glance replaces opening it', () => {
    const html = streamsView(initial(), sk, [wf], AT, false)
    // Done never counts the failed agent, as in the phase rows: the card and its phases must not disagree.
    expect(html).toContain('Verify · 2/4 · ✗1')
    expect(html).not.toContain('status detail')
    expect(html).toContain('role="progressbar"')
  })

  test('counts the session only inferred are marked, so a guess never reads as the run’s own record', () => {
    expect(streamsView(initial(), sk, [stream({ id: 'wf', workflow: run({ inferred: true }) })], AT, false)).toContain('Verify · ≈2/4 · ✗1')
  })

  test('opened, a failed agent is pinned above the phases, and the failing phase is open while the finished one is not', () => {
    const html = streamsView(opened('wf'), sk, [wf], AT, false)
    expect(html.indexOf('1 failed')).toBeLessThan(html.indexOf('class="phases"'))
    const phases = html.slice(html.indexOf('class="phases"'))
    expect(phases).toContain('verify-seal')
    expect(phases).not.toContain('map-hooks')
  })

  test('a tap on a phase flips it, so the person decides what stays open across redraws', () => {
    const s = reduce(opened('wf'), { type: 'toggle', key: `${streamKey(sk, 'wf')}|phase|Map` })
    expect(streamsView(s, sk, [wf], AT, false)).toContain('map-hooks')
  })

  test('Stop workflow is offered only while the run runs, with its task id', () => {
    expect(streamsView(opened('wf'), sk, [wf], AT, false)).toContain('data-stop-task="wf1"')
    const done = stream({ id: 'wf', workflow: run({ status: 'completed', endedAt: AT }) })
    expect(streamsView(opened('wf'), sk, [done], AT, false)).not.toContain('data-stop-task')
  })
})

describe('a loop on its card', () => {
  const lp = stream({ id: 'ci', name: 'CI', kind: 'loop', state: 'LOOP', loop: loop(), nextAt: AT + 250_000 })

  test('the card counts down to the next tick from its time, and says how long it has been quiet and when it last changed', () => {
    // A countdown reads `in m:ss`, a time of day bare `HH:MM`: on one line the two must not look alike.
    expect(streamsView(initial(), sk, [lp], AT, false)).toContain('in 4:10 · 3 quiet · ✓ 12:04')
    expect(streamsView(initial(), sk, [lp], AT + 10_000, false)).toContain('in 4:00 · 3 quiet')
  })

  test('opened, it explains itself and offers Run now and Stop loop; a monitor has no prompt to run', () => {
    const html = streamsView(opened('ci'), sk, [lp], AT, false)
    for (const t of ['CI still running', '3 ticks found nothing', 'PR merged', 'data-run-tick', 'data-stop-loop']) expect(html).toContain(t)
    const mon = stream({ id: 'ci', kind: 'loop', loop: loop({ kind: 'monitor', nextAt: undefined }) })
    expect(streamsView(opened('ci'), sk, [mon], AT, false)).not.toContain('data-run-tick')
    // A cron or monitor whose id the session never learned cannot be ended: no button that silently does nothing.
    const lost = stream({ id: 'ci', kind: 'loop', loop: loop({ kind: 'cron', canStop: false }) })
    expect(streamsView(opened('ci'), sk, [lost], AT, false)).not.toContain('data-stop-loop')
  })
})

test('a destructive stream button needs a second tap soon after, and arming one never arms another', () => {
  const s = reduce(initial(), { type: 'arm', key: 'a|stopTask', now: 1000 })
  expect(isArmed(s, 'a|stopTask', 1000 + STOP_MS - 1)).toBe(true)
  expect(isArmed(s, 'a|stopTask', 1000 + STOP_MS)).toBe(false)
  expect(isArmed(s, 'a|stopLoop', 1001)).toBe(false)
})

describe('the sticky summary', () => {
  const base: Snapshot = { v: 1, session: { id: 's1', account: 'a', project: 'p', busy: true }, at: AT, streams: [], status: [], limits: [], updates: [], permissions: [] }

  test('shows agents done of total, failures and the next loop tick in words, counted from times', () => {
    // Bare symbols and numbers do not read at a glance, nor to a screen reader.
    const x = { ...base, streams: [stream({ workflow: run() })], summary: { workflows: 1, agentsRunning: 1, failures: 1, nextTickAt: AT + 250_000 } }
    const html = summaryLine(x, AT)
    const text = html.replace(/<[^>]+>/g, '')
    expect(text).toContain('⚙ 2/4 agents')
    expect(text).toContain('✗ 1 failed')
    expect(text).toContain('↻ next in 4:10')
    expect(html).toContain('aria-label="1 workflow running, 1 failed, next loop tick in 4:10"')
  })

  test('is not drawn when nothing runs, fails or ticks, so it never takes room for nothing', () => {
    expect(summaryLine({ ...base, summary: { workflows: 0, agentsRunning: 0, failures: 0 } }, AT)).toBe('')
  })
})
