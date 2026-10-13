import { describe, expect, test } from 'claude-code/testing'

import type { Stream, Workflow } from '../types'
import { statusOf } from '../hooks/status'
import { afterCall, type Loops } from '../hooks/streams/loops'
import { fromJournal, type Workflows } from '../hooks/streams/workflows'
import { cardsOf } from '../hooks/view'
import { JOURNAL, T, live, run } from './kit/workflows'

// The cards `$.streams.view()` gives other surfaces (the phone add-on draws these): what each one carries, and that
// time passing alone changes none of it, since a reader that resends on change would otherwise resend every tick.

const at = (n: number) => n * 1000
const stream = (id: string, extra: Partial<Stream> = {}): Stream => ({ id, name: id, summary: '', createdAt: 0, lastAt: 0, rows: 0, agents: 0, loops: 0, ...extra })
const color = () => '#a5d8ff'

describe('a stream card', () => {
  test('carries its running agents and those that ended lately, newest first; one that ended long ago is not news', () => {
    const cards = cardsOf({
      lines: [{ id: 'auth', area: 'Auth', kind: 'running', state: 'RUNNING', detail: '1 agent' }],
      streams: [stream('auth')],
      colorOf: color,
      agents: [
        { id: 'a1', streamId: 'auth', description: 'Move sessions', status: 'running', startedAt: at(0), lastAt: at(50), last: 'Edit auth.ts', tools: 4 },
        { id: 'a2', streamId: 'auth', description: 'Old run', status: 'done', startedAt: at(0), endedAt: at(1), lastAt: at(1), last: '', tools: 1 },
        { id: 'a3', streamId: 'auth', description: 'Just done', status: 'done', startedAt: at(0), endedAt: at(3500), lastAt: at(3500), last: '', tools: 2 },
      ],
      rows: [],
      now: at(3600),
    })
    expect(cards[0]?.agents.map(a => a.id)).toEqual(['a3', 'a1'])
  })

  test('a stream the status card no longer lists is not a card, and the order is the status order', () => {
    const cards = cardsOf({
      lines: [
        { id: 'docs', area: 'Docs', kind: 'waiting', state: 'WAITING', detail: 'Shall I open a PR for it?' },
        { id: 'auth', area: 'Auth', kind: 'running', state: 'RUNNING', detail: '' },
        { id: 'gone', area: 'Gone', kind: 'done', state: 'DONE', detail: '' },
      ],
      streams: [stream('auth'), stream('docs')],
      colorOf: color,
      agents: [],
      rows: [],
      now: 0,
    })
    expect(cards.map(c => [c.id, c.kind, c.detail])).toEqual([
      ['docs', 'waiting', 'Shall I open a PR for it?'],
      ['auth', 'running', ''],
    ])
  })
})

describe("a loop's card", () => {
  const NOON = new Date(2026, 9, 10, 12, 3, 20).getTime()
  const loops: Loops = afterCall({}, 'ci', {
    tool: 'ScheduleWakeup',
    input: { tool: 'ScheduleWakeup', delaySeconds: 60, reason: 'CI still running', noop: true },
    result: { scheduledFor: NOON + 60_000 },
    now: NOON,
  })
  const ci = stream('ci', { name: 'CI', summary: 'Watch CI', loops: 1 })
  const cards = (now: number) =>
    cardsOf({
      lines: [statusOf({ stream: ci, health: 'idle', loop: loops.ci, running: [] })],
      streams: [ci],
      colorOf: color,
      agents: [],
      rows: [
        { id: 'l1', streamId: 'ci', kind: 'loop', text: 'check', at: 1, quiet: true },
        { id: 'l2', streamId: 'ci', kind: 'loop', text: 'check', at: 2, quiet: true },
      ],
      loops,
      now,
    })
  test('carries the loop as fields with no clock text, so a minute passing is not news', () => {
    expect(cards(NOON)[0]?.loop).toEqual({ kind: 'wakeup', nextAt: NOON + 60_000, reason: 'CI still running', noopStreak: 1 })
    expect(cards(NOON + 30_000)).toEqual(cards(NOON))
  })
  test('folds quiet ticks, so a reader with room for a few rows does not show only "check"', () => {
    expect(cards(NOON)[0]?.rows.map(r => r.text)).toEqual(['··· 2 quiet ticks'])
  })
})

describe("a run's card", () => {
  const audit = stream('audit', { name: 'audit', createdAt: T, lastAt: T, agents: 4 })
  const m: Workflows = { w1: fromJournal(live(run(), ['a1', 'a2', 'a3', 'a4'], T + 10).w1 as Workflow, JOURNAL, T + 1000) }
  const cards = (now: number) =>
    cardsOf({ lines: [statusOf({ stream: audit, health: 'running', running: [] })], streams: [audit], colorOf: color, agents: [], rows: [], workflows: m, now })
  // Each phase lists its agents with times, not clocks, failures first: a reader's phase list pins what broke.
  test('carries the run as counts and times, each phase its agents failures first', () => {
    const ended = { tools: 1, startedAt: T + 10, endedAt: T + 1000 }
    expect(cards(T + 60_000)[0]?.run).toEqual({
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
  })
  test('a minute passing changes nothing on it', () => {
    expect(cards(T + 120_000)).toEqual(cards(T + 60_000))
  })
})
