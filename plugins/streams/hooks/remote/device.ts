import { channel, connectionKeys, newIdentity, pairingProof, passkeyChallenge, randomId } from './seal'
import { ackOf, type Ack, type PasskeyAssertion, type PhoneCommand, type Snapshot } from './snapshot'

// One device's side of the protocol (ARCHITECTURE.md, "Session ↔ device messages"), shared by the app and the tests
// like seal.ts: the hello, the welcome or denial, the sealed snapshots and commands. No socket and no WebAuthn in it:
// it gives the challenges to sign, takes the signed passkey assertions as data, and says what to send. The app's
// transport.ts does the WebSocket and Face ID.

/** This device's keys: one id and X25519 key pair for every room. */
export type DeviceKeys = { id: string; sk: string; pk: string }
/** A passkey made at pairing (fields b64u): its id, its public key as SPKI, and the ceremony's client data. */
export type Registration = { credentialId: string; publicKey: string; clientDataJSON: string }
/** A frame for the relay: `*` for every session of the room, or one session's id. */
export type DeviceFrame = { to: string; data: Record<string, unknown> }

/** What a frame from a session meant for this device. */
export type Received =
  | { t: 'welcome'; session: string }
  | { t: 'denied'; why: string; isPairing: boolean }
  | { t: 'snapshot'; snapshot: Snapshot }
  /** What the session did with one of this device's commands. */
  | { t: 'ack'; ack: Ack }

type Keys = { eph: { sk: string; pk: string }; nonce: string }

/**
 * The device in one room: `accountPk` is the account's public key from the pairing link. A connection starts with
 * a hello (`pairHello`, or `unlockChallenge` then `unlockHello`); each session that welcomes it gets its own sealed
 * channel. `reset` when the socket closes: nothing from the old connection carries over.
 */
export function createDevice(o: { device: DeviceKeys; room: string; accountPk: string; label?: string }) {
  /** The hello sent on this connection, which welcomes and denials answer. */
  let hello: (Keys & { isPairing: boolean }) | undefined
  /** Keys made for an unlock while Face ID is up, sent with its hello. */
  let pending: Keys | undefined
  const channels = new Map<string, ReturnType<typeof channel>>()

  const fresh = (): Keys => ({ eph: newIdentity(), nonce: randomId(32) })

  function send(k: Keys, isPairing: boolean, extra: Record<string, unknown>): DeviceFrame {
    hello = { ...k, isPairing }
    channels.clear()
    const label = o.label ? { label: o.label } : {}
    return { to: '*', data: { t: 'hello', device: o.device.id, pk: o.device.pk, eph: k.eph.pk, nonce: k.nonce, ...label, ...extra } }
  }

  return {
    isUnlocked: () => channels.size > 0,
    hasChannel: (session: string) => channels.has(session),

    /** What the pairing passkey signs: this pairing's room and this device, so the relay cannot reuse it elsewhere. */
    pairChallenge: () => passkeyChallenge('pair', o.room, o.device.id, o.device.pk),

    /** The first hello: proof that this device saw the QR code's secret, covering everything the session stores. */
    pairHello: (secret: string, reg: Registration): DeviceFrame =>
      send(fresh(), true, { proof: pairingProof(secret, o.device.id, o.device.pk, reg.credentialId, reg.publicKey), registration: reg }),

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
      const ch = channels.get(session)
      return ch && { to: session, data: { t: 'box', b: ch.seal({ t: 'command', command }) } }
    },

    /** Reads a frame from session `from`; undefined for anything that is not for this connection or does not open. */
    receive(from: string, d: Record<string, unknown>): Received | undefined {
      if (d.t === 'welcome' && hello && typeof d.eph === 'string' && typeof d.nonce === 'string') {
        const k = connectionKeys({ ownSk: o.device.sk, peerPk: o.accountPk, ownEphSk: hello.eph.sk, peerEphPk: d.eph, sessionNonce: d.nonce, deviceNonce: hello.nonce })
        channels.set(from, channel(k.deviceToSession, k.sessionToDevice))
        return { t: 'welcome', session: from }
      }
      if (d.t === 'denied' && hello) return { t: 'denied', why: typeof d.why === 'string' ? d.why.slice(0, 200) : 'refused', isPairing: hello.isPairing }
      if (d.t !== 'box' || typeof d.b !== 'string') return undefined
      const ch = channels.get(from)
      if (!ch) return undefined
      try {
        const x = ch.open(d.b) as { t?: string; snapshot?: Snapshot }
        const ack = ackOf(x)
        if (ack) return { t: 'ack', ack }
        // A session speaks only for itself: a snapshot naming another session is dropped.
        return x?.t === 'snapshot' && x.snapshot?.v === 1 && x.snapshot.session?.id === from ? { t: 'snapshot', snapshot: x.snapshot } : undefined
      } catch {
        // Tampered, replayed or reordered: dropped, the next snapshot comes within 30 s.
        return undefined
      }
    },

    /** The socket closed: a new connection needs a new hello, and so a new Face ID. */
    reset() {
      hello = undefined
      pending = undefined
      channels.clear()
    },
  }
}

export type DeviceCore = ReturnType<typeof createDevice>
