// End-to-end proof, all on this Mac: the real relay (`wrangler dev`), the real app (relay/cloudflare/public, built by
// app/build.sh), two headless Chrome devices with virtual passkeys, and a Claude Code session played by the plugin's
// own pure remote core (hooks/remote/link.ts + seal.ts) posting to /v1/room/{room}/up with real fetch calls, on
// the link's own polling cadence.
// Run from the repo root with Node 22+ on PATH (wrangler needs it): bun e2e/run.ts [shots dir]; E2E_SCHEME=dark for dark.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INVITE_MS, PAIRING_MS, SHARE_DAYS, createLink, withPaired, type Device, type Identity, type Invite, type Pairing } from '../plugins/streams/hooks/remote/link'
import { newIdentity, publicKeyOf, randomId } from '../plugins/streams/hooks/remote/seal'
import type { Ack, PhoneCommand, Settled, Snapshot } from '../plugins/streams/hooks/remote/snapshot'
import { qrVideo } from './camera'
import { linkFragment } from '../app/src/links'

const ROOT = join(import.meta.dir, '..')
const SHOTS = process.argv[2] ?? join(ROOT, 'e2e', 'shots')
/** E2E_OFFSET moves every port and the temp folder, so two runs (two worktrees) never stop each other's processes. */
const OFFSET = Number(process.env.E2E_OFFSET ?? 0)
const TMP = join(tmpdir(), `claudeflow-e2e${OFFSET ? `-${OFFSET}` : ''}`)
const PORT = 8791 + OFFSET
// Pages load from localhost: a passkey needs a host name (not an IP) and a secure context, which localhost is.
const ORIGIN = `http://localhost:${PORT}`
const UP = `http://127.0.0.1:${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/**
 * How long a hello or a command may wait for the session to read it. The session learns that a device is looking
 * only from a post's answer after the device was welcomed and pinged, so until then it polls at its idle 30 s
 * (ARCHITECTURE.md, "Polling budget").
 */
const POLL_WAIT_MS = 45_000
/** A refusal shows once no other session has let the device in for transport.ts DENY_GRACE_MS (35 s). */
const DENIAL_WAIT_MS = POLL_WAIT_MS + 35_000
/** The app's state.ts SLOW_MS: how long a hello waits before the app says nobody has answered. */
const SLOW_MS = 45_000
/** Words that mean nothing to someone a project was shared with: they never set up Claude Code. */
const JARGON = /\bMac\b|pair|\/streams|passkey|Claude Code/i
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
}

const results: { name: string; ok: boolean; why?: string }[] = []
const check = (name: string, ok: boolean, why = '') => {
  results.push({ name, ok, why })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !why ? '' : `  (${why})`}`)
}
const procs: ChildProcess[] = []
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

// ---- the relay, with a VAPID key of this run's as its secret ----
async function startRelay() {
  const vapid = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair
  const secret = Buffer.from(await crypto.subtle.exportKey('pkcs8', vapid.privateKey)).toString('base64url')
  const log = openSync(join(TMP, 'wrangler.log'), 'w')
  const p = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--var', `VAPID_PRIVATE_KEY:${secret}`, ...(OFFSET ? ['--inspector-port', String(9229 + OFFSET)] : [])], {
    cwd: join(ROOT, 'relay/cloudflare'), detached: true, stdio: ['ignore', log, log],
  })
  procs.push(p)
  return until('wrangler dev', () => fetch(`${UP}/`).then(r => r.ok, () => false), 60_000)
}

// ---- a push service on this Mac: headless Chrome has none, so the devices' subscriptions point here ----
const PUSH_PORT = 8795 + OFFSET
const pushes: { path: string; authorization: string; body: Uint8Array }[] = []
function startPushService() {
  return Bun.serve({
    port: PUSH_PORT, hostname: '127.0.0.1',
    fetch: async req => (pushes.push({ path: new URL(req.url).pathname, authorization: req.headers.get('authorization') ?? '', body: new Uint8Array(await req.arrayBuffer()) }), new Response(null, { status: 201 })),
  })
}

/** A browser's push keys: what PushManager would make, so this run can open what the relay sealed (RFC 8291). */
async function pushKeys(path: string) {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const json = { endpoint: `http://127.0.0.1:${PUSH_PORT}${path}`, expirationTime: null, keys: { p256dh: Buffer.from(pub).toString('base64url'), auth: Buffer.from(auth).toString('base64url') } }
  const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8))
  const text = (s: string) => new TextEncoder().encode(s)
  /** The push body opened with this browser's private key: what the phone would read. */
  async function open(body: Uint8Array): Promise<string> {
    const salt = body.slice(0, 16)
    const asPublic = body.slice(21, 21 + body[20]!)
    const peer = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, keys.privateKey, 256))
    const ikm = await hkdf(auth, ecdh, Buffer.concat([text('WebPush: info\0'), pub, asPublic]), 32)
    const aes = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['decrypt'])
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12) }, aes, body.slice(21 + body[20]!)))
    return new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2)))
  }
  return { json, open }
}

/** Makes a page's Push API hand out `sub` (headless Chrome cannot reach a real push service) and allow notifications. */
const fakePushApi = (sub: unknown) => `(() => {
  let permission = 'default', current = null
  Object.defineProperty(Notification, 'permission', { get: () => permission, configurable: true })
  Notification.requestPermission = async () => (permission = 'granted')
  PushManager.prototype.getSubscription = async () => current
  PushManager.prototype.subscribe = async () => (current = { toJSON: () => (${JSON.stringify(sub)}), unsubscribe: async () => ((current = null), true) })
  return true
})()`

// ---- a device: one headless Chrome with its own profile and a virtual platform authenticator ----
type Page = Awaited<ReturnType<typeof openDevice>>
/**
 * What a device is: its browser's user agent and screen, and its authenticator: built in (`internal`, Face ID or
 * Windows Hello), only a security key or phone (`usb`, as on most Linux and some Windows), or no WebAuthn at all.
 */
type Kind = { ua?: string; width?: number; height?: number; isMobile?: boolean; auth?: 'internal' | 'usb' | 'none' }
async function openDevice(name: string, port: number, extra: string[] = [], kind: Kind = {}) {
  const p = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(TMP, `chrome-${name}`)}`,
    '--no-first-run', '--no-default-browser-check', ...extra, 'about:blank'], { detached: true, stdio: 'ignore' })
  procs.push(p)
  const targets = await until(`${name} DevTools`, () =>
    fetch(`http://127.0.0.1:${port}/json`).then(r => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>, () => undefined), 60_000)
  const ws = new WebSocket(targets.find(t => t.type === 'page')!.webSocketDebuggerUrl)
  await new Promise(r => (ws.onopen = r))
  let n = 0
  const waiting = new Map<number, (m: { result?: any; error?: unknown }) => void>()
  ws.onmessage = m => {
    const msg = JSON.parse(String(m.data))
    if (msg.method === 'Runtime.exceptionThrown') console.log(`  [${name}] page error:`, msg.params.exceptionDetails.exception?.description)
    waiting.get(msg.id)?.(msg)
  }
  const send = (method: string, params = {}) =>
    new Promise<any>((ok, no) => {
      const id = ++n
      waiting.set(id, m => (m.error ? no(new Error(`${method}: ${JSON.stringify(m.error)}`)) : ok(m.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: kind.width ?? 390, height: kind.height ?? 844, deviceScaleFactor: kind.isMobile === false ? 1 : 2, mobile: kind.isMobile ?? true })
  if (kind.ua) await send('Emulation.setUserAgentOverride', { userAgent: kind.ua })
  // A browser with no WebAuthn: the page never sees one.
  if (kind.auth === 'none') {
    await send('Page.enable')
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'delete window.PublicKeyCredential; Object.defineProperty(Navigator.prototype, "credentials", { get: () => undefined })' })
  }
  // The devices' colour scheme: light by default, E2E_SCHEME=dark to check the dark theme.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: process.env.E2E_SCHEME === 'dark' ? 'dark' : 'light' }] })
  // Headless pages never have focus; a phone in the hand does, and only a focused page counts as looking.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('WebAuthn.enable')
  const { authenticatorId } = kind.auth === 'none' ? { authenticatorId: undefined } : await send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: kind.auth ?? 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const js = async (expression: string) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.value
  return {
    name,
    goto: (url: string) => send('Page.navigate', { url }),
    reload: () => send('Page.reload'),
    js,
    text: () => js('document.body.innerText') as Promise<string>,
    /** A tap, as a person makes it: with a user gesture, so WebAuthn may run. */
    tap: (sel: string) => until(`${name}: ${sel}`, () => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b || b.disabled) return false; b.click(); return true })()`)),
    see: (what: string, ms?: number) => until(`${name} to show "${what}"`, async () => String((await js('document.body.innerText')) ?? '').includes(what), ms),
    width: kind.width ?? 390,
    /** Phone (390), tablet (820) or Mac (1280): the app picks its layout from the width, as on the real device. */
    async resize(width: number, height: number) {
      this.width = width
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: width > 390 ? 1 : 2, mobile: width <= 390 })
      await sleep(400)
    },
    /** A finger swipe across `sel`, from `from` (a selector inside it, or its middle) by dx and drifting dy, as touch input. */
    async swipe(sel: string, dx: number, from?: string, dy = 0) {
      const at = (await js(`(() => { const e = document.querySelector(${JSON.stringify(from ?? sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 } })()`)) as { x: number; y: number } | null
      if (!at) throw new Error(`${name}: nothing at ${from ?? sel} to swipe`)
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      const touch = (type: string, x: number, y = at.y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] })
      await touch('touchStart', at.x)
      for (let i = 1; i <= 8; i++) {
        await touch('touchMove', at.x + (dx * i) / 8, at.y + (dy * i) / 8)
        await sleep(40)
      }
      await touch('touchEnd', at.x + dx)
      await send('Emulation.setTouchEmulationEnabled', { enabled: false })
    },
    async shot(file: string) {
      const h = (await js('document.documentElement.scrollHeight')) as number
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: this.width, height: Math.max(844, h), scale: 1 } })
      writeFileSync(join(SHOTS, file), Buffer.from(s.data, 'base64'))
    },
    /** The app put away, as a phone in a pocket: the page is frozen, so it stops saying it is looking. */
    freeze: async () => {
      await send('Emulation.setFocusEmulationEnabled', { enabled: false })
      await send('Page.setWebLifecycleState', { state: 'frozen' })
    },
    deviceId: async () => JSON.parse((await js(`localStorage.getItem('cf:device')`)) ?? '{}').id as string,
    /** The passkeys this device's authenticator holds: one per pairing ceremony that ran. */
    passkeys: async () => (authenticatorId ? ((await send('WebAuthn.getCredentials', { authenticatorId })).credentials as unknown[]).length : 0),
    /** Types `text` where the focus is, then presses Enter: a keyboard, not a tap. */
    async typeAndEnter(sel: string, text: string) {
      await js(`document.querySelector(${JSON.stringify(sel)}).focus()`)
      await send('Input.insertText', { text })
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    },
    /** Two taps as fast as a thumb, the second landing before the redraw disables the button (as on a slow phone). */
    doubleTap: (sel: string) =>
      js(`(() => { const q = () => document.querySelector(${JSON.stringify(sel)}); q().click(); const b = q(); b.disabled = false; b.click(); return true })()`),
    /** Whether `sel` is disabled now. */
    isDisabled: (sel: string) => js(`!!document.querySelector(${JSON.stringify(sel)})?.disabled`) as Promise<boolean>,
    close: () => ws.close(),
  }
}

// ---- the session: what hooks/remote/index.ts does on each tick, with plain fetch and memory for $.store ----
/** hooks/remote/index.ts's TICK_MS (index.ts needs the engine, so it is not imported here). */
const TICK_MS = 2000

function startSession() {
  const sk = newIdentity().sk
  const identity: Identity = { room: randomId(), token: randomId(32), sk }
  const pairing: Pairing = { secret: randomId(32), until: Date.now() + PAIRING_MS }
  const id = crypto.randomUUID()
  const link = createLink({ identity, session: id, origin: ORIGIN, project: '/work/claudeflow' })
  const s = {
    identity, pairing, pk: publicKeyOf(sk), id,
    devices: [] as Device[],
    /** Shared invites until they expire, as index.tsx keeps them in $.store. */
    invites: [] as Invite[],
    commands: [] as { device: string; command: PhoneCommand }[],
    denied: [] as { to: string; why: string }[],
    permissions: [] as Snapshot['permissions'],
    questions: [] as NonNullable<Snapshot['questions']>,
    /** What became of prompts no longer held, as index.ts keeps it for late taps and the snapshot. */
    settled: [] as Settled[],
    answer: (() => {}) as (id: string, why: Settled["why"], label?: string) => void,
    acks: [] as { device: string; ack: Ack }[],
    /** Pairings taken, per device id: a double tap must make one. */
    pairings: new Map<string, number>(),
    /** A slow Mac: while set, the session does not post at all. */
    isLagging: false,
    posts: 0,
    isRunning: true,
  }
  /** A held prompt or question ends (on a phone, or on the Mac): it leaves the snapshot, which says how. */
  s.answer = (id, why, label) => {
    s.permissions = s.permissions.filter(p => p.id !== id)
    s.questions = s.questions.filter(q => q.id !== id)
    s.settled = [...s.settled, { id, why, at: Date.now(), ...(label ? { label } : {}) }]
  }
  const at = Date.now()
  // A Workflow run mid-way: one phase done, one running with a failure, one not started. Times, not clocks.
  const agent = (id: string, label: string, status: 'running' | 'done' | 'error', ago: number, took?: number, verdict?: string) =>
    ({ id, label, status, tools: 3, startedAt: at - ago, ...(took ? { endedAt: at - ago + took } : {}), ...(verdict ? { verdict } : {}) })
  const WORKFLOW = {
    name: 'audit', taskId: 'wf_e2e', status: 'running' as const, startedAt: at - 252_000, agents: { run: 2, done: 3, err: 1 }, inferred: false,
    phases: [
      { title: 'Map', done: 2, total: 2, err: 0, agents: [agent('a1', 'map hooks', 'done', 250_000, 60_000), agent('a2', 'map remote', 'done', 250_000, 80_000)] },
      { title: 'Verify', done: 1, total: 4, err: 1, verdicts: { confirmed: 1 },
        agents: [agent('a3', 'verify seal replay', 'error', 120_000, 40_000), agent('a4', 'verify passkey origin', 'done', 120_000, 70_000, 'confirmed'), agent('a5', 'verify link backoff', 'running', 110_000), agent('a6', 'verify room limits', 'running', 100_000)] },
      { title: 'Fix', done: 0, total: 0, err: 0, agents: [] },
    ],
  }
  const snapshot = (): Snapshot => ({
    v: 1,
    session: { id, account: 'e2e', project: 'claudeflow', busy: true },
    at: Date.now(),
    streams: [
      { id: 'st1', name: 'relay deploy', color: '#79c0ff', kind: 'waiting', state: 'WAITING FOR YOU', detail: '', question: 'Deploy the relay now?', agents: [], rows: [{ kind: 'prompt', text: 'ship the relay', at }] },
      { id: 'st2', name: 'phone app', color: '#ffd33d', kind: 'running', state: 'RUNNING', detail: 'building views', agents: [], rows: [] },
      { id: 'st3', name: 'audit', color: '#d0bfff', kind: 'running', state: 'RUNNING', detail: 'workflow', agents: [], rows: [], workflow: WORKFLOW },
      { id: 'st5', name: 'docs pass', color: '#b2f2bb', kind: 'done', state: 'DONE', detail: '', agents: [],
        rows: [{ kind: 'reply', text: 'Done: see [the guide](https://example.com/guide) and\n```\nnpx wrangler deploy --env production --minify --keep-vars\n```', at }] },
      { id: 'st4', name: 'CI watch', color: '#99e9f2', kind: 'loop', state: 'LOOP', detail: 'CI still running', nextAt: at + 250_000, agents: [], rows: [{ kind: 'loop', text: '↻ tick: checks still pending', at }],
        loop: { kind: 'wakeup', nextAt: at + 250_000, reason: 'CI still running', noopStreak: 3, lastChange: { at: at - 600_000, text: 'PR #12 merged' } } },
    ],
    summary: { workflows: 1, agentsRunning: 2, failures: 1, nextTickAt: at + 250_000 },
    archived: [{ id: 'st9', name: 'old chore', color: '#ff94d1' }],
    status: [{ id: 'g', area: 'main', state: 'clean', detail: '' }],
    limits: [],
    updates: [],
    permissions: s.permissions,
    questions: s.questions,
    settled: s.settled,
  }) as Snapshot
  // The same calls as index.ts's tick, on the same 2 s clock: the link decides when to post and what.
  void (async () => {
    while (s.isRunning) {
      const now = Date.now()
      // As index.tsx: the owner's devices see who the project is shared with.
      const people = s.devices.flatMap(d => (d.role && !d.removed ? [{ id: d.id, label: d.label, role: d.role, until: d.until ?? 0, pairedAt: d.pairedAt }] : []))
      const known = () => ({ devices: s.devices, pairing, invites: s.invites, now, snapshot: { ...snapshot(), ...(people.length ? { people } : {}) }, isHolding: s.permissions.length > 0 })
      let post = s.isLagging ? undefined : link.next(known())
      let hasAcked = false
      while (post) {
        s.posts++
        for (const f of post.frames) if ((f.data as { t: string }).t === 'denied') s.denied.push({ to: f.to, why: (f.data as { why: string }).why })
        const r = await fetch(`${UP}/v1/room/${identity.room}/up`, { method: 'POST', body: JSON.stringify(post) }).catch(() => undefined)
        const got = link.answered(r?.ok ? await r.text().catch(() => undefined) : undefined, now)
        for (const d of got.paired) s.pairings.set(d.id, (s.pairings.get(d.id) ?? 0) + 1)
        s.devices = withPaired(s.devices, got.paired)
        s.commands.push(...got.commands)
        // What index.tsx's phoneCommand answers, acked in the same tick.
        for (const { device, command: c } of got.commands) {
          let done: Omit<Ack, 't' | 'id'> = { ok: true }
          if (c.kind === 'invite') {
            const secret = randomId(32)
            s.invites.push({ secret, until: Date.now() + INVITE_MS, project: '/work/claudeflow', role: c.role, days: SHARE_DAYS })
            done = { ok: true, secret }
          }
          // As index.tsx: a removed guest is kept as removed, so its next unlock is told so.
          if (c.kind === 'forgetDevice') s.devices = s.devices.map(d => (d.id === c.deviceId && d.role ? { ...d, removed: true, until: Date.now() } : d))
          if (c.kind === 'permission' || c.kind === 'choose') {
            const isHeld = c.kind === 'permission' ? s.permissions.some(p => p.id === c.requestId) : s.questions.some(q => q.id === c.requestId)
            if (isHeld) {
              const why = c.kind === 'choose' ? 'chosen' : c.decision === 'allow' ? 'allowed' : 'denied'
              s.answer(c.requestId, why, c.kind === 'choose' ? c.label : undefined)
              done = { ok: true, why }
            } else done = { ok: false, why: s.settled.find(x => x.id === c.requestId)?.why ?? 'unknown request' }
          }
          const ack: Ack = { t: 'ack', id: c.id, ...done }
          link.ack(device, ack)
          s.acks.push({ device, ack })
        }
        const isAcking = got.commands.length > 0 && !hasAcked
        hasAcked ||= isAcking
        post = got.again || isAcking ? link.next(known()) : undefined
      }
      await sleep(TICK_MS)
    }
  })()
  return s
}

/**
 * Another session of the same account still on an older plugin: it knows the paired devices but not invites, so it
 * refuses a guest's invite hello, as plugins before 1.2 do, while the current session lets the guest in.
 */
function startOlderSession(s: ReturnType<typeof startSession>) {
  const id = crypto.randomUUID()
  const link = createLink({ identity: s.identity, session: id, origin: ORIGIN, project: '/work/[vault:master/CLAUDE_BIN]flow' })
  const o = { id, denied: [] as { to: string; why: string }[], isRunning: true }
  void (async () => {
    while (o.isRunning) {
      const now = Date.now()
      const snapshot = { v: 1, session: { id, account: 'e2e', project: '[vault:master/CLAUDE_BIN]flow', busy: false }, at: now, streams: [], status: [], limits: [], updates: [], permissions: [], questions: [], settled: [] } as Snapshot
      const known = () => ({ devices: s.devices, invites: [], now, snapshot, isHolding: false })
      let post = link.next(known())
      while (post) {
        for (const f of post.frames) if ((f.data as { t: string }).t === 'denied') o.denied.push({ to: f.to, why: (f.data as { why: string }).why })
        const r = await fetch(`${UP}/v1/room/${s.identity.room}/up`, { method: 'POST', body: JSON.stringify(post) }).catch(() => undefined)
        const got = link.answered(r?.ok ? await r.text().catch(() => undefined) : undefined, now)
        post = got.again ? link.next(known()) : undefined
      }
      await sleep(TICK_MS)
    }
  })()
  return o
}

/**
 * Bun does not always start a detached child in its own process group, so what the run started is also stopped by
 * name: the Chromes by their profile folder, wrangler and its workerd by this run's port.
 */
const stopLeftovers = () => {
  for (const pattern of [`${TMP}/chrome-`, `wrangler dev --port ${PORT}`, `workerd serve.*:${PORT}`]) spawnSync('pkill', ['-f', pattern])
}

// ---- the run ----
let failed = false
try {
  // Every wait has its own limit, but a stuck DevTools call has none: the whole run gets eight minutes.
  await Promise.race([
    (async () => {
      const v = spawnSync('node', ['--version']).stdout?.toString().trim() ?? ''
      if (Number(/^v(\d+)/.exec(v)?.[1] ?? 0) < 22) throw new Error(`wrangler 4 needs Node 22+ on PATH, found ${v || 'none'}`)
      stopLeftovers()
      await sleep(1000)
      rmSync(TMP, { recursive: true, force: true })
      mkdirSync(TMP, { recursive: true })
      mkdirSync(SHOTS, { recursive: true })
      await startRelay()
      const pushService = startPushService()
      check('relay serves the app at /', (await (await fetch(`${UP}/`)).text()).includes('app.js'))

      const s = startSession()
      const link = `${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=${s.pairing.secret}`
      // A fourth device has a camera that sees the Mac's pairing code: it pairs from inside the app, never leaving it.
      qrVideo(join(TMP, 'pairing-code.y4m'), link)
      const camera = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${join(TMP, 'pairing-code.y4m')}`]
      const [d1, d2, d3, d4, d5, d6, d7, d8] = await Promise.all([
        openDevice('device1', 9341 + OFFSET), openDevice('device2', 9342 + OFFSET), openDevice('stranger', 9343 + OFFSET), openDevice('scanner', 9344 + OFFSET, camera),
        openDevice('guest', 9345 + OFFSET, [], { ua: UA.iphone }),
        // Guests on other devices: Android Chrome (screen lock built in), Windows with only a security key, Linux
        // with no WebAuthn at all; the desktops at desktop sizes, with a keyboard.
        openDevice('android', 9346 + OFFSET, [], { ua: UA.android, width: 412, height: 915, auth: 'internal' }),
        openDevice('windows', 9347 + OFFSET, [], { ua: UA.windows, width: 1366, height: 768, isMobile: false, auth: 'usb' }),
        openDevice('linux', 9348 + OFFSET, [], { ua: UA.linux, width: 1280, height: 800, isMobile: false, auth: 'none' }),
      ])
      // Like a Home Screen app added from an old pairing link: its start address carries a stale code.
      await d4.goto(`${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=${randomId(32)}`)
      await d4.see('Pair this device')
      await d4.tap('[data-menu]')
      await d4.tap('[data-scan]')
      await until('the scanned code in the address', () => d4.js(`location.hash === ${JSON.stringify(link.slice(link.indexOf('#')))}`))
      await d4.see('Create passkey')
      check('an app scans the pairing code with its camera from the menu and goes on to Create passkey, in the same app, the new code in its address',
        (await d4.js('location.pathname + location.hash')) === link.slice(ORIGIN.length), String(await d4.js('location.pathname')))
      await d4.shot('e2e-00-scanner-paired-in-app.png')

      // Both devices pair at the same time from the same link.
      await Promise.all([d1, d2].map(d => d.goto(link)))
      await Promise.all([d1, d2].map(d => d.see('Pair this device')))
      await d1.shot('e2e-01-device1-pair.png')
      check('both devices show "Pair this device" for the link', true)
      // Device 1 taps Create passkey twice, the second tap landing before the redraw (a slow phone): one ceremony only.
      await d1.see('Create passkey')
      await d1.doubleTap('[data-gate="pair"]')
      await d2.tap('[data-gate="pair"]')
      // The session polls at its idle pace until a device looks, so "Syncing…" shows for a while.
      await d1.see('Syncing…')
      check('Create passkey shows its pending state and is disabled while the Mac checks', await d1.isDisabled('[data-gate="pair"]'))
      await d1.shot('e2e-02a-device1-checking.png')
      await Promise.all([d1, d2].map(d => d.see('Deploy the relay now?', POLL_WAIT_MS)))
      const [id1, id2] = await Promise.all([d1.deviceId(), d2.deviceId()])
      check('both devices paired with a passkey and are stored by the session', s.devices.length === 2 && [id1, id2].every(i => s.devices.some(d => d.id === i)), JSON.stringify(s.devices.map(d => d.id)))
      const [keys1, pairings1] = [await d1.passkeys(), s.pairings.get(id1)]
      check('a double tap on Create passkey made one passkey and paired once (one device stored)',
        keys1 === 1 && pairings1 === 1 && s.devices.filter(d => d.id === id1).length === 1, `passkeys ${keys1}, pairings ${pairings1}`)
      check('each device opened the session\'s sealed snapshot', true)
      await d1.shot('e2e-02-device1-paired.png')

      // A new connection needs Face ID: reload both, see Locked, unlock both with their passkeys.
      await Promise.all([d1, d2].map(d => d.reload()))
      await Promise.all([d1, d2].map(d => d.see('Locked')))
      check('after a reload both devices are Locked', !(await d1.text()).includes('Deploy the relay now?'))
      await d2.shot('e2e-03-device2-locked.png')
      await Promise.all([d1, d2].map(d => d.tap('[data-gate="unlock"]')))
      await Promise.all([d1, d2].map(d => d.see('Deploy the relay now?', POLL_WAIT_MS)))
      check('both devices unlocked with a passkey hello and see the snapshot', true)
      await d2.shot('e2e-04-device2-unlocked.png')

      // Device 1 answers Yes.
      await d1.tap('[data-answer]')
      const answer = await until('the answer command', () => s.commands.find(c => c.command.kind === 'answer'), POLL_WAIT_MS)
      check('device 1 taps Yes and the session receives "answer yes" from device 1',
        answer.device === id1 && answer.command.kind === 'answer' && answer.command.text === 'yes' && answer.command.streamId === 'st1', JSON.stringify(answer))

      // A touch on the dock that never lifts (iOS cancels it when 📎 opens the photo picker) must not hold every redraw.
      await d1.js(`document.querySelector('[data-slides]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
      // A photo attached in the composer shows at once (thumbnail, green 📎), then goes as chunks before the prompt that
      // names it. The file goes in through the input, as the photo picker hands it over.
      await d1.js(`(async () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 48
        const g = c.getContext('2d'); g.fillStyle = '#7cc8ff'; g.fillRect(0, 0, 64, 48)
        const blob = await new Promise(r => c.toBlob(r, 'image/png'))
        const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
        const input = document.querySelector('[data-attach]'); input.files = dt.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await until('the attached thumbnail', () => d1.js(`(() => { const i = document.querySelector('.attached img'); return !!i && i.complete && i.naturalWidth > 0 && !!document.querySelector('.clip.has') })()`))
      check('an attached photo shows at once in the composer: a thumbnail, and 📎 green with a count', true)
      await d1.shot('app-390-attached.png')
      await d1.tap('[data-send]')
      const sentPhoto = await until('the prompt with the photo', () => s.commands.find(c => c.command.kind === 'answer' && !!c.command.files?.length), POLL_WAIT_MS)
      const chunks = s.commands.filter(c => c.command.kind === 'chunk')
      check('the photo reaches the session as chunks before the prompt that names it',
        sentPhoto.command.kind === 'answer' && chunks.length > 0 && chunks.every(c => c.command.kind === 'chunk' && sentPhoto.command.kind === 'answer' && c.command.blob === sentPhoto.command.files![0]!.blob) &&
          s.commands.indexOf(chunks.at(-1)!) < s.commands.indexOf(sentPhoto),
        JSON.stringify({ chunks: chunks.length, files: sentPhoto.command.kind === 'answer' ? sentPhoto.command.files : undefined }))

      // The archived list opens from its heading, and ↺ restores a stream there.
      await d1.tap('.archived-head')
      await until('the archived list open', () => d1.js(`!!document.querySelector('.arow [data-restore]')`))
      await d1.tap('[data-restore]')
      const restored = await until('the restore command', () => s.commands.find(c => c.command.kind === 'restore'), POLL_WAIT_MS)
      check('tapping Archived opens the list, and ↺ there reaches the session as restore for that stream',
        restored.command.kind === 'restore' && restored.command.streamId === 'st9', JSON.stringify(restored))

      // A swipe left archives a finished card wherever the finger lands, a sideways-scrolling code block included; an active
      // card gives a little and stays.
      await d1.swipe('[data-swipe="hold"]', -160)
      await sleep(600)
      check('an active card swiped left is not archived', !s.commands.some(c => c.command.kind === 'archive'))
      await d1.tap('[data-swipe="archive"] .head')
      await until('the done card open', () => d1.js(`!!document.querySelector('[data-swipe="archive"] .body pre')`))
      // As a thumb does it: a short, unhurried move left that drifts down, not a long exact drag.
      await d1.swipe('[data-swipe="archive"]', -64, '[data-swipe="archive"] .body pre', 30)
      const archived = await until('the archive command', () => s.commands.find(c => c.command.kind === 'archive'), POLL_WAIT_MS)
      check('a short, drifting swipe left on a finished card, from a code block in it, reaches the session as archive for that stream',
        archived.command.kind === 'archive' && archived.command.streamId === 'st5', JSON.stringify(archived))

      // A held permission reaches both devices; device 2 allows it with its passkey.
      s.permissions = [{ id: 'toolu_e2e', tool: 'Bash', summary: 'Bash: npx wrangler deploy', at: Date.now(), since: Date.now() }]
      await Promise.all([d1, d2].map(d => d.see('Claude wants to run Bash')))
      check('the held permission shows on both devices', true)
      await d1.shot('e2e-05-device1-permission.png')
      // The Mac is slow: device 2's Allow shows where it is and takes no second tap until the session answers.
      s.isLagging = true
      const ALLOW = '[data-perm="toolu_e2e"][data-decision="allow"]'
      await d2.tap(ALLOW)
      const pendingText = await d2.text()
      const isPending = ['Waiting for Face ID…', 'Sent: waiting for your Mac…'].some(t => pendingText.includes(t))
      check('right after the tap, Allow and Deny are disabled and the card shows the pending text',
        isPending && (await d2.isDisabled(ALLOW)) && (await d2.isDisabled('[data-perm="toolu_e2e"][data-decision="deny"]')), pendingText.slice(0, 200))
      await d2.see('Sent: waiting for your Mac…')
      await d2.shot('e2e-05a-device2-allow-sent.png')
      s.isLagging = false
      const allow = await until('the allow command', () => s.commands.find(c => c.command.kind === 'permission'))
      check('device 2 taps Allow (no second Face ID) and the session receives allow from device 2',
        allow.device === id2 && allow.command.kind === 'permission' && allow.command.decision === 'allow' && allow.command.requestId === 'toolu_e2e', JSON.stringify(allow.command))
      await d2.see('Allowed ✓')
      await d2.shot('e2e-05b-device2-allowed.png')
      check('the session acks the Allow, sealed, and the card resolves to "Allowed ✓"',
        s.acks.some(a => a.device === id2 && a.ack.id === allow.command.id && a.ack.ok && a.ack.why === 'allowed'))
      await until('the settled card to collapse', async () => !(await d2.text()).includes('Claude wants to run Bash'), 10_000)
      check('the settled card collapses on its own', s.commands.filter(c => c.command.kind === 'permission').length === 1)

      // A prompt answered in the terminal: it leaves the snapshot saying so, and the phone's card collapses.
      s.permissions = [{ id: 'toolu_mac', tool: 'Bash', summary: 'Bash: rm -rf build', at: Date.now(), since: Date.now() }]
      await d1.see('Claude wants to run Bash')
      check('a held permission has no countdown: it says how long it has waited', (await d1.text()).includes('just now') && !(await d1.text()).includes('s left'))
      s.answer('toolu_mac', 'answered on Mac')
      await d1.see('Answered on your Mac', POLL_WAIT_MS)
      await d1.shot('e2e-05c-device1-answered-on-mac.png')
      await until('the card answered on the Mac to collapse', async () => !(await d1.text()).includes('Answered on your Mac'), 15_000)
      check('a permission answered on the Mac collapses on the phone', !(await d1.text()).includes('rm -rf build'))

      // A question with options: the recommended one first, and a choice from the phone is acked.
      s.questions = [{ id: 'toolu_q', question: 'Which store should the relay use?', header: 'Store', since: Date.now(),
        options: [{ label: 'Postgres', isRecommended: false }, { label: 'SQLite (Recommended)', isRecommended: true }] }]
      await d1.see('Which store should the relay use?')
      const labels = await d1.js(`[...document.querySelectorAll('[data-choose]')].map(b => b.dataset.label)`) as string[]
      await d1.shot('e2e-05d-device1-question.png')
      check('a question shows its options, the recommended one first', JSON.stringify(labels) === JSON.stringify(['SQLite (Recommended)', 'Postgres']), JSON.stringify(labels))
      await d1.tap('[data-choose="toolu_q"][data-label="Postgres"]')
      await d1.see('Chose Postgres ✓', POLL_WAIT_MS)
      check('the phone\'s choice reaches the session and is acked', s.acks.some(a => a.ack.why === 'chosen') && s.commands.some(c => c.command.kind === 'choose' && c.command.label === 'Postgres'))

      // ✕ hides a card on this phone only: the session still holds the prompt, nothing is answered.
      s.permissions = [{ id: 'toolu_hide', tool: 'Bash', summary: 'Bash: make release', at: Date.now(), since: Date.now() }]
      await d1.see('make release')
      await d1.tap('[data-hide="toolu_hide"]')
      await sleep(300)
      check('✕ hides a card without answering it', !(await d1.text()).includes('make release') && s.permissions.length === 1 && !s.commands.some(c => c.command.kind === 'permission' && c.command.requestId === 'toolu_hide'))
      s.permissions = []

      // A stranger with the right room but a made-up secret is turned away and sees nothing.
      await d3.goto(`${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=${randomId(32)}`)
      await d3.see('Pair this device')
      await d3.tap('[data-gate="pair"]')
      await d3.see('bad pairing proof', POLL_WAIT_MS)
      const id3 = await d3.deviceId()
      check('an unpaired device with a bogus secret is denied ("bad pairing proof")', s.denied.some(x => x.to === id3 && x.why === 'bad pairing proof'))
      check('the denied device is not stored and saw no snapshot', !s.devices.some(d => d.id === id3) && !(await d3.text()).includes('Deploy the relay now?'))
      await d3.shot('e2e-06-stranger-denied.png')

      // The scanner pairs with the code it scanned, not the stale one it started with (once: bad pairing proof).
      await d4.tap('[data-gate="pair"]')
      const id4 = await d4.deviceId()
      await until('the scanner paired', () => s.devices.some(d => d.id === id4), POLL_WAIT_MS)
      check('the scanned code pairs, the stale start-address code never coming back over it', !s.denied.some(x => x.to === id4), JSON.stringify(s.denied.filter(x => x.to === id4)))

      // Device 1 shares the project from the ☰ menu: an invite to watch, as a link a guest opens and pairs with.
      await d1.tap('[data-menu]')
      await d1.tap('[data-invite="viewer"]')
      const inviteLink = String(await until('the invite link', () => d1.js(`document.querySelector('.invite-link')?.value || ''`), POLL_WAIT_MS))
      check('the ☰ menu makes an invite link for this project, naming it and who shares it',
        inviteLink.startsWith(`${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=`) && inviteLink.endsWith('&p=claudeflow&o=e2e'), inviteLink)
      await d1.shot('app-390-share.png')
      // The guest's hello reaches an older session first, which refuses the invite it does not know; the current
      // session (held back until then) lets it in. The guest must never be told it is not paired meanwhile.
      s.isLagging = true
      await d5.goto(inviteLink)
      await d5.see('Join claudeflow')
      check('the guest is asked to join the project by name, in words with no Mac, pairing or /streams', !JARGON.test(await d5.text()), await d5.text())
      await d5.shot('app-390-guest-join.png')
      await d5.js(`(() => { const i = document.querySelector('[data-guest-name]'); i.value = 'Sam'; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      await d5.tap('[data-gate="pair"]')
      await sleep(1000)
      const older = startOlderSession(s)
      const id5 = await d5.deviceId()
      await until('the older session refusing the invite', () => older.denied.some(x => x.to === id5), POLL_WAIT_MS)
      await sleep(1500)
      const REFUSAL = /Not paired|expired|no longer knows|bad pairing/i
      let refusal = REFUSAL.exec(await d5.text())?.[0] ?? ''
      s.isLagging = false
      await until('the guest watching', async () => {
        const t = await d5.text()
        refusal ||= REFUSAL.exec(t)?.[0] ?? ''
        return t.includes('Watching')
      }, POLL_WAIT_MS)
      older.isRunning = false
      check("one older session's refusal is not shown: the guest pairs when the current session lets it in, with no pairing error on the way", !refusal, refusal)
      check('the guest joins as a watcher of this project under the name they gave: role, project, an end date, the invite',
        s.devices.some(d => d.id === id5 && d.label === 'Sam' && d.role === 'viewer' && d.project === '/work/claudeflow' && (d.until ?? 0) > Date.now() && !!d.via),
        JSON.stringify(s.devices.find(d => d.id === id5)))
      check('a watcher sees the streams but no control: no Yes, no Stop, no composer',
        (await d5.text()).includes('relay deploy') && !(await d5.js(`[...document.querySelectorAll('[data-answer], [data-stop], .slide.compose')].some(e => e.offsetParent)`)))
      await d5.shot('app-390-watching.png')
      check('inside the project the guest reads no Mac, pairing or /streams either', !JARGON.test(await d5.text()), (await d5.text()).match(JARGON)?.[0])

      // Back in the app later: Unlock with Face ID, and the project is there again.
      await d5.reload()
      await d5.see('Unlock with Face ID')
      check('a guest coming back is asked only to unlock, in plain words', !JARGON.test(await d5.text()), await d5.text())
      await d5.tap('[data-gate="unlock"]')
      await d5.see('Watching', POLL_WAIT_MS)
      check('the guest unlocks again and sees the project', (await d5.text()).includes('relay deploy'))

      // The owner is away (the session posts nothing): the guest is told the project is not online, and gets in once it is.
      s.isLagging = true
      await d5.reload()
      await d5.tap('[data-gate="unlock"]')
      await d5.see("isn't online right now", SLOW_MS + POLL_WAIT_MS)
      const away = await d5.text()
      check('with the owner away, the guest is told the project is not online and that it opens while e2e works on it',
        away.includes('It opens while e2e is working on it') && !JARGON.test(away), away)
      await d5.shot('app-390-guest-away.png')
      s.isLagging = false
      await d5.tap('[data-gate="retry"]')
      await d5.see('Watching', POLL_WAIT_MS)
      check('once the owner is back, the waiting guest gets in', (await d5.text()).includes('relay deploy'))

      // The owner removes the guest from the ☰ menu: the guest's next unlock says so, and who to ask.
      await until('the guest in the people list', () => d1.js(`!!document.querySelector('[data-arm-remove="${id5}"]')`), POLL_WAIT_MS)
      await d1.tap(`[data-arm-remove="${id5}"]`)
      await d1.tap(`[data-arm-remove="${id5}"]`)
      await until('the guest removed', () => s.devices.some(d => d.id === id5 && d.removed), POLL_WAIT_MS)
      await d1.tap('[data-menu-close]')
      await d5.reload()
      await d5.tap('[data-gate="unlock"]')
      await d5.see('removed your access', DENIAL_WAIT_MS)
      const removed = await d5.text()
      check('a removed guest is told the owner removed their access, not that a Mac does not know the device',
        removed.includes('e2e removed your access to claudeflow') && !JARGON.test(removed), removed)
      await d5.shot('app-390-guest-removed.png')

      // An invite opened after its day: turned away in plain words, with who to ask for a new one.
      const old = { secret: randomId(32), until: Date.now() - 1000, project: '/work/claudeflow', role: 'viewer' as const, days: SHARE_DAYS }
      s.invites.push(old)
      // A fresh load of the link: only the fragment differs from the page it is on, which would not reload.
      await d3.goto('about:blank')
      await until('the stranger on a blank page', () => d3.js("location.href === 'about:blank'"))
      await d3.goto(`${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=${old.secret}&p=claudeflow&o=e2e`)
      await d3.see('Join claudeflow')
      await d3.tap('[data-gate="pair"]')
      await d3.see('This invite has expired', DENIAL_WAIT_MS)
      const expired = await d3.text()
      check('an expired invite says so and to ask e2e for a new link, with no Mac or pairing words', expired.includes('Ask e2e for a new link') && !JARGON.test(expired), expired)
      await d3.shot('app-390-guest-expired.png')

      // Guests on other devices, each with their own invite. None is told about Face ID, a Mac or pairing.
      const inviteLinkFor = (role: Invite['role']) => {
        const invite = { secret: randomId(32), until: Date.now() + INVITE_MS, project: '/work/claudeflow', role, days: SHARE_DAYS }
        s.invites.push(invite)
        return `${ORIGIN}/${linkFragment({ room: s.identity.room, pk: s.pk, secret: invite.secret, guest: { project: 'claudeflow', owner: 'e2e' } })}`
      }
      const plain = (t: string) => !JARGON.test(t) && !t.includes('Face ID')
      // Nothing wider than the window, and a gate a readable card rather than a stretched band.
      const fits = (d: Page) => d.js(`(() => { const g = document.querySelector('#gate .gate'); return document.documentElement.scrollWidth <= innerWidth && (!g || g.getBoundingClientRect().width <= 800) })()`)

      // Android Chrome: its screen lock, named so.
      await d6.goto(inviteLinkFor('viewer'))
      await d6.see('Join with your screen lock')
      check('on Android the guest is asked for their screen lock, not Face ID', plain(await d6.text()), await d6.text())
      await d6.js(`(() => { const i = document.querySelector('[data-guest-name]'); i.value = 'Pia'; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      await d6.tap('[data-gate="pair"]')
      await d6.see('Watching', POLL_WAIT_MS)
      check('the Android guest gets in and reads only guest words', plain(await d6.text()) && (await d6.text()).includes('relay deploy'), (await d6.text()).match(JARGON)?.[0])
      await d6.shot('app-412-android-guest.png')

      // Windows with no Hello, only a security key: the key it is, joined by keyboard, as a contributor.
      await d7.goto(inviteLinkFor('contributor'))
      await d7.see('Join with your phone or security key')
      check('on a desktop with nothing built in, the guest is offered a phone or security key, or this browser', plain(await d7.text()) && (await d7.js(`!!document.querySelector('[data-gate="pair-browser"]')`)), await d7.text())
      check('the desktop join screen fits the window', await fits(d7))
      await d7.shot('app-1366-windows-guest-join.png')
      await d7.typeAndEnter('[data-guest-name]', 'Wes')
      await d7.see('Contributing', POLL_WAIT_MS)
      const wes = s.devices.find(d => d.label === 'Wes')
      check('the Windows guest joined with the security key, by keyboard, and may contribute', !!wes && !wes.browserKey && wes.role === 'contributor' && (await d7.passkeys()) === 1, JSON.stringify(wes))
      check('the desktop app fits the window and reads only guest words', (await fits(d7)) && plain(await d7.text()), (await d7.text()).match(JARGON)?.[0])
      await d7.shot('app-1366-windows-guest.png')

      // Linux with no WebAuthn at all: a key kept in this browser, watch only whatever the invite said.
      await d8.goto(inviteLinkFor('contributor'))
      await d8.see('Join on this browser')
      check('with no passkeys at all, the guest is offered only this browser, and told it then only watches',
        plain(await d8.text()) && (await d8.text()).includes('watch, not act') && !(await d8.js(`!!document.querySelector('[data-gate="pair"]')`)), await d8.text())
      await d8.typeAndEnter('[data-guest-name]', 'Lin')
      await d8.see('Watching', POLL_WAIT_MS)
      const lin = s.devices.find(d => d.label === 'Lin')
      check('the Linux guest joined with a browser key and only watches, though invited to contribute', !!lin && !!lin.browserKey && (await d8.text()).includes('relay deploy') && !(await d8.js(`!!document.querySelector('.slide.compose')?.offsetParent`)), JSON.stringify(lin))
      await d8.reload()
      await d8.see('Open it to see it')
      await d8.tap('[data-gate="unlock"]')
      await d8.see('Watching', POLL_WAIT_MS)
      check('back later, the browser key opens the project with no prompt', plain(await d8.text()) && (await fits(d8)), await d8.text())
      await d8.shot('app-1280-linux-guest.png')

      // Workflows and loops: the cards say where each is, and Stop workflow (two taps) reaches the session as stopTask.
      s.permissions = []
      await d1.see('Verify · 3/6 · ✗1')
      await d1.see('3 quiet')
      check('the device shows the running workflow (phase, count, failure) and the loop (next tick, quiet streak)', /in \d+:\d\d · 3 quiet/.test(await d1.text()), 'no loop countdown')
      await d1.tap('[data-toggle$="|st3"]')
      await d1.see('Stop workflow')
      await d1.shot('app-390-workflow.png')
      await d1.tap('[data-stop-task="wf_e2e"]')
      await d1.see('Tap again to stop')
      await d1.tap('[data-stop-task="wf_e2e"]')
      const stopTask = await until('the stopTask command', () => s.commands.find(c => c.command.kind === 'stopTask'), POLL_WAIT_MS)
      // Acked like any tap: the button settles on the Mac's word, not on a guess.
      await d1.see('Done ✓', POLL_WAIT_MS)
      check('tapping Stop workflow twice reaches the session as stopTask for that run, from device 1, and its ack shows "Done ✓"',
        stopTask.device === id1 && stopTask.command.kind === 'stopTask' && stopTask.command.taskId === 'wf_e2e' && s.acks.some(a => a.ack.id === stopTask.command.id && a.ack.ok), JSON.stringify(stopTask))
      await d1.tap('[data-toggle$="|st3"]')
      await d1.tap('[data-toggle$="|st4"]')
      await d1.see('Run now')
      await d1.shot('app-390-loop.png')
      await d1.tap('[data-run-tick]')
      const tick = await until('the runTick command', () => s.commands.find(c => c.command.kind === 'runTick'), POLL_WAIT_MS)
      await until('the runTick ack', () => s.acks.some(a => a.ack.id === tick.command.id), POLL_WAIT_MS)
      check('tapping Run now reaches the session as runTick for the loop\'s stream, and is acked', tick.command.kind === 'runTick' && tick.command.streamId === 'st4', JSON.stringify(tick))
      for (const [w, h] of [[820, 1180], [1280, 860]] as const) {
        await d1.resize(w, h)
        await d1.tap('[data-select$="|st3"]')
        await d1.see('Stop workflow')
        await d1.shot(`app-${w}-workflow.png`)
        await d1.tap('[data-select$="|st4"]')
        await d1.see('Run now')
        await d1.shot(`app-${w}-loop.png`)
      }

      check('only the two real devices ever sent commands', s.commands.every(c => c.device === id1 || c.device === id2))

      // Notify me: both devices subscribe (to this run's push service). Device 2 puts the app away; a new permission
      // then wakes device 2 only, with a push that opens to its kind and nothing else, signed by the relay's key.
      await d1.resize(390, 844)
      const [k1, k2] = [await pushKeys('/device1'), await pushKeys('/device2')]
      for (const [d, k] of [[d1, k1], [d2, k2]] as const) {
        await d.js(fakePushApi(k.json))
        await d.tap('[data-notify][aria-checked="false"]')
        await until(`${d.name} notify on`, () => d.js(`!!document.querySelector('[data-notify][aria-checked="true"]')`))
      }
      await d2.shot('app-390-notify.png')
      await d2.freeze()
      // Device 2 is looking until its last visible ping is 30 s old; then the session must post once more to learn it.
      const looking = () => fetch(`${UP}/v1/room/${s.identity.room}/up`, { method: 'POST', body: JSON.stringify({ token: s.identity.token, session: randomId(), since: Number.MAX_SAFE_INTEGER, frames: [] }) })
        .then(r => r.json() as Promise<{ devices: { id: string; isActive: boolean }[] }>).then(r => r.devices.filter(d => d.isActive).map(d => d.id))
      await until('device 2 to stop looking', async () => !(await looking()).includes(id2), POLL_WAIT_MS)
      const posted = s.posts
      await until('a post after device 2 left', () => s.posts >= posted + 1, POLL_WAIT_MS)
      s.permissions = [{ id: 'toolu_push', tool: 'Bash', summary: 'Bash: npm publish', at: Date.now() }]
      const push = await until('the push to device 2', () => pushes.find(p => p.path === '/device2'), POLL_WAIT_MS)
      const { key } = (await (await fetch(`${UP}/v1/push/key`)).json()) as { key: string }
      check('device 2, not looking, gets one push that opens to {"kind":"needs-you"} only, VAPID-signed with the relay\'s key',
        (await k2.open(push.body)) === '{"kind":"needs-you"}' && push.authorization.endsWith(`, k=${key}`), push.authorization.slice(0, 40))
      await sleep(3000)
      check('device 1, looking, gets no push, and device 2 no second one', !pushes.some(p => p.path === '/device1') && pushes.filter(p => p.path === '/device2').length === 1, JSON.stringify(pushes.map(p => p.path)))
      pushService.stop(true)
      s.isRunning = false
      for (const d of [d1, d2, d3, d4, d5, d6, d7, d8]) d.close()
    })(),
    sleep(480_000).then(() => {
      throw new Error('the run took over 8 minutes')
    }),
  ])
} catch (e) {
  check('run finished', false, String((e as Error).message ?? e))
} finally {
  for (const p of procs) {
    try {
      process.kill(-p.pid!, 'SIGTERM')
    } catch {}
  }
  stopLeftovers()
  await sleep(1000)
  failed = results.some(r => !r.ok) || results.length === 0
  const passed = results.filter(r => r.ok).length
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} of ${results.length} checks passed. Screenshots in ${SHOTS}`)
  process.exit(failed ? 1 : 0)
}
