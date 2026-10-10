// End-to-end tests of the relay against a real local runtime (`wrangler dev`, Node 22+ on PATH): the room is the only
// thing between an account's sessions and its devices, so these check what each side can and cannot see through it.
//   bun test        (from relay/cloudflare)
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 8790
const BASE = `http://127.0.0.1:${PORT}`
/** A fake push service: the room posts pushes here, and the test says what it answers. */
const PUSH_PORT = 8792
const here = join(import.meta.dir, '..')
let wrangler: ReturnType<typeof Bun.spawn> | undefined
let pushService: ReturnType<typeof Bun.serve> | undefined
/** Every push the room sent, by endpoint path, with its headers. */
const pushes: { path: string; headers: Headers; bytes: number }[] = []
/** The relay's VAPID key for this run (b64u PKCS#8), passed to `wrangler dev` as the secret would be. */
let vapidSecret = ''

const id = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value !== undefined) return value
    if (Date.now() > until) throw new Error('timed out')
    await sleep(50)
  }
}

type UpReply = { frames: { seq: number; from: string; data: unknown }[]; devices: { id: string; isActive: boolean }[] }

function post(room: string, body: unknown) {
  return fetch(`${BASE}/v1/room/${room}/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function up(room: string, body: { token: string; session: string; since?: number; frames?: unknown[]; notify?: string[]; kind?: string }) {
  const res = await post(room, { since: 0, frames: [], ...body })
  expect(res.status).toBe(200)
  return (await res.json()) as UpReply
}

/** A device's socket, with every message it receives kept in order. */
async function device(room: string, deviceId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/room/${room}/device?id=${deviceId}`)
  const got: unknown[] = []
  ws.onmessage = e => got.push(JSON.parse(String(e.data)))
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  return { ws, got, send: (msg: unknown) => ws.send(JSON.stringify(msg)) }
}

beforeAll(async () => {
  if (!existsSync(join(here, 'public/index.html'))) {
    mkdirSync(join(here, 'public'), { recursive: true })
    writeFileSync(join(here, 'public/index.html'), '<!doctype html><title>Claudeflow</title>\n')
  }
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair
  vapidSecret = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64url')
  // A 410 path is a subscription the browser dropped, a /down path a push service failing, a /slow path one that
  // takes 3 s; any other path takes the push at once.
  pushService = Bun.serve({
    port: PUSH_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path.startsWith('/slow')) await sleep(3000)
      pushes.push({ path, headers: req.headers, bytes: (await req.arrayBuffer()).byteLength })
      return new Response(null, { status: path.startsWith('/gone') ? 410 : path.startsWith('/down') ? 500 : 201 })
    },
  })
  wrangler = Bun.spawn(['npx', 'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--var', `VAPID_PRIVATE_KEY:${vapidSecret}`], {
    cwd: here,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await waitFor(() => fetch(`${BASE}/`).then(r => (r.ok ? true : undefined), () => undefined), 60_000)
}, 70_000)

afterAll(async () => {
  pushService?.stop(true)
  wrangler?.kill()
  await wrangler?.exited
})

test('the first token owns a room; another token is refused', async () => {
  // Anyone may learn a room id (it is in the pairing link); only the account holding the token may use the room.
  const room = id()
  const owner = token()
  await up(room, { token: owner, session: id() })
  const res = await post(room, { token: token(), session: id(), since: 0, frames: [] })
  expect(res.status).toBe(403)
  await up(room, { token: owner, session: id() })
})

test('a frame a session posts reaches the device it is addressed to', async () => {
  const room = id()
  const session = id()
  const deviceId = id()
  const d = await device(room, deviceId)
  await up(room, { token: token(), session, frames: [{ to: deviceId, data: { t: 'box', b: '0.abc' } }] })
  const msg = await waitFor(() => d.got[0])
  expect(msg).toEqual({ from: session, data: { t: 'box', b: '0.abc' } })
  d.ws.close()
})

test('device frames reach the addressed session and every session for *, once per since-cursor', async () => {
  // A session must see each command exactly once, and never one meant for another session.
  const room = id()
  const tok = token()
  const [s1, s2, deviceId] = [id(), id(), id()]
  const d = await device(room, deviceId)
  d.send({ to: s1, data: { t: 'box', b: 'for-s1' } })
  d.send({ to: '*', data: { t: 'hello', device: deviceId } })
  d.send({ to: s2, data: { t: 'box', b: 'for-s2' } })
  const first = await waitFor(async () => {
    const r = await up(room, { token: tok, session: s1 })
    return r.frames.length === 2 ? r : undefined
  })
  expect(first.frames.map(f => f.data)).toEqual([{ t: 'box', b: 'for-s1' }, { t: 'hello', device: deviceId }])
  expect(first.frames.every(f => f.from === deviceId)).toBe(true)
  const since = Math.max(...first.frames.map(f => f.seq))
  expect((await up(room, { token: tok, session: s1, since })).frames).toEqual([])

  const other = await up(room, { token: tok, session: s2 })
  expect(other.frames.map(f => f.data)).toEqual([{ t: 'hello', device: deviceId }, { t: 'box', b: 'for-s2' }])
  d.ws.close()
})

test('two devices connected at once each get only their own frames', async () => {
  // Each device's frames are sealed for it alone; delivering another's would at best waste it, at worst confuse it.
  const room = id()
  const session = id()
  const [id1, id2] = [id(), id()]
  const [d1, d2] = [await device(room, id1), await device(room, id2)]
  const reply = await up(room, {
    token: token(),
    session,
    frames: [
      { to: id1, data: { n: 1 } },
      { to: id2, data: { n: 2 } },
    ],
  })
  expect(reply.devices.map(x => x.id).sort()).toEqual([id1, id2].sort())
  await waitFor(() => (d1.got.length && d2.got.length ? true : undefined))
  await sleep(200)
  expect(d1.got).toEqual([{ from: session, data: { n: 1 } }])
  expect(d2.got).toEqual([{ from: session, data: { n: 2 } }])
  d1.ws.close()
  d2.ws.close()
})

test('a device is listed while connected and active only after it reports itself visible', async () => {
  // Sessions poll fast only while some device is active, to stay inside the free plan's request budget.
  const room = id()
  const [tok, session, deviceId] = [token(), id(), id()]
  const d = await device(room, deviceId)
  expect((await up(room, { token: tok, session })).devices).toEqual([{ id: deviceId, isActive: false }])
  d.send({ here: true })
  await waitFor(async () => ((await up(room, { token: tok, session })).devices[0]?.isActive ? true : undefined))
  d.ws.close()
  await waitFor(async () => ((await up(room, { token: tok, session })).devices.length === 0 ? true : undefined))
})

/** Sends `count` frames from fresh device sockets (at most 30 each, the per-minute limit), in order, each batch stored before the next. */
async function fill(room: string, tok: string, session: string, count: number, data: (n: number) => unknown) {
  for (let n = 0; n < count; ) {
    const d = await device(room, id())
    const end = Math.min(count, n + 30)
    for (; n < end; n++) d.send({ to: session, data: data(n) })
    const last = JSON.stringify(data(end - 1))
    await waitFor(async () => ((await up(room, { token: tok, session })).frames.some(f => JSON.stringify(f.data) === last) ? true : undefined))
    d.ws.close()
  }
}

test('the room keeps at most the newest 500 device frames', async () => {
  // Bounded storage: a misbehaving device cannot grow the room without limit.
  const room = id()
  const [tok, session] = [token(), id()]
  await fill(room, tok, session, 510, n => ({ n }))
  const { frames } = await up(room, { token: tok, session })
  expect(frames.length).toBe(500)
  expect(frames[0].data).toEqual({ n: 10 })
  expect(frames[499].data).toEqual({ n: 509 })
}, 30_000)

test('the room keeps at most the newest 1 MB of frame data, so one up answer stays readable', async () => {
  // 500 frames of 16 KB would be 8 MB in one JSON answer: more than a session's fetch should have to parse.
  const room = id()
  const [tok, session] = [token(), id()]
  const pad = 'x'.repeat(15_000)
  await fill(room, tok, session, 90, n => ({ n, pad }))
  const { frames } = await up(room, { token: tok, session })
  const bytes = frames.reduce((sum, f) => sum + JSON.stringify(f.data).length, 0)
  expect(bytes).toBeLessThanOrEqual(1 << 20)
  expect(frames.length).toBeGreaterThan(60)
  expect(frames.at(-1)?.data).toMatchObject({ n: 89 })
}, 30_000)

test('a device message over 16 KB is dropped, and a socket sending over 30 a minute is closed', async () => {
  // Device sockets need no token: anyone with the room id could otherwise fill its storage or spend the account's
  // free-plan writes and requests for every room. A real device sends a few small messages a minute.
  const room = id()
  const [tok, session] = [token(), id()]
  const d = await device(room, id())
  d.send({ to: session, data: 'x'.repeat(16 << 10) })
  d.send({ to: session, data: { ok: true } })
  const reply = await waitFor(async () => {
    const r = await up(room, { token: tok, session })
    return r.frames.length ? r : undefined
  })
  expect(reply.frames.map(f => f.data)).toEqual([{ ok: true }])

  const flood = await device(room, id())
  const closed = new Promise<number>(resolve => flood.ws.addEventListener('close', e => resolve(e.code)))
  for (let n = 0; n < 40; n++) flood.send({ to: session, data: { n } })
  expect(await closed).toBe(1008)
  const { frames } = await up(room, { token: tok, session })
  expect(frames.filter(f => typeof f.data === 'object' && f.data !== null && 'n' in f.data)).toHaveLength(30)
  d.ws.close()
})

test('bad ids, bad shapes and oversized bodies are rejected', async () => {
  // Validation at the edge keeps junk out of storage and out of other devices' sockets.
  const room = id()
  const [tok, session] = [token(), id()]
  expect((await post('short', { token: tok, session, since: 0, frames: [] })).status).toBe(400)
  expect((await post('bad$room$id$here$', { token: tok, session, since: 0, frames: [] })).status).toBe(400)
  expect((await post(room, { token: 'short', session, since: 0, frames: [] })).status).toBe(400)
  expect((await post(room, { token: tok, session: 'x', since: 0, frames: [] })).status).toBe(400)
  expect((await post(room, { token: tok, session, since: -1, frames: [] })).status).toBe(400)
  expect((await post(room, { token: tok, session, since: 0, frames: [{ to: 'x', data: {} }] })).status).toBe(400)
  expect((await post(room, { token: tok, session, since: 0, frames: [{ to: id() }] })).status).toBe(400)
  expect((await post(room, 'not json')).status).toBe(400)
  const big = { token: tok, session, since: 0, frames: [{ to: id(), data: 'x'.repeat(1 << 20) }] }
  expect((await post(room, big)).status).toBe(413)

  const ws = await fetch(`${BASE}/v1/room/${room}/device?id=bad`, { headers: { upgrade: 'websocket' } })
  expect(ws.status).toBe(400)
  expect((await fetch(`${BASE}/v1/room/${room}/device?id=${id()}`)).status).toBe(426)

  // A malformed device message is dropped; the next good one still goes through.
  const d = await device(room, id())
  d.ws.send('not json')
  d.send({ to: 'x', data: {} })
  d.send({ to: session })
  d.send({ to: session, data: { ok: true } })
  const reply = await waitFor(async () => {
    const r = await up(room, { token: tok, session })
    return r.frames.length ? r : undefined
  })
  expect(reply.frames.map(f => f.data)).toEqual([{ ok: true }])
  d.ws.close()
})

/** A subscription as a browser makes one: its endpoint on the fake push service, a P-256 key and an auth secret. */
async function subscription(path: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url')
  return { endpoint: `http://127.0.0.1:${PUSH_PORT}${path}`, keys: { p256dh, auth: id() } }
}

test('the app reads the relay\'s VAPID public key, which signs every push', async () => {
  const res = await fetch(`${BASE}/v1/push/key`)
  expect(res.status).toBe(200)
  const { key } = (await res.json()) as { key: string }
  expect(Buffer.from(key, 'base64url').length).toBe(65)
  const room = id()
  const [tok, session, deviceId] = [token(), id(), id()]
  const d = await device(room, deviceId)
  const path = `/sub/${id()}`
  d.send({ push: await subscription(path) })
  await sleep(200)
  await up(room, { token: tok, session, notify: [deviceId], kind: 'done' })
  const got = await waitFor(() => pushes.find(p => p.path === path))
  expect(got.headers.get('authorization')).toEndWith(`, k=${key}`)
  d.ws.close()
})

test('a hinted device not looking gets one sealed push; a looking one, a repeat within a minute, or junk gets none', async () => {
  // The session names devices and a kind, no text; the push itself is sealed for the phone (aes128gcm).
  const room = id()
  const [tok, session, away, looking] = [token(), id(), id(), id()]
  const [a, l] = [await device(room, away), await device(room, looking)]
  const [pathA, pathL] = [`/sub/${id()}`, `/sub/${id()}`]
  a.send({ push: await subscription(pathA) })
  l.send({ push: await subscription(pathL) })
  l.send({ here: true })
  await waitFor(async () => ((await up(room, { token: tok, session })).devices.find(d => d.id === looking)?.isActive ? true : undefined))
  await up(room, { token: tok, session, notify: [away, looking], kind: 'needs-you' })
  const got = await waitFor(() => pushes.find(p => p.path === pathA))
  expect(got.headers.get('content-encoding')).toBe('aes128gcm')
  expect(got.headers.get('urgency')).toBe('high')
  expect(got.bytes).toBe(86 + '{"kind":"needs-you"}'.length + 1 + 16)
  await up(room, { token: tok, session, notify: [away], kind: 'done' })
  await sleep(300)
  expect(pushes.filter(p => p.path === pathA)).toHaveLength(1)
  expect(pushes.some(p => p.path === pathL)).toBe(false)
  // A hint with text in it, or an unknown kind, is not a hint: the post is refused whole.
  expect((await post(room, { token: tok, session, since: 0, frames: [], notify: [away], kind: 'Deploy now?' })).status).toBe(400)
  expect((await post(room, { token: tok, session, since: 0, frames: [], notify: ['x'], kind: 'done' })).status).toBe(400)
  a.ws.close()
  l.ws.close()
})

test('a subscription the push service says is gone (410) is forgotten, and turning notifications off forgets it too', async () => {
  // Otherwise every hint would post to a dead endpoint for ever.
  const room = id()
  const [tok, session, gone, off] = [token(), id(), id(), id()]
  const [g, o] = [await device(room, gone), await device(room, off)]
  const [pathG, pathO] = [`/gone/${id()}`, `/sub/${id()}`]
  g.send({ push: await subscription(pathG) })
  o.send({ push: await subscription(pathO) })
  o.send({ push: null })
  await sleep(200)
  await up(room, { token: tok, session, notify: [gone, off], kind: 'failed' })
  await waitFor(() => pushes.find(p => p.path === pathG))
  // A 410 spends no budget, so only a forgotten subscription explains no second post.
  await up(room, { token: tok, session, notify: [gone], kind: 'failed' })
  await sleep(300)
  expect(pushes.filter(p => p.path === pathG)).toHaveLength(1)
  expect(pushes.some(p => p.path === pathO)).toBe(false)
  g.ws.close()
  o.ws.close()
})

test('a session\'s post is answered at once, not after the push services: its frames and its tick never wait on them', async () => {
  const room = id()
  const [tok, session, deviceId] = [token(), id(), id()]
  const d = await device(room, deviceId)
  const path = `/slow/${id()}`
  d.send({ push: await subscription(path) })
  await sleep(200)
  const t0 = Date.now()
  await up(room, { token: tok, session, notify: [deviceId], kind: 'done' })
  expect(Date.now() - t0).toBeLessThan(2000)
  await waitFor(() => pushes.find(p => p.path === path))
  d.ws.close()
})

test('a push the service did not take gives its budget back, so the next news is not held for a minute', async () => {
  const room = id()
  const [tok, session, deviceId] = [token(), id(), id()]
  const d = await device(room, deviceId)
  const path = `/down/${id()}`
  d.send({ push: await subscription(path) })
  await sleep(200)
  await up(room, { token: tok, session, notify: [deviceId], kind: 'done' })
  await waitFor(() => pushes.find(p => p.path === path))
  await sleep(200)
  await up(room, { token: tok, session, notify: [deviceId], kind: 'done' })
  await waitFor(() => (pushes.filter(p => p.path === path).length === 2 ? true : undefined))
  d.ws.close()
})

test('a room keeps at most 32 push subscriptions, the most recently sent: made-up device ids cannot grow its storage', async () => {
  // Sockets need no token, so anyone with the room id can subscribe under any id.
  const room = id()
  const [tok, session] = [token(), id()]
  const ids = Array.from({ length: 40 }, () => id())
  const paths = ids.map(() => `/sub/${id()}`)
  const sockets = []
  for (const [i, deviceId] of ids.entries()) {
    const d = await device(room, deviceId)
    d.send({ push: await subscription(paths[i]!) })
    sockets.push(d)
    await sleep(5)
  }
  await sleep(300)
  await up(room, { token: tok, session, notify: ids.slice(0, 20), kind: 'done' })
  await up(room, { token: tok, session, notify: ids.slice(20), kind: 'done' })
  await waitFor(() => (pushes.filter(p => paths.includes(p.path)).length >= 32 ? true : undefined))
  await sleep(300)
  const sent = new Set(pushes.filter(p => paths.includes(p.path)).map(p => p.path))
  expect(sent.size).toBe(32)
  for (const path of paths.slice(8)) expect(sent.has(path)).toBe(true)
  for (const d of sockets) d.ws.close()
})
