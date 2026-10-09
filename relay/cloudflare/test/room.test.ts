// End-to-end tests of the relay against a real local runtime (`wrangler dev`, Node 22+ on PATH): the room is the only
// thing between an account's sessions and its devices, so these check what each side can and cannot see through it.
//   bun test        (from relay/cloudflare)
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 8790
const BASE = `http://127.0.0.1:${PORT}`
const here = join(import.meta.dir, '..')
let wrangler: ReturnType<typeof Bun.spawn> | undefined

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

async function up(room: string, body: { token: string; session: string; since?: number; frames?: unknown[] }) {
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
  wrangler = Bun.spawn(['npx', 'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: here,
    stdout: 'ignore',
    stderr: 'ignore',
  })
  await waitFor(() => fetch(`${BASE}/`).then(r => (r.ok ? true : undefined), () => undefined), 60_000)
}, 70_000)

afterAll(async () => {
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
