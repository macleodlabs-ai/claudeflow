// The device's passkeys (WebAuthn, ES256): one made per room at pairing, then one assertion per connection (the
// hello) and one per Allow. Sessions check them with seal.ts's verifyPasskey; the challenge strings come from
// passkeyChallenge, so the bytes signed here are exactly the b64u the session compares.
import { b64u, fromB64u } from '../../plugins/streams/hooks/remote/seal'
import type { Registration } from '../../plugins/streams/hooks/remote/device'
import type { PasskeyAssertion } from '../../plugins/streams/hooks/remote/snapshot'

const bytesOf = (b: ArrayBuffer): Uint8Array => new Uint8Array(b)
const buf = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(fromB64u(s))

/**
 * Makes this room's passkey over `challenge` (the session checks it names this pairing); undefined when the person
 * cancels or the device has no passkey support.
 */
export async function createPasskey(label: string, challenge: string): Promise<Registration | undefined> {
  const cred = (await navigator.credentials
    .create({
      publicKey: {
        challenge: buf(challenge),
        rp: { name: 'Claudeflow', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `Claudeflow ${label}`, displayName: 'Claudeflow' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        attestation: 'none',
      },
    })
    .catch(() => null)) as PublicKeyCredential | null
  const response = cred?.response as AuthenticatorAttestationResponse | undefined
  const spki = response?.getPublicKey?.()
  if (!cred || !response || !spki) return undefined
  return { credentialId: b64u(bytesOf(cred.rawId)), publicKey: b64u(bytesOf(spki)), clientDataJSON: b64u(bytesOf(response.clientDataJSON)) }
}

/** Signs a challenge with Face ID (or the passcode); undefined when the person cancels. */
export async function assertPasskey(credentialId: string, challenge: string): Promise<PasskeyAssertion | undefined> {
  const cred = (await navigator.credentials
    .get({
      publicKey: {
        challenge: buf(challenge),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: [{ type: 'public-key', id: buf(credentialId) }],
      },
    })
    .catch(() => null)) as PublicKeyCredential | null
  const r = cred?.response as AuthenticatorAssertionResponse | undefined
  if (!r) return undefined
  return { authenticatorData: b64u(bytesOf(r.authenticatorData)), clientDataJSON: b64u(bytesOf(r.clientDataJSON)), signature: b64u(bytesOf(r.signature)) }
}
