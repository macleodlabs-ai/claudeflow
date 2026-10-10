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
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
      },
    })) as PublicKeyCredential | null
    const response = cred?.response as AuthenticatorAttestationResponse | undefined
    const spki = response?.getPublicKey?.()
    if (!cred || !response || !spki) return undefined
    return { credentialId: b64u(bytesOf(cred.rawId)), publicKey: b64u(bytesOf(spki)), clientDataJSON: b64u(bytesOf(response.clientDataJSON)) }
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
      },
    })) as PublicKeyCredential | null
    const r = cred?.response as AuthenticatorAssertionResponse | undefined
    if (!r) return undefined
    return { authenticatorData: b64u(bytesOf(r.authenticatorData)), clientDataJSON: b64u(bytesOf(r.clientDataJSON)), signature: b64u(bytesOf(r.signature)) }
  })
