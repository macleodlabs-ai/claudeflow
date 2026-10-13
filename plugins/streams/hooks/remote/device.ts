import { channel, connectionKeys, newIdentity, pairingProof, passkeyChallenge, randomId, relayHash, relayPairToken } from './seal'
import { ackOf, type Ack, type PasskeyAssertion, type PhoneCommand, type Snapshot } from './snapshot'

// One device's side of the protocol (ARCHITECTURE.md, "Session ↔ device messages"), shared by the app and the tests
// like seal.ts: the hello, the welcome or denial, the sealed snapshots and commands. No socket and no WebAuthn in it:
// it gives the challenges to sign, takes the signed passkey assertions as data, and says what to send. The app's
// transport.ts does the WebSocket and Face ID.

/** This device's keys: one id and X25519 key pair for every room. */
export type DeviceKeys = { id: string; sk: string; pk: string }
/**
 * A passkey made at pairing (fields b64u): its id, its public key as SPKI, and the ceremony's client data. `browser`:
 * not a passkey but a key this browser keeps (a guest whose device has no authenticator), so watch only.
 */
export type Registration = { credentialId: string; publicKey: string; clientDataJSON: string; browser?: true }
/** A frame for the relay: `*` for every session of the room, or one session's id. */
export type DeviceFrame = { to: string; data: Record<string, unknown> }

/** What a frame from a session meant for this device. */
export type Received =
  | { t: 'welcome'; session: string }
  | { t: 'denied'; why: string; isPairing: boolean }
  | { t: 'snapshot'; snapshot: Snapshot }
  /** What the session did with one of this device's commands. */
  | { t: 'ack'; ack: Ack }
  /**
   * A session has no channel with this device (it started after the welcome, or its welcome went astray): sending the
   * same hello again opens one, while the hello is fresh; otherwise only a new unlock does.
   */
  | { t: 'rehello'; session: string }

type Keys = { eph: { sk: string; pk: string }; nonce: string }

/** What a pairing proof covers: all the session stores for the device, a browser key's kind included. */
export const proofParts = (device: { id: string; pk: string }, reg: { credentialId: string; publicKey: string; browser?: unknown }): string[] =>
  [device.id, device.pk, reg.credentialId, reg.publicKey, ...(reg.browser === true ? ['browser'] : [])]

/**
 * The device in one room: `accountPk` is the account's public key from the pairing link. A connection starts with
 * a hello (`pairHello`, or `unlockChallenge` then `unlockHello`); each session that welcomes it gets its own sealed
 * channel. The channels outlive the socket (the relay only carries sealed frames): `reset` is for locking.
 */
/**
 * The WebSocket protocol a device opens its relay socket with, `sr.<relay key>[.<pairing token>]`: its relay key,
 * which the relay checks against the hash its sessions admitted, and while it pairs, the token derived from the
 * link's secret (never the secret). One protocol: some clients fail a handshake that offers several.
 */
export const relayProtocols = (relayKey: string, secret?: string): string[] => [`sr.${relayKey}${secret ? `.${relayPairToken(secret)}` : ''}`]

/** `relayKey`: this device's key for the room's relay sockets (random, kept with its pairing); its hash goes in every hello. */
export function createDevice(o: { device: DeviceKeys; room: string; accountPk: string; label?: string; relayKey?: string }) {
  /** The hello sent on this connection, which welcomes and denials answer. */
  let hello: (Keys & { isPairing: boolean }) | undefined
  /** Keys made for an unlock while Face ID is up, sent with its hello. */
  let pending: Keys | undefined
  /** Each session's channel, with the welcome that opened it: the same welcome again keeps it, counters and all. */
  const channels = new Map<string, { ch: ReturnType<typeof channel>; from: string }>()

  const fresh = (): Keys => ({ eph: newIdentity(), nonce: randomId(32) })

  function send(k: Keys, isPairing: boolean, extra: Record<string, unknown>, name = o.label): DeviceFrame {
    hello = { ...k, isPairing }
    channels.clear()
    const label = name ? { label: name } : {}
    const rk = o.relayKey ? { rk: relayHash(o.relayKey) } : {}
    return { to: '*', data: { t: 'hello', device: o.device.id, pk: o.device.pk, eph: k.eph.pk, nonce: k.nonce, ...label, ...rk, ...extra } }
  }

  return {
    isUnlocked: () => channels.size > 0,
    hasChannel: (session: string) => channels.has(session),

    /** What the pairing passkey signs: this pairing's room and this device, so the relay cannot reuse it elsewhere. */
    pairChallenge: () => passkeyChallenge('pair', o.room, o.device.id, o.device.pk),

    /**
     * The first hello: proof that this device saw the QR code's secret, covering everything the session stores.
     * `label` is the name the owner sees for it (a guest's own name), when given.
     */
    pairHello: (secret: string, reg: Registration, label?: string): DeviceFrame =>
      send(fresh(), true, { proof: pairingProof(secret, ...proofParts(o.device, reg)), registration: reg }, label || o.label),

    /** What Face ID signs to unlock: this room, a new connection key and the minute (`now`, ms). */
    unlockChallenge(now: number): string {
      pending = fresh()
      return passkeyChallenge('hello', o.room, pending.eph.pk, Math.floor(now / 60_000))
    },

    /** The unlock hello, with the assertion over `unlockChallenge`; undefined if no challenge was made. */
    unlockHello(passkey: PasskeyAssertion): DeviceFrame | undefined {
      const k = pending
      pending = undefined
      return k && send(k, false, { passkey })
    },

    /** What Face ID signs to allow a request: the request and this connection's key, so it works only here. */
    allowChallenge: (requestId: string): string | undefined => hello && passkeyChallenge('allow', requestId, hello.eph.pk),

    /** A command sealed for one session (an Allow carries its assertion over `allowChallenge`); none without a channel. */
    seal(session: string, command: PhoneCommand): DeviceFrame | undefined {
      const ch = channels.get(session)?.ch
      return ch && { to: session, data: { t: 'box', b: ch.seal({ t: 'command', command }) } }
    },

    /** Reads a frame from session `from`; undefined for anything that is not for this connection or does not open. */
    receive(from: string, d: Record<string, unknown>): Received | undefined {
      // A welcome naming another hello answers an older connection's: its keys are not this hello's.
      if (d.t === 'welcome' && typeof d.hello === 'string' && d.hello !== hello?.eph.pk) return undefined
      if (d.t === 'welcome' && hello && typeof d.eph === 'string' && typeof d.nonce === 'string') {
        const id = `${d.eph}.${d.nonce}`
        if (channels.get(from)?.from !== id) {
          const k = connectionKeys({ ownSk: o.device.sk, peerPk: o.accountPk, ownEphSk: hello.eph.sk, peerEphPk: d.eph, sessionNonce: d.nonce, deviceNonce: hello.nonce })
          channels.set(from, { ch: channel(k.deviceToSession, k.sessionToDevice), from: id })
        }
        return { t: 'welcome', session: from }
      }
      if (d.t === 'rehello') return hello && !hello.isPairing ? { t: 'rehello', session: from } : undefined
      if (d.t === 'denied' && hello) return { t: 'denied', why: typeof d.why === 'string' ? d.why.slice(0, 200) : 'refused', isPairing: hello.isPairing }
      if (d.t !== 'box' || typeof d.b !== 'string') return undefined
      const ch = channels.get(from)?.ch
      // A sealed frame from a session this device has no channel with: that session has a channel this device lost.
      if (!ch) return hello && !hello.isPairing ? { t: 'rehello', session: from } : undefined
      try {
        const x = ch.open(d.b) as { t?: string; snapshot?: Snapshot }
        const ack = ackOf(x)
        if (ack) return { t: 'ack', ack }
        // A session speaks only for itself: a snapshot naming another session is dropped.
        return x?.t === 'snapshot' && x.snapshot?.v === 1 && x.snapshot.session?.id === from ? { t: 'snapshot', snapshot: x.snapshot } : undefined
      } catch (e) {
        // Replayed or reordered: dropped, the next snapshot comes within 30 s. One that does not open at all is sealed
        // on a channel this device does not have (a session on an older plugin opened a new one for a repeated
        // hello): the hello again settles which.
        if ((e as Error).message.includes('replayed')) return undefined
        return hello && !hello.isPairing ? { t: 'rehello', session: from } : undefined
      }
    },

    /** Locked: the channels and the hello go, so seeing this room again needs a new Face ID. A socket closing is not this. */
    reset() {
      hello = undefined
      pending = undefined
      channels.clear()
    },
  }
}

export type DeviceCore = ReturnType<typeof createDevice>
