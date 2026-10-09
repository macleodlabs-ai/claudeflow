// End-to-end proof, all on this Mac: the real relay (`wrangler dev`), the real app (relay/cloudflare/public, built by
// app/build.sh), two headless Chrome devices with virtual passkeys, and a Claude Code session played by the plugin's
// own pure remote core (hooks/remote/link.ts + seal.ts) posting to /v1/room/{room}/up with real fetch calls.
// Run from the repo root with Node 22+ on PATH (wrangler needs it): bun e2e/run.ts [shots dir]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PAIRING_MS, createLink, upOf, type Device, type Identity, type Pairing } from '../plugins/streams/hooks/remote/link'
import { newIdentity, publicKeyOf, randomId } from '../plugins/streams/hooks/remote/seal'
import type { PhoneCommand, Snapshot } from '../plugins/streams/hooks/remote/snapshot'

const ROOT = join(import.meta.dir, '..')
const SHOTS = process.argv[2] ?? join(ROOT, 'e2e', 'shots')
const TMP = join(tmpdir(), 'claudeflow-e2e')
const PORT = 8791
// Pages load from localhost: a passkey needs a host name (not an IP) and a secure context, which localhost is.
const ORIGIN = `http://localhost:${PORT}`
const UP = `http://127.0.0.1:${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

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

// ---- the relay ----
function startRelay() {
  const log = openSync(join(TMP, 'wrangler.log'), 'w')
  const p = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: join(ROOT, 'relay/cloudflare'), detached: true, stdio: ['ignore', log, log],
  })
  procs.push(p)
  return until('wrangler dev', () => fetch(`${UP}/`).then(r => r.ok, () => false), 60_000)
}

// ---- a device: one headless Chrome with its own profile and a virtual platform authenticator ----
type Page = Awaited<ReturnType<typeof openDevice>>
async function openDevice(name: string, port: number) {
  const p = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(TMP, `chrome-${name}`)}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { detached: true, stdio: 'ignore' })
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
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('WebAuthn.enable')
  await send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
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
    see: (what: string, ms?: number) => until(`${name} to show "${what}"`, async () => (await js('document.body.innerText') as string).includes(what), ms),
    async shot(file: string) {
      const h = (await js('document.documentElement.scrollHeight')) as number
      const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 390, height: Math.max(844, h), scale: 1 } })
      writeFileSync(join(SHOTS, file), Buffer.from(s.data, 'base64'))
    },
    deviceId: async () => JSON.parse((await js(`localStorage.getItem('cf:device')`)) ?? '{}').id as string,
    close: () => ws.close(),
  }
}

// ---- the session: what hooks/remote/index.ts does on each tick, with plain fetch and memory for $.store ----
function startSession() {
  const sk = newIdentity().sk
  const identity: Identity = { room: randomId(), token: randomId(32), sk }
  const pairing: Pairing = { secret: randomId(32), until: Date.now() + PAIRING_MS }
  const id = crypto.randomUUID()
  const link = createLink({ identity, session: id, origin: ORIGIN })
  const s = {
    identity, pairing, pk: publicKeyOf(sk), id,
    devices: [] as Device[],
    commands: [] as { device: string; command: PhoneCommand }[],
    denied: [] as { to: string; why: string }[],
    permissions: [] as Snapshot['permissions'],
    posts: 0,
    isRunning: true,
  }
  const at = Date.now()
  const snapshot = (): Snapshot => ({
    v: 1,
    session: { id, account: 'e2e', project: 'claudeflow', busy: true },
    at: Date.now(),
    streams: [
      { id: 'st1', name: 'relay deploy', color: '#79c0ff', kind: 'waiting', state: 'WAITING FOR YOU', detail: '', lastAt: at, question: 'Deploy the relay now?', agents: [], rows: [{ kind: 'prompt', text: 'ship the relay', at }] },
      { id: 'st2', name: 'phone app', color: '#ffd33d', kind: 'running', state: 'RUNNING', detail: 'building views', lastAt: at, agents: [], rows: [] },
    ],
    status: [{ id: 'g', area: 'main', state: 'clean', detail: '' }],
    limits: [],
    updates: [],
    permissions: s.permissions,
  }) as Snapshot
  const post = async (frames: unknown[]) => {
    s.posts++
    const r = await fetch(`${UP}/v1/room/${identity.room}/up`, { method: 'POST', body: JSON.stringify({ token: identity.token, session: id, since: link.since(), frames }) })
    return upOf(await r.text())
  }
  void (async () => {
    let out: unknown[] = []
    while (s.isRunning) {
      const r = await post(out).catch(() => undefined)
      out = []
      if (r) {
        const now = Date.now()
        const t = link.take(r, { devices: s.devices, pairing, now })
        for (const d of t.paired) s.devices = [...s.devices.filter(x => x.id !== d.id), d]
        s.commands.push(...t.commands)
        for (const f of t.send) if ((f.data as { t: string }).t === 'denied') s.denied.push({ to: f.to, why: (f.data as { why: string }).why })
        // Welcomes first, then the first sealed snapshot behind them, in one post (index.ts does the same).
        out = [...t.send, ...link.snapshots(snapshot(), now)]
        if (out.length) continue
      }
      await sleep(400)
    }
  })()
  return s
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
  // Every wait has its own limit, but a stuck DevTools call has none: the whole run gets three minutes.
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
      check('relay serves the app at /', (await (await fetch(`${UP}/`)).text()).includes('app.js'))

      const s = startSession()
      const link = `${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=${s.pairing.secret}`
      const [d1, d2, d3] = await Promise.all([openDevice('device1', 9341), openDevice('device2', 9342), openDevice('stranger', 9343)])

      // Both devices pair at the same time from the same link.
      await Promise.all([d1, d2].map(d => d.goto(link)))
      await Promise.all([d1, d2].map(d => d.see('Pair this device')))
      await d1.shot('e2e-01-device1-pair.png')
      check('both devices show "Pair this device" for the link', true)
      await Promise.all([d1, d2].map(d => d.tap('[data-gate="pair"]')))
      await Promise.all([d1, d2].map(d => d.see('Deploy the relay now?')))
      const [id1, id2] = await Promise.all([d1.deviceId(), d2.deviceId()])
      check('both devices paired with a passkey and are stored by the session', s.devices.length === 2 && [id1, id2].every(i => s.devices.some(d => d.id === i)), JSON.stringify(s.devices.map(d => d.id)))
      check('each device opened the session\'s sealed snapshot', true)
      await d1.shot('e2e-02-device1-paired.png')

      // A new connection needs Face ID: reload both, see Locked, unlock both with their passkeys.
      await Promise.all([d1, d2].map(d => d.reload()))
      await Promise.all([d1, d2].map(d => d.see('Locked')))
      check('after a reload both devices are Locked', !(await d1.text()).includes('Deploy the relay now?'))
      await d2.shot('e2e-03-device2-locked.png')
      await Promise.all([d1, d2].map(d => d.tap('[data-gate="unlock"]')))
      await Promise.all([d1, d2].map(d => d.see('Deploy the relay now?')))
      check('both devices unlocked with a passkey hello and see the snapshot', true)
      await d2.shot('e2e-04-device2-unlocked.png')

      // Device 1 answers Yes.
      await d1.tap('[data-answer]')
      const answer = await until('the answer command', () => s.commands.find(c => c.command.kind === 'answer'))
      check('device 1 taps Yes and the session receives "answer yes" from device 1',
        answer.device === id1 && answer.command.kind === 'answer' && answer.command.text === 'yes' && answer.command.streamId === 'st1', JSON.stringify(answer))

      // A held permission reaches both devices; device 2 allows it with its passkey.
      s.permissions = [{ id: 'toolu_e2e', tool: 'Bash', summary: 'Bash: npx wrangler deploy', at: Date.now() }]
      await Promise.all([d1, d2].map(d => d.see('Claude wants to run Bash')))
      check('the held permission shows on both devices', true)
      await d1.shot('e2e-05-device1-permission.png')
      await d2.tap('[data-perm="toolu_e2e"][data-decision="allow"]')
      const allow = await until('the allow command', () => s.commands.find(c => c.command.kind === 'permission'))
      check('device 2 taps Allow (passkey checked) and the session receives allow from device 2',
        allow.device === id2 && allow.command.kind === 'permission' && allow.command.decision === 'allow' && allow.command.requestId === 'toolu_e2e', JSON.stringify(allow.command))

      // A stranger with the right room but a made-up secret is turned away and sees nothing.
      await d3.goto(`${ORIGIN}/#r=${s.identity.room}&k=${s.pk}&s=${randomId(32)}`)
      await d3.see('Pair this device')
      await d3.tap('[data-gate="pair"]')
      await d3.see('bad pairing proof')
      const id3 = await d3.deviceId()
      check('an unpaired device with a bogus secret is denied ("bad pairing proof")', s.denied.some(x => x.to === id3 && x.why === 'bad pairing proof'))
      check('the denied device is not stored and saw no snapshot', !s.devices.some(d => d.id === id3) && !(await d3.text()).includes('Deploy the relay now?'))
      await d3.shot('e2e-06-stranger-denied.png')

      check('only the two real devices ever sent commands', s.commands.every(c => c.device === id1 || c.device === id2))
      s.isRunning = false
      for (const d of [d1, d2, d3]) d.close()
    })(),
    sleep(180_000).then(() => {
      throw new Error('the run took over 3 minutes')
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
