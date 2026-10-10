// Web Push from the Room, with WebCrypto only (no library): VAPID (RFC 8292) signs who is sending, aes128gcm
// (RFC 8291) seals the payload for the browser's subscription keys. The payload is only a kind, so neither the relay
// nor the push service ever has session content to see. No Workers APIs beyond crypto and an injectable fetch.

/** Also in plugins/streams/hooks/remote/notify.ts and app/src/push.ts (separate packages): change all three together. */
export type NotifyKind = 'needs-you' | 'done' | 'failed'
export const KINDS: readonly NotifyKind[] = ['needs-you', 'done', 'failed']

/** A browser's push subscription, as a device sends it: where to post, and the keys to seal for (b64u). */
export type Subscription = { endpoint: string; p256dh: string; auth: string }
/** The relay's VAPID signing key, its public half (uncompressed P-256 point, b64u) and the `sub` claim. */
export type Vapid = { key: CryptoKey; publicKey: string; subject: string }

/**
 * One device gets at most one push a minute and 30 a day, however many sessions ask; the relay alone keeps this
 * limit, as only it sees every session. `needs-you` skips the minute (Claude is waiting on the person; a `done`
 * just before must not hold it back) but not the day's 30.
 */
export const PUSH_GAP_MS = 60_000
export const PUSH_PER_DAY = 30
/** How long a push service keeps an undelivered push: news an hour old is not worth a buzz. */
const TTL_S = 3600

const utf8 = (s: string) => new TextEncoder().encode(s)
export const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export const fromB64u = (s: string): Uint8Array => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), c => c.charCodeAt(0))
}
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/**
 * RFC 8291: one aes128gcm record sealed for the subscription's keys, with a fresh server key pair and salt (tests pass
 * the RFC's fixed ones). Body = salt (16) ‖ record size (4) ‖ key id length (1) ‖ server public key (65) ‖ ciphertext.
 */
export async function encrypt(plaintext: Uint8Array, sub: Pick<Subscription, 'p256dh' | 'auth'>, fixed?: { salt: Uint8Array; keys: CryptoKeyPair }): Promise<Uint8Array> {
  const ua = fromB64u(sub.p256dh)
  const keys = fixed?.keys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair)
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  // Workers' types call the peer key `$public`; the runtime, like every other, reads `public`.
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, keys.privateKey, 256))
  const ikm = await hkdf(fromB64u(sub.auth), ecdh, concat(utf8('WebPush: info\0'), ua, asPublic), 32)
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // 0x02: this is the last (and only) record; no padding is needed for a payload that is one of three kinds.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, Uint8Array.of(2))))
  const header = new Uint8Array(21)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, 4096)
  header[20] = asPublic.length
  return concat(header, asPublic, sealed)
}

/**
 * The relay's VAPID key from its Worker secret: a P-256 private JWK (as `vapid.ts` prints it) or a b64u PKCS#8.
 * Undefined when unset or unreadable: then the relay sends no pushes and the app hides "Notify me".
 */
export async function vapidOf(secret: string | undefined, subject: string): Promise<Vapid | undefined> {
  if (!secret) return undefined
  try {
    let jwk: JsonWebKey
    if (secret.trim().startsWith('{')) jwk = JSON.parse(secret) as JsonWebKey
    else {
      const k = await crypto.subtle.importKey('pkcs8', fromB64u(secret.trim()), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
      jwk = (await crypto.subtle.exportKey('jwk', k)) as JsonWebKey
    }
    if (!jwk.d || !jwk.x || !jwk.y) return undefined
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    return { key, publicKey: b64u(concat(Uint8Array.of(4), fromB64u(jwk.x), fromB64u(jwk.y))), subject }
  } catch {
    return undefined
  }
}

/** RFC 8292: `vapid t=<ES256 JWT for the endpoint's origin, 12 h>, k=<public key>`. */
export async function vapidAuth(endpoint: string, v: Vapid, now: number): Promise<string> {
  const part = (o: object) => b64u(utf8(JSON.stringify(o)))
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })}`
  // WebCrypto's ECDSA signature is r ‖ s (64 bytes), which is what JWS ES256 wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, utf8(unsigned)))
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.publicKey}`
}

/** What became of one push: delivered to the push service, a subscription that is gone for good, or a failure. */
export type Pushed = 'sent' | 'gone' | 'failed'

/**
 * Sends `{ kind }` to one subscription. 404 and 410 mean the browser dropped it, and keys that cannot be sealed for
 * never work: the caller forgets it. Never throws.
 */
export async function sendPush(sub: Subscription, kind: NotifyKind, v: Vapid, o: { now: number; fetch?: typeof fetch }): Promise<Pushed> {
  // A key that is not a P-256 point can never be sealed for: as good as gone.
  const body = await encrypt(utf8(JSON.stringify({ kind })), sub).catch(() => undefined)
  if (!body) return 'gone'
  const res = await (o.fetch ?? fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: await vapidAuth(sub.endpoint, v, o.now),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(TTL_S),
      urgency: kind === 'needs-you' ? 'high' : 'normal',
      // One topic per kind: a phone that was offline gets the latest of each, so a later `done` never replaces
      // an unread `needs-you`.
      topic: `claudeflow-${kind}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (!res) return 'failed'
  return res.status === 404 || res.status === 410 ? 'gone' : res.ok ? 'sent' : 'failed'
}

/** A device's push budget as the Room keeps it: the last push, and the day (UTC) and count of today's. */
export type Budget = { lastAt: number; day: number; count: number }

/** Whether one more push of `kind` fits: a minute since the last (not for `needs-you`), and fewer than 30 today. */
export const mayPush = (b: Budget | undefined, now: number, kind: NotifyKind): boolean =>
  !b || ((kind === 'needs-you' || now - b.lastAt >= PUSH_GAP_MS) && (b.day !== Math.floor(now / 86_400_000) || b.count < PUSH_PER_DAY))

/** The budget after a push was sent. */
export const spent = (b: Budget | undefined, now: number): Budget => {
  const day = Math.floor(now / 86_400_000)
  return { lastAt: now, day, count: b && b.day === day ? b.count + 1 : 1 }
}
