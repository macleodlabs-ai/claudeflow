// What e2e/chaos.ts found, as deterministic tests (its fault-proxy runs against the real relay and app): each states
// the robust behaviour, and failed before 1.5.0 (the "Before:" notes say how). The fake socket, Face ID and timers
// are this file's, put in place before each test and taken back after, so the other test files keep their own.
// Same harness as app/test/transport.test.ts: the plugin's real link answers the app's real transport through a fake
// socket, with a software passkey behind navigator.credentials.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { b64u, fromB64u, newIdentity, randomId } from '../../plugins/streams/hooks/remote/seal'
import { createLink, type Device as Stored } from '../../plugins/streams/hooks/remote/link'
import { authenticator } from '../../plugins/streams/tests/authenticator'
import type { Snapshot } from '../src/state'
import type { Pairing } from '../src/links'
import { roomLink, type Device } from '../src/transport'

const ORIGIN = 'https://relay.test'
class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 1
  sent: any[] = []
  onopen?: () => void
  onmessage?: (m: { data: string }) => void
  onclose?: (() => void) | null
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  send(s: string) {
    if (this.readyState !== 1) throw new Error('send on a closed socket')
    this.sent.push(JSON.parse(s))
  }
  close() {
    this.readyState = 3
  }
  /** The line dies under the app (network, edge, relay restart): the browser reports it, with the relay's code. */
  drop(code = 1006) {
    this.readyState = 3
    ;(this.onclose as ((e: { code: number }) => void) | null | undefined)?.({ code })
  }
  deliver(from: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ from, data }) })
  }
}
const passkey = authenticator(ORIGIN)
let hold: Promise<void> | undefined
const buf = (s: string) => fromB64u(s).slice().buffer
const g = globalThis as any
const credentials = {
  async get(o: { publicKey: { challenge: Uint8Array } }) {
    if (hold) await hold
    const a = passkey.assert(b64u(o.publicKey.challenge))
    return { response: { authenticatorData: buf(a.authenticatorData), clientDataJSON: buf(a.clientDataJSON), signature: buf(a.signature) } }
  },
}
const account = newIdentity()
const room = randomId()
const device: Device = { id: randomId(), ...newIdentity() }
const stored: Stored = { id: device.id, pk: device.pk, credentialId: passkey.credentialId, credentialKey: passkey.spki, label: 'phone', pairedAt: 0 }
const PAIRED: Pairing = { room, pk: account.pk, isPaired: true, credentialId: passkey.credentialId }
const snap = (id: string): Snapshot => ({ v: 1, session: { id, account: 'm', project: 'p', busy: false }, at: 0, streams: [], status: [], limits: [], updates: [], permissions: [] })
const lastSocket = () => FakeSocket.all.at(-1)!

/**
 * One session on the real link, reading every frame the device sent on any of its sockets (the relay stores them by
 * device, not by socket) and answering on whichever socket is open now (the relay sends to the device's live socket).
 */
function session(id: string) {
  const link = createLink({ identity: { room, token: randomId(32), sk: account.sk }, session: id, origin: ORIGIN, project: '/p' })
  let seq = 0
  const read = new Map<FakeSocket, number>()
  return {
    tick() {
      const now = Date.now()
      const known = () => ({ devices: [stored], now, snapshot: snap(id), isHolding: true })
      let post = link.next(known())
      while (post) {
        for (const f of post.frames) if (f.to === device.id) lastSocket().readyState === 1 && lastSocket().deliver(id, f.data)
        const frames = FakeSocket.all.flatMap(ws => {
          const from = read.get(ws) ?? 0
          read.set(ws, ws.sent.length)
          return ws.sent.slice(from).filter(m => m.data && (m.to === '*' || m.to === id)).map(m => ({ seq: ++seq, from: device.id, data: m.data }))
        })
        const got = link.answered(JSON.stringify({ frames, devices: [{ id: device.id, isActive: true }] }), now)
        post = got.again ? link.next(known()) : undefined
      }
    },
  }
}
const timers: (() => void)[] = []
/** What this file swaps in for each test, and what it gives back after. */
const was: Record<string, unknown> = {}
const FAKES = (): Record<string, unknown> => ({
  WebSocket: FakeSocket,
  location: { protocol: 'https:', host: 'relay.test', hostname: 'relay.test' },
  document: { visibilityState: 'visible', hasFocus: () => true },
  navigator: { credentials },
  setTimeout: (f: () => void) => (timers.push(f), 0),
  // The link's own heal timer is driven by the tests (link.heal), never by the clock.
  setInterval: () => 0,
})
beforeEach(() => {
  for (const [k, v] of Object.entries(FAKES())) {
    was[k] = g[k]
    g[k] = v
  }
})
afterEach(() => {
  for (const k of Object.keys(was)) g[k] = was[k]
})
/** The app's reconnect timer fires: a new socket opens. */
function reconnectNow() {
  const due = timers.splice(0)
  for (const f of due) f()
  lastSocket().onopen?.()
}
function start() {
  // Each test's sockets only: a session reading an earlier test's hellos would answer those instead.
  FakeSocket.all = []
  timers.length = 0
  const got: Snapshot[] = []
  const link = roomLink(PAIRED, device, { save() {}, snapshot: (_, s) => got.push(s), ack() {}, changed() {} })
  link.start()
  lastSocket().onopen?.()
  return { link, got }
}

describe('control', () => {
  test('with no fault, this harness unlocks (so a failure below is the fault, not the harness)', async () => {
    const { link, got } = start()
    await link.unlock()
    session('s1').tick()
    expect(link.isUnlocked()).toBe(true)
    expect(got.length).toBe(1)
  })
})

describe('a dropped socket during an unlock (chaos: drop-faceid, drop-after-hello, flap, background)', () => {
  test('the line drops while Face ID is up: the unlock still completes on the new line, with no second Face ID', async () => {
    const { link } = start()
    let answer!: () => void
    hold = new Promise(r => (answer = r))
    const unlocking = link.unlock()
    lastSocket().drop()
    reconnectNow()
    answer()
    hold = undefined
    await unlocking
    session('s1').tick()
    // Before: pending keys were dropped with the socket, the gate goes back to idle with no word, nothing was sent.
    expect(link.isUnlocked()).toBe(true)
  })

  test('the hello went out, the line dropped, and the session welcomes on the new line: that unlocks', async () => {
    const { link } = start()
    await link.unlock()
    lastSocket().drop()
    reconnectNow()
    session('s1').tick()
    // Before: the welcome arrives and is ignored (core.reset dropped the hello's keys); the gate says
    // "The connection dropped before your Mac answered", though it had.
    expect(link.isUnlocked()).toBe(true)
    expect(link.why()).toBe('')
  })
})

describe('a dropped socket once in (chaos: drop-snapshot, relay-restart, idle-edge-close)', () => {
  test('a socket that drops and comes back keeps the unlock: no Face ID, and the session snapshots still open', async () => {
    const { link, got } = start()
    await link.unlock()
    const s1 = session('s1')
    s1.tick()
    expect(link.isUnlocked()).toBe(true)
    const before = got.length
    lastSocket().drop()
    reconnectNow()
    s1.tick()
    // Before: every drop locks the app (core.reset in onclose), so a network blip costs a Face ID.
    expect(link.isUnlocked()).toBe(true)
    expect(got.length).toBeGreaterThan(before)
  })
})

describe('a tap between retries (chaos: flap, idle-edge-close)', () => {
  test('Unlock tapped while the line is between retries is kept and runs once the line is back, not dropped', async () => {
    const { link } = start()
    lastSocket().drop()
    await link.unlock()
    reconnectNow()
    await Promise.resolve()
    session('s1').tick()
    // Before: the tap only says "Reconnecting… tap again in a moment." and is forgotten.
    expect(link.isUnlocked()).toBe(true)
  })
})

describe("a phone clock ahead of the Mac's (chaos: skew-ahead)", () => {
  afterEach(() => setSystemTime())
  test('a phone 2.5 min ahead still unlocks: the Mac takes hellos up to 5 min old but only 1 min from the future', async () => {
    const real = Date.now()
    const { link } = start()
    setSystemTime(new Date(real + 150_000))
    await link.unlock()
    setSystemTime(new Date(real))
    session('s1').tick()
    // Before: plugins/streams/hooks/remote/link.ts HELLO_MINUTES = [0, 1, -1, 2, 3, 4, 5] refuses it as
    // 'passkey not verified'; the phone shows "Your Mac hasn't answered yet…" for 35 s, then "could not check that Face ID".
    expect(link.isUnlocked()).toBe(true)
  })
})

describe('the same device open twice (chaos: two-tabs)', () => {
  test('two tabs of one browser (one device id) settle: one keeps its line instead of both replacing each other forever', () => {
    FakeSocket.all = []
    timers.length = 0
    const ev = { save() {}, snapshot() {}, ack() {}, changed() {} }
    const a = roomLink(PAIRED, device, ev)
    const b = roomLink(PAIRED, device, ev)
    /** The relay: a device's new socket closes its older one (room.ts join, code 4000 'replaced'). */
    const open = () => {
      const all = FakeSocket.all.filter(w => w.readyState === 1)
      const newest = all.at(-1)!
      newest.onopen?.()
      for (const w of all.slice(0, -1)) if (w.url === newest.url) w.drop(4000)
    }
    a.start()
    open()
    b.start()
    open()
    // Ten rounds of the apps' reconnect timers.
    let opened = 0
    for (let i = 0; i < 10; i++) {
      const due = timers.splice(0)
      for (const f of due) {
        f()
        opened++
        open()
      }
    }
    // Before: every round each tab's reconnect closes the other's socket, so the sockets keep replacing each other
    // (~1/s in the chaos run, for as long as both are open) and neither can stay unlocked.
    expect(opened).toBeLessThan(3)
  })
})

describe('a welcome for an older hello (chaos: drop-after-hello with a slow session)', () => {
  afterEach(() => setSystemTime())
  test('a late welcome answering the previous connection\'s hello does not count as unlocked on this one', async () => {
    const { link, got } = start()
    await link.unlock()
    const oldHello = lastSocket().sent.at(-1)
    lastSocket().drop()
    reconnectNow()
    // A drop keeps the hello under way (it goes again on the new socket), so a newer one exists only once the old
    // one has gone stale and Unlock is tapped again.
    setSystemTime(new Date(Date.now() + 4 * 60_000))
    link.heal()
    await link.unlock()
    // A slow session reads only the first hello (the second waits for its next post) and welcomes it: the relay
    // delivers that welcome to the device's socket, which is the new one.
    const s1 = createLink({ identity: { room, token: randomId(32), sk: account.sk }, session: 's1', origin: ORIGIN, project: '/p' })
    const known = { devices: [stored], now: Date.now(), snapshot: snap('s1'), isHolding: true }
    const first = s1.next(known)!
    s1.answered(JSON.stringify({ frames: [{ seq: 1, from: device.id, data: oldHello.data }], devices: [] }), Date.now())
    const post = s1.next(known)
    for (const f of [...first.frames, ...(post?.frames ?? [])]) if (f.to === device.id) lastSocket().deliver('s1', f.data)
    // Before: device.ts receive() takes any welcome while a hello is out and makes a channel from the wrong keys, so
    // the app reads as unlocked while nothing from that session will ever open (the snapshot box is dropped).
    expect(link.isUnlocked() && got.length === 0).toBe(false)
  })
})

describe('switching apps quickly (chaos: app-switch)', () => {
  test('focus, blur and visibility changes send at most one looking ping per 10 s, so the relay never closes the line for it', async () => {
    // Every wake asked for a ping, undeduped: switching apps fast sent dozens a minute, over the relay's limit, which
    // closed the socket (1008) and, before 1.5.0, locked the app.
    const { link } = start()
    await link.unlock()
    session('s1').tick()
    const before = lastSocket().sent.length
    for (let i = 0; i < 40; i++) link.wake()
    expect(lastSocket().sent.slice(before).filter(m => 'here' in m).length).toBeLessThanOrEqual(1)
  })
})
