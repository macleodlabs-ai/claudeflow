// One Durable Object per room (one per account). Devices hold hibernating WebSockets here (no charge while idle);
// sessions poll `up`. Device→session frames wait in SQLite for the sessions to collect them; session→device frames
// go straight to the device's socket. The room holds no keys and never logs what passes through it.
import { DurableObject } from 'cloudflare:workers'
import { DEVICE_MAX_BYTES, MAX_BYTES, parseDeviceMessage, parseUp } from './shapes'

export type Env = { ROOMS: DurableObjectNamespace<Room> }

/** Device frames older than this are gone: a session that has not polled for 2 minutes starts fresh. */
const KEEP_MS = 2 * 60_000
/** At most this many device frames are kept, so a chatty device cannot grow the room's storage. */
const KEEP_FRAMES = 500
/** At most this much frame data is kept, so one `up` answer stays small enough for a session to read. */
const KEEP_BYTES = 1 << 20
/**
 * Messages one device socket may send a minute (it pings 4 times a minute, plus hellos and commands). Sockets need
 * no token, so this keeps one from spending the account's free-plan row writes and requests for every room.
 */
const SOCKET_PER_MINUTE = 30
/** A device is active when it reported itself visible this recently (it pings every 15 s while visible). */
const ACTIVE_MS = 30_000

/** Kept on each device socket, so it survives hibernation: its id, last visible ping, and this minute's messages. */
type Device = { id: string; here: number; minute: number; sent: number }

const json = (body: unknown, status = 200) => Response.json(body, { status })
const fail = (status: number, why: string) => new Response(why, { status })

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** The request body as text, or null when it is over the limit (whatever content-length claimed). */
async function readBody(req: Request): Promise<string | null> {
  const bytes = await req.arrayBuffer()
  return bytes.byteLength > MAX_BYTES ? null : new TextDecoder().decode(bytes)
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // AUTOINCREMENT: a seq is never reused after pruning, so a session's `since` cursor never skips a new frame.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS frames (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
      sender TEXT NOT NULL, recipient TEXT NOT NULL, data TEXT NOT NULL)`)
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    return url.pathname.endsWith('/up') ? this.up(req) : this.join(url.searchParams.get('id') ?? '')
  }

  /** A device's WebSocket (its id was checked by the Worker). A reconnect replaces the device's older socket. */
  private join(id: string): Response {
    for (const old of this.ctx.getWebSockets(`device:${id}`)) old.close(4000, 'replaced')
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], [`device:${id}`])
    pair[1].serializeAttachment({ id, here: 0, minute: 0, sent: 0 } satisfies Device)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /** A session sends its frames to devices and collects the device frames for it. */
  private async up(req: Request): Promise<Response> {
    const text = await readBody(req)
    if (text === null) return fail(413, 'too large')
    const up = parseUp(text)
    if (!up) return fail(400, 'bad request')
    // The first token to reach a room owns it; anyone else who learns the room id cannot read or send.
    const hash = await sha256(up.token)
    const owner = await this.ctx.storage.get<string>('tokenHash')
    if (owner && owner !== hash) return fail(403, 'not yours')
    if (!owner) await this.ctx.storage.put('tokenHash', hash)

    for (const frame of up.frames) {
      const out = JSON.stringify({ from: up.session, data: frame.data })
      for (const ws of this.ctx.getWebSockets(`device:${frame.to}`)) ws.send(out)
    }
    this.prune()
    const frames = this.ctx.storage.sql
      .exec<{ seq: number; sender: string; data: string }>(
        `SELECT seq, sender, data FROM frames WHERE seq > ? AND (recipient = ? OR recipient = '*') ORDER BY seq`,
        up.since,
        up.session,
      )
      .toArray()
      .map(row => ({ seq: row.seq, from: row.sender, data: JSON.parse(row.data) as unknown }))
    const now = Date.now()
    const devices = this.ctx.getWebSockets().flatMap(ws => {
      const device = ws.deserializeAttachment() as Device | null
      return device ? [{ id: device.id, isActive: now - device.here < ACTIVE_MS }] : []
    })
    return json({ frames, devices })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const stored = ws.deserializeAttachment() as Device | null
    if (!stored) return
    const now = Date.now()
    const minute = Math.floor(now / 60_000)
    const device: Device = { ...stored, minute, sent: stored.minute === minute ? stored.sent + 1 : 1 }
    if (device.sent > SOCKET_PER_MINUTE) {
      ws.close(1008, 'too many messages')
      return
    }
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    const message = new TextEncoder().encode(text).byteLength > DEVICE_MAX_BYTES ? null : parseDeviceMessage(text)
    ws.serializeAttachment(message && 'here' in message ? { ...device, here: now } : device)
    if (!message || 'here' in message) return
    this.ctx.storage.sql.exec(
      'INSERT INTO frames (at, sender, recipient, data) VALUES (?, ?, ?, ?)',
      now,
      device.id,
      message.to,
      JSON.stringify(message.data),
    )
    this.prune()
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Finish the closing handshake; the runtime may already have replied, in which case there is nothing to do.
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing')
    } catch {}
  }

  /** Drops device frames past the 2-minute window, beyond the newest 500, or beyond the newest 1 MB of data. */
  private prune(): void {
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM frames WHERE at < ?', Date.now() - KEEP_MS)
    sql.exec('DELETE FROM frames WHERE seq <= (SELECT MAX(seq) FROM frames) - ?', KEEP_FRAMES)
    sql.exec(
      `DELETE FROM frames WHERE seq <= (SELECT seq FROM (
        SELECT seq, SUM(length(CAST(data AS BLOB))) OVER (ORDER BY seq DESC) AS kept FROM frames
      ) WHERE kept > ? ORDER BY seq DESC LIMIT 1)`,
      KEEP_BYTES,
    )
  }
}
