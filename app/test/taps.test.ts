// Taps on a laggy network: each tap is one command, settled by the session's ack or by its snapshot, never by a guess.
// A held prompt has no deadline: its card waits until someone answers, then says who did. These rules are what keep
// a phone from sending twice, spinning on, or claiming an answer it did not give.
import { describe, expect, test } from 'bun:test'
import type { PendingPermission, PendingQuestion, PhoneCommand, Settled } from '../../plugins/streams/hooks/remote/snapshot'
import { askCards, initial, keyOf, permKey, reduce, SENT_MS, SHOWN_MS, SLOW_MS, streamKey, type State, type Tap } from '../src/state'
import { permissions } from '../src/views/permissions'
import { card } from '../src/views/streams'
import type { Snapshot } from '../src/state'

const T = 1_700_000_000_000
const SK = keyOf('r', 's1')
const ask = (id: string, extra: Partial<PendingPermission> = {}): PendingPermission => ({ id, tool: 'Bash', summary: 'Bash: git push', at: T, since: T, ...extra })
type Extra = { questions?: PendingQuestion[]; settled?: Settled[] }
const snap = (permissions: PendingPermission[], o: Extra = {}): Snapshot => ({
  v: 1, session: { id: 's1', account: 'a', project: 'p', busy: false }, at: T, streams: [], status: [], limits: [], updates: [], permissions, ...o,
})
const seen = (s: State, now: number, p: PendingPermission[], o: Extra = {}) => reduce(s, { type: 'snapshot', room: 'r', snapshot: snap(p, o), now })
const tap = (command: PhoneCommand, stage: Tap['stage'], at: number, extra: Partial<Tap> = {}): Tap => ({ command, room: 'r', sessionId: 's1', stage, at, ...extra })
const allow = (id = 'c1', requestId = 'req1'): PhoneCommand => ({ id, kind: 'permission', requestId, decision: 'allow' })
const phases = (s: State, now: number) => askCards(s, SK, now).map(c => c.phase)
const html = (s: State, now: number) => permissions(askCards(s, SK, now), now)

describe('a permission card under lag', () => {
  test('Allow shows Face ID, then Sent, then settles as Allowed when the snapshot drops the request, and collapses 2 s later', () => {
    let s = seen(initial(), T, [ask('req1')])
    s = reduce(s, { type: 'tap', key: permKey('req1'), tap: tap(allow(), 'faceid', T + 1000) })
    expect(phases(s, T + 1000)).toEqual(['faceid'])
    // Both buttons are disabled from the first tap: a double tap cannot send twice.
    expect(html(s, T + 1000).match(/<button class="btn (allow|deny)"[^>]*disabled/g)).toHaveLength(2)
    expect(html(s, T + 1000)).toContain('Waiting for Face ID…')
    s = reduce(s, { type: 'tap', key: permKey('req1'), tap: tap(allow(), 'sent', T + 2000) })
    expect(html(s, T + 2000)).toContain('Sent: waiting for your Mac…')
    s = seen(s, T + 3000, [])
    expect(phases(s, T + 3000)).toEqual(['allowed'])
    expect(html(s, T + 3000)).toContain('Allowed ✓')
    expect(phases(s, T + 3000 + SHOWN_MS.allowed + 1)).toEqual([])
  })

  test("an ack settles the card before any snapshot, and the ack's word wins over the app's guess", () => {
    let s = seen(initial(), T, [ask('req1')])
    s = reduce(s, { type: 'tap', key: permKey('req1'), tap: tap({ id: 'c1', kind: 'permission', requestId: 'req1', decision: 'deny' }, 'sent', T) })
    s = reduce(s, { type: 'ack', ack: { t: 'ack', id: 'c1', ok: true, why: 'denied' }, now: T + 500 })
    expect(phases(s, T + 500)).toEqual(['denied'])
    // The Mac answered first: the late Deny is told so, and the card says what really happened.
    s = reduce(s, { type: 'ack', ack: { t: 'ack', id: 'c1', ok: false, why: 'answered on Mac' }, now: T + 600 })
    expect(html(s, T + 600)).toContain('Answered on your Mac')
  })

  test('a refused Face ID re-enables Allow with a reason, and after 3 refusals Allow stays off', () => {
    let s = seen(initial(), T, [ask('req1')])
    for (let i = 1; i <= 3; i++) {
      s = reduce(s, { type: 'tap', key: permKey('req1'), tap: tap(allow(`c${i}`), 'sent', T, { tries: s.taps[permKey('req1')]?.tries }) })
      s = reduce(s, { type: 'ack', ack: { t: 'ack', id: `c${i}`, ok: false, why: 'passkey not verified' }, now: T + i })
      const [c] = askCards(s, SK, T + i)
      expect(c?.phase).toBe('open')
      expect(c?.canAllow).toBe(i < 3)
    }
    expect(html(s, T + 3)).toContain('Answer on your Mac')
  })

  test('a card has no deadline: after 10 minutes it is still open and says how long it has waited, with no countdown', () => {
    const s = seen(initial(), T, [ask('req1')])
    expect(phases(s, T + 10 * 60_000)).toEqual(['open'])
    expect(html(s, T + 10 * 60_000)).toContain('waiting 10m')
    expect(html(s, T + 10 * 60_000)).not.toMatch(/s left|Timed out/)
    expect(html(s, T + 30_000)).toContain('just now')
  })

  test('answered on the Mac: the card says so for a few seconds, then collapses', () => {
    let s = seen(initial(), T, [ask('req1')])
    s = seen(s, T + 5_000, [], { settled: [{ id: 'req1', why: 'answered on Mac', at: T + 4_000 }] })
    expect(html(s, T + 5_000)).toContain('Answered on your Mac')
    expect(phases(s, T + 5_000 + SHOWN_MS.mac + 1)).toEqual([])
  })

  test('nobody answered for 2 minutes: the card says "Moved to your Mac", then collapses; ✕ hides any card at once', () => {
    let s = seen(initial(), T, [ask('req1'), ask('req2')])
    s = seen(s, T + 5_000, [ask('req2')], { settled: [{ id: 'req1', why: 'moved to Mac', at: T + 4_000 }] })
    expect(html(s, T + 5_000)).toContain('Moved to your Mac')
    expect(phases(s, T + 5_000 + SHOWN_MS.moved + 1)).toEqual(['open'])
    expect(html(s, T + 5_000)).toContain('data-hide="req2"')
    s = reduce(s, { type: 'hide', requestId: 'req2' })
    expect(askCards(s, SK, T + 5_000).map(c => c.id)).toEqual(['req1'])
    expect(s.hidden).toEqual(['req2'])
  })

  test('a session from before `since` gets its waiting time from `at`', () => {
    const { since: _, ...old } = ask('req1', { at: T - 3 * 60_000 })
    expect(html(seen(initial(), T, [old]), T)).toContain('waiting 3m')
  })

  test('with no word from the Mac for 45 s the card says so and offers Retry, still waiting', () => {
    let s = seen(initial(), T, [ask('req1')])
    s = reduce(s, { type: 'tap', key: permKey('req1'), tap: tap(allow(), 'sent', T) })
    expect(phases(s, T + SLOW_MS)).toEqual(['slow'])
    expect(html(s, T + SLOW_MS)).toContain('answered yet: is Claude Code running?')
    expect(html(s, T + SLOW_MS)).toContain(`data-retry="${permKey('req1')}"`)
  })
})

describe("a question's card", () => {
  const q: PendingQuestion = {
    id: 'toolu_q', question: 'Which store?', header: 'Store', since: T,
    options: [{ label: 'Postgres', isRecommended: false }, { label: 'SQLite (Recommended)', isRecommended: true }],
  }

  test('shows the options as buttons, the recommended one first and primary', () => {
    const out = html(seen(initial(), T, [], { questions: [q] }), T)
    expect([...out.matchAll(/data-label="([^"]+)"/g)].map(m => m[1])).toEqual(['SQLite (Recommended)', 'Postgres'])
    expect(out).toMatch(/class="btn primary" data-choose="toolu_q" data-label="SQLite \(Recommended\)"/)
    expect(out).toContain('Which store?')
  })

  test('a choice disables every option until it settles, then says what was chosen', () => {
    let s = seen(initial(), T, [], { questions: [q] })
    s = reduce(s, { type: 'tap', key: permKey('toolu_q'), tap: tap({ id: 'k1', kind: 'choose', requestId: 'toolu_q', label: 'Postgres' }, 'sent', T) })
    expect(html(s, T).match(/data-choose="toolu_q"[^>]*disabled/g)).toHaveLength(2)
    s = reduce(s, { type: 'ack', ack: { t: 'ack', id: 'k1', ok: true, why: 'chosen' }, now: T + 1 })
    expect(html(s, T + 1)).toContain('Chose Postgres ✓')
  })

  test('when the session chose for an absent person, the card says which and why', () => {
    let s = seen(initial(), T, [], { questions: [q] })
    s = seen(s, T + 3 * 60_000, [], { settled: [{ id: 'toolu_q', why: 'chose recommended', label: 'SQLite (Recommended)', at: T + 2 * 60_000 }] })
    expect(html(s, T + 3 * 60_000)).toContain('Chose the recommended answer: SQLite (no answer for 2m)')
  })
})

describe('Yes and Reply under lag', () => {
  const key = streamKey(SK, 'st1')
  const waiting = { id: 'st1', name: 'docs', color: '#a5d8ff', kind: 'waiting', state: 'WAITING', detail: '', question: 'Ship it?', agents: [], rows: [] } as Snapshot['streams'][number]

  test('Yes is disabled while its answer is on its way, and says Sent ✓ only once the Mac acks it', () => {
    let s = reduce(initial(), { type: 'tap', key, tap: tap({ id: 'a1', kind: 'answer', streamId: 'st1', text: 'yes' }, 'sent', T) })
    expect(card(s, SK, waiting, T)).toMatch(/data-answer="[^"]+" disabled/)
    expect(card(s, SK, waiting, T)).toContain('Sent: waiting for your Mac…')
    expect(card(s, SK, waiting, T)).not.toContain('Sent ✓')
    s = reduce(s, { type: 'ack', ack: { t: 'ack', id: 'a1', ok: true }, now: T + 1 })
    expect(card(s, SK, waiting, T + 1)).toContain('Sent ✓')
    expect(card(s, SK, waiting, T + 1)).not.toMatch(/data-answer="[^"]+" disabled/)
    expect(card(s, SK, waiting, T + 1 + SENT_MS)).not.toContain('Sent ✓')
  })
})

describe('Stop workflow, Stop loop and Run now under lag', () => {
  // These act on the Mac like Yes does, so they get the same honesty: one command per tap, disabled while it is on
  // its way, and a word from the Mac (or plain words when it could not) instead of a button that just goes quiet.
  const key = streamKey(SK, 'ci')
  const looping = {
    id: 'ci', name: 'ci', color: '#a5d8ff', kind: 'loop', state: 'LOOP', detail: '', agents: [], rows: [],
    loop: { kind: 'wakeup', nextAt: T + 60_000, noopStreak: 0 },
    workflow: { name: 'audit', taskId: 'wf1', status: 'running', startedAt: T, agents: { run: 1, done: 0, err: 0 }, phases: [], inferred: false },
  } as unknown as Snapshot['streams'][number]
  const opened = reduce(initial(), { type: 'toggle', key })
  const button = (html: string, attr: string) => html.match(new RegExp(`<button[^>]*${attr}[^>]*>`))?.[0] ?? ''

  test('each button is disabled while its own command is in flight, and says Done ✓ once acked', () => {
    let s = reduce(opened, { type: 'tap', key: `${key}|runTick`, tap: tap({ id: 't1', kind: 'runTick', streamId: 'ci' }, 'sent', T) })
    let html = card(s, SK, looping, T)
    expect(button(html, 'data-run-tick')).toContain('disabled')
    // Only that button: Stop loop and Stop workflow are separate taps.
    expect(button(html, 'data-stop-loop')).not.toContain('disabled')
    expect(button(html, 'data-stop-task')).not.toContain('disabled')
    expect(html).toContain('Sent: waiting for your Mac…')
    s = reduce(s, { type: 'ack', ack: { t: 'ack', id: 't1', ok: true }, now: T + 1 })
    html = card(s, SK, looping, T + 1)
    expect(html).toContain('Done ✓')
    expect(button(html, 'data-run-tick')).not.toContain('disabled')
  })

  test('a stop the Mac could not do is told in words; a slow one offers Retry of the same command', () => {
    let s = reduce(opened, { type: 'tap', key: `${key}|stopTask`, tap: tap({ id: 'k1', kind: 'stopTask', taskId: 'wf1' }, 'sent', T) })
    expect(card(s, SK, looping, T + SLOW_MS + 1)).toContain(`data-retry="${key}|stopTask"`)
    s = reduce(s, { type: 'ack', ack: { t: 'ack', id: 'k1', ok: false }, now: T + 2 })
    expect(card(s, SK, looping, T + 2)).toMatch(/Your Mac couldn(&#39;|&#x27;|')t do that/)
    expect(button(card(s, SK, looping, T + 2), 'data-stop-task')).not.toContain('disabled')
  })
})
