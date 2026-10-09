// The claudeflow phone bridge: every Claude Code session's streams mod reports to it over a Unix socket,
// and it serves your phone a live view of all of them. The streams plugin installs it to ~/.claudeflow/bridge
// and runs it at login; `/streams phone` pairs a phone. `bun server.ts pair` prints the pairing link.
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const SOCKET = process.env.CLAUDEFLOW_SOCKET ?? '/tmp/claudeflow-bridge.sock'
const HOST = process.env.CLAUDEFLOW_HOST ?? '127.0.0.1'
const PORT = Number(process.env.CLAUDEFLOW_PORT ?? 7878)
const DIR = join(homedir(), '.claudeflow')
const TOKEN_FILE = join(DIR, 'bridge-token')

/** A session not heard from for this long is shown as gone quiet; after DROP_MS it leaves the list. */
const STALE_MS = 90_000
const DROP_MS = 6 * 3600_000
const MAX_BODY = 2_000_000

/** The phone's one secret: made once, kept where only you can read it. */
function tokenOf(): string {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim()
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const token = randomBytes(24).toString('base64url')
  writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 })
  return token
}
const TOKEN = tokenOf()

if (process.argv[2] === 'pair') {
  console.log(`Open this on your phone, then Add to Home Screen:\n\n  http://${HOST === '0.0.0.0' ? '<this-mac>' : HOST}:${PORT}/?t=${TOKEN}\n`)
  console.log(`Behind \`tailscale serve ${PORT}\`, use https://<this-mac>.<tailnet>.ts.net/?t=${TOKEN}`)
  process.exit(0)
}

type Snapshot = { v: 1; session: { id: string; account: string; project: string; busy: boolean }; at: number }
const sessions = new Map<string, { snap: Snapshot; seen: number }>()

const listOf = () => {
  const now = Date.now()
  return [...sessions.values()]
    .sort((a, b) => b.seen - a.seen)
    .map(({ snap, seen }) => ({ ...snap, seen, isStale: now - seen > STALE_MS }))
}

const isSame = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const cookieOf = (req: Request) => /(?:^|;\s*)cf=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? ''
const isPaired = (req: Request) => isSame(cookieOf(req), TOKEN) || isSame((req.headers.get('authorization') ?? '').replace(/^Bearer /, ''), TOKEN)

const APP = readFileSync(join(import.meta.dir, 'app.html'), 'utf8')

/** What a browser that is not paired sees: where pairing happens, never the token. */
const UNPAIRED = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not paired</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:16px/1.5 -apple-system,Helvetica,sans-serif;text-align:center;padding:16px}code{color:#ffd33d}.dim{color:#8b949e;font-size:14px}</style></head>
<body><main><h1>This browser isn't paired</h1><p>In Claude Code on your Mac, run <code>/streams phone</code>.<br>It opens a pairing page here with a QR code for your phone.</p>
<p class="dim">Streams shows your sessions only to browsers paired with this Mac.</p></main></body></html>`

/**
 * This Mac's tailnet name: the address the phone opens. `/streams phone` records it when it serves the bridge,
 * because the Tailscale app's command line does not answer a process launchd started.
 */
function tailnetHost(): string | undefined {
  try {
    const recorded = new URL(readFileSync(join(DIR, 'phone-url'), 'utf8').trim()).host
    if (recorded) return recorded
  } catch {}
  for (const bin of ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale']) {
    try {
      const r = Bun.spawnSync([bin, 'status', '--json'])
      const s = JSON.parse(r.stdout.toString()) as { BackendState?: string; Self?: { DNSName?: string } }
      const host = (s.Self?.DNSName ?? '').replace(/\.$/, '')
      if (s.BackendState === 'Running' && host) return host
    } catch {}
  }
  return undefined
}

/** The pairing page: the phone's link as a QR code to scan, for a browser on this Mac that is already paired. */
function pairPage(): string {
  const host = tailnetHost()
  const link = host ? `https://${host}/?t=${TOKEN}` : ''
  const body = host
    ? `<div id="qr"></div><p>Scan with your phone's camera, then <b>Share → Add to Home Screen</b>.</p><p class="dim">${host}</p>`
    : `<p>Tailscale is not signed in on this Mac, so your phone cannot reach the bridge yet.</p><p class="dim">Install Tailscale (<code>brew install --cask tailscale-app</code>), sign in here and on your phone, then run <code>/streams phone</code> again.</p>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pair your phone</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:16px/1.5 -apple-system,Helvetica,sans-serif;text-align:center;padding:16px}
#qr{background:#fff;padding:16px;border-radius:16px;display:inline-block}#qr svg{display:block;width:280px;height:280px}.dim{color:#8b949e;font-size:14px}code{color:#ffd33d}</style></head>
<body><main><h1>Pair your phone</h1>${body}</main>
${host ? `<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"></script><script>const q = qrcode(0, 'M'); q.addData(${JSON.stringify(link)}); q.make(); document.getElementById('qr').innerHTML = q.createSvgTag({ scalable: true, margin: 0 })</script>` : ''}
</body></html>`
}
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1117"/><path d="M14 22h36M14 32h28M14 42h20" stroke-width="7" stroke-linecap="round" stroke="#ffd33d"/><circle cx="50" cy="42" r="5" fill="#2ea043"/></svg>`

// The sessions' side: only processes of this user reach the socket.
if (existsSync(SOCKET)) unlinkSync(SOCKET)
const inbound = Bun.serve({
  unix: SOCKET,
  async fetch(req) {
    const m = /^\/sessions\/([^/]+)$/.exec(new URL(req.url).pathname)
    if (!m || req.method !== 'POST') return new Response('not found', { status: 404 })
    const text = await req.text()
    if (text.length > MAX_BODY) return new Response('too large', { status: 413 })
    let snap: Snapshot
    try {
      snap = JSON.parse(text)
    } catch {
      return new Response('bad json', { status: 400 })
    }
    if (snap?.v !== 1 || snap.session?.id !== decodeURIComponent(m[1]!)) return new Response('bad snapshot', { status: 400 })
    sessions.set(snap.session.id, { snap, seen: Date.now() })
    publish()
    return new Response('ok')
  },
})
chmodSync(SOCKET, 0o600)

// The phone's side.
const outbound = Bun.serve<undefined, never>({
  hostname: HOST,
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url)
    const t = url.searchParams.get('t')
    if (t !== null) {
      if (!isSame(t, TOKEN)) return new Response(UNPAIRED, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
      // Only a page of this bridge's own is a place to land after pairing.
      const next = url.searchParams.get('next') === '/pair' ? '/pair' : '/'
      return new Response(null, {
        status: 302,
        headers: { location: next, 'set-cookie': `cf=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` },
      })
    }
    if (url.pathname === '/icon.svg') return new Response(ICON, { headers: { 'content-type': 'image/svg+xml' } })
    if (!isPaired(req)) return new Response(UNPAIRED, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
    switch (url.pathname) {
      case '/':
        return new Response(APP, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      case '/manifest.webmanifest':
        // A home-screen app keeps its own cookies: its start link pairs it again.
        return Response.json({
          name: 'Claudeflow',
          short_name: 'Streams',
          start_url: `/?t=${TOKEN}`,
          display: 'standalone',
          background_color: '#0d1117',
          theme_color: '#0d1117',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
        })
      case '/pair':
        return new Response(pairPage(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
      case '/api/sessions':
        return Response.json(listOf())
      case '/ws':
        return server.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws) {
      ws.subscribe('all')
      ws.send(JSON.stringify({ type: 'sessions', sessions: listOf() }))
    },
    message() {},
  },
})

function publish() {
  outbound.publish('all', JSON.stringify({ type: 'sessions', sessions: listOf() }))
}

// Sessions that went quiet are marked, then dropped, without waiting for news.
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) if (now - s.seen > DROP_MS) sessions.delete(id)
  publish()
}, 15_000)

const stop = () => {
  inbound.stop(true)
  outbound.stop(true)
  if (existsSync(SOCKET)) unlinkSync(SOCKET)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

console.log(`claudeflow bridge: sessions on ${SOCKET}, phone on http://${HOST}:${PORT}`)
