// One room's link: a WebSocket to /v1/room/{room}/device, retries, and the passkey prompts. What the frames say
// (hello, welcome, sealed snapshots, commands and acks) is the plugin's device core, remote/device.ts, shared like
// seal.ts: the relay sees only ids, sizes and timing.
import { createDevice, type DeviceFrame, type DeviceKeys } from '../../plugins/streams/hooks/remote/device'
import type { Ack, PhoneCommand, Snapshot } from '../../plugins/streams/hooks/remote/snapshot'
import { paired, refused, type Pairing } from './links'
import { assertBrowserKey, assertPasskey, createBrowserKey, createPasskey, isCeremonyBusy } from './passkey'
import type { PushSub } from './push'

/** This device: one id and X25519 key pair for every room; each room has its own passkey. */
export type Device = DeviceKeys

export type RoomEvents = {
  /** The pairing changed (paired, refused, passkey made) and should be kept. */
  save(p: Pairing): void
  snapshot(room: string, snapshot: Snapshot): void
  /** A session told this device what came of one of its commands. */
  ack(room: string, session: string, ack: Ack): void
  /** The link's state changed: connected, unlocked, refused, a passkey step began or ended. */
  changed(): void
  /** A session welcomed this device (it is unlocked): the time to tell the room where to push. */
  welcomed?(): void
}

/** Visible pings: sessions poll fast and hold permissions only while a device is looking. */
export const PING_MS = 15_000
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/**
 * Back on screen after this long with nothing heard, the socket is not trusted: iOS freezes a put-away app and its
 * socket can still read OPEN while nothing gets through. Unlocked, a session sends at least every 30 s.
 */
const STALE_MS = 45_000
/**
 * One session's refusal is not the Mac's: a session on an older plugin, or one for a project this device may not
 * see, refuses what another session lets in. A refusal stands only once no session has welcomed this hello for this
 * long; a session answers a hello within one 30 s heartbeat.
 */
export const DENY_GRACE_MS = 35_000
/** A hello is signed for its minute and the Mac takes it for a few minutes only: older, Retry asks for Face ID again. */
const HELLO_FRESH_MS = 3 * 60_000

/**
 * Where a gate's passkey step is: Face ID up, or the hello sent and no session has answered yet (`checking`, until a
 * welcome, a denial or a snapshot). `kind` is the button that started it.
 */
export type GateStage = { at: 'idle' } | { at: 'faceid' | 'checking'; kind: 'pair' | 'unlock'; since: number }

/** How a command went: posted, or why not. `isOffline`: no line to its session now, so it can wait for one. */
export type Sent = { ok: true } | { ok: false; why: string; isOffline?: boolean }

export type RoomLink = ReturnType<typeof roomLink>

export function roomLink(pairing: Pairing, device: Device, ev: RoomEvents) {
  let p = pairing
  let ws: WebSocket | undefined
  const core = createDevice({ device, room: p.room, accountPk: p.pk })
  let retries = 0
  let why = ''
  let stage: GateStage = { at: 'idle' }
  /** This connection's hello, for Retry: sent again as it was, so it needs no new Face ID. */
  let hello: DeviceFrame | undefined
  let helloAt = 0
  /** When this socket last heard anything, opened included. */
  let heardAt = 0
  /** A session's refusal of this hello, held for DENY_GRACE_MS in case another session welcomes it. */
  let denial: { why: string; isPairing: boolean; at: number; timer: ReturnType<typeof setTimeout> } | undefined
  /** Commands as sent on this connection (an Allow with its Face ID), by id: Retry sends the same one again. */
  const sent = new Map<string, PhoneCommand>()

  const set = (next: Pairing) => {
    p = next
    ev.save(p)
  }
  const setStage = (s: GateStage) => {
    stage = s
    ev.changed()
  }
  const post = (f: { to: string; data: unknown } | undefined): boolean => {
    if (!f || ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(f))
    return true
  }
  /** Looking: on screen and in focus. Only then do sessions send every change; otherwise at most one every 30 s. */
  const isLooking = () => document.visibilityState === 'visible' && document.hasFocus()
  /** What this socket last told the relay: looking pings repeat (they lapse after 30 s), "put away" is said once. */
  let saidHere: boolean | undefined
  const ping = () => {
    if (!core.isUnlocked() || ws?.readyState !== WebSocket.OPEN) return
    const here = isLooking()
    if (!here && saidHere === false) return
    saidHere = here
    ws.send(JSON.stringify({ here }))
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const sock = new WebSocket(`${proto}://${location.host}/v1/room/${p.room}/device?id=${device.id}`)
    ws = sock
    saidHere = undefined
    sock.onopen = () => {
      retries = 0
      heardAt = Date.now()
      ev.changed()
    }
    sock.onmessage = m => {
      heardAt = Date.now()
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
      hello = undefined
      sent.clear()
      dropDenial()
      if (stage.at === 'checking') {
        why = 'The connection dropped before your Mac answered. Try again once it is back.'
        stage = { at: 'idle' }
      }
      ev.changed()
      setTimeout(connect, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)])
    }
  }

  /** Drops this socket without waiting out a backoff and opens a fresh one; the old one's keys go with it. */
  function reconnect() {
    const old = ws
    ws = undefined
    if (old) {
      old.onclose = null
      old.close()
    }
    core.reset()
    hello = undefined
    sent.clear()
    dropDenial()
    retries = 0
    connect()
    ev.changed()
  }

  /** A refusal no session has overruled within DENY_GRACE_MS stands: say why, and a refused pairing spends its secret. */
  function settleDenial(): void {
    if (!denial || Date.now() - denial.at < DENY_GRACE_MS) return
    const d = denial
    clearTimeout(d.timer)
    denial = undefined
    if (core.isUnlocked()) return
    why = d.why
    if (stage.at === 'checking') stage = { at: 'idle' }
    // A refused pairing secret has expired or was turned down: it cannot be tried again.
    if (d.isPairing && !p.isPaired) set(refused(p))
    ev.changed()
  }
  const dropDenial = () => {
    if (denial) clearTimeout(denial.timer)
    denial = undefined
  }

  function receive(from: string, d: Record<string, unknown>) {
    const r = core.receive(from, d)
    if (!r) return
    if (r.t === 'denied') {
      // Held, not shown: another session may still let this hello in (DENY_GRACE_MS).
      if (!denial && !core.isUnlocked()) denial = { why: r.why, isPairing: r.isPairing, at: Date.now(), timer: setTimeout(settleDenial, DENY_GRACE_MS + 50) }
      return
    }
    // Any other answer from a session ends "Syncing…".
    if (stage.at === 'checking') stage = { at: 'idle' }
    if (r.t === 'welcome') {
      dropDenial()
      why = ''
      if (!p.isPaired) set(paired(p))
      ping()
      ev.welcomed?.()
      ev.changed()
    } else if (r.t === 'snapshot') ev.snapshot(p.room, r.snapshot)
    else ev.ack(p.room, from, r.ack)
  }

  /** One passkey step per gate: a tap while one is up (here or in any room) does nothing. */
  async function gateStep(kind: 'pair' | 'unlock', ceremony: () => Promise<DeviceFrame | string | undefined>) {
    if (stage.at !== 'idle' || isCeremonyBusy()) return
    if (!ws) {
      // Between retries: open the line now and say so, rather than ignore the tap.
      why = 'Reconnecting… tap again in a moment.'
      retries = 0
      connect()
      return ev.changed()
    }
    why = ''
    setStage({ at: 'faceid', kind, since: Date.now() })
    const r = await ceremony()
    if (typeof r === 'string' || !r) {
      why = r ?? ''
      return setStage({ at: 'idle' })
    }
    // A new hello means new connection keys: an Allow signed for the old ones would be refused.
    hello = r
    dropDenial()
    helloAt = Date.now()
    sent.clear()
    if (!post(r)) {
      why = 'The connection dropped. Try again once it is back.'
      return setStage({ at: 'idle' })
    }
    setStage({ at: 'checking', kind, since: Date.now() })
  }

  return {
    room: () => p.room,
    pairing: () => p,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    isUnlocked: () => core.isUnlocked(),
    stage: () => (settleDenial(), stage),
    why: () => (settleDenial(), why),
    /** Whether a command for `session` can go now: the line is up and that session welcomed this connection. */
    canSend: (session: string) => ws?.readyState === WebSocket.OPEN && core.hasChannel(session),
    start: connect,
    ping,
    /**
     * Tells the room where to push for this device, or (null) to stop. Plaintext to the room, as the relay needs it;
     * only once unlocked, so a locked or refused device registers nothing.
     */
    push(sub: PushSub | null): boolean {
      if (!core.isUnlocked() || ws?.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify({ push: sub }))
      return true
    },
    /** Back on screen or in focus: reconnect now rather than wait out the backoff. Put away: say so at once. */
    /** Locks this account on this device: the connection's keys are dropped, so Face ID is needed to see it again. */
    lock() {
      if (!core.isUnlocked()) return
      core.reset()
      setStage({ at: 'idle' })
    },
    wake() {
      if (!ws) {
        retries = 0
        connect()
      } else if (Date.now() - heardAt > STALE_MS && stage.at === 'idle') {
        // Only between steps: the Face ID sheet itself blurs the page, and the focus coming back must not drop the
        // line the hello just went out on.
        // Locked, a fresh line costs nothing. Unlocked, it is kept: a new one would cost a Face ID, and a Mac with
        // nothing new can be quiet for 30 s; a line that really died closes, and that reconnects.
        if (!core.isUnlocked()) return reconnect()
      }
      ping()
    },
    /**
     * First pairing: a new passkey, and proof this device saw the QR code's secret. `label`: a guest's own name.
     * `isBrowserKey`: a guest with no way to make a passkey keeps a key in this browser instead (watch only).
     */
    pair: (label?: string, isBrowserKey = false) =>
      gateStep('pair', async () => {
        const secret = p.secret
        if (!secret) return undefined
        const reg = isBrowserKey ? await createBrowserKey(core.pairChallenge()) : await createPasskey(p.guest?.project ?? p.room.slice(0, 6), core.pairChallenge())
        if (!reg.ok) return reg.why
        set({ ...p, credentialId: reg.value.credentialId, browserKey: isBrowserKey || undefined })
        return core.pairHello(secret, reg.value, label)
      }),
    /** One Face ID per connection: every session in the room checks the same assertion. */
    unlock: () =>
      gateStep('unlock', async () => {
        if (!p.credentialId) return undefined
        const passkey = await (p.browserKey ? assertBrowserKey : assertPasskey)(p.credentialId, core.unlockChallenge(Date.now()))
        return passkey.ok ? core.unlockHello(passkey.value) : passkey.why
      }),
    /**
     * The Mac is slow to answer: send this connection's hello again, as it was (no new Face ID). Sessions take a
     * repeated hello like the first, so a late welcome to either still unlocks.
     */
    retry() {
      if (stage.at !== 'checking' || !hello) return
      // Too old for the Mac to take, or the line is dead: start over on a fresh line, and Face ID again.
      if (Date.now() - helloAt > HELLO_FRESH_MS || !post(hello)) {
        why = 'Reconnected. Tap Unlock again.'
        stage = { at: 'idle' }
        return reconnect()
      }
      setStage({ ...stage, since: Date.now() })
    },
    /**
     * Seals a command for one session; sending the same command id again reuses it, so the session sees one command.
     * Face ID is asked once, to unlock: the channel it opened carries every answer, an Allow included.
     */
    async send(session: string, command: PhoneCommand): Promise<Sent> {
      const offline: Sent = { ok: false, why: 'offline', isOffline: true }
      if (!core.hasChannel(session) || !p.credentialId || ws?.readyState !== WebSocket.OPEN) return offline
      const c = sent.get(command.id) ?? command
      if (!post(core.seal(session, c))) return offline
      sent.set(c.id, c)
      return { ok: true }
    },
  }
}
