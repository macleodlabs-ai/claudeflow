// One room's link: a WebSocket to /v1/room/{room}/device, the hello / welcome handshake, and a sealed channel per
// session. The relay sees only ids, sizes and timing; everything a session and this device say is sealed with keys
// derived from both static keys and fresh ephemeral ones (seal.ts's connectionKeys).
import { channel, connectionKeys, newIdentity, pairingProof, passkeyChallenge, randomId } from '../../plugins/streams/hooks/remote/seal'
import type { PhoneCommand, Snapshot } from '../../plugins/streams/hooks/remote/snapshot'
import { paired, refused, type Pairing } from './links'
import { assertPasskey, createPasskey, type Assertion } from './passkey'

/** This device: one id and X25519 key pair for every room; each room has its own passkey. */
export type Device = { id: string; sk: string; pk: string }

/** A command as sent; an Allow also carries its passkey assertion. */
export type Command = PhoneCommand & { passkey?: Assertion }

export type RoomEvents = {
  /** The pairing changed (paired, refused, passkey made) and should be kept. */
  save(p: Pairing): void
  snapshot(room: string, snapshot: Snapshot): void
  /** The link's state changed: connected, unlocked, refused. */
  changed(): void
}

/** Visible pings: sessions poll fast and hold permissions only while a device is looking. */
export const PING_MS = 15_000
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

type Ch = ReturnType<typeof channel>
type Hello = { eph: { sk: string; pk: string }; nonce: string; isPairing: boolean }

export type RoomLink = ReturnType<typeof roomLink>

export function roomLink(pairing: Pairing, device: Device, ev: RoomEvents) {
  let p = pairing
  let ws: WebSocket | undefined
  let hello: Hello | undefined
  const channels = new Map<string, Ch>()
  let retries = 0
  let why = ''
  let isBusy = false

  const set = (next: Pairing) => {
    p = next
    ev.save(p)
  }
  const post = (to: string, data: unknown): boolean => {
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify({ to, data }))
    return true
  }
  const ping = () => {
    if (document.visibilityState === 'visible' && channels.size && ws?.readyState === WebSocket.OPEN) ws.send('{"here":true}')
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const sock = new WebSocket(`${proto}://${location.host}/v1/room/${p.room}/device?id=${device.id}`)
    ws = sock
    sock.onopen = () => {
      retries = 0
      ev.changed()
    }
    sock.onmessage = m => {
      try {
        const msg = JSON.parse(String(m.data)) as { from?: unknown; data?: unknown }
        if (typeof msg.from === 'string' && msg.data && typeof msg.data === 'object') receive(msg.from, msg.data as Record<string, unknown>)
      } catch {
        // Not JSON: the relay only forwards, so there is nothing to answer.
      }
    }
    sock.onclose = () => {
      if (ws !== sock) return
      // A new connection needs a new hello, and so a new Face ID: nothing from the old one carries over.
      ws = undefined
      hello = undefined
      channels.clear()
      ev.changed()
      setTimeout(connect, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)])
    }
  }

  function receive(from: string, d: Record<string, unknown>) {
    if (d.t === 'welcome' && hello && typeof d.eph === 'string' && typeof d.nonce === 'string') {
      const keys = connectionKeys({ ownSk: device.sk, peerPk: p.pk, ownEphSk: hello.eph.sk, peerEphPk: d.eph, sessionNonce: d.nonce, deviceNonce: hello.nonce })
      channels.set(from, channel(keys.deviceToSession, keys.sessionToDevice))
      why = ''
      if (!p.isPaired) set(paired(p))
      ping()
      ev.changed()
      return
    }
    if (d.t === 'denied' && hello) {
      why = typeof d.why === 'string' ? d.why.slice(0, 200) : 'refused'
      // A refused pairing secret has expired or was turned down: it cannot be tried again.
      if (hello.isPairing && !channels.size) set(refused(p))
      ev.changed()
      return
    }
    if (d.t === 'box' && typeof d.b === 'string') {
      const ch = channels.get(from)
      if (!ch) return
      try {
        const x = ch.open(d.b) as { t?: string; snapshot?: Snapshot }
        // A session speaks only for itself: a snapshot naming another session is dropped.
        if (x?.t === 'snapshot' && x.snapshot?.v === 1 && x.snapshot.session?.id === from) ev.snapshot(p.room, x.snapshot)
      } catch {
        // Tampered, replayed or reordered: dropped, the next snapshot comes within 30 s.
      }
    }
  }

  function sendHello(extra: Record<string, unknown>, isPairing: boolean, eph: Hello['eph']) {
    hello = { eph, nonce: randomId(32), isPairing }
    channels.clear()
    post('*', { t: 'hello', device: device.id, pk: device.pk, eph: eph.pk, nonce: hello.nonce, ...extra })
  }

  /** Runs one passkey step at a time: a second tap while Face ID is up does nothing. */
  async function busy(step: () => Promise<void>) {
    if (isBusy) return
    isBusy = true
    ev.changed()
    try {
      await step()
    } finally {
      isBusy = false
      ev.changed()
    }
  }

  return {
    room: () => p.room,
    pairing: () => p,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    isUnlocked: () => channels.size > 0,
    isBusy: () => isBusy,
    why: () => why,
    start: connect,
    ping,
    /** Back on screen: reconnect now rather than wait out the backoff. */
    wake() {
      if (!ws) {
        retries = 0
        connect()
      }
      ping()
    },
    /** First pairing: a new passkey, and proof this device saw the QR code's secret. */
    pair: () =>
      busy(async () => {
        if (!p.secret || !ws) return
        const reg = await createPasskey(p.room.slice(0, 6), passkeyChallenge('pair', p.room, device.id, device.pk))
        if (!reg) {
          why = 'The passkey was not created.'
          return
        }
        set({ ...p, credentialId: reg.credentialId })
        sendHello({ proof: pairingProof(p.secret, device.id, device.pk, reg.credentialId, reg.publicKey), registration: reg }, true, newIdentity())
      }),
    /** One Face ID per connection: every session in the room checks the same assertion. */
    unlock: () =>
      busy(async () => {
        if (!p.credentialId || !ws) return
        const eph = newIdentity()
        const minute = Math.floor(Date.now() / 60_000)
        const passkey = await assertPasskey(p.credentialId, passkeyChallenge('hello', p.room, eph.pk, minute))
        if (!passkey) {
          why = 'Face ID was cancelled.'
          return
        }
        sendHello({ passkey }, false, eph)
      }),
    /** Seals a command for one session. An Allow asks for Face ID over that request first. */
    async send(session: string, command: Command): Promise<boolean> {
      const ch = channels.get(session)
      const eph = hello?.eph.pk
      if (!ch || !eph || !p.credentialId) return false
      if (command.kind === 'permission' && command.decision === 'allow') {
        const passkey = await assertPasskey(p.credentialId, passkeyChallenge('allow', command.requestId, eph))
        if (!passkey) return false
        command = { ...command, passkey }
      }
      // The channel may have been replaced while Face ID was up; the command goes on the current one or not at all.
      const now = channels.get(session)
      return !!now && post(session, { t: 'box', b: now.seal({ t: 'command', command }) })
    },
  }
}
