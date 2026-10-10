import { describe, expect, mock, test } from 'claude-code/testing'

import type { Loop, Stream, StreamRow } from '../types'
import { afterCall, afterNotification, foldQuiet, loopLines, loopsAt, markQuiet, nextFire, type Loops } from '../hooks/streams/loops'
import { snapshotOf, type SnapshotInput } from '../hooks/remote/snapshot'
import { statusOf } from '../hooks/status'

const ENGINE = { timeoutMs: 20_000 }
/** Local noon on a Saturday: cron reads local time, so the expectations do too. */
const NOON = new Date(2026, 9, 10, 12, 3, 20).getTime()
const at = (h: number, m: number, day = 10) => new Date(2026, 9, day, h, m, 0, 0).getTime()

const wake = (m: Loops, input: Record<string, unknown>, result: unknown, now = NOON, sid = 'ci') =>
  afterCall(m, sid, { tool: 'ScheduleWakeup', input: { tool: 'ScheduleWakeup', ...input }, result, now })

describe('a wakeup says when it really fires', () => {
  // The person plans around the countdown: the runtime clamps a 30 s request to 60 s, so 30 s would be a lie.
  test('a 30 s request clamped to 60 s counts down from 60 s', () => {
    const loops = wake({}, { delaySeconds: 30, reason: 'CI still running', noop: false }, { scheduledFor: NOON + 60_000, clampedDelaySeconds: 60, wasClamped: true })
    expect(loops.ci?.nextAt).toBe(NOON + 60_000)
    expect(loopLines(loops.ci as Loop, NOON, 80)[0]).toBe('↻ LOOP next 1:00 (CI still running)')
  })
  test('without the runtime answer, the request is clamped as the runtime would', () => {
    expect(wake({}, { delaySeconds: 30 }, 'ok').ci?.nextAt).toBe(NOON + 60_000)
    expect(wake({}, { delaySeconds: 7200 }, 'ok').ci?.nextAt).toBe(NOON + 3_600_000)
  })
  test('a refused call arms nothing, and an answer that says stopped ends the loop', () => {
    expect(wake({}, { delaySeconds: 90 }, undefined)).toEqual({})
    const armed = wake({}, { delaySeconds: 90 }, { scheduledFor: NOON + 90_000 })
    expect(wake(armed, {}, { stopped: true, cancelledWakeups: 1 }, NOON, 'other')).toEqual({})
  })
})

describe('quiet ticks', () => {
  // A loop that checks every minute and finds nothing would bury the one tick that mattered.
  const change = wake({}, { delaySeconds: 60, reason: 'PR merged', noop: false }, { scheduledFor: at(12, 5) }, at(12, 4))
  const quiet = [1, 2, 3].reduce((m, i) => wake(m, { delaySeconds: 60, reason: 'CI still running', noop: true }, { scheduledFor: at(12, 5 + i) }, at(12, 4 + i)), change)

  test('noop ticks count a streak and keep the last real change; a change resets it', () => {
    expect(quiet.ci).toMatchObject({ noopStreak: 3, lastChange: { at: at(12, 4), text: 'PR merged' }, reason: 'CI still running' })
    const moved = wake(quiet, { delaySeconds: 60, reason: 'CI went green', noop: false }, { scheduledFor: at(12, 9) }, at(12, 8))
    expect(moved.ci).toMatchObject({ noopStreak: 0, lastChange: { at: at(12, 8), text: 'CI went green' } })
  })
  test('the loop reads as when it fires next, then how long it has been quiet and what last happened', () => {
    expect(loopLines(quiet.ci as Loop, (quiet.ci?.nextAt ?? 0) - 250_000, 80)).toEqual(['↻ LOOP next 4:10 (CI still running)', '  ··· 3 quiet ticks · last change 12:04 "PR merged"'])
  })
  test('every line fits 40, 60 and 90 columns, the quote giving way first', () => {
    for (const w of [40, 60, 90]) for (const line of loopLines(quiet.ci as Loop, at(12, 7), w)) expect(line.length).toBeLessThanOrEqual(w)
    expect(loopLines(quiet.ci as Loop, at(12, 7), 40)[1]).toBe('  ··· 3 quiet ticks · last change 12:04')
  })

  const row = (id: string, kind: StreamRow['kind'], extra: Partial<StreamRow> = {}): StreamRow => ({ id, streamId: 'ci', kind, text: id, at: Number(id.slice(1)) || 0, ...extra })
  test('runs of quiet ticks fold into one line, and a tick that changed something stays whole', () => {
    const rows = [
      row('p1', 'prompt'),
      row('l2', 'loop', { quiet: true }),
      row('t3', 'tool'),
      row('l4', 'loop', { quiet: true }),
      row('r5', 'reply'),
      row('l6', 'loop'),
      row('r7', 'reply'),
      row('l8', 'loop', { quiet: true }),
    ]
    expect(foldQuiet(rows).map(r => r.text)).toEqual(['p1', '··· 2 quiet ticks', 'l6', 'r7', '··· 1 quiet tick'])
  })
  test('only the running tick is marked quiet, never the person\'s own prompt', () => {
    const rows = [row('l1', 'loop'), row('t2', 'tool'), row('l3', 'loop'), row('t4', 'tool')]
    expect(markQuiet(rows, 'ci').map(r => !!r.quiet)).toEqual([false, false, true, false])
    const typed = [row('l1', 'loop'), row('p2', 'prompt')]
    expect(markQuiet(typed, 'ci')).toBe(typed)
  })
})

describe('cron loops', () => {
  test('*/5 fires at the next fifth minute, an hourly job at the top of the next hour', () => {
    expect(nextFire('*/5 * * * *', NOON)).toBe(at(12, 5))
    expect(nextFire('0 * * * *', NOON)).toBe(at(13, 0))
  })
  test('lists, ranges and steps read as cron does, in local time', () => {
    // Saturday noon: a weekday job waits for Monday 9:00.
    expect(nextFire('0 9-17/4 * * 1-5', NOON)).toBe(at(9, 0, 12))
    expect(nextFire('15,45 12 * * *', NOON)).toBe(at(12, 15))
    expect(nextFire('30 14 28 2 *', NOON)).toBe(new Date(2027, 1, 28, 14, 30).getTime())
    // Both day fields restricted: either one fires.
    expect(nextFire('0 0 1 * 0', NOON)).toBe(at(0, 0, 11))
  })
  test('a malformed expression has no next fire rather than a wrong one', () => {
    for (const bad of ['*/0 * * * *', '61 * * * *', '* * *', 'a b c d e', '5-1 * * * *']) expect(nextFire(bad, NOON)).toBe(undefined)
  })

  const created = afterCall({}, 'ci', { tool: 'CronCreate', input: { cron: '*/5 * * * *', prompt: 'check the deploy' }, result: { id: 'j1', humanSchedule: 'Every 5 minutes', recurring: true }, now: NOON })
  test('a cron counts down to its next match and says its schedule in words, not as an expression', () => {
    expect(loopLines(created.ci as Loop, NOON, 80)[0]).toBe('↻ LOOP next 1:40 · Every 5 minutes (check the deploy)')
  })
  test('after it fires it counts to the next match; a one-shot is gone; unchanged loops stay the same object', () => {
    expect(loopsAt(created, at(12, 4))).toBe(created)
    expect(loopsAt(created, at(12, 5, 10) + 2_000).ci?.nextAt).toBe(at(12, 10))
    const once = { ci: { ...(created.ci as Loop), recurring: false } }
    expect(loopsAt(once, at(12, 5) + 11 * 60_000)).toEqual({})
  })
  test('deleting the job ends its loop from any stream, and leaves another job alone', () => {
    const two = afterCall(created, 'docs', { tool: 'CronCreate', input: { cron: '0 * * * *' }, result: { id: 'j2', humanSchedule: 'Every hour', recurring: true }, now: NOON })
    expect(Object.keys(afterCall(two, 'docs', { tool: 'CronDelete', input: { id: 'j1' }, result: { id: 'j1' }, now: NOON }))).toEqual(['docs'])
  })
})

describe('monitors', () => {
  const watching = afterCall({}, 'ci', { tool: 'Monitor', input: { description: 'deploy log', timeout_ms: 300_000, command: 'tail -f x' }, result: { taskId: 'b1', timeoutMs: 300_000 }, now: NOON })
  const note = (id: string, body: string) => `<task-notification>\n<task-id>${id}</task-id>\n${body}\n</task-notification>`

  test('a monitor is a loop of its own kind, with its description and deadline', () => {
    expect(watching.ci).toMatchObject({ kind: 'monitor', id: 'b1', reason: 'deploy log', until: NOON + 300_000 })
    const forever = afterCall({}, 'ci', { tool: 'Monitor', input: { description: 'x', timeout_ms: 0 }, result: { taskId: 'b2', timeoutMs: 0, persistent: true }, now: NOON })
    expect(forever.ci?.until).toBe(undefined)
  })
  test('its events are its latest change; only its own end notice ends it, matched by its task id', () => {
    const evented = afterNotification(watching, note('b1', '<summary>Monitor event: "build 42 passed"</summary>'), NOON + 5_000)
    expect(evented.ci?.lastChange).toEqual({ at: NOON + 5_000, text: 'build 42 passed' })
    expect(afterNotification(watching, note('b11', '<status>completed</status>'), NOON)).toBe(watching)
    expect(afterNotification(watching, note('b1', '<status>completed</status>\n<summary>Monitor "deploy log" stream ended</summary>'), NOON)).toEqual({})
  })
  test('TaskStop ends it', () => {
    expect(afterCall(watching, 'docs', { tool: 'TaskStop', input: { task_id: 'b1' }, result: { task_id: 'b1', task_type: 'monitor', message: 'stopped' }, now: NOON })).toEqual({})
  })
})

describe('what the phone is told of a loop', () => {
  const stream: Stream = { id: 'ci', name: 'CI', summary: 'Watch CI', createdAt: 0, lastAt: 0, rows: 0, agents: 0, loops: 1 }
  const loops = wake({}, { delaySeconds: 60, reason: 'CI still running', noop: true }, { scheduledFor: NOON + 60_000 })
  const input = (now: number): SnapshotInput => ({
    session: { id: 's', account: 'a', project: 'p', busy: false },
    lines: [statusOf({ stream, health: 'idle', loop: loops.ci, running: [] })],
    streams: [stream],
    colorOf: () => '#fff',
    agents: [],
    rows: [
      { id: 'l1', streamId: 'ci', kind: 'loop', text: 'check', at: 1, quiet: true },
      { id: 'l2', streamId: 'ci', kind: 'loop', text: 'check', at: 2, quiet: true },
    ],
    status: [],
    limits: [],
    updates: [],
    loops,
    now,
  })
  test('the loop goes as fields, with no clock text, so a minute passing is not news', () => {
    const a = snapshotOf(input(NOON))
    expect(a.streams[0]?.loop).toEqual({ kind: 'wakeup', nextAt: NOON + 60_000, reason: 'CI still running', noopStreak: 1 })
    const { at: _a, ...first } = a
    const { at: _b, ...later } = snapshotOf(input(NOON + 30_000))
    expect(later).toEqual(first)
  })
  test('quiet ticks reach the phone folded, so its few rows are not all "check"', () => {
    expect(snapshotOf(input(NOON)).streams[0]?.rows.map(r => r.text)).toEqual(['··· 2 quiet ticks'])
  })
})

describe('the loop in the pane', () => {
  const props = (bodyColumns: number) => ({ title: 'Streams', isFocused: false, bodyColumns, placement: 'dock' }) as never
  test('a clamped, quiet loop reads the same at 40, 60 and 90 columns: next fire, then the quiet streak', ENGINE, async ($, on) => {
    const clock = mock.clock(on, { now: at(12, 4) })
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    let scheduled = 0
    on('tool.call', async () => ({ result: { scheduledFor: scheduled, clampedDelaySeconds: 60, wasClamped: true } }) as never)
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#ci watch the PR', wait: false, origin: { kind: 'composer' } })
    let n = 0
    const tick = async (reason: string, noop: boolean) => {
      scheduled = at(12, 5) + 250_000
      await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: `w${n++}`, delaySeconds: 30, reason, noop, prompt: '/loop x' } as never)
    }
    await tick('PR merged', false)
    await clock.advance(60_000)
    for (let i = 0; i < 3; i++) await tick('CI still running', true)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: props(40) })
    const drawn: Record<number, string[]> = {}
    for (const w of [40, 60, 90]) {
      await pane.redraw(props(w))
      drawn[w] = (await pane.findAll({ type: 'Text' })).map(t => t.text).filter(t => /LOOP|quiet/.test(t))
    }
    expect(drawn[90]).toEqual(['↻ LOOP next 4:10 (CI still running)', '  ··· 3 quiet ticks · last change 12:04 "PR merged"'])
    expect(drawn[60]).toEqual(['↻ LOOP next 4:10 (CI still running)', '  ··· 3 quiet ticks · last change 12:04 "PR merged"'])
    expect(drawn[40]).toEqual(['↻ LOOP next 4:10 (CI still running)', '  ··· 3 quiet ticks · last change 12:04'])
  })
})
