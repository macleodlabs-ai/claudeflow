// Web Push as the Room sends it (src/push.ts), with no runtime: the payload must open only on the phone (RFC 8291,
// checked against the RFC's own example), the push service must accept who sent it (RFC 8292), and a subscription
// the browser dropped must be forgotten rather than retried forever.
import { expect, test } from 'bun:test'
import { b64u, encrypt, fromB64u, mayPush, sendPush, spent, vapidAuth, vapidOf, PUSH_PER_DAY } from '../src/push'
import { subscriptionOf } from '../src/shapes'

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
}

async function rfcServerKeys(): Promise<CryptoKeyPair> {
  const pub = fromB64u(RFC.asPublic)
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), d: RFC.asPrivate }
  const alg = { name: 'ECDH', namedCurve: 'P-256' }
  return {
    privateKey: await crypto.subtle.importKey('jwk', jwk, alg, false, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', pub, alg, true, []),
  }
}

async function newVapid() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pkcs8 = b64u(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer))
  return { pair, pkcs8, vapid: (await vapidOf(pkcs8, 'https://relay.example.workers.dev'))! }
}

const SUB = { endpoint: 'https://push.example.com/send/abc', p256dh: RFC.uaPublic, auth: RFC.auth }

test('the payload is sealed exactly as RFC 8291 says, so every browser can open it', async () => {
  const body = await encrypt(new TextEncoder().encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: fromB64u(RFC.salt), keys: await rfcServerKeys() })
  // The RFC prints the 86-byte header and the ciphertext apart; the body is the one after the other.
  expect(body.slice(0, 86)).toEqual(fromB64u(RFC.header))
  expect(body.slice(86)).toEqual(fromB64u(RFC.ciphertext))
})

test('each push is sealed with a fresh key and salt: two pushes of the same kind do not look alike', async () => {
  const a = await encrypt(new TextEncoder().encode('{"kind":"done"}'), SUB)
  const b = await encrypt(new TextEncoder().encode('{"kind":"done"}'), SUB)
  expect(b64u(a.slice(0, 86))).not.toBe(b64u(b.slice(0, 86)))
  expect(a.length).toBe(86 + 15 + 1 + 16)
})

test('the VAPID header is an ES256 JWT for the endpoint\'s origin, signed by the key it names', async () => {
  // A push service refuses a JWT for another audience, or one that outlives 24 h.
  const { pair, vapid } = await newVapid()
  const now = Date.UTC(2026, 9, 10)
  const auth = await vapidAuth(SUB.endpoint, vapid, now)
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth)!
  expect(m).not.toBeNull()
  const [, h, c, s, k] = m as unknown as string[]
  expect(JSON.parse(new TextDecoder().decode(fromB64u(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(new TextDecoder().decode(fromB64u(c!)))
  expect(claims).toEqual({ aud: 'https://push.example.com', exp: now / 1000 + 12 * 3600, sub: 'https://relay.example.workers.dev' })
  expect(k).toBe(vapid.publicKey)
  expect(fromB64u(k!).length).toBe(65)
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, fromB64u(s!), new TextEncoder().encode(`${h}.${c}`))
  expect(ok).toBe(true)
})

test('the VAPID key is read from a JWK or a PKCS#8 secret, and a junk secret sends nothing', async () => {
  const { pair, vapid } = await newVapid()
  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey))
  expect((await vapidOf(jwk, 'mailto:a@b.c'))?.publicKey).toBe(vapid.publicKey)
  expect(await vapidOf('not a key', 'mailto:a@b.c')).toBeUndefined()
  expect(await vapidOf(undefined, 'mailto:a@b.c')).toBeUndefined()
})

test('a push carries only its kind, sealed, with the headers a push service needs', async () => {
  const { vapid } = await newVapid()
  const seen: { url: string; init: RequestInit }[] = []
  const fake = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(null, { status: 201 }))) as unknown as typeof fetch
  expect(await sendPush(SUB, 'needs-you', vapid, { now: Date.now(), fetch: fake })).toBe('sent')
  const h = seen[0]!.init.headers as Record<string, string>
  expect(seen[0]!.url).toBe(SUB.endpoint)
  expect(h['content-encoding']).toBe('aes128gcm')
  expect(h.urgency).toBe('high')
  expect(Number(h.ttl)).toBeGreaterThan(0)
  expect(h.authorization).toStartWith('vapid t=')
  // Sealed: the kind is not in the body in the clear.
  expect(new TextDecoder().decode(seen[0]!.init.body as Uint8Array)).not.toContain('needs-you')
})

test('404, 410 and keys that cannot be sealed for say the subscription is gone (the Room forgets it); other failures do not', async () => {
  const { vapid } = await newVapid()
  const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch
  expect(await sendPush(SUB, 'done', vapid, { now: Date.now(), fetch: answer(410) })).toBe('gone')
  expect(await sendPush(SUB, 'done', vapid, { now: Date.now(), fetch: answer(404) })).toBe('gone')
  expect(await sendPush(SUB, 'done', vapid, { now: Date.now(), fetch: answer(500) })).toBe('failed')
  const down = (async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch
  expect(await sendPush(SUB, 'done', vapid, { now: Date.now(), fetch: down })).toBe('failed')
  // A key that is no P-256 point can never be sealed for, so it is gone too, and nothing is posted.
  const offCurve = Buffer.concat([Buffer.of(4), Buffer.alloc(64, 1)]).toString('base64url')
  expect(await sendPush({ ...SUB, p256dh: offCurve }, 'done', vapid, { now: Date.now(), fetch: down })).toBe('gone')
})

test('a device gets at most one push a minute and 30 a day, and a new day starts afresh', () => {
  // However many sessions ask: a phone that buzzes all day gets its notifications turned off.
  const day = Date.UTC(2026, 9, 10)
  let b = spent(undefined, day)
  expect(mayPush(b, day + 59_000, 'done')).toBe(false)
  expect(mayPush(b, day + 60_000, 'done')).toBe(true)
  for (let i = 1; i < PUSH_PER_DAY; i++) b = spent(b, day + i * 60_000)
  expect(b.count).toBe(PUSH_PER_DAY)
  expect(mayPush(b, day + 3_600_000 * 20, 'done')).toBe(false)
  expect(mayPush(b, day + 86_400_000, 'done')).toBe(true)
})

test('Claude needing the person is never held back by a push a moment before, but still counts toward the day', () => {
  // A `done` thirty seconds earlier must not swallow the question that is now waiting on the person.
  const day = Date.UTC(2026, 9, 10)
  let b = spent(undefined, day)
  expect(mayPush(b, day + 30_000, 'needs-you')).toBe(true)
  for (let i = 1; i < PUSH_PER_DAY; i++) b = spent(b, day + i * 1000)
  expect(mayPush(b, day + 3_600_000, 'needs-you')).toBe(false)
})

test('each kind has its own topic, so a phone that was offline never gets a later done in place of a needs-you', async () => {
  const { vapid } = await newVapid()
  const topics: string[] = []
  const take = (async (_url: string, init: RequestInit) => {
    topics.push(String((init.headers as Record<string, string>).topic))
    return new Response(null, { status: 201 })
  }) as unknown as typeof fetch
  for (const kind of ['needs-you', 'done', 'failed'] as const) await sendPush(SUB, kind, vapid, { now: Date.now(), fetch: take })
  expect(new Set(topics).size).toBe(3)
})

test('a device\'s subscription is kept only with an https endpoint and keys of the right size', () => {
  // The room posts to whatever endpoint a device names: plain http (but on this machine, for tests) is refused.
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth }
  expect(subscriptionOf({ endpoint: SUB.endpoint, keys })).toEqual(SUB)
  expect(subscriptionOf({ endpoint: 'http://push.example.com/x', keys })).toBeUndefined()
  expect(subscriptionOf({ endpoint: 'http://127.0.0.1:9/x', keys })?.endpoint).toBe('http://127.0.0.1:9/x')
  expect(subscriptionOf({ endpoint: SUB.endpoint, keys: { ...keys, auth: 'short' } })).toBeUndefined()
  expect(subscriptionOf({ endpoint: SUB.endpoint })).toBeUndefined()
})
