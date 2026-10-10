// One Durable Object per room (one per account). Devices hold hibernating WebSockets here (no charge while idle);
// sessions poll `up`. Device→session frames wait in SQLite for the sessions to collect them; session→device frames
// go straight to the device's socket. The room holds no session keys and never logs what passes through it. It
// also keeps each device's Web Push subscription and sends the pushes a session hints at (a kind, never any text).
import { DurableObject } from 'cloudflare:workers'
import { mayPush, sendPush, spent, vapidOf, type Budget, type NotifyKind } from './push'
import { DEVICE_MAX_BYTES, MAX_BYTES, parseDeviceMessage, parseUp } from './shapes'

export type Env = {
  ROOMS: DurableObjectNamespace<Room>
  /** The VAPID private key (a Worker secret: P-256 JWK or b64u PKCS#8, from vapid.ts). Unset: no pushes. */
  VAPID_PRIVATE_KEY?: string
  /** VAPID's `sub` contact (mailto: or https:); the relay's own https origin when unset. */
  VAPID_SUBJECT?: string
}

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
/**
 * At most this many push subscriptions a room keeps, and none from a device unseen this long. Anyone with the room
 * id can add rows under made-up device ids, so storage must stay bounded; a paired device sends its subscription
 * again on every welcome, so one pushed out comes back the next time it opens the app.
 */
const PUSH_ROWS = 32
const PUSH_UNSEEN_MS = 30 * 86_400_000

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
    // One push subscription per device, its push budget (push.ts `mayPush`), shared by every session, and when the
    // device last sent it (`seen_at`, for PUSH_ROWS and PUSH_UNSEEN_MS).
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS push (
      device TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      last_at INTEGER NOT NULL DEFAULT 0, day INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0,
      seen_at INTEGER NOT NULL DEFAULT 0)`)
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
    if (up.notify) {
      // A device looking now needs no buzz, whatever the session thought when it posted.
      const looking = new Set(devices.filter(d => d.isActive).map(d => d.id))
      const origin = new URL(req.url).origin
      const subject = this.env.VAPID_SUBJECT || (origin.startsWith('https:') ? origin : 'mailto:relay@claudeflow.invalid')
      // Not awaited: the session's frames and its tick never wait on push services (each up to 10 s).
      this.ctx.waitUntil(this.notify(up.notify.to.filter(id => !looking.has(id)), up.notify.kind, subject).catch(() => {}))
    }
    return json({ frames, devices })
  }

  /**
   * Sends `kind` by Web Push to each named device that has a subscription and push budget left, after the session's
   * post was answered. Each push's budget is taken before it is sent (reading and writing it with no wait between,
   * so two sessions posting at once cannot both pass `mayPush`) and given back when the push service did not take
   * it. A subscription the push service says is gone (404, 410) is forgotten.
   */
  private async notify(ids: string[], kind: NotifyKind, subject: string): Promise<void> {
    const vapid = await vapidOf(this.env.VAPID_PRIVATE_KEY, subject)
    if (!vapid || !ids.length) return
    const sql = this.ctx.storage.sql
    const now = Date.now()
    type Row = { device: string; endpoint: string; p256dh: string; auth: string; last_at: number; day: number; count: number }
    const rows = sql.exec<Row>(`SELECT * FROM push WHERE device IN (${ids.map(() => '?').join(',')})`, ...ids).toArray()
    const taken = rows.flatMap(row => {
      const budget: Budget = { lastAt: row.last_at, day: row.day, count: row.count }
      if (!mayPush(budget, now, kind)) return []
      const b = spent(budget, now)
      sql.exec('UPDATE push SET last_at = ?, day = ?, count = ? WHERE device = ?', b.lastAt, b.day, b.count, row.device)
      return [{ row, budget, b }]
    })
    await Promise.all(
      taken.map(async ({ row, budget, b }) => {
        const r = await sendPush(row, kind, vapid, { now })
        if (r === 'gone') sql.exec('DELETE FROM push WHERE device = ? AND endpoint = ?', row.device, row.endpoint)
        // Given back only if no later push took the budget meanwhile.
        else if (r !== 'sent')
          sql.exec(
            'UPDATE push SET last_at = ?, day = ?, count = ? WHERE device = ? AND last_at = ? AND count = ?',
            budget.lastAt, budget.day, budget.count, row.device, b.lastAt, b.count,
          )
      }),
    )
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
    if ('push' in message) {
      // Kept per device, never logged; a new subscription replaces the old one and keeps the day's budget. Rows of
      // devices unseen for 30 days go, and past PUSH_ROWS the least recently seen go first.
      const sql = this.ctx.storage.sql
      const sub = message.push
      if (!sub) sql.exec('DELETE FROM push WHERE device = ?', device.id)
      else {
        sql.exec(
          `INSERT INTO push (device, endpoint, p256dh, auth, seen_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(device) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, seen_at = excluded.seen_at`,
          device.id,
          sub.endpoint,
          sub.p256dh,
          sub.auth,
          now,
        )
        sql.exec('DELETE FROM push WHERE seen_at < ?', now - PUSH_UNSEEN_MS)
        sql.exec('DELETE FROM push WHERE device NOT IN (SELECT device FROM push ORDER BY seen_at DESC LIMIT ?)', PUSH_ROWS)
      }
      return
    }
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
