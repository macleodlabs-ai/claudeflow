import { describe, expect, test } from 'bun:test'
import { b64u, passkeyChallenge, verifyPasskey } from '../../plugins/streams/hooks/remote/seal'
import { browserAssertion } from '../src/passkey'
import { platformTerm, signInOf, type SignIn } from '../src/signin'
import { currentOf, initial, reduce, type Snapshot } from '../src/state'
import { gates, type GateView } from '../src/views/gates'
import { menuView } from '../src/views/menu'
import { forGuest } from '../src/views/util'

// The invited person may be on Android, Windows, Linux or any desktop browser: no "Face ID" there, and a way in even
// where no passkey can be made.

const room = 'AAAAAAAAAAAAAAAAAAAAAA'
const guest = { project: 'docs', owner: 'Steve' }
const JARGON = /\bMac\b|pair|\/streams|passkey|Claude Code/i
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
}

describe('signing in on any device', () => {
  test("each platform's sign-in is named as its owner knows it", () => {
    expect(platformTerm(UA.iphone)).toBe('Face ID')
    expect(platformTerm(UA.android)).toBe('your screen lock')
    expect(platformTerm(UA.windows)).toBe('Windows Hello')
    expect(platformTerm(UA.linux)).toBe("your device's sign-in")
  })

  test('with nothing built in, a phone or security key; with no passkeys at all, this browser', () => {
    expect(signInOf(UA.linux, 0, true, false).term).toBe('your phone or security key')
    expect(signInOf(UA.windows, 0, false, false).term).toBe('this browser')
  })

  const view = (gate: GateView['gate'], signIn: SignIn, extra: Partial<GateView> = {}): GateView => ({
    room, gate, label: 'macleod', why: '', stage: { at: 'idle' }, isSlow: false, isCeremony: false, isOnline: true, canRepair: false, guest, signIn, ...extra,
  })
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ')
  const [android, windows, linux, bare] = [signInOf(UA.android, 5, true, true), signInOf(UA.windows, 0, true, true), signInOf(UA.linux, 0, true, false), signInOf(UA.linux, 0, false, false)]

  test('off Apple devices no screen says Face ID, nor anything a guest would not know', () => {
    const whys = ['', 'passkey not verified', 'bad registration', 'Face ID was cancelled or timed out. Tap to try again.', "This browser can't use passkeys. Try Safari or Chrome.",
      'This device already has that passkey. Tap to try again.', 'Passkeys need this page to be opened from its https address.']
    for (const signIn of [android, windows, linux, bare])
      for (const gate of ['pair', 'locked', 'not-paired'] as const)
        for (const why of whys) {
          const t = text(gates([view(gate, signIn, { why })]))
          expect(t).not.toContain('Face ID')
          expect(t).not.toMatch(JARGON)
        }
    expect(text(gates([view('pair', windows)]))).toContain('Join with Windows Hello')
    expect(text(gates([view('locked', android, { why: 'Face ID was cancelled or timed out. Tap to try again.' })]))).toContain('Your screen lock was cancelled')
  })

  test('with nothing built in, the guest may join on this browser instead, told it then only watches', () => {
    const both = gates([view('pair', linux)])
    expect(both).toContain('data-gate="pair"')
    expect(both).toContain('data-gate="pair-browser"')
    expect(text(both)).toContain('watch, not act')
    const only = gates([view('pair', bare)])
    expect(only).not.toContain('data-gate="pair"')
    expect(text(only)).toContain('Join on this browser')
    // An iPhone has Face ID: no second way to confuse.
    expect(gates([view('pair', signInOf(UA.iphone, 5, true, true))])).not.toContain('pair-browser')
  })

  test('a room kept by a browser key opens with no prompt to name', () => {
    const t = text(gates([view('locked', android, { isBrowserKey: true })]))
    expect(t).toContain('Open')
    expect(t).not.toMatch(/screen lock|Face ID/)
  })

  test("inside the project, Face ID lines name this device's sign-in", () => {
    expect(forGuest('Face ID was not accepted. Tap Allow to try again.', 'Steve', 'Windows Hello')).toBe('Windows Hello was not accepted. Tap Allow to try again.')
    expect(forGuest('Face ID was not accepted. Answer on your Mac.', 'Steve', 'your screen lock')).toBe('Your screen lock was not accepted.')
  })
})

describe('a browser key', () => {
  test('signs as a passkey would, so the Mac checks it the same way, but never as a verified user', async () => {
    // The session must take it from a guest's browser, and must never mistake it for Face ID or another site's.
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair
    const spki = b64u(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))
    const origin = 'https://relay.example.workers.dev'
    // Many signatures: DER needs care when r or s starts with a high bit or a zero byte.
    for (let i = 0; i < 40; i++) {
      const challenge = passkeyChallenge('hello', 'room', `eph${i}`, i)
      const a = await browserAssertion(pair.privateKey, challenge, origin)
      expect(verifyPasskey(a, spki, challenge, origin, false)).toBe(true)
      expect(verifyPasskey(a, spki, challenge, origin)).toBe(false)
      expect(verifyPasskey(a, spki, challenge, 'https://evil.example', false)).toBe(false)
    }
  })

  test('the owner sees a guest on a browser key as watch only, with no role to switch', () => {
    const snap = {
      v: 1, session: { id: 'a', account: 'Steve', project: 'docs', busy: false }, at: 0, streams: [], status: [], limits: [], updates: [], permissions: [],
      people: [{ id: 'd1', label: 'Sam', role: 'viewer', until: 86_400_000, pairedAt: 0, browserKey: true }],
    } as unknown as Snapshot
    const s = reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap, now: 0 })
    const html = menuView(s, currentOf(s, 0), true, 0, undefined)
    expect(html).toContain('Watch only')
    expect(html).not.toContain('data-people-role="d1"')
  })
})
