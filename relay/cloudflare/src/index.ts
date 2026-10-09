// The Claudeflow relay on Cloudflare's free plan: a Worker that hands each connection to the Durable Object of its Mac.
// The object holds that Mac's socket and its phones' sockets with the WebSocket Hibernation API (no charge while idle)
// and forwards sealed frames between them. It holds no keys. The phone page is served as static assets (free).
import { DurableObject } from 'cloudflare:workers'

type Env = { MACS: DurableObjectNamespace<MacRoom> }
const ID = /^[A-Za-z0-9_-]{16,64}$/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname !== '/mac' && url.pathname !== '/phone') return new Response('not found', { status: 404 })
    if (req.headers.get('upgrade') !== 'websocket') return new Response('websocket only', { status: 426 })
    const mac = url.pathname === '/mac' ? url.searchParams.get('id') : url.searchParams.get('mac')
    if (!mac || !ID.test(mac)) return new Response('bad id', { status: 400 })
    // One object per Mac: its traffic never shares memory with anyone else's.
    return env.MACS.get(env.MACS.idFromName(mac)).fetch(req)
  },
}

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')

export class MacRoom extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    if (url.pathname === '/mac') {
      const token = url.searchParams.get('token') ?? ''
      if (token.length < 32) return new Response('bad token', { status: 400 })
      const hash = await sha256(token)
      // The first Mac to use an id owns it; anyone else presenting it is refused.
      const owner = await this.ctx.storage.get<string>('tokenHash')
      if (owner && owner !== hash) return new Response('not yours', { status: 403 })
      if (!owner) await this.ctx.storage.put('tokenHash', hash)
      for (const old of this.ctx.getWebSockets('mac')) old.close(4000, 'replaced')
      this.ctx.acceptWebSocket(server, ['mac'])
    } else {
      const phone = url.searchParams.get('id') ?? ''
      if (!ID.test(phone)) return new Response('bad phone', { status: 400 })
      for (const old of this.ctx.getWebSockets(`phone:${phone}`)) old.close(4000, 'replaced')
      this.ctx.acceptWebSocket(server, [`phone:${phone}`])
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    const tag = this.ctx.getTags(ws)[0] ?? ''
    if (tag.startsWith('phone:')) {
      // A phone speaks only to its own Mac.
      for (const mac of this.ctx.getWebSockets('mac')) mac.send(JSON.stringify({ from: tag.slice(6), data: text }))
      return
    }
    let frame: { to?: unknown; data?: unknown }
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (typeof frame.to !== 'string' || typeof frame.data !== 'string') return
    for (const phone of this.ctx.getWebSockets(`phone:${frame.to}`)) phone.send(frame.data)
  }

  async webSocketClose(ws: WebSocket, code: number) {
    ws.close(code === 1005 ? 1000 : code, 'closing')
  }
}
