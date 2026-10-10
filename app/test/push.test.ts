import { describe, expect, test } from 'bun:test'
import { notificationOf, notifyState, turnOff, turnOn, type PushDeps, type PushEnv } from '../src/push'
import { notifyRow } from '../src/views/notify'

// "Notify me" must work where the browser allows it and say plainly what to do where it does not (an iPhone outside
// the Home Screen, notifications blocked). What a push shows is fixed per kind: no session content reaches it.

const env = (x: Partial<PushEnv> = {}): PushEnv => ({ hasPush: true, isIOS: false, isStandalone: false, permission: 'default', isSubscribed: false, ...x })

const SUB_JSON = { endpoint: 'https://push.example.com/abc', expirationTime: null, keys: { p256dh: 'BKEY', auth: 'AUTH' } }

/** A browser that records what the flow asked of it, in order. */
function browser(o: { permission?: NotificationPermission; key?: string; existing?: boolean; failSubscribe?: boolean } = {}) {
  const calls: string[] = []
  let current = o.existing ? { toJSON: () => SUB_JSON, unsubscribe: async () => (calls.push('unsubscribe'), true) } : null
  const deps: PushDeps = {
    permission: async () => (calls.push('permission'), o.permission ?? 'granted'),
    key: async () => (calls.push('key'), 'key' in o ? o.key : 'BPUB_KEY'),
    manager: async () => ({
      getSubscription: async () => current,
      subscribe: async opts => {
        calls.push(`subscribe:${opts.userVisibleOnly}:${opts.applicationServerKey.length}`)
        if (o.failSubscribe) throw new Error('no push service')
        current = { toJSON: () => SUB_JSON, unsubscribe: async () => (calls.push('unsubscribe'), true) }
        return current
      },
    }),
  }
  return { deps, calls }
}

describe('what the toggle shows', () => {
  test('an iPhone page outside the Home Screen is told to add it there, since iOS offers Push only to Home Screen apps', () => {
    expect(notifyState(env({ isIOS: true, hasPush: false }))).toBe('home-screen')
    expect(notifyState(env({ isIOS: true, isStandalone: true }))).toBe('off')
    expect(notifyRow({ state: 'home-screen', why: '', isBusy: false })).toContain('Add to Home Screen')
  })
  test('blocked says where to allow it; no Push at all shows nothing; on and off are a switch', () => {
    expect(notifyState(env({ permission: 'denied' }))).toBe('blocked')
    expect(notifyState(env({ hasPush: false }))).toBe('unsupported')
    expect(notifyRow({ state: 'unsupported', why: '', isBusy: false })).toBe('')
    expect(notifyState(env({ permission: 'granted', isSubscribed: true }))).toBe('on')
    // A subscription the person since revoked permission for is not on.
    expect(notifyState(env({ permission: 'default', isSubscribed: true }))).toBe('off')
    expect(notifyRow({ state: 'on', why: '', isBusy: false })).toContain('aria-checked="true"')
    expect(notifyRow({ state: 'off', why: '', isBusy: false })).toContain('aria-checked="false"')
  })
})

describe('turning it on and off', () => {
  test('asks permission first (iOS allows the prompt only inside the tap), then subscribes with the relay\'s key', async () => {
    const b = browser()
    expect(await turnOn(b.deps)).toEqual({ sub: { endpoint: SUB_JSON.endpoint, keys: SUB_JSON.keys } })
    expect(b.calls[0]).toBe('permission')
    // userVisibleOnly, and the key decoded from b64u to bytes.
    expect(b.calls).toEqual(['permission', 'key', 'subscribe:true:6'])
  })
  test('a subscription this browser already has is reused, not made again', async () => {
    const b = browser({ existing: true })
    expect('sub' in (await turnOn(b.deps))).toBe(true)
    expect(b.calls.some(c => c.startsWith('subscribe'))).toBe(false)
  })
  test('a refused prompt, a relay without a key, or a failed subscribe each say why, and subscribe nothing', async () => {
    expect(await turnOn(browser({ permission: 'denied' }).deps)).toEqual({ why: 'Notifications were not allowed.' })
    const noKey = browser({ key: undefined })
    expect(await turnOn(noKey.deps)).toEqual({ why: 'This relay has no notification key yet.' })
    expect(noKey.calls.some(c => c.startsWith('subscribe'))).toBe(false)
    expect(await turnOn(browser({ failSubscribe: true }).deps)).toEqual({ why: 'This browser could not subscribe.' })
  })
  test('turning off unsubscribes in the browser, so the push service answers 410 to anything still sent', async () => {
    const b = browser({ existing: true })
    await turnOff(b.deps)
    expect(b.calls).toEqual(['unsubscribe'])
  })
})

test('a push shows fixed words for its kind and nothing else; an unknown kind still reads as a call to look', () => {
  expect(notificationOf('needs-you').title).toBe('Claude needs you')
  expect(notificationOf('done').title).toBe('Something finished')
  expect(notificationOf('failed').title).toBe('Something failed')
  expect(notificationOf({ text: 'rm -rf' })).toEqual(notificationOf('needs-you'))
  // A later "finished" must not replace an unread "needs you" on the lock screen.
  expect(new Set(['needs-you', 'done', 'failed'].map(k => notificationOf(k).tag)).size).toBe(3)
})
