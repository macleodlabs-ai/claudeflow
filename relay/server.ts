// The Claudeflow relay: Macs and their paired phones both dial out to it, and it passes sealed messages between them.
// It never holds a key. It knows a Mac by a random id, keeps a hash of that Mac's token (first come, so nobody else can
// take its id), and forwards each frame to the one connection it is addressed to. It also serves the phone page; the
// page's pairing keys ride in the link's #fragment, which browsers never send to a server.
//
//   bun relay/server.ts            (PORT, default 8787)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.PORT ?? 8787)
const PAGE_DIR = join(import.meta.dir, '..', 'plugins', 'streams', 'bridge')
const APP = readFileSync(join(PAGE_DIR, 'app.html'), 'utf8')
const SEAL = readFileSync(join(PAGE_DIR, 'seal.js'), 'utf8')
/** Show what the relay sees: off by default; on, it logs each frame's route and size, and the start of its sealed body. */
const IS_SHOWING = process.env.RELAY_SHOW === '1'

type Peer = { role: 'mac'; mac: string } | { role: 'phone'; mac: string; phone: string }
type Socket = import('bun').ServerWebSocket<Peer>

const tokenHashes = new Map<string, string>()
const macs = new Map<string, Socket>()
const phones = new Map<string, Socket>()
const phoneKey = (mac: string, phone: string) => `${mac}/${phone}`
const ID = /^[A-Za-z0-9_-]{16,64}$/

const sha256 = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex')

const show = (route: string, data: string) => {
  if (IS_SHOWING) console.log(`${route}  ${data.length}B  ${data.slice(0, 72)}…`)
}

Bun.serve<Peer, never>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url)
    const q = (k: string) => url.searchParams.get(k) ?? ''
    if (url.pathname === '/mac') {
      const mac = q('id')
      const token = q('token')
      if (!ID.test(mac) || token.length < 32) return new Response('bad mac', { status: 400 })
      const hash = await sha256(token)
      // The first Mac to use an id owns it; anyone else presenting it is refused.
      if (tokenHashes.has(mac) && tokenHashes.get(mac) !== hash) return new Response('not yours', { status: 403 })
      tokenHashes.set(mac, hash)
      return server.upgrade(req, { data: { role: 'mac', mac } }) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/phone') {
      const mac = q('mac')
      const phone = q('id')
      if (!ID.test(mac) || !ID.test(phone)) return new Response('bad phone', { status: 400 })
      return server.upgrade(req, { data: { role: 'phone', mac, phone } }) ? undefined : new Response('upgrade failed', { status: 400 })
    }
    if (url.pathname === '/seal.js') return new Response(SEAL, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(APP, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    if (url.pathname === '/health') return new Response('ok')
    return new Response('not found', { status: 404 })
  },
  websocket: {
    maxPayloadLength: 2_000_000,
    open(ws) {
      const p = ws.data
      if (p.role === 'mac') {
        macs.get(p.mac)?.close(4000, 'replaced')
        macs.set(p.mac, ws)
      } else {
        phones.get(phoneKey(p.mac, p.phone))?.close(4000, 'replaced')
        phones.set(phoneKey(p.mac, p.phone), ws)
        macs.get(p.mac)?.send(JSON.stringify({ from: p.phone, data: JSON.stringify({ t: 'online' }) }))
      }
    },
    message(ws, raw) {
      const p = ws.data
      const text = String(raw)
      if (p.role === 'phone') {
        // A phone speaks only to its own Mac.
        show(`phone ${p.phone.slice(0, 6)} → mac ${p.mac.slice(0, 6)}`, text)
        macs.get(p.mac)?.send(JSON.stringify({ from: p.phone, data: text }))
        return
      }
      let frame: { to?: unknown; data?: unknown }
      try {
        frame = JSON.parse(text)
      } catch {
        return
      }
      if (typeof frame.to !== 'string' || typeof frame.data !== 'string') return
      show(`mac ${p.mac.slice(0, 6)} → phone ${frame.to.slice(0, 6)}`, frame.data)
      phones.get(phoneKey(p.mac, frame.to))?.send(frame.data)
    },
    close(ws) {
      const p = ws.data
      if (p.role === 'mac' && macs.get(p.mac) === ws) macs.delete(p.mac)
      if (p.role === 'phone' && phones.get(phoneKey(p.mac, p.phone)) === ws) phones.delete(phoneKey(p.mac, p.phone))
    },
  },
})
console.log(`claudeflow relay on :${PORT}`)
