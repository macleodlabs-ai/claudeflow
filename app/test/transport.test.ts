// The device side of the handshake against a session built from the same seal.ts, with the browser's WebSocket and
// passkeys faked: what the device sends must be exactly what a session checks, and nothing unsealed gets through.
import { beforeEach, describe, expect, test } from 'bun:test'
import { channel, connectionKeys, fromB64u, newIdentity, pairingProof, passkeyChallenge, randomId } from '../../plugins/streams/hooks/remote/seal'
import type { Snapshot } from '../src/state'
import type { Pairing } from '../src/links'
import { roomLink, type Device } from '../src/transport'

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

const challenges: string[] = []
const bytes = (s: string) => new TextEncoder().encode(s).buffer
const g = globalThis as any
g.WebSocket = FakeSocket
g.location = { protocol: 'https:', host: 'relay.test', hostname: 'relay.test' }
g.document = { visibilityState: 'visible' }
g.navigator = {
  credentials: {
    async create(o: { publicKey: { challenge: Uint8Array } }) {
      challenges.push(Buffer.from(o.publicKey.challenge).toString('base64url'))
      return { rawId: new Uint8Array([1, 2, 3]).buffer, response: { getPublicKey: () => new Uint8Array([9, 9]).buffer, clientDataJSON: bytes('{"type":"webauthn.create"}') } }
    },
    async get(o: { publicKey: { challenge: Uint8Array } }) {
      challenges.push(Buffer.from(o.publicKey.challenge).toString('base64url'))
      return { response: { authenticatorData: bytes('ad'), clientDataJSON: bytes('cd'), signature: bytes('sig') } }
    },
  },
}

const account = newIdentity()
const room = randomId()
const device: Device = { id: randomId(), ...newIdentity() }

function start(p: Pairing) {
  const got: Snapshot[] = []
  const saved: Pairing[] = []
  const link = roomLink(p, device, { save: x => saved.push(x), snapshot: (_, s) => got.push(s), changed() {} })
  link.start()
  const ws = FakeSocket.last
  ws.onopen?.()
  return { link, ws, got, saved }
}

/** What a session does with a hello: welcome it and keep the session's end of the channel. */
function welcome(ws: FakeSocket, session: string, sk = account.sk) {
  const hello = ws.sent.findLast((m: any) => m.data?.t === 'hello').data
  const eph = newIdentity()
  const nonce = randomId(32)
  const k = connectionKeys({ ownSk: sk, peerPk: hello.pk, ownEphSk: eph.sk, peerEphPk: hello.eph, sessionNonce: nonce, deviceNonce: hello.nonce })
  ws.deliver(session, { t: 'welcome', session, eph: eph.pk, nonce })
  return channel(k.sessionToDevice, k.deviceToSession)
}

const snap = (id: string): Snapshot => ({
  v: 1, session: { id, account: 'macleod', project: 'p', busy: false }, at: 0, streams: [], status: [], limits: [], updates: [], permissions: [],
})

beforeEach(() => (challenges.length = 0))

describe('unlocking a paired room', () => {
  test('the hello carries one passkey assertion over this room, this connection key and this minute', async () => {
    const { link, ws } = start({ room, pk: account.pk, isPaired: true, credentialId: 'AQID' })
    expect(ws.url).toBe(`wss://relay.test/v1/room/${room}/device?id=${device.id}`)
    await link.unlock()
    const hello = ws.sent.at(-1)
    expect(hello.to).toBe('*')
    expect(hello.data).toMatchObject({ t: 'hello', device: device.id, pk: device.pk })
    expect(hello.data.proof).toBeUndefined()
    const minute = Math.floor(Date.now() / 60_000)
    expect(challenges).toEqual([passkeyChallenge('hello', room, hello.data.eph, minute)])
    expect(hello.data.passkey).toEqual({ authenticatorData: 'YWQ', clientDataJSON: 'Y2Q', signature: 'c2ln' })
  })

  test('snapshots open only from the session that sealed them, once', async () => {
    const { link, ws, got } = start({ room, pk: account.pk, isPaired: true, credentialId: 'AQID' })
    await link.unlock()
    const s1 = welcome(ws, 's1')
    expect(link.isUnlocked()).toBe(true)
    const box = s1.seal({ t: 'snapshot', snapshot: snap('s1') })
    ws.deliver('s1', { t: 'box', b: box })
    // The relay replays it, and passes s1's next box off as another session's.
    ws.deliver('s1', { t: 'box', b: box })
    ws.deliver('s2', { t: 'box', b: s1.seal({ t: 'snapshot', snapshot: snap('s1') }) })
    // A session speaks only for itself, even with a valid box.
    ws.deliver('s1', { t: 'box', b: s1.seal({ t: 'snapshot', snapshot: snap('other') }) })
    expect(got.map(s => s.session.id)).toEqual(['s1'])
  })

  test('a welcome from someone without the account key opens nothing (a relay swapping keys)', async () => {
    const { link, ws, got } = start({ room, pk: account.pk, isPaired: true, credentialId: 'AQID' })
    await link.unlock()
    const fake = welcome(ws, 's1', newIdentity().sk)
    ws.deliver('s1', { t: 'box', b: fake.seal({ t: 'snapshot', snapshot: snap('s1') }) })
    expect(got).toEqual([])
  })

  test('an Allow asks Face ID over that request and this connection, and goes sealed', async () => {
    const { link, ws } = start({ room, pk: account.pk, isPaired: true, credentialId: 'AQID' })
    await link.unlock()
    const eph = ws.sent.at(-1).data.eph
    const s1 = welcome(ws, 's1')
    challenges.length = 0
    expect(await link.send('s1', { id: 'c1', kind: 'permission', requestId: 'req1', decision: 'allow' })).toBe(true)
    expect(challenges).toEqual([passkeyChallenge('allow', 'req1', eph)])
    const out = ws.sent.at(-1)
    expect(out.to).toBe('s1')
    expect(JSON.stringify(out)).not.toContain('req1')
    const opened = s1.open(out.data.b) as any
    expect(opened).toMatchObject({ t: 'command', command: { kind: 'permission', requestId: 'req1', decision: 'allow' } })
    expect(opened.command.passkey.signature).toBe('c2ln')
  })

  test('a Deny or an answer needs no Face ID', async () => {
    const { link, ws } = start({ room, pk: account.pk, isPaired: true, credentialId: 'AQID' })
    await link.unlock()
    welcome(ws, 's1')
    challenges.length = 0
    expect(await link.send('s1', { id: 'c2', kind: 'permission', requestId: 'r', decision: 'deny' })).toBe(true)
    expect(await link.send('s1', { id: 'c3', kind: 'answer', streamId: 'st', text: 'yes' })).toBe(true)
    expect(challenges).toEqual([])
  })

  test('nothing is sent to a session that has not welcomed this connection', async () => {
    const { link, ws } = start({ room, pk: account.pk, isPaired: true, credentialId: 'AQID' })
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
    expect(hello.proof).toBe(pairingProof(secret, device.id, device.pk, 'AQID', 'CQk'))
    expect(hello.registration).toEqual({ credentialId: 'AQID', publicKey: 'CQk', clientDataJSON: Buffer.from('{"type":"webauthn.create"}').toString('base64url') })
    expect(hello.passkey).toBeUndefined()
    expect(fromB64u(hello.eph).length).toBe(32)
    welcome(ws, 's1')
    expect(saved.at(-1)).toMatchObject({ isPaired: true, credentialId: 'AQID', secret: undefined, spent: secret })
  })

  test('a refused pairing drops the secret, so the app says Not paired', async () => {
    const { link, ws, saved } = start({ room, pk: account.pk, secret, isPaired: false })
    await link.pair()
    ws.deliver('s1', { t: 'denied', why: 'pairing code expired' })
    expect(saved.at(-1)).toMatchObject({ isPaired: false, secret: undefined, spent: secret })
    expect(link.why()).toBe('pairing code expired')
  })
})
