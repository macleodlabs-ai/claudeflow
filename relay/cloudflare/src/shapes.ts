// The JSON shapes the relay accepts, checked before anything is stored or forwarded. Pure: no Workers APIs.
// The relay never looks inside `data` (it is sealed or public-key material); it only checks that one is there.

/** Room, device, session ids and the room token: base64url, 16 to 64 characters. */
export const ID = /^[A-Za-z0-9_-]{16,64}$/

/** Largest `up` body, in bytes. */
export const MAX_BYTES = 1 << 20

/** Largest device message, in bytes: a hello with its passkey is about 3 KB, a sealed command at most about 6 KB. */
export const DEVICE_MAX_BYTES = 16 << 10

export type Data = string | object
export type Up = { token: string; session: string; since: number; frames: { to: string; data: Data }[] }
export type DeviceMessage = { here: true } | { to: string; data: Data }

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
  return { token: v.token, session: v.session, since: v.since, frames }
}

/** A device's WebSocket message: a visible ping, or a frame for one session or for every session (`*`). */
export function parseDeviceMessage(text: string): DeviceMessage | null {
  const v = parse(text)
  if (!v) return null
  if (v.here === true) return { here: true }
  if ((v.to !== '*' && !isId(v.to)) || !isData(v.data)) return null
  return { to: v.to as string, data: v.data }
}
