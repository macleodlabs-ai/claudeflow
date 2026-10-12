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
  /** The socket is open again after a drop: commands waiting on the line, or not yet answered, can go again. */
  reopened?(): void
}

/** Visible pings: sessions poll fast and hold permissions only while a device is looking. */
export const PING_MS = 15_000
/** Waits before opening the socket again after it closed: the first almost at once, as a drop is usually a blip. */
const RETRY_MS = [300, 1_000, 2_000, 5_000, 10_000]
/**
 * While no session has answered a hello, it is sent again this often (the same hello, no Face ID): a welcome lost on a
 * socket that dropped, or a hello that reached the room just after a session's post, is answered on the next one.
 */
export const RESEND_HELLO_MS = 5_000
/** How often the link checks on itself (`heal`): hellos to resend, refusals that now stand. */
export const HEAL_MS = 1_000
/** A session that asks for the hello again (it restarted, or lost its channel) is answered at most this often. */
const REHELLO_GAP_MS = 4_000
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
/** A hello is signed for its minute and the Mac takes it for a few minutes only: older, only a new Face ID unlocks. */
export const HELLO_FRESH_MS = 3 * 60_000

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
  /** This unlock's hello: sent again as it was (no new Face ID) on a new socket, to a session that asks, or on Retry. */
  let hello: DeviceFrame | undefined
  let helloAt = 0
  /** When the hello last went out, and when each session that asked for it again was last answered. */
  let helloSentAt = 0
  const reheld = new Map<string, number>()
  /** Sessions that asked for the hello after it went stale: only a new unlock reaches them. */
  const unreached = new Set<string>()
  /** Whether the socket has been open since this link started: a reopen is news to the app (`reopened`). */
  let wasOpen = false
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
  const isFresh = () => !!hello && Date.now() - helloAt < HELLO_FRESH_MS
  /** Sends this unlock's hello again, as it was, while the Mac still takes it. */
  const sayHello = (): boolean => {
    if (!isFresh() || !post(hello)) return false
    helloSentAt = Date.now()
    return true
  }
  /** Looking: on screen and in focus. Only then do sessions send every change; otherwise at most one every 30 s. */
  const isLooking = () => document.visibilityState === 'visible' && (document.hasFocus?.() ?? true)
  /** What this socket last told the relay, and when: looking pings repeat (they lapse after 30 s), "put away" is said once. */
  let saidHere: boolean | undefined
  let saidAt = 0
  /**
   * A looking ping again sooner than this is not sent: every focus, blur and visibility change asks for one, and
   * switching apps quickly could send dozens a minute, over the relay's limit (which closes the socket).
   */
  const PING_GAP_MS = 10_000
  /**
   * Locked too: a phone on its lock screen counts as looking, so sessions post every few seconds and its unlock is
   * answered at once rather than at a quiet session's next post. The relay learns no more than that it is open.
   */
  const ping = () => {
    if (ws?.readyState !== WebSocket.OPEN) return
    const here = isLooking()
    if (!here && saidHere === false) return
    if (here && saidHere === true && Date.now() - saidAt < PING_GAP_MS) return
    saidHere = here
    saidAt = Date.now()
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
      // The same hello on the new socket while no session has answered it: no new Face ID.
      if (stage.at === 'checking') sayHello()
      // Back on a new socket, unlocked: snapshots sent while it was away went nowhere, so ask for the latest now.
      else if (core.isUnlocked()) post({ to: '*', data: { t: 'sync' } })
      ping()
      if (wasOpen) ev.reopened?.()
      wasOpen = true
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
    sock.onclose = (e?: { code?: number }) => {
      if (ws !== sock) return
      // The socket is only the road: the channels are end to end and outlive it, so an unlocked phone stays unlocked
      // and an unlock under way carries on. Locking (`lock`) is what drops them.
      ws = undefined
      saidHere = undefined
      ev.changed()
      // Another tab of this device took the line (4000): it is that tab's until this one is used again (`wake` on
      // focus, or a tap). Taking it straight back, the two tabs would take it from each other forever.
      if (e?.code === 4000) return
      setTimeout(connect, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)])
    }
  }

  /** Drops this socket without waiting out a backoff and opens a fresh one; the channels and an unlock under way carry on. */
  function reconnect() {
    const old = ws
    ws = undefined
    if (old) {
      old.onclose = null
      old.close()
    }
    retries = 0
    connect()
    ev.changed()
  }

  /**
   * Checks on the link every HEAL_MS: an unanswered hello goes again every RESEND_HELLO_MS while the Mac still takes
   * it, and one gone stale ends the step, so Unlock asks for Face ID once more.
   */
  function heal() {
    settleDenial()
    if (stage.at !== 'checking') return
    if (!isFresh()) {
      why = 'Still not through. Tap Unlock to try again.'
      hello = undefined
      return setStage({ at: 'idle' })
    }
    if (Date.now() - helloSentAt >= RESEND_HELLO_MS) sayHello()
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
    if (r.t === 'rehello') {
      // That session has no channel with this device (it restarted, or its welcome went astray): the same hello
      // opens one while the Mac still takes it; after that only a new unlock does.
      if (isFresh()) {
        if (Date.now() - (reheld.get(r.session) ?? 0) >= REHELLO_GAP_MS && sayHello()) reheld.set(r.session, Date.now())
      } else if (core.isUnlocked() && !unreached.has(r.session)) {
        unreached.add(r.session)
        ev.changed()
      }
      return
    }
    if (r.t === 'denied') {
      // Held, not shown: another session may still let this hello in (DENY_GRACE_MS).
      if (!denial && !core.isUnlocked()) denial = { why: r.why, isPairing: r.isPairing, at: Date.now(), timer: setTimeout(settleDenial, DENY_GRACE_MS + 50) }
      return
    }
    // Any other answer from a session ends "Syncing…".
    if (stage.at === 'checking') stage = { at: 'idle' }
    if (r.t === 'welcome') {
      dropDenial()
      unreached.delete(r.session)
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
    // Between retries: open the line now. Face ID goes ahead, and the hello goes as soon as the line is up.
    if (!ws) {
      retries = 0
      connect()
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
    reheld.clear()
    unreached.clear()
    sent.clear()
    // Not on the line yet (it dropped during Face ID): the hello goes as it opens, or on the next heal.
    sayHello()
    setStage({ at: 'checking', kind, since: Date.now() })
  }

  return {
    room: () => p.room,
    pairing: () => p,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    isUnlocked: () => core.isUnlocked(),
    /** How many sessions asked for this device's hello after it went stale: a new unlock is needed to see them. */
    unreached: () => unreached.size,
    heal,
    stage: () => (settleDenial(), stage),
    why: () => (settleDenial(), why),
    /** Whether a command for `session` can go now: the line is up and that session welcomed this connection. */
    canSend: (session: string) => ws?.readyState === WebSocket.OPEN && core.hasChannel(session),
    start() {
      connect()
      setInterval(heal, HEAL_MS)
    },
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
      if (!core.isUnlocked() && stage.at === 'idle') return
      core.reset()
      hello = undefined
      sent.clear()
      unreached.clear()
      dropDenial()
      setStage({ at: 'idle' })
    },
    wake() {
      if (!ws) {
        retries = 0
        connect()
      } else if (Date.now() - heardAt > STALE_MS && stage.at === 'idle') {
        // A fresh line costs nothing: the channels carry over to it. Only between steps: the Face ID sheet blurs the
        // page, and the focus coming back must not drop the line the hello just went out on.
        return reconnect()
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
      // Too old for the Mac to take: the step ends, and Unlock asks for Face ID again.
      if (!isFresh()) {
        why = 'Still not through. Tap Unlock to try again.'
        hello = undefined
        return setStage({ at: 'idle' })
      }
      // Not on the line: a fresh one, which sends the hello as it opens.
      if (!sayHello()) return reconnect()
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
