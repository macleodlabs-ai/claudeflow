// The device's passkeys (WebAuthn, ES256): one made per room at pairing, then one assertion per connection (the
// hello) and one per Allow. Sessions check them with seal.ts's verifyPasskey; the challenge strings come from
// passkeyChallenge, so the bytes signed here are exactly the b64u the session compares.
import { b64u, fromB64u } from '../../plugins/streams/hooks/remote/seal'
import type { Registration } from '../../plugins/streams/hooks/remote/device'
import type { PasskeyAssertion } from '../../plugins/streams/hooks/remote/snapshot'

const bytesOf = (b: ArrayBuffer): Uint8Array => new Uint8Array(b)
const buf = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(fromB64u(s))

/** A ceremony's outcome: its value, or why not in words a person reads. */
export type Ceremony<T> = { ok: true; value: T } | { ok: false; why: string }

/**
 * One ceremony at a time, app-wide: a second tap while Face ID is up (or a tap in another room's gate) starts nothing.
 * A second ceremony is how a slow network once paired one phone twice.
 */
let inFlight = false
export const isCeremonyBusy = (): boolean => inFlight

/** A WebAuthn failure in plain words. NotAllowedError covers both a cancel and the browser's own timeout. */
export function plainWhy(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name
  if (name === 'NotAllowedError') return 'Face ID was cancelled or timed out. Tap to try again.'
  if (name === 'InvalidStateError') return 'This device already has that passkey. Tap to try again.'
  if (name === 'SecurityError') return 'Passkeys need this page to be opened from its https address.'
  if (name === 'NotSupportedError') return "This browser can't use passkeys. Try Safari or Chrome."
  if (name === 'AbortError') return 'Face ID was interrupted. Tap to try again.'
  return "Face ID didn't work. Tap to try again."
}

async function once<T>(step: () => Promise<T | undefined>): Promise<Ceremony<T>> {
  if (inFlight) return { ok: false, why: 'Finish the Face ID that is already open.' }
  inFlight = true
  try {
    const value = await step()
    return value ? { ok: true, value } : { ok: false, why: plainWhy(undefined) }
  } catch (e) {
    return { ok: false, why: plainWhy(e) }
  } finally {
    inFlight = false
  }
}

/** Makes this room's passkey over `challenge` (the session checks it names this pairing). */
export const createPasskey = (label: string, challenge: string): Promise<Ceremony<Registration>> =>
  once(async () => {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: buf(challenge),
        rp: { name: 'Claudeflow', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `Claudeflow ${label}`, displayName: 'Claudeflow' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        // No attachment asked: where nothing is built in (Linux, some Windows) the browser offers a phone or a key.
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null
    const response = cred?.response as AuthenticatorAttestationResponse | undefined
    const spki = response?.getPublicKey?.()
    if (!cred || !response || !spki) return undefined
    return { credentialId: b64u(bytesOf(cred.rawId)), publicKey: b64u(bytesOf(spki)), clientDataJSON: b64u(bytesOf(response.clientDataJSON)) }
  })

// ---- A guest's browser key, for a browser with no way to make a passkey ----
// A P-256 key made here, not extractable, kept in IndexedDB: it signs what a passkey would (client data and
// authenticator data, DER), with "user present" only, so the session's own check reads it unchanged. It proves this
// browser, not who uses it, so the session lets it only watch (link.ts roleOf) and never pairs an owner's device.

const KEYS_DB = 'cf-keys'
function keyStore<T>(mode: IDBTransactionMode, step: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((ok, no) => {
    const open = indexedDB.open(KEYS_DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('keys')
    open.onerror = () => no(open.error)
    open.onsuccess = () => {
      const r = step(open.result.transaction('keys', mode).objectStore('keys'))
      r.onsuccess = () => ok(r.result)
      r.onerror = () => no(r.error)
    }
  })
}

/** A WebCrypto ECDSA signature (r‖s, 32 bytes each) in the DER form WebAuthn uses. */
export function derOf(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    const v = b.subarray(i)
    return v[0]! & 0x80 ? Uint8Array.of(0, ...v) : v
  }
  const r = int(raw.subarray(0, 32))
  const s = int(raw.subarray(32))
  return Uint8Array.of(0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s)
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const sha = async (b: Uint8Array): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>))

/** What `key` signs for `challenge` on `origin`, shaped as a passkey's assertion: user present, not verified. */
export async function browserAssertion(key: CryptoKey, challenge: string, origin: string): Promise<PasskeyAssertion> {
  const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }))
  const authData = Uint8Array.of(...(await sha(utf8(new URL(origin).hostname))), 0x01, 0, 0, 0, 0)
  const signed = Uint8Array.of(...authData, ...(await sha(clientDataJSON)))
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed))
  return { authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(derOf(raw)) }
}

/** Makes this browser's key for a guest's room, kept in IndexedDB under its id; registered as a browser key. */
export const createBrowserKey = (challenge: string): Promise<Ceremony<Registration>> =>
  once(async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair
    const credentialId = b64u(crypto.getRandomValues(new Uint8Array(16)))
    await keyStore('readwrite', s => s.put(pair, credentialId))
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
    const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.create', challenge, origin: location.origin }))
    return { credentialId, publicKey: b64u(spki), clientDataJSON: b64u(clientDataJSON), browser: true as const }
  })

/** Signs a challenge with this browser's key for the room: no prompt. */
export const assertBrowserKey = (credentialId: string, challenge: string): Promise<Ceremony<PasskeyAssertion>> =>
  once(async () => {
    const pair = await keyStore<CryptoKeyPair | undefined>('readonly', s => s.get(credentialId))
    return pair ? browserAssertion(pair.privateKey, challenge, location.origin) : undefined
  })

/** Signs a challenge with Face ID (or the passcode). */
export const assertPasskey = (credentialId: string, challenge: string): Promise<Ceremony<PasskeyAssertion>> =>
  once(async () => {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: buf(challenge),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: buf(credentialId) }],
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null
    const r = cred?.response as AuthenticatorAssertionResponse | undefined
    if (!r) return undefined
    return { authenticatorData: b64u(bytesOf(r.authenticatorData)), clientDataJSON: b64u(bytesOf(r.clientDataJSON)), signature: b64u(bytesOf(r.signature)) }
  })
