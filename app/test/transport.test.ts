// The app's transport against a real session: the plugin's own link (remote/link.ts) answers what the device core
// (remote/device.ts) sends, through a fake socket, with a software passkey behind navigator.credentials. What the
// device sends must be exactly what a session checks, and nothing unsealed gets through.
import { beforeEach, describe, expect, test } from 'bun:test'
import { b64u, fromB64u, newIdentity, pairingProof, passkeyChallenge, randomId } from '../../plugins/streams/hooks/remote/seal'
import { PAIRING_MS, createLink, type Answered, type Device as Stored, type OutFrame, type Pairing as Open } from '../../plugins/streams/hooks/remote/link'
import { authenticator } from '../../plugins/streams/tests/authenticator'
import type { Snapshot } from '../src/state'
import type { Pairing } from '../src/links'
import { roomLink, type Device } from '../src/transport'

const ORIGIN = 'https://relay.test'

class FakeSocket {
  static OPEN = 1
  static last: FakeSocket
  readyState = 1
  sent: any[] = []
  onopen?: () => void
  onmessage?: (m: { data: string }) => void
  onclose?: () => void
  constructor(public url: string) {
    FakeSocket.last = this
  }
  send(s: string) {
    this.sent.push(JSON.parse(s))
  }
  deliver(from: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ from, data }) })
  }
}

const passkey = authenticator(ORIGIN)
const challenges: string[] = []
const buf = (s: string) => fromB64u(s).slice().buffer
const g = globalThis as any
g.WebSocket = FakeSocket
g.location = { protocol: 'https:', host: 'relay.test', hostname: 'relay.test' }
g.document = { visibilityState: 'visible' }
g.navigator = {
  credentials: {
    async create(o: { publicKey: { challenge: Uint8Array } }) {
      const challenge = b64u(o.publicKey.challenge)
      challenges.push(challenge)
      const reg = passkey.register(challenge)
      return { rawId: buf(reg.credentialId), response: { getPublicKey: () => buf(reg.publicKey), clientDataJSON: buf(reg.clientDataJSON) } }
    },
    async get(o: { publicKey: { challenge: Uint8Array } }) {
      const challenge = b64u(o.publicKey.challenge)
      challenges.push(challenge)
      const a = passkey.assert(challenge)
      return { response: { authenticatorData: buf(a.authenticatorData), clientDataJSON: buf(a.clientDataJSON), signature: buf(a.signature) } }
    },
  },
}

const account = newIdentity()
const room = randomId()
const device: Device = { id: randomId(), ...newIdentity() }
/** This device as a session's $.store keeps it once paired. */
const stored: Stored = { id: device.id, pk: device.pk, credentialId: passkey.credentialId, credentialKey: passkey.spki, label: 'phone', pairedAt: 0 }
const PAIRED: Pairing = { room, pk: account.pk, isPaired: true, credentialId: passkey.credentialId }

function start(p: Pairing) {
  const got: Snapshot[] = []
  const saved: Pairing[] = []
  const link = roomLink(p, device, { save: x => saved.push(x), snapshot: (_, s) => got.push(s), changed() {} })
  link.start()
  const ws = FakeSocket.last
  ws.onopen?.()
  return { link, ws, got, saved }
}

const snap = (id: string, busy = false): Snapshot => ({
  v: 1, session: { id, account: 'macleod', project: 'p', busy }, at: 0, streams: [], status: [], limits: [], updates: [], permissions: [],
})

/**
 * A session on the real link, and the relay between it and the device's socket. `tick` runs one post cycle: what the
 * device sent since the last tick is the relay's answer, and what the session posts reaches the socket (`relay`
 * may redirect it, as a relay could).
 */
function session(ws: FakeSocket, id: string, o: { sk?: string; devices?: Stored[]; pairing?: Open } = {}) {
  const link = createLink({ identity: { room, token: randomId(32), sk: o.sk ?? account.sk }, session: id, origin: ORIGIN })
  let read = 0
  let seq = 0
  let devices = o.devices ?? []
  const s = { paired: [] as Stored[], commands: [] as Answered['commands'], posted: [] as OutFrame[] }
  const tick = (t: { snapshot?: Snapshot; relay?: (from: string, data: unknown) => void } = {}) => {
    const now = Date.now()
    const known = () => ({ devices, pairing: o.pairing, now, snapshot: t.snapshot ?? snap(id), isHolding: true })
    let post = link.next(known())
    while (post) {
      s.posted.push(...post.frames)
      for (const f of post.frames) if (f.to === device.id) (t.relay ?? ((from, data) => ws.deliver(from, data)))(id, f.data)
      const frames = ws.sent.slice(read).filter(m => m.data && (m.to === '*' || m.to === id)).map(m => ({ seq: ++seq, from: device.id, data: m.data }))
      read = ws.sent.length
      const got = link.answered(JSON.stringify({ frames, devices: [{ id: device.id, isActive: true }] }), now)
      s.paired.push(...got.paired)
      s.commands.push(...got.commands)
      devices = [...devices.filter(d => !got.paired.some(p => p.id === d.id)), ...got.paired]
      post = got.again ? link.next(known()) : undefined
    }
  }
  return { ...s, tick, boxes: () => s.posted.filter(f => (f.data as { t: string }).t === 'box').map(f => f.data) }
}

beforeEach(() => (challenges.length = 0))

describe('unlocking a paired room', () => {
  test('the hello carries one passkey assertion over this room, this connection key and this minute, and a session lets it in', async () => {
    const { link, ws, got } = start(PAIRED)
    expect(ws.url).toBe(`wss://relay.test/v1/room/${room}/device?id=${device.id}`)
    await link.unlock()
    const hello = ws.sent.at(-1)
    expect(hello.to).toBe('*')
    expect(hello.data).toMatchObject({ t: 'hello', device: device.id, pk: device.pk })
    expect(hello.data.proof).toBeUndefined()
    const minute = Math.floor(Date.now() / 60_000)
    expect(challenges).toEqual([passkeyChallenge('hello', room, hello.data.eph, minute)])
    session(ws, 's1', { devices: [stored] }).tick()
    expect(link.isUnlocked()).toBe(true)
    expect(got.map(s => s.session.id)).toEqual(['s1'])
  })

  test('snapshots open only from the session that sealed them, once', async () => {
    const { link, ws, got } = start(PAIRED)
    await link.unlock()
    const s1 = session(ws, 's1', { devices: [stored] })
    s1.tick()
    // The relay replays it, and passes s1's next box off as another session's.
    ws.deliver('s1', s1.boxes().at(-1))
    s1.tick({ snapshot: snap('s1', true), relay: (_, data) => ws.deliver('s2', data) })
    // A session speaks only for itself, even with a valid box.
    s1.tick({ snapshot: snap('other') })
    expect(s1.boxes()).toHaveLength(3)
    expect(got.map(s => s.session.id)).toEqual(['s1'])
  })

  test('a welcome from someone without the account key opens nothing (a relay swapping keys)', async () => {
    const { link, ws, got } = start(PAIRED)
    await link.unlock()
    const fake = session(ws, 's1', { devices: [stored], sk: newIdentity().sk })
    fake.tick()
    expect(fake.boxes()).toHaveLength(1)
    expect(got).toEqual([])
  })

  test('an Allow asks Face ID over that request and this connection, goes sealed, and the session takes it', async () => {
    const { link, ws } = start(PAIRED)
    await link.unlock()
    const eph = ws.sent.at(-1).data.eph
    const s1 = session(ws, 's1', { devices: [stored] })
    s1.tick()
    challenges.length = 0
    expect(await link.send('s1', { id: 'c1', kind: 'permission', requestId: 'req1', decision: 'allow' })).toBe(true)
    expect(challenges).toEqual([passkeyChallenge('allow', 'req1', eph)])
    const out = ws.sent.at(-1)
    expect(out.to).toBe('s1')
    expect(JSON.stringify(out)).not.toContain('req1')
    s1.tick()
    expect(s1.commands.map(c => [c.device, c.command])).toEqual([[device.id, expect.objectContaining({ kind: 'permission', requestId: 'req1', decision: 'allow' })]])
  })

  test('a Deny or an answer needs no Face ID', async () => {
    const { link, ws } = start(PAIRED)
    await link.unlock()
    const s1 = session(ws, 's1', { devices: [stored] })
    s1.tick()
    challenges.length = 0
    expect(await link.send('s1', { id: 'c2', kind: 'permission', requestId: 'r', decision: 'deny' })).toBe(true)
    expect(await link.send('s1', { id: 'c3', kind: 'answer', streamId: 'st', text: 'yes' })).toBe(true)
    expect(challenges).toEqual([])
    s1.tick()
    expect(s1.commands.map(c => c.command.id)).toEqual(['c2', 'c3'])
  })

  test('nothing is sent to a session that has not welcomed this connection', async () => {
    const { link, ws } = start(PAIRED)
    await link.unlock()
    const before = ws.sent.length
    expect(await link.send('s9', { id: 'c', kind: 'stop' })).toBe(false)
    expect(ws.sent.length).toBe(before)
  })
})

describe('pairing', () => {
  const secret = randomId(32)

  test('the first hello proves the QR secret, registers the passkey, and the welcome spends the secret', async () => {
    // The proof and the passkey's challenge cover what the session stores, so the relay cannot swap any of it.
    const { link, ws, saved } = start({ room, pk: account.pk, secret, isPaired: false })
    await link.pair()
    const hello = ws.sent.at(-1).data
    expect(challenges).toEqual([passkeyChallenge('pair', room, device.id, device.pk)])
    expect(hello.proof).toBe(pairingProof(secret, device.id, device.pk, passkey.credentialId, passkey.spki))
    expect(hello.registration).toMatchObject({ credentialId: passkey.credentialId, publicKey: passkey.spki })
    expect(hello.passkey).toBeUndefined()
    expect(fromB64u(hello.eph).length).toBe(32)
    const s1 = session(ws, 's1', { pairing: { secret, until: Date.now() + PAIRING_MS } })
    s1.tick()
    expect(s1.paired).toEqual([expect.objectContaining({ id: device.id, pk: device.pk, credentialId: passkey.credentialId, credentialKey: passkey.spki })])
    expect(saved.at(-1)).toMatchObject({ isPaired: true, credentialId: passkey.credentialId, secret: undefined, spent: secret })
  })

  test('a refused pairing drops the secret, so the app says Not paired', async () => {
    const { link, ws, saved } = start({ room, pk: account.pk, secret, isPaired: false })
    await link.pair()
    // The pairing closed before the hello was read; another device keeps the session polling.
    session(ws, 's1', { devices: [{ ...stored, id: randomId() }], pairing: { secret, until: Date.now() - 1 } }).tick()
    expect(saved.at(-1)).toMatchObject({ isPaired: false, secret: undefined, spent: secret })
    expect(link.why()).toBe('pairing expired')
  })
})
