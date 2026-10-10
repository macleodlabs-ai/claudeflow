import { describe, expect, test } from 'claude-code/testing'

import { createLink } from '../hooks/remote/link'
import { QUESTION_GRACE_MS, QUIET_STREAK, createNotifier } from '../hooks/remote/notify'
import type { PhoneStream, Snapshot } from '../hooks/remote/snapshot'
import { ORIGIN, SESSION, T0, account, cycle, phone, room, snapshot } from './room'

// A push wakes a phone in a pocket: worth it when Claude needs the person or something finished or failed, and
// never for a tick that changed nothing, never for a phone already looking, and never for a question the person is
// answering at the Mac. How often a device is woken is the relay's to limit (it sees every session).
// The hint names devices and a kind only: the relay and the push service must not learn what happened.

const stream = (id: string, extra: Partial<PhoneStream> = {}): PhoneStream =>
  ({ id, name: id, color: '#7cc8ff', kind: 'running', state: 'RUNNING', detail: '', agents: [], rows: [], ...extra }) as PhoneStream
const waiting = (id: string, question: string) => stream(id, { kind: 'waiting', state: 'WAITING', question, detail: question })
const run = (status: string) =>
  ({ name: 'audit', taskId: 'wf1', status, startedAt: T0, agents: { run: 0, done: 1, err: 0 }, phases: [], inferred: false }) as unknown as PhoneStream['workflow']
const loop = (noopStreak: number, changedAt: number) =>
  ({ kind: 'wakeup', nextAt: T0 + 60_000, noopStreak, lastChange: { at: changedAt, text: 'PR merged' } }) as PhoneStream['loop']
const snap = (streams: PhoneStream[], extra: Partial<Snapshot> = {}) => snapshot(T0, { streams, ...extra })

/** The kind a change from `before` to `after` wakes a device that is not looking with, if any (a question once its grace is over). */
function kindOf(before: Snapshot, after: Snapshot): string | undefined {
  const n = createNotifier()
  n.hint(before, ['d1'], () => false, T0)
  const now = n.hint(after, ['d1'], () => false, T0 + 1000)?.kind
  return now ?? n.hint(after, ['d1'], () => false, T0 + 1000 + QUESTION_GRACE_MS)?.kind
}

describe('what is worth a push', () => {
  test('a new held permission or a new waiting question needs you', () => {
    const perm = { id: 'toolu_1', tool: 'Bash', summary: 'Bash: npm publish', at: T0 }
    expect(kindOf(snap([]), snap([], { permissions: [perm] }))).toBe('needs-you')
    expect(kindOf(snap([stream('a')]), snap([waiting('a', 'Deploy now?')]))).toBe('needs-you')
    // The same question still waiting is old news; another question in the same stream is new.
    expect(kindOf(snap([waiting('a', 'Deploy now?')]), snap([waiting('a', 'Deploy now?')]))).toBeUndefined()
    expect(kindOf(snap([waiting('a', 'Deploy now?')]), snap([waiting('a', 'Tag it too?')]))).toBe('needs-you')
  })

  test('a workflow that finishes is done; one that fails or is killed, or a failure not shown before, failed', () => {
    const agent = (id: string, status: string) => ({ id, description: id, status, tools: 0, startedAt: T0, last: '' }) as PhoneStream['agents'][number]
    const wf = (status: string, agents: PhoneStream['agents'] = []) => snap([stream('a', { workflow: run(status), agents })])
    expect(kindOf(wf('running'), wf('completed'))).toBe('done')
    expect(kindOf(wf('running'), wf('failed'))).toBe('failed')
    expect(kindOf(wf('running'), wf('killed'))).toBe('failed')
    expect(kindOf(wf('running'), wf('running', [agent('x', 'error')]))).toBe('failed')
    // A failure is named, not counted: the same one again (or one leaving the cards after ten minutes and the count
    // dropping) is no news, so an old failure never buzzes twice.
    const n = createNotifier()
    n.hint(wf('running', [agent('x', 'error')]), ['d1'], () => false, T0)
    expect(n.hint(wf('running'), ['d1'], () => false, T0 + 600_000)).toBeUndefined()
    expect(n.hint(wf('running', [agent('x', 'error')]), ['d1'], () => false, T0 + 602_000)).toBeUndefined()
    expect(n.hint(wf('running', [agent('y', 'error')]), ['d1'], () => false, T0 + 604_000)?.kind).toBe('failed')
  })

  test('a loop that changes something after a quiet streak is done; a plain tick or a stopped loop is nothing', () => {
    const quiet = snap([stream('ci', { loop: loop(QUIET_STREAK, T0 - 600_000) })])
    // Stopping a loop is mostly the person (or the model) ending it on purpose: not worth a buzz.
    expect(kindOf(quiet, snap([stream('ci')]))).toBeUndefined()
    expect(kindOf(quiet, snap([stream('ci', { loop: loop(0, T0) })]))).toBe('done')
    expect(kindOf(quiet, snap([stream('ci', { loop: loop(QUIET_STREAK + 1, T0 - 600_000) })]))).toBeUndefined()
    // A loop that changes every tick has no quiet streak: each change is not worth a buzz.
    const busy = snap([stream('ci', { loop: loop(0, T0 - 60_000) })])
    expect(kindOf(busy, snap([stream('ci', { loop: loop(0, T0) })]))).toBeUndefined()
  })

  test('a session starting is no news, and needs-you wins when several things happen at once', () => {
    const n = createNotifier()
    expect(n.hint(snap([waiting('a', 'Deploy now?')]), ['d1'], () => false, T0)).toBeUndefined()
    const perm = { id: 'toolu_1', tool: 'Bash', summary: 'Bash: npm publish', at: T0 }
    const both = snap([waiting('a', 'Deploy now?'), stream('c', { workflow: run('failed') })], { permissions: [perm] })
    expect(kindOf(snap([waiting('a', 'Deploy now?'), stream('c', { workflow: run('running') })]), both)).toBe('needs-you')
  })
})

describe('who is woken, and how often', () => {
  const ask = (q: string) => snap([waiting('a', q)])

  test('never a device that is looking: it sees the news already', () => {
    const n = createNotifier()
    n.hint(ask('q0'), ['d1', 'd2'], () => false, T0)
    n.hint(ask('q1'), ['d1', 'd2'], () => false, T0 + 1000)
    expect(n.hint(ask('q1'), ['d1', 'd2'], id => id === 'd1', T0 + 1000 + QUESTION_GRACE_MS)).toEqual({ notify: ['d2'], kind: 'needs-you' })
    n.hint(ask('q2'), ['d1'], () => true, T0 + 3 * QUESTION_GRACE_MS)
    expect(n.hint(ask('q2'), ['d1'], () => true, T0 + 4 * QUESTION_GRACE_MS)).toBeUndefined()
  })

  test('a question buzzes only once it has waited unanswered past its grace, and only once', () => {
    // Most replies ending in "?" are answered at the Mac within a minute: buzzing the phone then is noise.
    const n = createNotifier()
    n.hint(snap([stream('a')]), ['d1'], () => false, T0)
    expect(n.hint(ask('Deploy now?'), ['d1'], () => false, T0 + 2000)).toBeUndefined()
    // Answered at the Mac within the grace: never news.
    expect(n.hint(snap([stream('a')]), ['d1'], () => false, T0 + 60_000)).toBeUndefined()
    expect(n.hint(snap([stream('a')]), ['d1'], () => false, T0 + 2000 + QUESTION_GRACE_MS)).toBeUndefined()
    // Left waiting: news once the grace is over, then old news.
    const asked = T0 + 10 * QUESTION_GRACE_MS
    expect(n.hint(ask('Merge?'), ['d1'], () => false, asked)).toBeUndefined()
    expect(n.hint(ask('Merge?'), ['d1'], () => false, asked + QUESTION_GRACE_MS)).toEqual({ notify: ['d1'], kind: 'needs-you' })
    expect(n.hint(ask('Merge?'), ['d1'], () => false, asked + 2 * QUESTION_GRACE_MS)).toBeUndefined()
  })

  test('the session leaves the rate limit to the relay: each piece of news is hinted, never held back or lost', () => {
    // The relay sees every session of the account, so only it can count a device's pushes; a session that counted
    // too would mark news as sent that the relay then refused.
    const n = createNotifier()
    const perm = (id: string) => snap([], { permissions: [{ id, tool: 'Bash', summary: 'Bash: ls', at: T0 }] })
    n.hint(perm('p0'), ['d1'], () => false, T0)
    for (let i = 1; i <= 40; i++) expect(n.hint(perm(`p${i}`), ['d1'], () => false, T0 + i * 1000)?.kind).toBe('needs-you')
  })

  test('the session posts the hint at once, with the kind and device ids and no words from the session', () => {
    // An idle session posts every 30 s: the hint should not wait for that, and it must carry no text.
    const me = account()
    const [a, b] = [phone(me, 'iPhone'), phone(me, 'iPad')]
    const relay = room([a, b])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    const devices = [a.stored(), b.stored()]
    cycle(link, relay, { devices, now: T0, snapshot: ask('Deploy now?'), isHolding: false, active: [a] })
    expect(cycle(link, relay, { devices, now: T0 + 2000, snapshot: ask('Deploy now?'), isHolding: false, active: [a] }).posts).toHaveLength(0)
    cycle(link, relay, { devices, now: T0 + 4000, snapshot: ask('Rotate the keys?'), isHolding: false, active: [a] })
    const due = T0 + 4000 + QUESTION_GRACE_MS
    cycle(link, relay, { devices, now: due - 2000, snapshot: ask('Rotate the keys?'), isHolding: false, active: [a] })
    const [post] = cycle(link, relay, { devices, now: due, snapshot: ask('Rotate the keys?'), isHolding: false, active: [a] }).posts
    expect(post).toMatchObject({ notify: [b.id], kind: 'needs-you' })
    const { frames, ...plain } = post!
    expect(JSON.stringify(plain)).not.toContain('Rotate')
  })

  test('a hint whose post failed goes with the next post', () => {
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    const devices = [a.stored()]
    cycle(link, relay, { devices, now: T0, snapshot: ask('q0'), active: [] })
    cycle(link, relay, { devices, now: T0 + 2000, snapshot: ask('q1'), active: [] })
    const due = T0 + 2000 + QUESTION_GRACE_MS
    expect(cycle(link, relay, { devices, now: due, snapshot: ask('q1'), active: [], isDown: true }).posts[0]?.notify).toEqual([a.id])
    const [again] = cycle(link, relay, { devices, now: due + 60_000, snapshot: ask('q1'), active: [] }).posts
    expect(again).toMatchObject({ notify: [a.id], kind: 'needs-you' })
  })
})
