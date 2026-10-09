// A software passkey for tests, in place of Face ID: a real P-256 key that makes real WebAuthn registrations and
// assertions (ES256, user present and verified), so the session's checks run unchanged. Shared by the plugin's and
// the app's tests.
import { p256, sha256 } from '../hooks/vendor/noble'
import { b64u } from '../hooks/remote/seal'
import type { Registration } from '../hooks/remote/device'
import type { PasskeyAssertion } from '../hooks/remote/snapshot'

const SPKI_HEADER = Uint8Array.from('3059301306072a8648ce3d020106082a8648ce3d030107034200'.match(/../g) ?? [], h => parseInt(h, 16))
const utf8 = (s: string) => new TextEncoder().encode(s)
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]))

/** A P-256 public key as WebAuthn gives it (SPKI, b64u). */
export const spkiOf = (key: Uint8Array): string => b64u(concat(SPKI_HEADER, p256.getPublicKey(key, false)))

/** A passkey on `origin`. Each call may sign as another origin or with another key, as an attacker would. */
export function authenticator(origin: string, credentialId = b64u(p256.utils.randomSecretKey().slice(0, 16))) {
  const key = p256.utils.randomSecretKey()
  return {
    credentialId,
    spki: spkiOf(key),
    /** The pairing ceremony's result over `challenge`. */
    register: (challenge: string, o: { origin?: string } = {}): Registration => ({
      credentialId,
      publicKey: spkiOf(key),
      clientDataJSON: b64u(utf8(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? origin }))),
    }),
    /** An assertion over `challenge`, as the authenticator signs it. */
    assert(challenge: string, o: { origin?: string; key?: Uint8Array } = {}): PasskeyAssertion {
      const on = o.origin ?? origin
      const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.get', challenge, origin: on, crossOrigin: false }))
      const authData = concat(sha256(utf8(new URL(on).hostname)), Uint8Array.of(0x05), Uint8Array.of(0, 0, 0, 1))
      const signature = p256.sign(concat(authData, sha256(clientDataJSON)), o.key ?? key, { prehash: true, format: 'der' })
      return { authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) }
    },
  }
}
