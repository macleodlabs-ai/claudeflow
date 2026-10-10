// The service worker: shows a push as fixed words for its kind (push.ts `notificationOf`), and opens the app on tap.
// It handles no fetches, so it caches nothing and changes nothing about how the app loads. Built to /sw.js.
import { notificationOf } from './push'

type Client = { url: string; focus(): Promise<unknown> }
type Worker = {
  registration: { showNotification(title: string, o: { body: string; icon: string; tag: string; renotify?: boolean }): Promise<void> }
  clients: { matchAll(o: { type: 'window'; includeUncontrolled: boolean }): Promise<Client[]>; openWindow(url: string): Promise<unknown> }
  addEventListener(type: 'push', f: (e: { data?: { json(): unknown } | null; waitUntil(p: Promise<unknown>): void }) => void): void
  addEventListener(type: 'notificationclick', f: (e: { notification: { close(): void }; waitUntil(p: Promise<unknown>): void }) => void): void
}
const sw = self as unknown as Worker

sw.addEventListener('push', e => {
  let kind: unknown
  try {
    kind = (e.data?.json() as { kind?: unknown } | undefined)?.kind
  } catch {}
  const { title, body, tag } = notificationOf(kind)
  // One tag per kind: a newer push replaces an unread one of its kind instead of stacking.
  e.waitUntil(sw.registration.showNotification(title, { body, icon: '/icon.png', tag, renotify: true }))
})

sw.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => (list[0] ? list[0].focus() : sw.clients.openWindow('/'))))
})
