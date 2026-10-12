import { b64u, channel, connectionKeys, fromB64u, newIdentity, pairingProof, passkeyChallenge, randomId, verifyPasskey } from './seal'
import { proofParts } from './device'
import { HEARTBEAT_MS, commandOf, type Ack, type PasskeyAssertion, type PhoneCommand, type Snapshot } from './snapshot'
import { createNotifier, type Hint } from './notify'

// One session's side of the protocol , with no engine in it: it
// reads what the relay answered and says what to post and when, which devices were paired and which commands to do.
// The engine adapter (index.ts) does the posting, the store and the effects, so all of this runs in plain tests.

/** The account's identity in $.store: room id, relay token, X25519 secret key (all b64u). */
export type Identity = { room: string; token: string; sk: string }
/**
 * A paired phone or tablet, as $.store keeps it. One paired with `/streams phone` is the owner's: every project, every
 * action. One that joined by a shared invite has a `role` (watch only, or contribute), the `project` (a cwd) it may
 * see, `until`, when its access ends, and `via`, the invite it joined by. One the owner removed stays as `removed`,
 * so it is told that rather than that it is unknown.
 */
export type Device = {
  id: string
  pk: string
  credentialId: string
  credentialKey: string
  label: string
  pairedAt: number
  role?: Role
  project?: string
  until?: number
  via?: string
  removed?: boolean
  /** Joined with a key its browser keeps, not a passkey: no one checks who holds it, so it may only watch. */
  browserKey?: boolean
}
/** What a shared device may do: watch only, or act as the owner does in that project. */
export type Role = 'viewer' | 'contributor'
/** An open pairing: the QR code's secret, and when it stops working. */
export type Pairing = { secret: string; until: number }
/**
 * A shared invite: a pairing secret for one project and role, and how many days the access lasts. It is one person's:
 * until it expires, using it again (the Home Screen app after Safari) moves their access to the new device.
 */
export type Invite = { secret: string; until: number; project: string; role: Role; days: number }

/** How long a shared invite link works, and how long the access it gives lasts by default. */
export const INVITE_MS = 24 * 60 * 60_000
export const SHARE_DAYS = 7
export const DAY_MS = 24 * 60 * 60_000

/** What a device may do in its project: a browser key only watches, whatever its invite said. */
export const roleOf = (d: Device): Role | undefined => (d.browserKey ? 'viewer' : d.role)

/** Whether a device may see this session: the owner's always; a shared one in its own project, until it expires. */
export const mayAccess = (d: Device, project: string, now: number): boolean => !d.role || (!d.removed && d.project === project && (d.until ?? 0) > now)

/**
 * The stored devices with those just paired: each replaces its own earlier entry and, when it joined by an invite,
 * the device that invite admitted before (one person, one device).
 */
export const withPaired = (devices: Device[], paired: Device[]): Device[] => [
  ...devices.filter(d => !paired.some(p => p.id === d.id || (!!p.via && p.via === d.via))),
  ...paired,
]

/** A frame for the relay to pass to one device. */
export type OutFrame = { to: string; data: unknown }
/** What the relay answers a session's `up`. */
/** The relay's answer to a post. `more`: it held frames back to keep the answer small (a photo's chunks); post again now. */
export type UpResponse = { frames: { seq: number; from: string; data: unknown }[]; devices: { id: string; isActive: boolean }[]; more?: boolean }

/** How long a pairing secret works: long enough to find the phone, short enough that a leaked QR code expires. */
export const PAIRING_MS = 10 * 60_000
/**
 * The minutes back from now a passkey hello may be signed for: five back (it can wait in the room while a session
 * backs off), and three ahead, as phone clocks run fast (a phone 2.5 min ahead was refused at one).
 */
export const HELLO_MINUTES = [0, 1, -1, 2, -2, 3, -3, 4, 5]

const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

/** What $.store holds, kept only when well formed: the store is a file anyone on the Mac can edit. */
export const identityOf = (v: unknown): Identity | undefined => {
  const x = obj(v)
  return str(x.room) && str(x.token) && str(x.sk) ? { room: x.room, token: x.token, sk: x.sk } : undefined
}
export const devicesOf = (v: unknown): Device[] => {
  const valid = (Array.isArray(v) ? v : []).filter((d): d is Device => {
    const x = obj(d)
    const isShared = x.role === undefined || ((x.role === 'viewer' || x.role === 'contributor') && str(x.project, 4000) && typeof x.until === 'number')
    return str(x.id) && str(x.pk) && str(x.credentialId, 1000) && str(x.credentialKey, 1000) && typeof x.label === 'string' && typeof x.pairedAt === 'number' && isShared
  })
  // One entry per device, the latest pairing winning: a device that paired twice (a double tap, a retry on a slow
  // network) holds only its newest passkey, and an older entry left first would refuse every unlock and Allow.
  return valid.filter((d, i) => !valid.slice(i + 1).some(x => x.id === d.id))
}
export const invitesOf = (v: unknown): Invite[] =>
  (Array.isArray(v) ? v : []).filter((i): i is Invite => {
    const x = obj(i)
    return str(x.secret) && typeof x.until === 'number' && str(x.project, 4000) && (x.role === 'viewer' || x.role === 'contributor') && typeof x.days === 'number'
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
      ...(x.more === true ? { more: true } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * `/streams phone relay <url|off>` read: the relay address to set, '' for off, or why it is refused. Only an https
 * origin: passkeys need a secure origin, and the relay serves at its root, so a path is a mistake.
 */
export function relayArg(arg: string): { relayUrl: string } | { error: string } {
  if (arg === 'off') return { relayUrl: '' }
  const bad = { error: `"${arg}" is not a relay address. Give its https origin, e.g. https://relay.<you>.workers.dev, or \`off\`.` }
  let u: URL
  try {
    u = new URL(arg)
  } catch {
    return bad
  }
  if (u.protocol !== 'https:') return { error: `The relay must be https (passkeys need a secure origin), e.g. https://${u.host || 'relay.<you>.workers.dev'}` }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return { error: `The relay address has no path: give ${u.origin}` }
  return u.hostname.includes('.') ? { relayUrl: u.origin } : bad
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

/** An ack that does not settle its command: sent again under the same id, it runs again (index.tsx `saveFiles`). */
export const RETRY_WHY = 'file missing'

/** What only the owner's devices may ask: sharing the project and managing who it is shared with. */
const OWNER_ONLY: readonly string[] = ['invite', 'setRole', 'extend', 'forgetDevice']

/**
 * One open, sealed connection with a device. `welcome` is the frame that opened it, sent again as it was when the same
 * hello comes again (`peerEph`, `peerNonce`): a phone that missed it, or asks twice, keeps one channel on both sides.
 */
type Conn = {
  device: Device
  ch: ReturnType<typeof channel>
  /** The channel's keys (b64u), kept with its counts so the channel outlives a reload of the plugin (`kept`). */
  keys: { send: string; recv: string }
  peerEph: string
  peerNonce: string
  welcome: OutFrame
  last: { body: string; at: number }
}

/** A channel as the session keeps it in $.state across a reload of the plugin, keys and counts included. */
export type KeptConn = { device: Device; send: string; recv: string; sent: number; lastOpened: number; peerEph: string; peerNonce: string; welcome: OutFrame }

/**
 * How far a kept channel's send count is moved on when it is taken up again: boxes sealed after it was last kept (a
 * reload mid-tick) must never share a nonce with the ones sealed after, and a tick seals a few at most.
 */
export const KEPT_MARGIN = 1000

/** `resync`: a device asked for the latest snapshot (`sync`), which goes in a post at once, not at the next. */
type Taken = { send: OutFrame[]; paired: Device[]; commands: { device: string; command: PhoneCommand }[]; resync?: boolean }

/** What the session knows of its devices on this tick, from $.store: the paired ones, and an open pairing. */
export type Known = { devices: Device[]; pairing?: Pairing; invites?: Invite[]; now: number }

/** The body of `POST /v1/room/{room}/up`, with a push hint (`notify`, `kind`) when there is news for devices not looking. */
export type UpBody = { token: string; session: string; since: number; frames: OutFrame[] } & Partial<Hint>

export type Answered = {
  /** Devices that paired with this post's hellos: the adapter adds them to $.store (`withPaired`) for every session. */
  paired: Device[]
  /** Commands opened from sealed boxes, checked; an `allow` only with a verified passkey. */
  commands: { device: string; command: PhoneCommand }[]
  /**
   * Post again now: hellos were answered, so the welcomes and the first snapshot go at once. Call `next` again with
   * the devices just paired among `devices`, or their new channels are closed as forgotten.
   */
  again: boolean
}

/**
 * How long to wait before trying the relay again after `fails` failures in a row: 4 s doubling, at most one
 * heartbeat. A session backed off any longer cannot answer a phone that opens meanwhile, and the phone says the Mac
 * is not answering; one post per 30 s while the relay is down costs no more than a quiet session's heartbeat.
 */
const backoffMs = (fails: number): number => Math.min(HEARTBEAT_MS, 2000 * 2 ** Math.max(1, fails))

/** How often a session posts while a device looks and nothing waits on it: every third 2 s tick. */
export const ACTIVE_POLL_MS = 6000

/**
 * How often a session with a device that may reach it posts when nothing else is due: a phone opened now waits at
 * most this long before a session sees it (then 6 s, as a phone on its lock screen counts as looking). 5,760 posts a
 * day a session: the free plan's 100k requests leave room for three idle sessions and most of a day of looking
 * . Shorter costs the budget a relay over its limit would fail every post on.
 */
export const IDLE_POLL_MS = 15_000


/** Posts in one tick at most: the first, and one more when it answered hellos. A relay that keeps sending hellos gets no more. */
export const MAX_ROUNDS = 2
/** Posts in one tick at most while the relay says it holds `more` frames (a photo's chunks): the rest come next tick. */
export const MORE_ROUNDS = 4

/**
 * How long a session keeps the 6 s cadence after it welcomes a device: the device counts as looking only once its
 * ping reaches a later answer, and its first tap (Yes, Reply) should not wait for the 30 s heartbeat meanwhile.
 */
export const WARM_MS = 60_000

/**
 * The session's link to its devices: one sealed channel per device, made by answering its hello, and the post cycle
 * that carries them . `identity` is the account's; `origin` is the relay's, where
 * the devices' passkeys live. Each tick the adapter asks `next` for a post, sends it, and hands the answer (or the
 * failure) to `answered`; the link keeps the cursor, the welcomes not yet sent, the cadence and the backoff.
 */
export function createLink(o: { identity: Identity; session: string; origin: string; project: string; kept?: readonly KeptConn[] }) {
  const conns = new Map<string, Conn>()
  // Channels this session had before the plugin reloaded: the phones keep theirs, so nothing needs a new Face ID.
  for (const k of o.kept ?? []) {
    const ch = channel(fromB64u(k.send), fromB64u(k.recv), { sent: k.sent + KEPT_MARGIN, lastOpened: k.lastOpened })
    conns.set(k.device.id, { device: k.device, ch, keys: { send: k.send, recv: k.recv }, peerEph: k.peerEph, peerNonce: k.peerNonce, welcome: k.welcome, last: { body: '', at: 0 } })
  }
  /**
   * Command ids already taken, with the ack each got: a phone on a laggy network sends a command again under the same
   * id, so it runs once and the phone is told again what came of it.
   */
  const seen = new Map<string, Ack | undefined>()
  /** Acks not yet posted, sealed only when posted so a failed post loses none. */
  let acks: { to: string; ack: Ack }[] = []
  const queueAck = (to: string, ack: Ack) => {
    // A prompt whose files had not all arrived may come again under its id once the phone has resent them.
    if (ack.why === RETRY_WHY) seen.delete(ack.id)
    else seen.set(ack.id, ack)
    acks.push({ to, ack })
  }
  let connected = new Map<string, boolean>()
  let since = 0
  /** What was last posted and when, and when the relay may be tried again after it failed. */
  const poll = { lastBody: '', lastAt: 0, fails: 0, retryAt: 0, warmUntil: 0 }
  /** Welcomes and denials not yet posted. */
  let outbox: OutFrame[] = []
  /** The post on the wire, read back by `answered`. */
  let sent: { frames: OutFrame[]; acks: typeof acks; body: string; known: Known; hint?: Hint } | undefined
  /** What wakes devices that are not looking (notify.ts); a hint whose post failed goes with the next one. */
  const notifier = createNotifier()
  let hintAgain: Hint | undefined
  /** Which post of this tick comes next: 0 is the tick's first, which waits until one is due. */
  let round = 0

  function welcome(h: Hello, device: Device): OutFrame {
    // The same hello again (the phone resent it, or a welcome went astray): the same welcome, the channel kept.
    const was = conns.get(device.id)
    if (was && was.peerEph === h.eph && was.peerNonce === h.nonce && was.device.pk === device.pk) {
      was.device = device
      was.last = { body: '', at: 0 }
      return was.welcome
    }
    const eph = newIdentity()
    const nonce = randomId(32)
    const k = connectionKeys({ ownSk: o.identity.sk, peerPk: h.pk, ownEphSk: eph.sk, peerEphPk: h.eph, sessionNonce: nonce, deviceNonce: h.nonce })
    // `hello`: which hello this answers, so a late welcome for an older one is not taken with this one's keys.
    const frame: OutFrame = { to: device.id, data: { t: 'welcome', session: o.session, eph: eph.pk, nonce, hello: h.eph } }
    conns.set(device.id, {
      device,
      ch: channel(k.sessionToDevice, k.deviceToSession),
      keys: { send: b64u(k.sessionToDevice), recv: b64u(k.deviceToSession) },
      peerEph: h.eph,
      peerNonce: h.nonce,
      welcome: frame,
      last: { body: '', at: 0 },
    })
    return frame
  }

  /** The device this hello may connect as, a new one when it pairs, or why not. */
  function admit(h: Hello, w: Known & { devices: Device[] }): { device: Device } | string | undefined {
    const { devices, pairing, now } = w
    if (h.proof !== undefined) {
      const reg = obj(h.registration)
      if (!str(reg.credentialId, 1000) || !str(reg.publicKey, 1000) || !str(reg.clientDataJSON, 4000)) return 'bad registration'
      // The relay may replay this hello for ten minutes: the proof covers all that is stored, so it cannot swap
      // in its own passkey or another device's id. The owner's pairing first, then a shared invite.
      const isBrowser = reg.browser === true
      const proofOf = (secret: string) => pairingProof(secret, ...proofParts({ id: h.device, pk: h.pk }, { credentialId: String(reg.credentialId), publicKey: String(reg.publicKey), browser: reg.browser }))
      const isOwner = !!pairing && now < pairing.until && h.proof === proofOf(pairing.secret)
      const invite = isOwner ? undefined : (w.invites ?? []).find(i => now < i.until && h.proof === proofOf(i.secret))
      // Another project's invite is that project's sessions' to admit: this one stays silent rather than deny it.
      if (invite && invite.project !== o.project) return undefined
      if (!isOwner && !invite) return (pairing && now < pairing.until) || (w.invites ?? []).some(i => now < i.until) ? 'bad pairing proof' : 'pairing expired'
      // The owner's own devices need a real passkey: a browser key is for someone invited to watch.
      if (isBrowser && !invite) return 'bad registration'
      // The registration is made on the relay's page, never on another site, for this device's pairing.
      let client: Record<string, unknown> = {}
      try {
        client = obj(JSON.parse(new TextDecoder().decode(fromB64u(reg.clientDataJSON))))
      } catch {}
      const challenge = passkeyChallenge('pair', o.identity.room, h.device, h.pk)
      if (client.type !== 'webauthn.create' || client.origin !== o.origin || client.challenge !== challenge) return 'bad registration'
      const label = typeof h.label === 'string' && h.label.trim() ? h.label.trim().slice(0, 60) : `device ${h.device.slice(0, 6)}`
      const device: Device = {
        id: h.device, pk: h.pk, credentialId: String(reg.credentialId), credentialKey: String(reg.publicKey), label, pairedAt: now, ...(isBrowser ? { browserKey: true } : {}),
      }
      if (!invite) return { device }
      // Joined before by this invite: the same person on another device keeps the role and end date they have.
      const was = devices.find(d => d.via === invite.secret && !d.removed)
      return { device: { ...device, role: was?.role ?? invite.role, project: invite.project, until: was?.until ?? now + invite.days * DAY_MS, via: invite.secret } }
    }
    const d = devices.find(x => x.id === h.device)
    if (!d || d.pk !== h.pk) return 'not paired'
    // A shared device's other projects stay silent (their sessions are none of its business); its own says when it ended.
    if (d.role && d.project !== o.project) return undefined
    if (d.removed) return 'access removed'
    if (!mayAccess(d, o.project, now)) return 'access expired'
    const passkey = assertionOf(h.passkey)
    const minute = Math.floor(now / 60_000)
    // From five minutes back to one ahead: a hello can wait in the room while this Mac backs off or wakes, and a
    // phone's clock can run a little fast. A replayed hello gains nothing: its keys are the phone's own (eph).
    const isVerified = !!passkey && HELLO_MINUTES.some(back => verifyPasskey(passkey, d.credentialKey, passkeyChallenge('hello', o.identity.room, h.eph, minute - back), o.origin, !d.browserKey))
    return isVerified ? { device: d } : 'passkey not verified'
  }

  /** The command in a sealed box, undefined when there is none to run, or `unread` when the box does not open here. */
  function command(conn: Conn, box: unknown): PhoneCommand | 'unread' | undefined {
    let opened: Record<string, unknown>
    try {
      opened = obj(conn.ch.open(String(box)))
    } catch {
      return 'unread'
    }
    const c = opened.t === 'command' ? commandOf(opened.command) : undefined
    if (!c) return undefined
    if (seen.has(c.id)) {
      const was = seen.get(c.id)
      if (was) acks.push({ to: conn.device.id, ack: was })
      return undefined
    }
    seen.set(c.id, undefined)
    // Ids are random per tap: keep the newest few hundred, enough for any phone's retries.
    if (seen.size > 500) seen.delete(seen.keys().next().value!)
    // A watcher may only watch, and only the owner shares: refused here, whatever the app shows, and told so.
    if (roleOf(conn.device) === 'viewer' || (conn.device.role && OWNER_ONLY.includes(c.kind))) {
      queueAck(conn.device.id, { t: 'ack', id: c.id, ok: false, why: 'read only' })
      return undefined
    }
    // An Allow needs no Face ID of its own: the channel it came on was opened by the unlock's passkey check.
    return c
  }

  /** Reads an `up` answer: hellos answered (pairing new devices), boxes opened into commands. */
  function take(r: UpResponse, w: Known): Taken {
    const out: Taken = { send: [], paired: [], commands: [] }
    const before = connected
    // Anyone who knows the room id can open a socket there: only devices that may talk to this session count.
    const isPairing = (!!w.pairing && w.now < w.pairing.until) || (w.invites ?? []).some(i => i.project === o.project && w.now < i.until)
    const mayTalk = r.devices.filter(d => isPairing || w.devices.some(x => x.id === d.id && mayAccess(x, o.project, w.now)))
    connected = new Map(mayTalk.map(d => [d.id, d.isActive === true]))
    // A device back after a gap, or picked up again, gets the latest snapshot at once, not at the next heartbeat.
    for (const [id, c] of conns) if ((connected.has(id) && !before.has(id)) || (connected.get(id) && !before.get(id))) c.last = { body: '', at: 0 }
    const devices = [...w.devices]
    for (const f of r.frames) {
      if (typeof f.seq === 'number' && f.seq > since) since = f.seq
      const data = obj(f.data)
      if (data.t === 'hello') {
        const h = helloOf(data)
        if (!h) continue
        const got = admit(h, { ...w, devices })
        if (got === undefined) continue
        if (typeof got === 'string') {
          out.send.push({ to: h.device, data: { t: 'denied', why: got } })
          continue
        }
        const admitted = got.device
        if (!devices.some(d => d.id === admitted.id && d.pk === admitted.pk && d.credentialKey === admitted.credentialKey)) {
          devices.splice(0, devices.length, ...withPaired(devices, [admitted]))
          out.paired.splice(0, out.paired.length, ...withPaired(out.paired, [admitted]))
        }
        out.send.push(welcome(h, admitted))
        poll.warmUntil = w.now + WARM_MS
      } else if (data.t === 'sync') {
        // A device back on a new socket (snapshots sent while it was away went nowhere): the latest, now.
        const c = conns.get(f.from)
        if (c) {
          c.last = { body: '', at: 0 }
          out.resync = true
        }
      } else if (data.t === 'box') {
        const conn = conns.get(f.from)
        const c = conn ? command(conn, data.b) : 'unread'
        // A device sealing for a channel this session does not have (it restarted, or a welcome went astray): ask it
        // for its hello again, once per answer. Its own command comes again under the same id once it has a channel.
        if (c === 'unread') {
          const mayTalk = w.devices.some(d => d.id === f.from && mayAccess(d, o.project, w.now))
          if (mayTalk && !out.send.some(x => x.to === f.from && obj(x.data).t === 'rehello')) out.send.push({ to: f.from, data: { t: 'rehello', session: o.session } })
        } else if (c) out.commands.push({ device: f.from, command: c })
      }
    }
    return out
  }

  /**
   * The snapshot sealed for every unlocked, connected device it is news to. A device looking at it gets every change,
   * and the same snapshot again as a heartbeat; one put away or out of focus gets at most one change per heartbeat
   * and no repeats, so a phone in a pocket or a tab behind other windows costs almost nothing.
   */
  function snapshots(s: Snapshot, now: number): OutFrame[] {
    const body = snapshotKey(s)
    const out: OutFrame[] = []
    for (const [id, c] of conns) {
      if (!connected.has(id)) continue
      const isDue = connected.get(id) ? body !== c.last.body || now - c.last.at >= HEARTBEAT_MS : body !== c.last.body && now - c.last.at >= HEARTBEAT_MS
      if (!isDue) continue
      c.last = { body, at: now }
      const { people, ...shared } = s
      const role = roleOf(c.device)
      const mine: Snapshot = role ? { ...shared, you: { role, until: c.device.until ?? 0 } } : { ...shared, ...(people ? { people } : {}) }
      out.push({ to: id, data: { t: 'box', b: c.ch.seal({ t: 'snapshot', snapshot: mine }) } })
    }
    return out
  }

  /** Whether no device could answer, or the relay failed and its backoff has not ended: then no snapshot is needed. */
  const isQuiet = (k: Known): boolean =>
    k.now < poll.retryAt ||
    (!k.devices.some(d => mayAccess(d, o.project, k.now)) && !(k.pairing && k.now < k.pairing.until) && !(k.invites ?? []).some(i => i.project === o.project && k.now < i.until))

  return {
    room: o.identity.room,

    /** The open channels as $.state keeps them, so a reload of the plugin takes them up again (`kept`). */
    kept: (): KeptConn[] =>
      [...conns.values()].map(c => ({ device: c.device, send: c.keys.send, recv: c.keys.recv, ...c.ch.counts(), peerEph: c.peerEph, peerNonce: c.peerNonce, welcome: c.welcome })),

    /** Whether a device with an open channel is looking now: only then are permission prompts held for it. */
    isLooking: () => [...conns.keys()].some(id => connected.get(id) === true),

    isQuiet,

    /**
     * Tells `device` what came of its command (`ack.id`), sealed in the next post; a later copy of the same command
     * gets the same ack again. Every command the adapter handles is acked, so the phone never has to guess.
     */
    ack: (device: string, ack: Ack) => queueAck(device, ack),

    /**
     * The post to send now, or none. A tick's first post waits until one is due: every tick while a permission is
     * held for a looking device (`isHolding`), when there are welcomes or a push hint to send (notify.ts), or when
     * the snapshot changed; every
     * 6 s while a paired device (any device while a pairing is open) looks or for a minute after a welcome; otherwise
     * every 30 s. An account with
     * nothing paired and no pairing open never posts, and a failed post waits out its backoff.
     */
    next(k: Known & { snapshot: Snapshot; isHolding: boolean }): UpBody | undefined {
      // A forgotten or expired device loses its channel at once, in every session: nothing more is sealed for it.
      for (const id of conns.keys()) if (!k.devices.some(d => d.id === id && mayAccess(d, o.project, k.now))) conns.delete(id)
      if (isQuiet(k)) return undefined
      const body = snapshotKey(k.snapshot)
      // Every snapshot is shown to the notifier, due or not, so news is seen once. Only devices that may see this
      // session: a guest of another project is never woken for it.
      const mayKnow = k.devices.filter(d => mayAccess(d, o.project, k.now)).map(d => d.id)
      const hint = notifier.hint(k.snapshot, mayKnow, id => connected.get(id) === true, k.now) ?? hintAgain
      hintAgain = undefined
      const isActive = k.now < poll.warmUntil || [...connected.values()].some(Boolean)
      const isDue =
        round > 0 ||
        k.isHolding ||
        outbox.length > 0 ||
        acks.length > 0 ||
        !!hint ||
        body !== poll.lastBody ||
        k.now - poll.lastAt >= (isActive ? ACTIVE_POLL_MS : mayKnow.length ? IDLE_POLL_MS : HEARTBEAT_MS)
      if (!isDue) return undefined
      // Acks are sealed like snapshots, on the device's current channel; one whose device has gone is dropped.
      const sealed = acks.flatMap(a => {
        const c = conns.get(a.to)
        return c ? [{ to: a.to, data: { t: 'box', b: c.ch.seal(a.ack) } }] : []
      })
      const frames = [...outbox, ...sealed, ...snapshots(k.snapshot, k.now)]
      sent = { frames, acks, body, known: { devices: k.devices, pairing: k.pairing, invites: k.invites, now: k.now }, ...(hint ? { hint } : {}) }
      outbox = []
      acks = []
      return { token: o.identity.token, session: o.session, since, frames, ...hint }
    },

    /**
     * Reads what the relay answered the last post: its body when the post succeeded, undefined when it failed. A
     * failure keeps the welcomes and denials to send again, drops the sealed snapshots (they are sealed afresh next
     * time, on the channel's next counter) and backs off: 4 s, doubling, at most one heartbeat (30 s).
     */
    answered(text: string | undefined, now: number): Answered {
      const s = sent
      sent = undefined
      const r = text === undefined ? undefined : upOf(text)
      if (!s || !r) {
        if (s) {
          outbox = [...s.frames.filter(f => obj(f.data).t !== 'box'), ...outbox]
          acks = [...s.acks, ...acks]
          hintAgain = s.hint
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
      round = ((outbox.length || t.resync) && round + 1 < MAX_ROUNDS) || (r.more && round + 1 < MORE_ROUNDS) ? round + 1 : 0
      return { paired: t.paired, commands: t.commands, again: round > 0 }
    },
  }
}

export type Link = ReturnType<typeof createLink>
