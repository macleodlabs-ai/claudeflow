import { describe, expect, test } from 'claude-code/testing'
import { p256, sha256 } from '../hooks/vendor/noble'
import {
  b64u,
  channel,
  connectionKeys,
  fromB64u,
  newIdentity,
  pairingProof,
  passkeyChallenge,
  publicKeyOf,
  randomId,
  verifyPasskey,
} from '../hooks/remote/seal'

// The relay sees every frame and can drop, replay, reorder, alter or substitute keys; these tests hold the
// properties that make that harmless: it learns nothing, and anything it changes is refused.

const utf8 = (s: string) => new TextEncoder().encode(s)
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(p => [...p]))

/** Both ends of one connection, keyed the way session and device each derive them from their own view. */
function connect(sessionPk = '', devicePk = '') {
  const session = newIdentity()
  const device = newIdentity()
  const sEph = newIdentity()
  const dEph = newIdentity()
  const sessionNonce = randomId(32)
  const deviceNonce = randomId(32)
  const atSession = connectionKeys({
    ownSk: session.sk, peerPk: devicePk || device.pk, ownEphSk: sEph.sk, peerEphPk: dEph.pk, sessionNonce, deviceNonce,
  })
  const atDevice = connectionKeys({
    ownSk: device.sk, peerPk: sessionPk || session.pk, ownEphSk: dEph.sk, peerEphPk: sEph.pk, sessionNonce, deviceNonce,
  })
  return {
    session: channel(atSession.sessionToDevice, atSession.deviceToSession),
    device: channel(atDevice.deviceToSession, atDevice.sessionToDevice),
  }
}

describe('keys and encoding', () => {
  test('ids and keys have the sizes the protocol stores', () => {
    // Rooms and device ids are 22 chars and keys 32 bytes; other modules and the relay rely on these shapes.
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const id = newIdentity()
    expect(fromB64u(id.pk)).toHaveLength(32)
    expect(publicKeyOf(id.sk)).toBe(id.pk)
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect([...fromB64u(b64u(all))]).toEqual([...all])
  })
})

describe('sealed channel', () => {
  test('round trips both directions', () => {
    const { session, device } = connect()
    expect(device.open(session.seal({ t: 'snapshot', n: 1 }))).toEqual({ t: 'snapshot', n: 1 })
    expect(session.open(device.seal({ t: 'command', command: 'stop' }))).toEqual({ t: 'command', command: 'stop' })
    expect(device.open(session.seal('second'))).toBe('second')
  })

  test('sealed text reveals nothing of the message', () => {
    // The relay stores and forwards these; a readable fragment would leak the user's session to it.
    const { session } = connect()
    const box = session.seal({ secret: 'rm -rf the-project' })
    expect(box).not.toContain('rm -rf')
    expect(box).not.toContain('secret')
    expect(String.fromCharCode(...fromB64u(box.split('.')[1]!))).not.toContain('rm -rf')
  })

  test('a tampered box is refused', () => {
    const { session, device } = connect()
    const box = session.seal({ allow: false })
    const ct = fromB64u(box.split('.')[1]!)
    ct[0]! ^= 1
    expect(() => device.open(`0.${b64u(ct)}`)).toThrow()
    // Moving a box to another counter is tampering too: the nonce changes, so it no longer authenticates.
    expect(() => device.open(box.replace(/^0\./, '1.'))).toThrow()
    expect(device.open(box)).toEqual({ allow: false })
  })

  test('replayed and reordered boxes are refused', () => {
    // Replaying an old "allow" or reordering commands would let the relay act for the user.
    const { session, device } = connect()
    const first = session.seal('a')
    const second = session.seal('b')
    const third = session.seal('c')
    expect(device.open(second)).toBe('b')
    expect(() => device.open(second)).toThrow()
    expect(() => device.open(first)).toThrow()
    expect(device.open(third)).toBe('c')
  })

  test('a forged box does not move the counter on', () => {
    // Otherwise one junk frame numbered high would make the channel refuse every real box after it.
    const { session, device } = connect()
    expect(() => device.open('99.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toThrow()
    expect(device.open(session.seal('ok'))).toBe('ok')
  })

  test('a relay that swaps a static key cannot open either direction', () => {
    // The relay relays the ephemeral keys too, so only the paired static keys stop it standing in the middle.
    const relay = newIdentity()
    const toDevice = connect('', relay.pk)
    expect(() => toDevice.device.open(toDevice.session.seal('x'))).toThrow()
    expect(() => toDevice.session.open(toDevice.device.seal('x'))).toThrow()
    const toSession = connect(relay.pk, '')
    expect(() => toSession.device.open(toSession.session.seal('x'))).toThrow()
    expect(() => toSession.session.open(toSession.device.seal('x'))).toThrow()
  })
})

describe('pairing proof', () => {
  test('binds the pairing secret and the device key', () => {
    // Without the QR code's secret no one can pair, and a relay cannot move a proof onto its own key.
    const secret = randomId(32)
    const device = newIdentity()
    const proof = pairingProof(secret, device.pk)
    expect(pairingProof(secret, device.pk)).toBe(proof)
    expect(pairingProof(randomId(32), device.pk)).not.toBe(proof)
    expect(pairingProof(secret, newIdentity().pk)).not.toBe(proof)
  })
})

describe('passkey assertions', () => {
  const ORIGIN = 'https://claudeflow.example.workers.dev'
  const SPKI_HEADER = Uint8Array.from('3059301306072a8648ce3d020106082a8648ce3d030107034200'.match(/../g)!, h => parseInt(h, 16))
  const sk = p256.utils.randomSecretKey()
  const spki = b64u(concat(SPKI_HEADER, p256.getPublicKey(sk, false)))
  const challenge = passkeyChallenge('allow', 'req-1', 'eph')

  /** A real assertion as an authenticator makes it, with each part overridable to fake one fault. */
  function assertion(o: { type?: string; challenge?: string; origin?: string; rpHost?: string; flags?: number; key?: Uint8Array } = {}) {
    const clientDataJSON = utf8(JSON.stringify({
      type: o.type ?? 'webauthn.get', challenge: o.challenge ?? challenge, origin: o.origin ?? ORIGIN, crossOrigin: false,
    }))
    const authData = concat(sha256(utf8(o.rpHost ?? 'claudeflow.example.workers.dev')), Uint8Array.of(o.flags ?? 0x05), Uint8Array.of(0, 0, 0, 7))
    const signature = p256.sign(concat(authData, sha256(clientDataJSON)), o.key ?? sk, { prehash: true, format: 'der' })
    return { authenticatorData: b64u(authData), clientDataJSON: b64u(clientDataJSON), signature: b64u(signature) }
  }

  test('accepts a correct assertion', () => {
    expect(verifyPasskey(assertion(), spki, challenge, ORIGIN)).toBe(true)
  })

  test('accepts a high-S signature', () => {
    // WebAuthn authenticators may return either S; refusing high S would fail about half of real Face ID checks.
    const a = assertion()
    const sig = p256.Signature.fromBytes(fromB64u(a.signature), 'der')
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
    const high = new p256.Signature(sig.r, N - sig.s).toBytes('der')
    expect(verifyPasskey({ ...a, signature: b64u(high) }, spki, challenge, ORIGIN)).toBe(true)
  })

  test('rejects an assertion made for anything else', () => {
    // Each is a way to reuse a Face ID elsewhere: another request, a phishing site, a registration, no biometrics.
    expect(verifyPasskey(assertion({ challenge: passkeyChallenge('allow', 'req-2', 'eph') }), spki, challenge, ORIGIN)).toBe(false)
    expect(verifyPasskey(assertion({ origin: 'https://evil.example' }), spki, challenge, ORIGIN)).toBe(false)
    expect(verifyPasskey(assertion({ rpHost: 'evil.example' }), spki, challenge, ORIGIN)).toBe(false)
    expect(verifyPasskey(assertion({ type: 'webauthn.create' }), spki, challenge, ORIGIN)).toBe(false)
    expect(verifyPasskey(assertion({ flags: 0x01 }), spki, challenge, ORIGIN)).toBe(false)
    expect(verifyPasskey(assertion({ flags: 0x04 }), spki, challenge, ORIGIN)).toBe(false)
  })

  test('rejects another key and altered authenticator data', () => {
    expect(verifyPasskey(assertion({ key: p256.utils.randomSecretKey() }), spki, challenge, ORIGIN)).toBe(false)
    const a = assertion()
    const authData = fromB64u(a.authenticatorData)
    authData[36]! ^= 1
    expect(verifyPasskey({ ...a, authenticatorData: b64u(authData) }, spki, challenge, ORIGIN)).toBe(false)
    expect(verifyPasskey({ ...a, signature: 'garbage' }, spki, challenge, ORIGIN)).toBe(false)
  })
})
