// The JSON shapes the relay accepts, checked before anything is stored or forwarded. Pure: no Workers APIs.
// The relay never looks inside `data` (it is sealed or public-key material); it only checks that one is there.
import { KINDS, type NotifyKind, type Subscription } from './push'

/** Room, device, session ids and the room token: base64url, 16 to 64 characters. */
export const ID = /^[A-Za-z0-9_-]{16,64}$/

/** Largest `up` body, in bytes. */
export const MAX_BYTES = 1 << 20

/** Largest device message, in bytes: a hello with its passkey is about 3 KB, a sealed command at most about 6 KB. */
export const DEVICE_MAX_BYTES = 16 << 10

export type Data = string | object
/** `notify`: the session's plaintext hint to wake these devices by Web Push. A kind, never any text. */
export type Up = { token: string; session: string; since: number; frames: { to: string; data: Data }[]; notify?: { to: string[]; kind: NotifyKind } }
/** A visible ping, a frame for sessions, or the device's push subscription (null: notifications turned off). */
export type DeviceMessage = { here: true } | { to: string; data: Data } | { push: Subscription | null }

/** Most devices one hint may name: an account pairs a handful. */
const NOTIFY_MAX = 32

const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const isData = (v: unknown): v is Data => typeof v === 'string' || (typeof v === 'object' && v !== null)

function parse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A session's `POST /v1/room/{room}/up` body, or null when any part is malformed. */
export function parseUp(text: string): Up | null {
  const v = parse(text)
  if (!v || !isId(v.token) || !isId(v.session) || !Array.isArray(v.frames)) return null
  if (typeof v.since !== 'number' || !Number.isSafeInteger(v.since) || v.since < 0) return null
  const frames: Up['frames'] = []
  for (const f of v.frames as unknown[]) {
    if (typeof f !== 'object' || f === null) return null
    const { to, data } = f as Record<string, unknown>
    if (!isId(to) || !isData(data)) return null
    frames.push({ to, data })
  }
  if (v.notify === undefined) return { token: v.token, session: v.session, since: v.since, frames }
  const to = v.notify
  if (!Array.isArray(to) || to.length > NOTIFY_MAX || !to.every(isId) || !KINDS.includes(v.kind as NotifyKind)) return null
  return { token: v.token, session: v.session, since: v.since, frames, notify: { to, kind: v.kind as NotifyKind } }
}

const B64U = /^[A-Za-z0-9_-]+$/

/**
 * A push subscription as `PushSubscription.toJSON()` gives it: an https endpoint (http only on this machine, for
 * tests), the browser's P-256 key (65 bytes) and auth secret (16 bytes), b64u.
 */
export function subscriptionOf(v: unknown): Subscription | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const { endpoint, keys } = v as Record<string, unknown>
  const { p256dh, auth } = (typeof keys === 'object' && keys !== null ? keys : {}) as Record<string, unknown>
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || typeof p256dh !== 'string' || typeof auth !== 'string') return undefined
  const key = p256dh.replace(/=+$/, '')
  const secret = auth.replace(/=+$/, '')
  if (key.length !== 87 || secret.length !== 22 || !B64U.test(key) || !B64U.test(secret)) return undefined
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return undefined
  }
  const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return undefined
  return { endpoint, p256dh: key, auth: secret }
}

/** A device's WebSocket message: a visible ping, or a frame for one session or for every session (`*`). */
export function parseDeviceMessage(text: string): DeviceMessage | null {
  const v = parse(text)
  if (!v) return null
  if (v.here === true) return { here: true }
  if (v.push === null) return { push: null }
  if (v.push !== undefined) {
    const sub = subscriptionOf(v.push)
    return sub ? { push: sub } : null
  }
  if ((v.to !== '*' && !isId(v.to)) || !isData(v.data)) return null
  return { to: v.to as string, data: v.data }
}
