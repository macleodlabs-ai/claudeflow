import { channel, connectionKeys, fromB64u, newIdentity, pairingProof, passkeyChallenge, randomId, verifyPasskey } from './seal'
import { HEARTBEAT_MS, commandOf, type PasskeyAssertion, type PhoneCommand, type Snapshot } from './snapshot'

// One session's side of the protocol (ARCHITECTURE.md, "Session ↔ device messages"), with no engine in it: it
// reads what the relay answered and says what to post and when, which devices were paired and which commands to do.
// The engine adapter (index.ts) does the posting, the store and the effects, so all of this runs in plain tests.

/** The account's identity in $.store: room id, relay token, X25519 secret key (all b64u). */
export type Identity = { room: string; token: string; sk: string }
/** A paired phone or tablet, as $.store keeps it. */
export type Device = { id: string; pk: string; credentialId: string; credentialKey: string; label: string; pairedAt: number }
/** An open pairing: the QR code's secret, and when it stops working. */
export type Pairing = { secret: string; until: number }

/** A frame for the relay to pass to one device. */
export type OutFrame = { to: string; data: unknown }
/** What the relay answers a session's `up`. */
export type UpResponse = { frames: { seq: number; from: string; data: unknown }[]; devices: { id: string; isActive: boolean }[] }

/** How long a pairing secret works: long enough to find the phone, short enough that a leaked QR code expires. */
export const PAIRING_MS = 10 * 60_000

const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** What $.store holds, kept only when well formed: the store is a file anyone on the Mac can edit. */
export const identityOf = (v: unknown): Identity | undefined => {
  const x = obj(v)
  return str(x.room) && str(x.token) && str(x.sk) ? { room: x.room, token: x.token, sk: x.sk } : undefined
}
export const devicesOf = (v: unknown): Device[] =>
  (Array.isArray(v) ? v : []).filter((d): d is Device => {
    const x = obj(d)
    return str(x.id) && str(x.pk) && str(x.credentialId, 1000) && str(x.credentialKey, 1000) && typeof x.label === 'string' && typeof x.pairedAt === 'number'
  })
export const pairingOf = (v: unknown): Pairing | undefined => {
  const x = obj(v)
  return str(x.secret) && typeof x.until === 'number' ? { secret: x.secret, until: x.until } : undefined
}

/** The relay's answer to `up`, if it is one; anything else is read as a failed post. */
export const upOf = (text: string): UpResponse | undefined => {
  try {
    const x = obj(JSON.parse(text))
    if (!Array.isArray(x.frames) || !Array.isArray(x.devices)) return undefined
    return {
      frames: x.frames.filter(f => typeof obj(f).seq === 'number' && typeof obj(f).from === 'string'),
      devices: x.devices.filter(d => typeof obj(d).id === 'string'),
    }
  } catch {
    return undefined
  }
}

/** The origin passkeys are made on: the relay's scheme, host and port. */
export const originOf = (relayUrl: string): string => /^https?:\/\/[^/?#]+/.exec(relayUrl)?.[0] ?? ''

/** A snapshot's identity for "has it changed": everything but its clock. */
export const snapshotKey = (s: Snapshot): string => JSON.stringify({ ...s, at: 0 })

/** A device's hello: its keys for this connection, and how it proves it may connect. */
type Hello = {
  device: string
  pk: string
  eph: string
  nonce: string
  label?: string
  passkey?: PasskeyAssertion
  proof?: string
  registration?: { credentialId: string; publicKey: string; clientDataJSON: string }
}

const helloOf = (data: unknown): Hello | undefined => {
  const x = obj(data)
  if (x.t !== 'hello' || !str(x.device) || !str(x.pk) || !str(x.eph) || !str(x.nonce)) return undefined
  return x as unknown as Hello
}

const assertionOf = (v: unknown): PasskeyAssertion | undefined => {
  const x = obj(v)
  return str(x.authenticatorData, 4000) && str(x.clientDataJSON, 4000) && str(x.signature, 400) ? (x as PasskeyAssertion) : undefined
}

/** One open, sealed connection with a device. */
type Conn = { device: Device; ch: ReturnType<typeof channel>; peerEph: string; last: { body: string; at: number } }

type Taken = { send: OutFrame[]; paired: Device[]; commands: { device: string; command: PhoneCommand }[] }

/** What the session knows of its devices on this tick, from $.store: the paired ones, and an open pairing. */
export type Known = { devices: Device[]; pairing?: Pairing; now: number }

/** The body of `POST /v1/room/{room}/up`. */
export type UpBody = { token: string; session: string; since: number; frames: OutFrame[] }

export type Answered = {
  /** Devices that paired with this post's hellos: the adapter adds them to $.store for every session. */
  paired: Device[]
  /** Commands opened from sealed boxes, checked; an `allow` only with a verified passkey. */
  commands: { device: string; command: PhoneCommand }[]
  /**
   * Post again now: hellos were answered, so the welcomes and the first snapshot go at once. Call `next` again with
   * the devices just paired among `devices`, or their new channels are closed as forgotten.
   */
  again: boolean
}

/** How long to wait before trying the relay again after `fails` failures in a row: 4 s doubling, at most 5 min. */
const backoffMs = (fails: number): number => Math.min(5 * 60_000, 2000 * 2 ** Math.max(1, fails))

/** How often a session posts while a device looks and nothing waits on it: every third 2 s tick. */
export const ACTIVE_POLL_MS = 6000

/** Posts in one tick at most: the first, and one more when it answered hellos. A relay that keeps sending hellos gets no more. */
export const MAX_ROUNDS = 2

/**
 * How long a session keeps the 6 s cadence after it welcomes a device: the device counts as looking only once its
 * ping reaches a later answer, and its first tap (Yes, Reply) should not wait for the 30 s heartbeat meanwhile.
 */
export const WARM_MS = 60_000

/**
 * The session's link to its devices: one sealed channel per device, made by answering its hello, and the post cycle
 * that carries them (ARCHITECTURE.md, "Polling budget"). `identity` is the account's; `origin` is the relay's, where
 * the devices' passkeys live. Each tick the adapter asks `next` for a post, sends it, and hands the answer (or the
 * failure) to `answered`; the link keeps the cursor, the welcomes not yet sent, the cadence and the backoff.
 */
export function createLink(o: { identity: Identity; session: string; origin: string }) {
  const conns = new Map<string, Conn>()
  /** Allows already checked, by requestId: one try each, so no assertion is used twice. */
  const allowsTried = new Set<string>()
  let connected = new Map<string, boolean>()
  let since = 0
  /** What was last posted and when, and when the relay may be tried again after it failed. */
  const poll = { lastBody: '', lastAt: 0, fails: 0, retryAt: 0, warmUntil: 0 }
  /** Welcomes and denials not yet posted. */
  let outbox: OutFrame[] = []
  /** The post on the wire, read back by `answered`. */
  let sent: { frames: OutFrame[]; body: string; known: Known } | undefined
  /** Which post of this tick comes next: 0 is the tick's first, which waits until one is due. */
  let round = 0

  function welcome(h: Hello, device: Device): OutFrame {
    const eph = newIdentity()
    const nonce = randomId(32)
    const k = connectionKeys({ ownSk: o.identity.sk, peerPk: h.pk, ownEphSk: eph.sk, peerEphPk: h.eph, sessionNonce: nonce, deviceNonce: h.nonce })
    conns.set(device.id, { device, ch: channel(k.sessionToDevice, k.deviceToSession), peerEph: h.eph, last: { body: '', at: 0 } })
    return { to: device.id, data: { t: 'welcome', session: o.session, eph: eph.pk, nonce } }
  }

  /** The device this hello may connect as, a new one when it pairs, or why not. */
  function admit(h: Hello, devices: Device[], pairing: Pairing | undefined, now: number): Device | string {
    if (h.proof !== undefined) {
      const reg = obj(h.registration)
      if (!pairing || now >= pairing.until) return 'pairing expired'
      if (!str(reg.credentialId, 1000) || !str(reg.publicKey, 1000) || !str(reg.clientDataJSON, 4000)) return 'bad registration'
      // The relay may replay this hello for ten minutes: the proof covers all that is stored, so it cannot swap
      // in its own passkey or another device's id.
      if (h.proof !== pairingProof(pairing.secret, h.device, h.pk, reg.credentialId, reg.publicKey)) return 'bad pairing proof'
      // The registration is made on the relay's page, never on another site, for this device's pairing.
      let client: Record<string, unknown> = {}
      try {
        client = obj(JSON.parse(new TextDecoder().decode(fromB64u(reg.clientDataJSON))))
      } catch {}
      const challenge = passkeyChallenge('pair', o.identity.room, h.device, h.pk)
      if (client.type !== 'webauthn.create' || client.origin !== o.origin || client.challenge !== challenge) return 'bad registration'
      const label = typeof h.label === 'string' && h.label.trim() ? h.label.trim().slice(0, 60) : `device ${h.device.slice(0, 6)}`
      return { id: h.device, pk: h.pk, credentialId: reg.credentialId, credentialKey: reg.publicKey, label, pairedAt: now }
    }
    const d = devices.find(x => x.id === h.device)
    if (!d || d.pk !== h.pk) return 'not paired'
    const passkey = assertionOf(h.passkey)
    const minute = Math.floor(now / 60_000)
    // The current or previous minute: a hello waits up to two minutes in the room, and clocks drift a little.
    const isVerified = !!passkey && [minute, minute - 1].some(m => verifyPasskey(passkey, d.credentialKey, passkeyChallenge('hello', o.identity.room, h.eph, m), o.origin))
    return isVerified ? d : 'passkey not verified'
  }

  function command(conn: Conn, box: unknown): PhoneCommand | undefined {
    let opened: Record<string, unknown>
    try {
      opened = obj(conn.ch.open(String(box)))
    } catch {
      return undefined
    }
    const c = opened.t === 'command' ? commandOf(opened.command) : undefined
    if (c?.kind !== 'permission' || c.decision !== 'allow') return c
    // An allow runs a tool on the Mac: it needs Face ID for this request on this connection, checked once.
    if (allowsTried.has(c.requestId)) return undefined
    allowsTried.add(c.requestId)
    const passkey = assertionOf(c.passkey)
    const challenge = passkeyChallenge('allow', c.requestId, conn.peerEph)
    return passkey && verifyPasskey(passkey, conn.device.credentialKey, challenge, o.origin) ? c : undefined
  }

  /** Reads an `up` answer: hellos answered (pairing new devices), boxes opened into commands. */
  function take(r: UpResponse, w: Known): Taken {
    const out: Taken = { send: [], paired: [], commands: [] }
    const before = connected
    // Anyone who knows the room id can open a socket there: only devices that may talk to this session count.
    const isPairing = !!w.pairing && w.now < w.pairing.until
    const mayTalk = r.devices.filter(d => isPairing || w.devices.some(x => x.id === d.id))
    connected = new Map(mayTalk.map(d => [d.id, d.isActive === true]))
    // A device back after a gap gets the snapshot at once, not at the next heartbeat.
    for (const [id, c] of conns) if (connected.has(id) && !before.has(id)) c.last = { body: '', at: 0 }
    const devices = [...w.devices]
    for (const f of r.frames) {
      if (typeof f.seq === 'number' && f.seq > since) since = f.seq
      const data = obj(f.data)
      if (data.t === 'hello') {
        const h = helloOf(data)
        if (!h) continue
        const admitted = admit(h, devices, w.pairing, w.now)
        if (typeof admitted === 'string') {
          out.send.push({ to: h.device, data: { t: 'denied', why: admitted } })
          continue
        }
        if (!devices.some(d => d.id === admitted.id && d.pk === admitted.pk && d.credentialKey === admitted.credentialKey)) {
          devices.splice(0, devices.length, ...devices.filter(d => d.id !== admitted.id), admitted)
          out.paired.push(admitted)
        }
        out.send.push(welcome(h, admitted))
        poll.warmUntil = w.now + WARM_MS
      } else if (data.t === 'box') {
        const conn = conns.get(f.from)
        const c = conn && command(conn, data.b)
        if (c) out.commands.push({ device: f.from, command: c })
      }
    }
    return out
  }

  /** The snapshot sealed for every unlocked, connected device it is news to (or due again as a heartbeat). */
  function snapshots(s: Snapshot, now: number): OutFrame[] {
    const body = snapshotKey(s)
    const out: OutFrame[] = []
    for (const [id, c] of conns) {
      if (!connected.has(id)) continue
      if (body === c.last.body && now - c.last.at < HEARTBEAT_MS) continue
      c.last = { body, at: now }
      out.push({ to: id, data: { t: 'box', b: c.ch.seal({ t: 'snapshot', snapshot: s }) } })
    }
    return out
  }

  /** Whether no device could answer, or the relay failed and its backoff has not ended: then no snapshot is needed. */
  const isQuiet = (k: Known): boolean => k.now < poll.retryAt || (!k.devices.length && !(k.pairing && k.now < k.pairing.until))

  return {
    room: o.identity.room,

    /** Whether a device with an open channel is looking now: only then are permission prompts held for it. */
    isLooking: () => [...conns.keys()].some(id => connected.get(id) === true),

    isQuiet,

    /**
     * The post to send now, or none. A tick's first post waits until one is due: every tick while a permission is
     * held for a looking device (`isHolding`), when there are welcomes to send, or when the snapshot changed; every
     * 6 s while a paired device (any device while a pairing is open) looks or for a minute after a welcome; otherwise
     * every 30 s. An account with
     * nothing paired and no pairing open never posts, and a failed post waits out its backoff.
     */
    next(k: Known & { snapshot: Snapshot; isHolding: boolean }): UpBody | undefined {
      // A forgotten device loses its channel at once, in every session: nothing more is sealed for it.
      for (const id of conns.keys()) if (!k.devices.some(d => d.id === id)) conns.delete(id)
      if (isQuiet(k)) return undefined
      const body = snapshotKey(k.snapshot)
      const isActive = k.now < poll.warmUntil || [...connected.values()].some(Boolean)
      const isDue = round > 0 || k.isHolding || outbox.length > 0 || body !== poll.lastBody || k.now - poll.lastAt >= (isActive ? ACTIVE_POLL_MS : HEARTBEAT_MS)
      if (!isDue) return undefined
      const frames = [...outbox, ...snapshots(k.snapshot, k.now)]
      outbox = []
      sent = { frames, body, known: { devices: k.devices, pairing: k.pairing, now: k.now } }
      return { token: o.identity.token, session: o.session, since, frames }
    },

    /**
     * Reads what the relay answered the last post: its body when the post succeeded, undefined when it failed. A
     * failure keeps the welcomes and denials to send again, drops the sealed snapshots (they are sealed afresh next
     * time, on the channel's next counter) and backs off: 4 s, doubling, at most 5 min.
     */
    answered(text: string | undefined, now: number): Answered {
      const s = sent
      sent = undefined
      const r = text === undefined ? undefined : upOf(text)
      if (!s || !r) {
        if (s) {
          outbox = [...s.frames.filter(f => obj(f.data).t !== 'box'), ...outbox]
          for (const c of conns.values()) c.last = { body: '', at: 0 }
          poll.fails++
          poll.retryAt = now + backoffMs(poll.fails)
        }
        round = 0
        return { paired: [], commands: [], again: false }
      }
      poll.fails = 0
      poll.lastBody = s.body
      poll.lastAt = now
      const t = take(r, s.known)
      outbox = t.send
      round = outbox.length && round + 1 < MAX_ROUNDS ? round + 1 : 0
      return { paired: t.paired, commands: t.commands, again: round > 0 }
    },
  }
}

export type Link = ReturnType<typeof createLink>
