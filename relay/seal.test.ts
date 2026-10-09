// What the hosted tier promises, as tests: the relay forwards what it cannot open, cannot alter, cannot replay,
// and cannot read by swapping in its own key. bun test relay
import { describe, expect, test } from 'bun:test'
import { channel, connectionKeys, exportPub, newKeyPair, pairingProof, randomId } from '../plugins/streams/bridge/seal.js'
import { verifyAssertion } from '../plugins/streams/bridge/remote.ts'

async function pairUp(macStaticPubSeenByPhone?: string) {
  const mac = await newKeyPair()
  const phone = await newKeyPair()
  const macEph = await newKeyPair()
  const phoneEph = await newKeyPair()
  const macNonce = randomId()
  const phoneNonce = randomId()
  const macKeys = await connectionKeys({
    ownStatic: mac, peerStaticPub: await exportPub(phone.publicKey), ownEphemeral: macEph,
    peerEphemeralPub: await exportPub(phoneEph.publicKey), macNonce, phoneNonce,
  })
  const phoneKeys = await connectionKeys({
    ownStatic: phone, peerStaticPub: macStaticPubSeenByPhone ?? (await exportPub(mac.publicKey)), ownEphemeral: phoneEph,
    peerEphemeralPub: await exportPub(macEph.publicKey), macNonce, phoneNonce,
  })
  return { macSide: channel(macKeys.macToPhone, macKeys.phoneToMac), phoneSide: channel(phoneKeys.phoneToMac, phoneKeys.macToPhone) }
}

describe('the sealed channel', () => {
  test('a paired Mac and phone read each other, and the sealed text gives nothing away', async () => {
    const { macSide, phoneSide } = await pairUp()
    const box = await macSide.seal({ t: 'sessions', sessions: [{ name: 'billing', secret: 'sk-live-123' }] })
    expect(box).not.toContain('billing')
    expect(box).not.toContain('sk-live')
    expect(await phoneSide.open(box)).toEqual({ t: 'sessions', sessions: [{ name: 'billing', secret: 'sk-live-123' }] })
    expect(await macSide.open(await phoneSide.seal({ t: 'command', command: { kind: 'stop' } }))).toEqual({ t: 'command', command: { kind: 'stop' } })
  })

  test('a relay that changes a message, or sends it again, gets it dropped', async () => {
    const { macSide, phoneSide } = await pairUp()
    const box = await phoneSide.seal({ t: 'command', command: { kind: 'answer', text: 'yes' } })
    const [n, body] = box.split('.')
    const flipped = `${n}.${body!.slice(0, 10)}${body![10] === 'A' ? 'B' : 'A'}${body!.slice(11)}`
    await expect(macSide.open(flipped)).rejects.toThrow()
    expect(await macSide.open(box)).toEqual({ t: 'command', command: { kind: 'answer', text: 'yes' } })
    await expect(macSide.open(box)).rejects.toThrow('replayed')
  })

  // The QR code pins the Mac's key on the phone: a relay answering with a key of its own derives different keys.
  test('a relay that swaps in its own key cannot read or write the conversation', async () => {
    const relayKey = await exportPub((await newKeyPair()).publicKey)
    const { macSide, phoneSide } = await pairUp(relayKey)
    await expect(phoneSide.open(await macSide.seal({ t: 'sessions' }))).rejects.toThrow()
    await expect(macSide.open(await phoneSide.seal({ t: 'command' }))).rejects.toThrow()
  })

  test('only the phone that saw the QR code can prove it', async () => {
    const secret = randomId(32)
    const pub = await exportPub((await newKeyPair()).publicKey)
    expect(await pairingProof(secret, pub)).toBe(await pairingProof(secret, pub))
    expect(await pairingProof(randomId(32), pub)).not.toBe(await pairingProof(secret, pub))
  })
})

describe('passkeys', () => {
  // A real WebAuthn assertion made with a P-256 key, as a phone's authenticator would make it.
  async function assertion(challenge: string, origin: string, flags = 0x05) {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key.publicKey))
    const rpIdHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(origin).hostname)))
    const auth = new Uint8Array([...rpIdHash, flags, 0, 0, 0, 1])
    const client = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin }))
    const signed = new Uint8Array([...auth, ...new Uint8Array(await crypto.subtle.digest('SHA-256', client))])
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, signed))
    const int = (b: Uint8Array) => (b[0]! & 0x80 ? new Uint8Array([0, ...b]) : b)
    const r = int(raw.slice(0, 32))
    const s = int(raw.slice(32))
    const der = new Uint8Array([0x30, r.length + s.length + 4, 0x02, r.length, ...r, 0x02, s.length, ...s])
    const { b64u } = await import('../plugins/streams/bridge/seal.js')
    return { a: { authenticatorData: b64u.enc(auth), clientDataJSON: b64u.enc(client), signature: b64u.enc(der) }, pub: b64u.enc(spki) }
  }

  test('a fresh passkey signature for this challenge and this relay unlocks; anything else does not', async () => {
    const origin = 'https://relay.example'
    const ok = await assertion('chal-1', origin)
    expect(await verifyAssertion(ok.a, ok.pub, 'chal-1', origin)).toBe(true)
    // An old signature, one for another site, or one made without Face ID or a passcode is refused.
    expect(await verifyAssertion(ok.a, ok.pub, 'chal-2', origin)).toBe(false)
    expect(await verifyAssertion(ok.a, ok.pub, 'chal-1', 'https://evil.example')).toBe(false)
    const noUser = await assertion('chal-1', origin, 0x01)
    expect(await verifyAssertion(noUser.a, noUser.pub, 'chal-1', origin)).toBe(false)
    const other = await assertion('chal-1', origin)
    expect(await verifyAssertion(ok.a, other.pub, 'chal-1', origin)).toBe(false)
  })
})
