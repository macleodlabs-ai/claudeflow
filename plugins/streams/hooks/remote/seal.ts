// The protocol's crypto (ARCHITECTURE.md, "Crypto"), shared by the plugin and the app's browser bundle.
// Pure JS on the bundled noble: the plugin runtime's crypto.subtle has only digest, and nothing here may use Node.
import { hkdf, hmac, p256, randomBytes, sha256, x25519, xchacha20poly1305 } from '../vendor/noble'

type Bytes = Uint8Array

const utf8 = (s: string): Bytes => new TextEncoder().encode(s)

/** base64url without padding. */
export function b64u(bytes: Bytes): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url')
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

/** Keys and nonces travel and are stored as b64u; callers may also hand raw bytes. */
const bytes = (v: string | Bytes): Bytes => (typeof v === 'string' ? fromB64u(v) : v)

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A random id of n bytes, b64u (16 bytes → 22 chars: rooms, devices; 32 for tokens, secrets, nonces). */
export const randomId = (n = 16): string => b64u(randomBytes(n))

/** A fresh X25519 key pair, b64u: an account identity, a device, or a connection's ephemeral key. */
export function newIdentity(): { sk: string; pk: string } {
  const sk = x25519.utils.randomSecretKey()
  return { sk: b64u(sk), pk: b64u(x25519.getPublicKey(sk)) }
}

export const publicKeyOf = (sk: string): string => b64u(x25519.getPublicKey(fromB64u(sk)))

const INFO = utf8('claudeflow-remote-v2')

/**
 * The two directions' keys for one session ↔ device connection. The ephemeral half gives forward secrecy; the
 * static half binds the connection to the paired keys, so a relay swapping in its own keys derives different ones.
 */
export function connectionKeys(k: {
  ownSk: string | Bytes
  peerPk: string | Bytes
  ownEphSk: string | Bytes
  peerEphPk: string | Bytes
  sessionNonce: string | Bytes
  deviceNonce: string | Bytes
}): { sessionToDevice: Bytes; deviceToSession: Bytes } {
  const ikm = concat(
    x25519.getSharedSecret(bytes(k.ownEphSk), bytes(k.peerEphPk)),
    x25519.getSharedSecret(bytes(k.ownSk), bytes(k.peerPk)),
  )
  const okm = hkdf(sha256, ikm, concat(bytes(k.sessionNonce), bytes(k.deviceNonce)), INFO, 64)
  return { sessionToDevice: okm.slice(0, 32), deviceToSession: okm.slice(32) }
}

/** The nonce for message n: 16 zero bytes, then n as 8-byte big-endian. Unique because each key has one sender. */
function nonceFor(n: number): Bytes {
  const nonce = new Uint8Array(24)
  new DataView(nonce.buffer).setBigUint64(16, BigInt(n))
  return nonce
}

/**
 * One end of a sealed channel. `open` throws on anything that is not the next-or-later box from the peer, so the
 * relay can neither alter, replay nor reorder messages; it only advances after a box authenticates.
 */
export function channel(sendKey: Bytes, recvKey: Bytes) {
  let sent = 0
  let lastOpened = -1
  return {
    seal(obj: unknown): string {
      const n = sent++
      return `${n}.${b64u(xchacha20poly1305(sendKey, nonceFor(n)).encrypt(utf8(JSON.stringify(obj))))}`
    },
    open(box: string): unknown {
      const m = /^(0|[1-9]\d{0,15})\.([A-Za-z0-9_-]+)$/.exec(box)
      const n = m ? Number(m[1]) : NaN
      if (!m || !Number.isSafeInteger(n)) throw new Error('malformed box')
      if (n <= lastOpened) throw new Error('replayed or reordered box')
      const plain = xchacha20poly1305(recvKey, nonceFor(n)).decrypt(fromB64u(m[2]!))
      lastOpened = n
      return JSON.parse(new TextDecoder().decode(plain))
    },
  }
}

/**
 * Shows a device saw the pairing secret (the QR code) and ties that to everything the session will store for it
 * (id, X25519 key, passkey id and key, joined by `|`): the relay sees the hello and must not be able to swap any.
 */
export const pairingProof = (secret: string, ...parts: string[]): string =>
  b64u(hmac(sha256, fromB64u(secret), utf8(parts.join('|'))))

export const passkeyChallenge = (...parts: (string | number)[]): string => b64u(sha256(utf8(parts.join('|'))))

const equalBytes = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Checks a WebAuthn assertion (fields b64u) made by the paired passkey, for this challenge, on this origin, with the
 * user present and verified (Face ID). False on anything else, never throws.
 */
export function verifyPasskey(
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string },
  credentialKeySpki: string,
  challenge: string,
  origin: string,
): boolean {
  try {
    const authData = fromB64u(assertion.authenticatorData)
    const clientDataJSON = fromB64u(assertion.clientDataJSON)
    const client = JSON.parse(new TextDecoder().decode(clientDataJSON))
    if (client?.type !== 'webauthn.get' || client.challenge !== challenge || client.origin !== origin) return false
    const host = /^https?:\/\/([^/:?#]+)(:\d+)?$/.exec(origin)?.[1]
    if (!host || authData.length < 37) return false
    if (!equalBytes(authData.subarray(0, 32), sha256(utf8(host)))) return false
    if ((authData[32]! & 0x05) !== 0x05) return false
    // WebAuthn does not ask authenticators for low-S signatures, so high S must verify too.
    return p256.verify(
      fromB64u(assertion.signature),
      concat(authData, sha256(clientDataJSON)),
      fromB64u(credentialKeySpki).slice(-65),
      { prehash: true, format: 'der', lowS: false },
    )
  } catch {
    return false
  }
}
