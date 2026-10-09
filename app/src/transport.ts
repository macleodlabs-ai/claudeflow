// One room's link: a WebSocket to /v1/room/{room}/device, retries, and the passkey prompts. What the frames say
// (hello, welcome, sealed snapshots and commands) is the plugin's device core, remote/device.ts, shared like seal.ts:
// the relay sees only ids, sizes and timing.
import { createDevice, type DeviceKeys } from '../../plugins/streams/hooks/remote/device'
import type { PhoneCommand, Snapshot } from '../../plugins/streams/hooks/remote/snapshot'
import { paired, refused, type Pairing } from './links'
import { assertPasskey, createPasskey } from './passkey'

/** This device: one id and X25519 key pair for every room; each room has its own passkey. */
export type Device = DeviceKeys

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

export type RoomLink = ReturnType<typeof roomLink>

export function roomLink(pairing: Pairing, device: Device, ev: RoomEvents) {
  let p = pairing
  let ws: WebSocket | undefined
  const core = createDevice({ device, room: p.room, accountPk: p.pk })
  let retries = 0
  let why = ''
  let isBusy = false

  const set = (next: Pairing) => {
    p = next
    ev.save(p)
  }
  const post = (f: { to: string; data: unknown } | undefined): boolean => {
    if (!f || ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(f))
    return true
  }
  const ping = () => {
    if (document.visibilityState === 'visible' && core.isUnlocked() && ws?.readyState === WebSocket.OPEN) ws.send('{"here":true}')
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
      core.reset()
      ev.changed()
      setTimeout(connect, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)])
    }
  }

  function receive(from: string, d: Record<string, unknown>) {
    const r = core.receive(from, d)
    if (r?.t === 'welcome') {
      why = ''
      if (!p.isPaired) set(paired(p))
      ping()
      ev.changed()
    } else if (r?.t === 'denied') {
      why = r.why
      // A refused pairing secret has expired or was turned down: it cannot be tried again.
      if (r.isPairing && !core.isUnlocked()) set(refused(p))
      ev.changed()
    } else if (r?.t === 'snapshot') ev.snapshot(p.room, r.snapshot)
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
    isUnlocked: () => core.isUnlocked(),
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
        const secret = p.secret
        if (!secret || !ws) return
        const reg = await createPasskey(p.room.slice(0, 6), core.pairChallenge())
        if (!reg) {
          why = 'The passkey was not created.'
          return
        }
        set({ ...p, credentialId: reg.credentialId })
        post(core.pairHello(secret, reg))
      }),
    /** One Face ID per connection: every session in the room checks the same assertion. */
    unlock: () =>
      busy(async () => {
        if (!p.credentialId || !ws) return
        const passkey = await assertPasskey(p.credentialId, core.unlockChallenge(Date.now()))
        if (!passkey) {
          why = 'Face ID was cancelled.'
          return
        }
        post(core.unlockHello(passkey))
      }),
    /** Seals a command for one session. An Allow asks for Face ID over that request first. */
    async send(session: string, command: PhoneCommand): Promise<boolean> {
      if (!core.hasChannel(session) || !p.credentialId) return false
      if (command.kind === 'permission' && command.decision === 'allow') {
        const challenge = core.allowChallenge(command.requestId)
        const passkey = challenge && (await assertPasskey(p.credentialId, challenge))
        if (!passkey) return false
        command = { ...command, passkey }
      }
      // The channel may have been replaced while Face ID was up; the command goes on the current one or not at all.
      return post(core.seal(session, command))
    },
  }
}
