// The sealed channel between a Mac's bridge and a paired phone, used by both: the bridge (Bun) and the phone page (browser).
// ECDH P-256 + HKDF-SHA256 + AES-256-GCM from WebCrypto, nothing else. A relay between them forwards what this seals
// and cannot open it: each connection's keys mix fresh ephemeral keys (forward secrecy) with the two devices' long-term
// keys (only the paired Mac and phone can derive them).

const te = new TextEncoder()
const td = new TextDecoder()
const subtle = globalThis.crypto.subtle
const P256 = { name: 'ECDH', namedCurve: 'P-256' }
const INFO = te.encode('claudeflow-remote-v1')

export const b64u = {
  enc(bytes) {
    let s = ''
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  },
  dec(text) {
    const s = text.replace(/-/g, '+').replace(/_/g, '/')
    return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0))
  },
}

export const randomId = (bytes = 16) => b64u.enc(globalThis.crypto.getRandomValues(new Uint8Array(bytes)))

/** A key pair that can be kept: exported as JWK for storage, the public half as raw bytes for the other side. */
export async function newKeyPair() {
  return subtle.generateKey(P256, true, ['deriveBits'])
}
export async function exportPair(pair) {
  return { priv: await subtle.exportKey('jwk', pair.privateKey), pub: await exportPub(pair.publicKey) }
}
export async function importPair(saved) {
  return { privateKey: await subtle.importKey('jwk', saved.priv, P256, true, ['deriveBits']), publicKey: await importPub(saved.pub) }
}
export async function exportPub(key) {
  return b64u.enc(await subtle.exportKey('raw', key))
}
export async function importPub(text) {
  return subtle.importKey('raw', b64u.dec(text), P256, true, [])
}

/** Proof that a phone saw the QR code: an HMAC of its public key under the one-time pairing secret. */
export async function pairingProof(secret, phonePub) {
  const key = await subtle.importKey('raw', b64u.dec(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64u.enc(await subtle.sign('HMAC', key, te.encode(phonePub)))
}

const ecdh = (priv, pub) => subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256)

/**
 * The two keys of one connection, one per direction. Ephemeral-ephemeral ECDH gives forward secrecy;
 * static-static ECDH binds it to the paired devices, so a relay that swaps a key cannot read or write.
 */
export async function connectionKeys({ ownStatic, peerStaticPub, ownEphemeral, peerEphemeralPub, macNonce, phoneNonce }) {
  const a = new Uint8Array(await ecdh(ownEphemeral.privateKey, await importPub(peerEphemeralPub)))
  const b = new Uint8Array(await ecdh(ownStatic.privateKey, await importPub(peerStaticPub)))
  const ikm = new Uint8Array([...a, ...b])
  const salt = new Uint8Array([...b64u.dec(macNonce), ...b64u.dec(phoneNonce)])
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, base, 512))
  const aes = raw => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { macToPhone: await aes(bits.slice(0, 32)), phoneToMac: await aes(bits.slice(32)) }
}

/** One direction-pair of a connection: seals with a counter nonce, and opens only messages newer than the last. */
export function channel(sendKey, recvKey) {
  let sent = 0n
  let seen = -1n
  const iv = n => {
    const v = new Uint8Array(12)
    new DataView(v.buffer).setBigUint64(4, n)
    return v
  }
  return {
    async seal(obj) {
      const n = sent++
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv(n) }, sendKey, te.encode(JSON.stringify(obj))))
      return `${n}.${b64u.enc(ct)}`
    },
    async open(box) {
      const [count, body] = String(box).split('.')
      const n = BigInt(count)
      if (n <= seen) throw new Error('replayed or out of order')
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv(n) }, recvKey, b64u.dec(body))
      seen = n
      return JSON.parse(td.decode(pt))
    },
  }
}
