// The Claudeflow relay on Cloudflare's free plan. Static assets (the app, the pairing page) are served before this
// Worker runs; it only routes the two API paths to the room's Durable Object, after the checks that need no state,
// so a malformed request never costs a Durable Object request.
import { Room, type Env } from './room'
import { ID, MAX_BYTES } from './shapes'

export { Room }

const ROUTE = /^\/v1\/room\/([^/]+)\/(up|device)$/

const fail = (status: number, why: string) => new Response(why, { status })

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const match = ROUTE.exec(url.pathname)
    if (!match) return fail(404, 'not found')
    const [, room, kind] = match
    if (!ID.test(room)) return fail(400, 'bad room')
    if (kind === 'up') {
      if (req.method !== 'POST') return fail(405, 'POST only')
      // The room re-checks the bytes it reads; this refuses honest oversize bodies before they are sent on.
      if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES) return fail(413, 'too large')
    } else {
      if (req.headers.get('upgrade') !== 'websocket') return fail(426, 'websocket only')
      if (!ID.test(url.searchParams.get('id') ?? '')) return fail(400, 'bad device')
    }
    // One object per room: an account's traffic never shares memory or storage with another's.
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req)
  },
} satisfies ExportedHandler<Env>
