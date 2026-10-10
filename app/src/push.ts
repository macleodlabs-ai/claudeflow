// "Notify me": the Web Push subscription, made after unlock and sent to each paired room over its device socket as
// { push: subscription } (keys and an endpoint, no secrets of the session's). What a push says is only its kind:
// the service worker (sw.ts) turns it into fixed words, so the relay and the push service never see content.
// The browser parts come in as `PushDeps`, so the flow is tested without one.

/** Also in plugins/streams/hooks/remote/notify.ts and relay/cloudflare/src/push.ts (separate packages): change all three together. */
export type NotifyKind = 'needs-you' | 'done' | 'failed'
/** A subscription as `PushSubscription.toJSON()` gives it, and as the relay keeps it per device. */
export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } }

/**
 * What the toggle shows: no Push in this browser; an iPhone or iPad page outside the Home Screen (iOS offers Push
 * only to Home Screen apps); notifications blocked in settings; or off and on.
 */
export type NotifyState = 'unsupported' | 'home-screen' | 'blocked' | 'off' | 'on'

export type PushEnv = { hasPush: boolean; isIOS: boolean; isStandalone: boolean; permission: NotificationPermission | 'unsupported'; isSubscribed: boolean }

export function notifyState(e: PushEnv): NotifyState {
  if (e.isIOS && !e.isStandalone) return 'home-screen'
  if (!e.hasPush || e.permission === 'unsupported') return 'unsupported'
  if (e.permission === 'denied') return 'blocked'
  return e.isSubscribed && e.permission === 'granted' ? 'on' : 'off'
}

type Sub = { toJSON(): unknown; unsubscribe(): Promise<boolean> }
type Manager = { getSubscription(): Promise<Sub | null>; subscribe(o: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<Sub> }

/** The browser, as the flow uses it. */
export type PushDeps = {
  /** Asks for permission: called first, inside the tap, which iOS requires. */
  permission(): Promise<NotificationPermission>
  /** The relay's VAPID public key (b64u), or undefined when it has none. */
  key(): Promise<string | undefined>
  /** The service worker's push manager, registering the worker if needed. */
  manager(): Promise<Manager>
}

/** A subscription's JSON, if it is one the relay will keep. */
export function subOf(j: unknown): PushSub | undefined {
  const x = (j ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  const { p256dh, auth } = x.keys ?? {}
  return typeof x.endpoint === 'string' && typeof p256dh === 'string' && typeof auth === 'string' ? { endpoint: x.endpoint, keys: { p256dh, auth } } : undefined
}

const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), c => c.charCodeAt(0))
}

/** Turns notifications on: permission, the relay's key, then a subscription (the one already made, if any). */
export async function turnOn(d: PushDeps): Promise<{ sub: PushSub } | { why: string }> {
  if ((await d.permission().catch(() => 'default' as const)) !== 'granted') return { why: 'Notifications were not allowed.' }
  const key = await d.key().catch(() => undefined)
  if (!key) return { why: 'This relay has no notification key yet.' }
  try {
    const pm = await d.manager()
    const sub = subOf(((await pm.getSubscription()) ?? (await pm.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) }))).toJSON())
    return sub ? { sub } : { why: 'This browser could not subscribe.' }
  } catch {
    return { why: 'This browser could not subscribe.' }
  }
}

/** Turns notifications off in the browser; the caller tells the rooms ({ push: null }). */
export async function turnOff(d: Pick<PushDeps, 'manager'>): Promise<void> {
  await (await d.manager().catch(() => undefined))?.getSubscription().then(s => s?.unsubscribe()).catch(() => undefined)
}

/**
 * The words a push shows: fixed per kind, never anything from a session. One tag per kind: a newer push replaces
 * an unread one of its kind, so a `done` never hides an unread `needs-you`.
 */
export function notificationOf(kind: unknown): { title: string; body: string; tag: string } {
  if (kind === 'done') return { title: 'Something finished', body: 'Open claudeflow to see what.', tag: 'claudeflow-done' }
  if (kind === 'failed') return { title: 'Something failed', body: 'Open claudeflow to see what.', tag: 'claudeflow-failed' }
  return { title: 'Claude needs you', body: 'Open claudeflow to answer.', tag: 'claudeflow-needs-you' }
}
