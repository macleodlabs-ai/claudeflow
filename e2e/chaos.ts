// Fault injection for unlocking: the real relay (`wrangler dev`) behind a proxy this script controls, the real app
// in headless Chrome with a virtual passkey, and a Claude Code session played by the plugin's own remote core (as in
// run.ts). Every scenario has its own device and its own session (its own room), so each keeps its own idle 30 s
// cadence, and runs its unlock REPS times, recording what the person saw and when.
//
// Run from the repo root, after app/build.sh, with Node 22+ on PATH:
//   E2E_OFFSET=80 bun e2e/chaos.ts                 every scenario
//   CHAOS_ONLY=baseline,drop-faceid CHAOS_REPS=3 E2E_OFFSET=80 bun e2e/chaos.ts
// It reports; it never fails the shell (exit 0), as a finding is the point. Results also go to $TMP/chaos.json.
//
// run.ts's device and session helpers are repeated here, cut down, rather than shared: run.ts is the suite that must
// stay green, and these copies add the knobs (lag, refusals, fetch timeouts) the faults need.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { PAIRING_MS, createLink, withPaired, type Device, type Identity, type Pairing } from '../plugins/streams/hooks/remote/link'
import { newIdentity, publicKeyOf, randomId } from '../plugins/streams/hooks/remote/seal'
import type { Snapshot } from '../plugins/streams/hooks/remote/snapshot'

const ROOT = join(import.meta.dir, '..')
const OFFSET = Number(process.env.E2E_OFFSET ?? 80)
const TMP = join(tmpdir(), `claudeflow-chaos-${OFFSET}`)
const RELAY_PORT = 8791 + OFFSET
const PROXY_PORT = 8792 + OFFSET
const RELAY = `127.0.0.1:${RELAY_PORT}`
/** The origin the app loads from and its passkeys are made for: the proxy, so every byte passes through it. */
const ORIGIN = `http://localhost:${PROXY_PORT}`
const UP = `http://127.0.0.1:${PROXY_PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const REPS = Number(process.env.CHAOS_REPS ?? 10)
const ONLY = process.env.CHAOS_ONLY?.split(',').filter(Boolean)
/** Between attempts: the session's warm minute after a welcome runs out, so each unlock meets the idle 30 s cadence. */
const GAP_MS = Number(process.env.CHAOS_GAP_MS ?? 62_000)
/** How long one unlock may take before it counts as failed: past the slow note (45 s) and a refusal's grace (35 s). */
const CAP_MS = Number(process.env.CHAOS_CAP_MS ?? 100_000)
/** hooks/remote/index.tsx: TICK_MS and FETCH_MS. */
const TICK_MS = 2000
const FETCH_MS = 20_000
/** What the session's snapshot shows once the device is in: the sign the unlock worked. */
const INSIDE = 'Deploy the relay now?'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(what: string, f: () => Promise<T> | T, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}
const procs: ChildProcess[] = []
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---- the relay ----
let relayProc: ChildProcess | undefined
async function startRelay() {
  const out = openSync(join(TMP, 'wrangler.log'), 'a')
  relayProc = spawn('npx', ['wrangler', 'dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--inspector-port', String(9229 + OFFSET), '--persist-to', join(TMP, 'state')], {
    cwd: join(ROOT, 'relay/cloudflare'), detached: true, stdio: ['ignore', out, out],
  })
  procs.push(relayProc)
  await until('wrangler dev', () => fetch(`http://${RELAY}/`).then(r => r.ok, () => false), 90_000)
}
/** The Durable Object restarts as on a deploy: every socket is lost, what it stored is kept (--persist-to). */
async function restartRelay() {
  if (relayProc) {
    try {
      process.kill(-relayProc.pid!, 'SIGTERM')
    } catch {}
  }
  spawnSync('pkill', ['-f', `wrangler dev --port ${RELAY_PORT}`])
  spawnSync('pkill', ['-f', `workerd serve.*:${RELAY_PORT}`])
  await sleep(1500)
  await startRelay()
}

// ---- the proxy: every device socket and every session post goes through here, where the faults are ----
type Dir = 'up' | 'down'
/** A fault on one device's socket, by device id. `drop`: close the socket when a frame of this type passes. */
type DevFault = { drop?: { dir: Dir; t: string; after?: number }; blockUntil?: number; idleCloseMs?: number }
/** A fault on one room's session posts. */
type UpFault = { fail?: number; status?: number; delayMs?: number; hang?: number }
const devFaults = new Map<string, DevFault>()
const upFaults = new Map<string, UpFault>()
/** What passed each device's socket: the frame types, when, and how sockets closed. */
const events = new Map<string, { at: number; what: string }[]>()
const note = (id: string, what: string) => {
  const list = events.get(id) ?? []
  list.push({ at: Date.now(), what })
  events.set(id, list)
}
type Sock = { device: string; path: string; up?: WebSocket; queue: string[]; lastAt: number; idle?: ReturnType<typeof setInterval> }
const sockets = new Set<ServerWebSocket<Sock>>()
const typeOf = (raw: string): string => {
  try {
    const m = JSON.parse(raw) as { data?: { t?: string }; here?: unknown; push?: unknown }
    return m.data?.t ?? ('here' in m ? 'here' : 'push' in m ? 'push' : '?')
  } catch {
    return '?'
  }
}
function dropSocket(ws: ServerWebSocket<Sock>, why: string) {
  note(ws.data.device, `chaos-close:${why}`)
  try {
    ws.data.up?.close()
  } catch {}
  try {
    ws.close(4001, why)
  } catch {}
}
/** Drops every socket now: the relay lost them (a deploy, an edge reset), or one device's network went. */
function dropAll(device?: string) {
  for (const ws of sockets) if (!device || ws.data.device === device) dropSocket(ws, 'dropped')
}
function startProxy() {
  return Bun.serve<Sock, {}>({
    port: PROXY_PORT,
    hostname: '127.0.0.1',
    async fetch(req, server) {
      const url = new URL(req.url)
      if (req.headers.get('upgrade') === 'websocket') {
        const device = url.searchParams.get('id') ?? ''
        const f = devFaults.get(device)
        if (f?.blockUntil && Date.now() < f.blockUntil) {
          note(device, 'chaos-refused-connect')
          return new Response('offline', { status: 502 })
        }
        return server.upgrade(req, { data: { device, path: url.pathname + url.search, queue: [], lastAt: Date.now() } }) ? undefined : new Response('no', { status: 400 })
      }
      const room = /^\/v1\/room\/([^/]+)\/up$/.exec(url.pathname)?.[1]
      const f = room ? upFaults.get(room) : undefined
      if (f?.delayMs) await sleep(f.delayMs)
      if (f?.hang && f.hang > 0) {
        f.hang--
        await sleep(10 * 60_000)
      }
      if (f?.fail && f.fail > 0) {
        f.fail--
        return new Response('chaos', { status: f.status ?? 503 })
      }
      // Uncompressed from the relay: the proxy reads and passes bodies, and the browser asks for encodings fetch lacks.
      const fwd = new Headers(req.headers)
      fwd.set('accept-encoding', 'identity')
      // Always a full answer: a 304 passed through here left reloads blank.
      fwd.delete('if-none-match')
      fwd.delete('if-modified-since')
      const r = await fetch(`http://${RELAY}${url.pathname}${url.search}`, {
        method: req.method, headers: fwd, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
      }).catch(() => new Response('relay down', { status: 502 }))
      // fetch has already decompressed the body: say nothing of the relay's encoding or length.
      const headers = new Headers(r.headers)
      headers.delete('content-encoding')
      headers.delete('content-length')
      return new Response(r.body, { status: r.status, headers })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
        note(ws.data.device, 'open')
        const up = new WebSocket(`ws://${RELAY}${ws.data.path}`)
        ws.data.up = up
        up.onopen = () => {
          for (const m of ws.data.queue) up.send(m)
          ws.data.queue = []
        }
        up.onmessage = m => {
          const raw = String(m.data)
          const t = typeOf(raw)
          note(ws.data.device, `down:${t}`)
          ws.data.lastAt = Date.now()
          ws.send(raw)
          const d = devFaults.get(ws.data.device)?.drop
          if (d && d.dir === 'down' && d.t === t) {
            devFaults.get(ws.data.device)!.drop = undefined
            setTimeout(() => dropSocket(ws, `after down:${t}`), d.after ?? 0)
          }
        }
        up.onclose = e => {
          note(ws.data.device, `relay-closed:${e.code}`)
          try {
            ws.close(e.code >= 4000 || e.code === 1008 ? e.code : 1011, e.reason || 'relay closed')
          } catch {}
        }
        const idle = devFaults.get(ws.data.device)?.idleCloseMs
        if (idle) ws.data.idle = setInterval(() => Date.now() - ws.data.lastAt > idle && dropSocket(ws, 'idle'), 1000)
      },
      message(ws, m) {
        const raw = String(m)
        const t = typeOf(raw)
        note(ws.data.device, `up:${t}`)
        ws.data.lastAt = Date.now()
        const d = devFaults.get(ws.data.device)?.drop
        if (d && d.dir === 'up' && d.t === t) {
          devFaults.get(ws.data.device)!.drop = undefined
          // Lost with the socket: the frame never reaches the relay.
          return void dropSocket(ws, `on up:${t}`)
        }
        if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(raw)
        else ws.data.queue.push(raw)
      },
      close(ws, code) {
        sockets.delete(ws)
        if (ws.data.idle) clearInterval(ws.data.idle)
        note(ws.data.device, `client-closed:${code}`)
        try {
          ws.data.up?.close()
        } catch {}
      },
    },
  })
}

// ---- a device ----
/**
 * Page knobs the faults turn, kept in localStorage so they hold across reloads: a slow Face ID (the sheet blurs the
 * page and focus comes back as it answers), a skewed clock, and visibility and focus this script controls.
 */
const KNOBS = `(() => {
  const n = k => Number(localStorage.getItem('chaos-' + k) || 0)
  const realNow = Date.now.bind(Date)
  Date.now = () => realNow() + n('skew')
  window.__vis = 'visible'
  window.__focus = true
  Object.defineProperty(Document.prototype, 'visibilityState', { get: () => window.__vis, configurable: true })
  Object.defineProperty(Document.prototype, 'hidden', { get: () => window.__vis !== 'visible', configurable: true })
  Document.prototype.hasFocus = () => window.__focus
  const wrap = (name) => {
    const orig = CredentialsContainer.prototype[name]
    CredentialsContainer.prototype[name] = async function (o) {
      const ms = n('faceid')
      if (ms) { window.__focus = false; dispatchEvent(new Event('blur')) }
      try {
        const r = await orig.call(this, o)
        if (ms) await new Promise(ok => setTimeout(ok, ms))
        return r
      } finally {
        if (ms) { window.__focus = true; dispatchEvent(new Event('focus')) }
      }
    }
  }
  wrap('get'); wrap('create')
})()`
type Page = Awaited<ReturnType<typeof openDevice>>
async function openDevice(name: string, port: number) {
  const p = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(TMP, `chrome-${name}`)}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' })
  procs.push(p)
  const targets = await until(`${name} DevTools`, () => fetch(`http://127.0.0.1:${port}/json`).then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>, () => undefined), 60_000)
  const page = await attach(name, targets.find(t => t.type === 'page')!.webSocketDebuggerUrl)
  await page.setup()
  return {
    ...page,
    /** A second tab of this browser: the same profile, so the same device id and pairing. */
    async newTab(url: string) {
      const t = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string }
      const tab = await attach(`${name}-tab2`, t.webSocketDebuggerUrl)
      await tab.setup()
      return tab
    },
  }
}
async function attach(name: string, wsUrl: string) {
  const ws = new WebSocket(wsUrl)
  await new Promise(r => (ws.onopen = r))
  let n = 0
  const waiting = new Map<number, (m: { result?: any; error?: unknown }) => void>()
  ws.onmessage = m => {
    const msg = JSON.parse(String(m.data))
    if (msg.method === 'Runtime.exceptionThrown') log(`[${name}] page error:`, msg.params.exceptionDetails.exception?.description?.slice(0, 200))
    waiting.get(msg.id)?.(msg)
  }
  const send = (method: string, params = {}) =>
    new Promise<any>((ok, no) => {
      const id = ++n
      waiting.set(id, m => (m.error ? no(new Error(`${method}: ${JSON.stringify(m.error)}`)) : ok(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const js = async (expression: string) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  return {
    name,
    send,
    js,
    async setup() {
      await send('Runtime.enable')
      await send('Page.enable')
      // The app's service worker caches the shell; every load here must come through the proxy instead.
      await send('Network.enable')
      await send('Network.setBypassServiceWorker', { bypass: true })
      await send('Network.setCacheDisabled', { cacheDisabled: true })
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      await send('Page.addScriptToEvaluateOnNewDocument', { source: KNOBS })
      await send('WebAuthn.enable')
      await send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      })
    },
    goto: (url: string) => send('Page.navigate', { url }),
    reload: () => send('Page.reload'),
    text: async () => String((await js('document.body.innerText')) ?? ''),
    tap: (sel: string) => until(`${name}: ${sel}`, () => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true })()`)),
    /** Clicks `sel` if it is there and enabled now; false if not. */
    tapNow: (sel: string) => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true })()`) as Promise<boolean>,
    doubleTap: (sel: string) => js(`(() => { const q = () => document.querySelector(${JSON.stringify(sel)}); q().click(); const b = q(); if (b) { b.disabled = false; b.click() } return true })()`),
    see: async (what: string, ms?: number) => {
      let last = ''
      try {
        return await until(`${name} to show "${what}"`, async () => (last = String((await js('document.body.innerText')) ?? '')).includes(what), ms)
      } catch (err) {
        throw new Error(`${(err as Error).message}; it showed: ${JSON.stringify(last.replace(/\s+/g, ' ').slice(0, 300))}`)
      }
    },
    knob: (k: string, v: number) => js(`localStorage.setItem('chaos-${k}', '${v}')`),
    /** The phone put away (hidden, out of focus) or back, with the events a browser sends. */
    away: (isAway: boolean) =>
      js(`(() => { window.__vis = ${isAway ? "'hidden'" : "'visible'"}; window.__focus = ${!isAway}; document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new Event(${isAway ? "'blur'" : "'focus'"})); return true })()`),
    deviceId: async () => JSON.parse(String((await js(`localStorage.getItem('cf:device')`)) ?? '{}')).id as string,
    close: () => ws.close(),
  }
}

// ---- a session, one per scenario: run.ts's, cut down, with the plugin's fetch timeout and the faults' knobs ----
type Session = ReturnType<typeof startSession>
function startSession(o: { identity?: Identity; refuses?: boolean; name?: string } = {}) {
  const identity: Identity = o.identity ?? { room: randomId(), token: randomId(32), sk: newIdentity().sk }
  const pairing: Pairing = { secret: randomId(32), until: Date.now() + PAIRING_MS }
  const id = crypto.randomUUID()
  const project = '/work/claudeflow'
  let link = createLink({ identity, session: id, origin: ORIGIN, project })
  const s = {
    identity, pairing, id, pk: publicKeyOf(identity.sk),
    devices: [] as Device[],
    /** Not posting until then: a tick stuck on the Mac (the engine busy, the lid shut). */
    lagUntil: 0,
    posts: 0,
    denied: [] as { at: number; to: string; why: string }[],
    welcomed: [] as { at: number; to: string }[],
    isRunning: true,
    /** A session that has lost this device (older plugin, another account's store): it refuses every hello. */
    refuses: !!o.refuses,
    /**
     * While a pairing is open the session polls every 6 s for any device. On a real Mac none is open when the person
     * unlocks, so it is closed once the device has paired: unlocks then meet the idle 30 s cadence.
     */
    isPairingOpen: true,
    /** As a new Claude session would start: its link from scratch. */
    restart: () => (link = createLink({ identity, session: id, origin: ORIGIN, project })),
  }
  const snapshot = (): Snapshot =>
    ({
      v: 1, session: { id, account: 'chaos', project: 'claudeflow', busy: false, proto: 2 }, at: Date.now(),
      streams: [{ id: 'st1', name: 'relay deploy', color: '#79c0ff', kind: 'waiting', state: 'WAITING FOR YOU', detail: '', question: INSIDE, agents: [], rows: [] }],
      status: [], limits: [], updates: [], permissions: [], questions: [], settled: [],
    }) as Snapshot
  void (async () => {
    while (s.isRunning) {
      const now = Date.now()
      const known = () => ({ devices: s.refuses ? [] : s.devices, pairing: s.refuses || !s.isPairingOpen ? undefined : pairing, invites: [], now, snapshot: snapshot(), isHolding: false })
      let post = now < s.lagUntil ? undefined : link.next(known())
      while (post) {
        s.posts++
        for (const f of post.frames) {
          const t = (f.data as { t: string }).t
          if (t === 'denied') s.denied.push({ at: Date.now(), to: f.to, why: (f.data as { why: string }).why })
          if (t === 'welcome') s.welcomed.push({ at: Date.now(), to: f.to })
        }
        const r = await fetch(`${UP}/v1/room/${identity.room}/up`, { method: 'POST', body: JSON.stringify(post), signal: AbortSignal.timeout(FETCH_MS) }).catch(() => undefined)
        const got = link.answered(r?.ok ? await r.text().catch(() => undefined) : undefined, now)
        if (!s.refuses) s.devices = withPaired(s.devices, got.paired)
        post = got.again ? link.next(known()) : undefined
      }
      await sleep(TICK_MS)
    }
  })()
  return s
}

// ---- one unlock, watched ----
type Attempt = { ok: boolean; ms: number; seen: string[]; final: string; events: string[] }
/** What the gate says now: a refusal or note (`.why`), the slow note, a pending button, Locked, or in. */
const GATE = `(() => {
  const t = s => document.querySelector(s)?.innerText?.replace(/\\s+/g, ' ').trim() || ''
  const body = document.body.innerText
  return { in: body.includes(${JSON.stringify(INSIDE)}), why: t('.gate .why'), slow: t('.gate .slow'), button: t('[data-gate]'), meta: t('.gate .meta'), h: t('.gate h2') }
})()`
async function attempt(d: Page, tap: () => Promise<unknown>, during?: (t0: number) => Promise<void>): Promise<Attempt> {
  const id = await d.deviceId()
  const from = events.get(id)?.length ?? 0
  const seen: string[] = []
  const t0 = Date.now()
  await tap()
  const side = during?.(t0).catch(e => seen.push(`(fault step failed: ${(e as Error).message})`))
  let last = ''
  let ok = false
  while (Date.now() - t0 < CAP_MS) {
    const g = (await d.js(GATE).catch(() => undefined)) as { in: boolean; why: string; slow: string; button: string; meta: string; h: string } | undefined
    if (g?.in) {
      ok = true
      break
    }
    if (g) {
      last = [g.h, g.button, g.why, g.slow, g.meta].filter(Boolean).join(' | ')
      for (const x of [g.why, g.slow, g.meta]) if (x && !seen.includes(x)) seen.push(x)
    }
    await sleep(250)
  }
  await side
  const ev = (events.get(id) ?? []).slice(from).map(e => `${((e.at - t0) / 1000).toFixed(1)}s ${e.what}`)
  return { ok, ms: Date.now() - t0, seen, final: ok ? INSIDE : last, events: compact(ev) }
}
/** Event lines with runs of the same frame type collapsed, so a report stays readable. */
const compact = (ev: string[]) => {
  const out: string[] = []
  for (const e of ev) {
    const what = e.split(' ')[1]
    const prev = out.at(-1)
    if (prev && prev.endsWith(` ${what}`)) out[out.length - 1] = prev.replace(/( ×\d+)?$/, m => ` ×${(Number(m.slice(2)) || 1) + 1}`)
    else if (prev && /×\d+$/.test(prev) && prev.split(' ')[1] === what) out[out.length - 1] = prev.replace(/×(\d+)$/, (_, k) => `×${Number(k) + 1}`)
    else out.push(e)
  }
  return out.slice(0, 40)
}

/** Fresh connection, locked, line up: as the app is opened again after time away. */
async function relock(d: Page) {
  await d.reload()
  await d.see('Locked', 30_000).catch(async e => {
    const why = await d.js(`JSON.stringify({ href: location.href, ready: document.readyState, html: document.documentElement.outerHTML.slice(0, 400) })`).catch(x => String(x))
    throw new Error(`${(e as Error).message} :: ${why}`)
  })
  await until(`${d.name} line up`, async () => !(await d.js(`!!document.querySelector('[data-gate="unlock"]')?.disabled`)), 30_000)
}

// ---- the scenarios ----
type Ctx = { d: Page; s: Session; id: string; rep: number }
type Scenario = {
  name: string
  what: string
  reps?: number
  /** Runs alone (after the others): it touches every room. */
  isGlobal?: boolean
  /** Extra sessions in the room, made once. */
  extra?: (s: Session) => Session[]
  run(c: Ctx): Promise<Attempt>
}
const unlock = (d: Page) => () => d.tap('[data-gate="unlock"]')
const after = (ms: number) => sleep(ms)

const SCENARIOS: Scenario[] = [
  { name: 'baseline', what: 'no fault: a locked app, Unlock, the idle session answers', run: async ({ d }) => attempt(d, unlock(d)) },
  {
    name: 'drop-faceid',
    what: 'the socket drops while Face ID (3 s) is up, before the hello is sent',
    run: async ({ d, id }) => {
      await d.knob('faceid', 3000)
      const a = await attempt(d, unlock(d), async () => {
        await after(1000)
        dropAll(id)
      })
      await d.knob('faceid', 0)
      return a
    },
  },
  {
    name: 'drop-hello',
    what: 'the socket drops as the hello goes up (the hello is lost with it)',
    run: async ({ d, id }) => {
      devFaults.set(id, { drop: { dir: 'up', t: 'hello' } })
      const a = await attempt(d, unlock(d))
      devFaults.delete(id)
      return a
    },
  },
  {
    name: 'drop-after-hello',
    what: 'the hello reaches the relay, then the socket drops 2 s later, before any session answers',
    run: async ({ d, id }) =>
      attempt(d, unlock(d), async () => {
        await until('hello up', () => (events.get(id) ?? []).some(e => e.what === 'up:hello'), 15_000)
        await after(2000)
        dropAll(id)
      }),
  },
  {
    name: 'drop-welcome',
    what: 'the socket drops right after the welcome is delivered (before the first snapshot)',
    run: async ({ d, id }) => {
      devFaults.set(id, { drop: { dir: 'down', t: 'welcome' } })
      const a = await attempt(d, unlock(d))
      devFaults.delete(id)
      return a
    },
  },
  {
    name: 'drop-snapshot',
    what: 'the socket drops right after the first sealed snapshot arrives (the app is in, then the line goes)',
    run: async ({ d, id }) => {
      devFaults.set(id, { drop: { dir: 'down', t: 'box', after: 300 } })
      const a = await attempt(d, unlock(d))
      devFaults.delete(id)
      // In counts only if it stays in: the drop came just after.
      if (a.ok) {
        await sleep(8000)
        const g = (await d.js(GATE)) as { in: boolean; h: string; why: string }
        if (!g.in) return { ...a, ok: false, final: `in, then thrown out to: ${g.h} ${g.why}`.trim() }
      }
      return a
    },
  },
  {
    name: 'faceid-slow',
    what: 'Face ID takes 10–40 s, the page blurred under the sheet and focused as it answers',
    reps: Math.ceil(REPS / 2),
    run: async ({ d, rep }) => {
      await d.knob('faceid', [10_000, 25_000, 40_000][rep % 3]!)
      const a = await attempt(d, unlock(d))
      await d.knob('faceid', 0)
      return a
    },
  },
  {
    name: 'background',
    what: 'put away 20 s after the hello goes up (hidden, blurred), the socket killed meanwhile as iOS does, then back',
    run: async ({ d, id }) =>
      attempt(d, unlock(d), async () => {
        await until('hello up', () => (events.get(id) ?? []).some(e => e.what === 'up:hello'), 15_000)
        await d.away(true)
        await after(5000)
        dropAll(id)
        devFaults.set(id, { blockUntil: Date.now() + 15_000 })
        await after(15_000)
        devFaults.delete(id)
        await d.away(false)
      }),
  },
  {
    name: 'double-tap-retry',
    what: 'Unlock tapped twice, then Retry pressed whenever it shows',
    run: async ({ d }) =>
      attempt(d, () => d.doubleTap('[data-gate="unlock"]'), async t0 => {
        while (Date.now() - t0 < CAP_MS - 5000) {
          if (((await d.js(GATE)) as { in: boolean }).in) return
          if (await d.tapNow('[data-gate="retry"]')) await sleep(3000)
          await sleep(500)
        }
      }),
  },
  {
    name: 'flap',
    what: 'the network flaps during the unlock: the line drops and stays down 3 s, twice',
    run: async ({ d, id }) =>
      attempt(d, unlock(d), async () => {
        for (const wait of [1500, 6000]) {
          await after(wait)
          dropAll(id)
          devFaults.set(id, { blockUntil: Date.now() + 3000 })
          await d.js(`dispatchEvent(new Event('offline'))`)
          await after(3000)
          devFaults.delete(id)
          await d.js(`dispatchEvent(new Event('online'))`)
        }
      }),
  },
  {
    name: 'idle-edge-close',
    what: 'the edge closes sockets idle for 20 s (a locked app sends nothing); Unlock tapped at a random moment',
    run: async ({ d, id, rep }) => {
      devFaults.set(id, { idleCloseMs: 20_000 })
      await relock(d)
      await sleep(15_000 + ((rep * 3700) % 10_000))
      const a = await attempt(d, unlock(d))
      devFaults.delete(id)
      return a
    },
  },
  {
    name: 'skew-ahead',
    what: "the phone's clock 2–3 min ahead of the Mac's",
    reps: Math.ceil(REPS / 2),
    run: async ({ d, rep }) => {
      await d.knob('skew', rep % 2 ? 150_000 : 180_000)
      await relock(d)
      const a = await attempt(d, unlock(d))
      await d.knob('skew', 0)
      return a
    },
  },
  {
    name: 'skew-behind',
    what: "the phone's clock 3 min behind the Mac's",
    reps: Math.ceil(REPS / 2),
    run: async ({ d }) => {
      await d.knob('skew', -180_000)
      await relock(d)
      const a = await attempt(d, unlock(d))
      await d.knob('skew', 0)
      return a
    },
  },
  {
    name: 'minute-edge',
    what: 'Unlock tapped 1 s before a minute turns, Face ID 2 s',
    reps: Math.ceil(REPS / 2),
    run: async ({ d }) => {
      await d.knob('faceid', 2000)
      await until('a minute edge', () => Date.now() % 60_000 > 58_800, 70_000)
      const a = await attempt(d, unlock(d))
      await d.knob('faceid', 0)
      return a
    },
  },
  {
    name: 'focus-storm',
    what: 'once in, the person flips away and back 12 times in 30 s (notifications, app switcher); does it stay in?',
    reps: Math.ceil(REPS / 2),
    run: async ({ d, id }) => {
      const a = await attempt(d, unlock(d))
      if (!a.ok) return a
      const t0 = Date.now()
      for (let i = 0; i < 12; i++) {
        await d.away(true)
        await sleep(600)
        await d.away(false)
        await sleep(1900)
      }
      await sleep(4000)
      const g = (await d.js(GATE)) as { in: boolean; h: string; why: string; button: string }
      // What the socket did during the flips: messages sent up, and how it closed.
      const wire = (events.get(id) ?? []).filter(e => e.at >= t0).map(e => `${((e.at - t0) / 1000).toFixed(1)}s ${e.what}`)
      const ups = wire.filter(e => / up:/.test(e)).length
      const out = { ...a, events: compact(wire) }
      return g.in ? out : { ...out, ok: false, ms: Date.now() - t0, final: `in, then thrown out to: ${[g.h, g.button, g.why].filter(Boolean).join(' | ')} (${ups} messages up in the flips)` }
    },
  },
  {
    name: 'two-tabs',
    what: 'once in, a second tab of the same browser opens the app (same device id); does the first stay in?',
    reps: Math.ceil(REPS / 3),
    run: async ({ d }) => {
      const a = await attempt(d, unlock(d))
      if (!a.ok) return a
      const tab = await d.newTab(`${ORIGIN}/`)
      await sleep(20_000)
      const g = (await d.js(GATE)) as { in: boolean; h: string; why: string; button: string }
      const t2 = await tab.text()
      tab.close()
      return g.in ? a : { ...a, ok: false, final: `first tab thrown out to: ${[g.h, g.button, g.why].filter(Boolean).join(' | ')}; second tab shows: ${t2.replace(/\s+/g, ' ').slice(0, 80)}` }
    },
  },
  {
    name: 'relay-5xx',
    what: "the relay answers the session's next 3 posts with 503 just after the hello",
    run: async ({ d, s }) => attempt(d, unlock(d), async () => void upFaults.set(s.identity.room, { fail: 3, status: 503 })).finally(() => upFaults.delete(s.identity.room)),
  },
  {
    name: 'relay-slow',
    what: "every session post takes 12 s at the relay during the unlock",
    run: async ({ d, s }) => {
      upFaults.set(s.identity.room, { delayMs: 12_000 })
      const a = await attempt(d, unlock(d))
      upFaults.delete(s.identity.room)
      return a
    },
  },
  {
    name: 'relay-hang',
    what: "the session's next post hangs (no answer; the plugin gives up after 20 s)",
    run: async ({ d, s }) => attempt(d, unlock(d), async () => void upFaults.set(s.identity.room, { hang: 1 })).finally(() => upFaults.delete(s.identity.room)),
  },
  {
    name: 'session-stall',
    what: "the session's tick stalls 40 s just as the person taps Unlock",
    run: async ({ d, s }) => attempt(d, () => ((s.lagUntil = Date.now() + 40_000), d.tap('[data-gate="unlock"]'))),
  },
  {
    name: 'refuser-then-late',
    what: 'another session in the room refuses (lost the device) at once; the right one is stalled 40 s',
    extra: s => [startSession({ identity: s.identity, refuses: true })],
    run: async ({ d, s }) => attempt(d, () => ((s.lagUntil = Date.now() + 40_000), d.tap('[data-gate="unlock"]'))),
  },
  {
    name: 'refuser-normal',
    what: 'another session in the room refuses (lost the device); the right one keeps its normal 30 s pace',
    extra: s => [startSession({ identity: s.identity, refuses: true })],
    run: async ({ d }) => attempt(d, unlock(d)),
  },
  {
    name: 'relay-restart',
    what: 'the relay restarts (a deploy) 2 s after the hello goes up: every socket lost, storage kept',
    isGlobal: true,
    reps: Math.ceil(REPS / 3),
    run: async ({ d, id }) =>
      attempt(d, unlock(d), async () => {
        await until('hello up', () => (events.get(id) ?? []).some(e => e.what === 'up:hello'), 15_000)
        await after(2000)
        await restartRelay()
      }),
  },
]

// ---- the run ----
type Result = { name: string; what: string; attempts: Attempt[] }
const results: Result[] = []
const stopLeftovers = () => {
  for (const pattern of [`${TMP}/chrome-`, `wrangler dev --port ${RELAY_PORT}`, `workerd serve.*:${RELAY_PORT}`]) spawnSync('pkill', ['-f', pattern])
}
async function runScenario(sc: Scenario, i: number) {
  const s = startSession()
  let extra: Session[] = []
  const d = await openDevice(sc.name, 9421 + OFFSET + i)
  const result: Result = { name: sc.name, what: sc.what, attempts: [] }
  results.push(result)
  try {
    await d.goto(`${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=${s.pairing.secret}`)
    await d.see('Create passkey', 30_000)
    await d.tap('[data-gate="pair"]')
    await d.see(INSIDE, 90_000)
    s.isPairingOpen = false
    // Other sessions join once the device is paired: a refusing one would deny the pairing too.
    extra = sc.extra?.(s) ?? []
    const id = await d.deviceId()
    const reps = sc.reps ?? REPS
    for (let rep = 0; rep < reps; rep++) {
      await sleep(GAP_MS)
      await relock(d)
      const a = await sc.run({ d, s, id, rep }).catch(e => ({ ok: false, ms: 0, seen: [], final: `harness: ${(e as Error).message}`, events: [] }) as Attempt)
      result.attempts.push(a)
      log(`${sc.name} #${rep + 1}: ${a.ok ? `in after ${(a.ms / 1000).toFixed(1)} s` : 'FAILED'}${a.seen.length ? `  saw: ${a.seen.join(' / ')}` : ''}${a.ok ? '' : `  final: ${a.final}`}`)
    }
  } catch (e) {
    log(`${sc.name}: setup failed: ${(e as Error).message}`)
    result.attempts.push({ ok: false, ms: 0, seen: [], final: `setup: ${(e as Error).message}`, events: [] })
  } finally {
    s.isRunning = false
    for (const x of extra) x.isRunning = false
    d.close()
  }
}

try {
  stopLeftovers()
  await sleep(1000)
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  const v = spawnSync('node', ['--version']).stdout?.toString().trim() ?? ''
  if (Number(/^v(\d+)/.exec(v)?.[1] ?? 0) < 22) throw new Error(`wrangler needs Node 22+ on PATH, found ${v || 'none'}`)
  await startRelay()
  startProxy()
  const chosen = SCENARIOS.filter(sc => !ONLY || ONLY.includes(sc.name))
  const local = chosen.filter(sc => !sc.isGlobal)
  const WAVE = Number(process.env.CHAOS_WAVE ?? 8)
  for (let i = 0; i < local.length; i += WAVE) {
    log(`wave: ${local.slice(i, i + WAVE).map(s => s.name).join(', ')}`)
    await Promise.all(local.slice(i, i + WAVE).map((sc, j) => runScenario(sc, i + j)))
  }
  for (const [j, sc] of chosen.filter(sc => sc.isGlobal).entries()) await runScenario(sc, 60 + j)
} catch (e) {
  log('chaos run stopped:', (e as Error).message)
} finally {
  for (const p of procs) {
    try {
      process.kill(-p.pid!, 'SIGTERM')
    } catch {}
  }
  stopLeftovers()
  writeFileSync(join(TMP, 'chaos.json'), JSON.stringify(results, null, 1))
  console.log('\n==== chaos summary ====')
  for (const r of results) {
    const fails = r.attempts.filter(a => !a.ok)
    const errs = r.attempts.filter(a => a.ok && a.seen.length)
    const times = r.attempts.filter(a => a.ok).map(a => a.ms / 1000).sort((x, y) => x - y)
    console.log(`${r.name.padEnd(18)} ${fails.length}/${r.attempts.length} failed, ${errs.length} showed a note on the way in; in after ${times.length ? `${times[0]!.toFixed(0)}–${times.at(-1)!.toFixed(0)} s` : '-'}  — ${r.what}`)
    for (const f of fails.slice(0, 3)) console.log(`    final: ${f.final}\n    saw: ${f.seen.join(' / ') || '-'}\n    wire: ${f.events.join(', ')}`)
  }
  console.log(`\nfull results: ${join(TMP, 'chaos.json')}`)
  process.exit(0)
}
