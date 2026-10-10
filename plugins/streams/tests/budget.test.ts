import { describe, expect, test } from 'claude-code/testing'

import { randomId } from '../hooks/remote/seal'
import { ACTIVE_POLL_MS, MAX_ROUNDS, WARM_MS, createLink, type OutFrame, type Pairing, type UpBody } from '../hooks/remote/link'
import { HEARTBEAT_MS, type Snapshot } from '../hooks/remote/snapshot'
import { TICK_MS } from '../hooks/remote/index'
import { ORIGIN, SESSION, T0, account, cycle, phone, room, snapshot, tOf, type Phone } from './room'

// The free plan allows 100k requests a day across the Worker and the Room, and every session of the account polls on
// its own. These tests hold the link's post cycle (`next`, `answered`) to the budget in ARCHITECTURE.md.

describe('the polling budget', () => {
  test('only a paired device, or any while a pairing is open, makes the session poll faster', () => {
    // Anyone with the room id (a forgotten phone, an old QR code) can keep a socket open and ping. Counting it would
    // keep every session of the account polling fast all day and spend the free plan's requests.
    const me = account()
    const a = phone(me, 'iPhone')
    const stranger = phone(me, 'stranger')
    const relay = room([a, stranger])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    const pairing: Pairing = { secret: randomId(32), until: T0 + 2 * HEARTBEAT_MS }
    let now = T0
    const posts = (step: number, active: Phone[], p?: Pairing) => {
      now += step
      return cycle(link, relay, { devices: [a.stored()], pairing: p, now, snapshot: snapshot(T0), isHolding: false, active }).posts.length
    }
    expect(posts(0, [stranger])).toBe(1)
    expect(posts(ACTIVE_POLL_MS, [stranger])).toBe(0)
    expect(posts(HEARTBEAT_MS - ACTIVE_POLL_MS, [a])).toBe(1)
    expect(posts(ACTIVE_POLL_MS, [stranger], pairing)).toBe(1)
    expect(posts(ACTIVE_POLL_MS, [stranger], pairing)).toBe(1)
    // The pairing closes: the stranger stops counting at the next answer.
    now = pairing.until
    expect(posts(0, [stranger], pairing)).toBe(1)
    expect(posts(ACTIVE_POLL_MS, [stranger], pairing)).toBe(0)
  })

  test('snapshots are not re-sealed when unchanged, only on change or as a heartbeat', () => {
    // The clock alone changing is not news.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    relay.from(a, a.hello({ now: T0 }))
    const boxes = (now: number, s: Snapshot) => cycle(link, relay, { devices: [a.stored()], now, snapshot: s }).frames.filter(f => tOf(f) === 'box').length
    const busy = { session: { id: SESSION, account: 'macleod', project: 'p', busy: true } }
    expect(boxes(T0, snapshot(T0))).toBe(1)
    expect(boxes(T0 + 2000, snapshot(T0 + 2000))).toBe(0)
    expect(boxes(T0 + 4000, snapshot(T0 + 4000, busy))).toBe(1)
    expect(boxes(T0 + 4000 + HEARTBEAT_MS, snapshot(T0 + 6000, busy))).toBe(1)
  })

  test('a device put away or out of focus gets at most one change per heartbeat and no repeats; picked up, the latest at once', () => {
    // A working session changes its snapshot every tick. Sent to a phone in a pocket or a tab behind other windows,
    // every one of them is mobile data and battery spent on a screen nobody reads.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    relay.from(a, a.hello({ now: T0 }))
    const working = (n: number) => snapshot(T0, { status: [{ id: 'x', area: 'x', state: 'x', detail: `step ${n}` }] })
    const boxes = (now: number, s: Snapshot, active: Phone[]) =>
      cycle(link, relay, { devices: [a.stored()], now, snapshot: s, active }).frames.filter(f => tOf(f) === 'box').length
    // The session learns what a device is doing from the relay's answer to its post, so each switch below takes one
    // post to land (in a session that is working, the next tick).
    expect(boxes(T0, working(0), [a])).toBe(1)
    expect(boxes(T0 + 1000, working(0), [])).toBe(0)
    // Put away: ten changes in the next 20 s send nothing.
    let sent = 0
    for (let i = 1; i <= 10; i++) sent += boxes(T0 + i * 2000, working(i), [])
    expect(sent).toBe(0)
    // A heartbeat after the last one sent, the latest goes, once; unchanged, it is never sent again while put away.
    expect(boxes(T0 + HEARTBEAT_MS, working(11), [])).toBe(1)
    expect(boxes(T0 + HEARTBEAT_MS + 2000, working(12), [])).toBe(0)
    expect(boxes(T0 + 2 * HEARTBEAT_MS + 2000, working(12), [])).toBe(1)
    expect(boxes(T0 + 4 * HEARTBEAT_MS, working(12), [])).toBe(0)
    // Picked up: the latest at once, then every change.
    expect(boxes(T0 + 4 * HEARTBEAT_MS + 2000, working(12), [a])).toBe(0)
    expect(boxes(T0 + 4 * HEARTBEAT_MS + 4000, working(12), [a])).toBe(1)
    expect(boxes(T0 + 4 * HEARTBEAT_MS + 6000, working(13), [a])).toBe(1)
    expect(boxes(T0 + 4 * HEARTBEAT_MS + 8000, working(14), [a])).toBe(1)
  })

  test('a session posts every tick only while a permission waits on a device, every 6 s while one looks, otherwise on news or every 30 s', () => {
    // 2 s for every session while a device looks would spend the 100k a day in a few hours. Fast polling is kept
    // for an Allow waiting on Face ID.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    let now = T0
    const posts = (step: number, o: { active?: Phone[]; isHolding?: boolean; snapshot?: Snapshot } = {}) => {
      now += step
      return cycle(link, relay, { devices: [a.stored()], now, snapshot: o.snapshot ?? snapshot(T0), isHolding: o.isHolding ?? false, active: o.active ?? [] }).posts.length
    }
    expect(posts(0)).toBe(1)
    expect(posts(10_000)).toBe(0)
    expect(posts(HEARTBEAT_MS - 10_000)).toBe(1)
    expect(posts(TICK_MS, { snapshot: snapshot(T0, { updates: [{ id: 'x', from: '1', to: '2' }] }) })).toBe(1)
    expect(posts(HEARTBEAT_MS, { active: [a], snapshot: snapshot(T0, { updates: [{ id: 'x', from: '1', to: '2' }] }) })).toBe(1)
    const looking = { active: [a], snapshot: snapshot(T0, { updates: [{ id: 'x', from: '1', to: '2' }] }) }
    expect(posts(TICK_MS, looking)).toBe(0)
    expect(posts(ACTIVE_POLL_MS - TICK_MS, looking)).toBe(1)
    expect(posts(TICK_MS, { ...looking, isHolding: true })).toBe(1)
    expect(posts(TICK_MS, { ...looking, isHolding: true })).toBe(1)
  })

  test('for a minute after welcoming a device the session polls every 6 s, then falls back to 30 s', () => {
    // A device counts as looking only once its ping reaches a later answer. Without this window the first Yes after
    // an unlock waited for the 30 s heartbeat, which felt broken on the phone.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    relay.from(a, a.hello({ now: T0 }))
    let now = T0
    const posts = (step: number) => {
      now += step
      return cycle(link, relay, { devices: [a.stored()], now, snapshot: snapshot(T0), isHolding: false, active: [] }).posts.length
    }
    expect(posts(0)).toBeGreaterThan(0)
    // Inside the window: a post every 6 s.
    while (now + ACTIVE_POLL_MS < T0 + WARM_MS) expect(posts(ACTIVE_POLL_MS)).toBe(1)
    // After it: quiet until the 30 s heartbeat.
    expect(posts(ACTIVE_POLL_MS)).toBe(0)
    expect(posts(HEARTBEAT_MS - 2 * ACTIVE_POLL_MS)).toBe(0)
    expect(posts(ACTIVE_POLL_MS)).toBe(1)
  })

  test('an account with nothing paired and no pairing open never posts', () => {
    // Every session of every account runs this; one that no device could answer must spend nothing.
    const link = createLink({ identity: account(), session: SESSION, origin: ORIGIN })
    const known = { devices: [], now: T0, snapshot: snapshot(T0), isHolding: true }
    expect(link.isQuiet(known)).toBe(true)
    expect(link.next(known)).toBeUndefined()
    expect(link.next({ ...known, pairing: { secret: randomId(32), until: T0 } })).toBeUndefined()
  })

  test('a relay that is down is retried 4 s later, then less and less often, never more than five minutes apart', () => {
    // Not even a held permission makes it hammer a relay that fails.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    let now = T0
    const tries = (at: number) => cycle(link, relay, { devices: [a.stored()], now: at, isDown: true }).posts.length
    expect(tries(now)).toBe(1)
    for (const gap of [4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]) {
      expect(tries(now + gap - TICK_MS)).toBe(0)
      now += gap
      expect(tries(now)).toBe(1)
    }
    // Back up: the next post goes through, and the one after it waits for nothing but its cadence.
    expect(cycle(link, relay, { devices: [a.stored()], now: now + 300_000 }).posts).toHaveLength(1)
    expect(cycle(link, relay, { devices: [a.stored()], now: now + 300_000 + TICK_MS }).posts).toHaveLength(1)
  })

  test('a failed post keeps its welcomes for the retry and seals the snapshot afresh', () => {
    // A welcome lost with a failed post would leave the phone waiting on a channel the session already opened.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    const known = (now: number) => ({ devices: [a.stored()], now, snapshot: snapshot(T0), isHolding: false })
    relay.from(a, a.hello({ now: T0 }))
    expect(link.next(known(T0))?.frames).toEqual([])
    expect(link.answered(JSON.stringify(relay.answer()), T0).again).toBe(true)
    const lost = link.next(known(T0)) as UpBody
    expect(lost.frames.map(tOf)).toEqual(['welcome', 'box'])
    expect(link.answered(undefined, T0)).toEqual({ paired: [], commands: [], again: false })
    expect(link.next(known(T0 + TICK_MS))).toBeUndefined()
    const retry = link.next(known(T0 + 4000)) as UpBody
    expect(retry.frames.map(tOf)).toEqual(['welcome', 'box'])
    // The same welcome (the session keeps the channel it opened), and a new box on the channel's next counter.
    expect(retry.frames[0]).toEqual(lost.frames[0] as OutFrame)
    expect(retry.frames[1]).not.toEqual(lost.frames[1] as OutFrame)
    const read = relay.deliver(retry.frames).get(a.id) as { t: string }[]
    expect(read.map(m => m.t)).toEqual(['welcome', 'snapshot'])
  })

  test('a tick posts at most twice, however many hellos the relay keeps sending', () => {
    // A relay replaying a hello in every answer must not turn one tick into a request loop.
    const me = account()
    const a = phone(me, 'iPhone')
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    const hello = a.hello({ now: T0 })
    let seq = 0
    const flood = () => JSON.stringify({ frames: [{ seq: ++seq, from: a.id, data: hello }], devices: [{ id: a.id, isActive: true }] })
    const known = (now: number) => ({ devices: [a.stored()], now, snapshot: snapshot(T0), isHolding: false })
    let posts = 0
    let post = link.next(known(T0))
    while (post && posts < 10) {
      posts++
      post = link.answered(flood(), T0).again ? link.next(known(T0)) : undefined
    }
    expect(posts).toBe(MAX_ROUNDS)
    // The welcome still owed goes with the next tick.
    expect(link.next(known(T0 + TICK_MS))?.frames.map(tOf)).toContain('welcome')
  })
})
