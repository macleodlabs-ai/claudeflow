import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { decodeArgv, mkdirArgv, openArgv, platformOf, removeArgv, sleepArgv } from '../hooks/remote/platform'
import { relayProtocols } from '../hooks/remote/device'

import { p256 } from '../hooks/vendor/noble'
import { fromB64u, newIdentity, passkeyChallenge, publicKeyOf, randomId, relayHash, relayPairToken } from '../hooks/remote/seal'
import { ACTIVE_POLL_MS, IDLE_POLL_MS, PAIRING_MS, createLink, devicesOf, guardOf, type Device, type Identity, type OutFrame, type Pairing } from '../hooks/remote/link'
import { CHUNK_B64, HEARTBEAT_MS, NO_DEVICE_MS, commandOf, type Ack, type PhoneCommand, type Snapshot } from '../hooks/remote/snapshot'
import { FETCH_MS, HOSTED_RELAY, SITE, STORE, TICK_MS, TICK_STUCK_MS, tokenFor } from '../hooks/remote/index'
import { SAVED_BUDGET, STORE_HISTORY_BUDGET, storeKey, type Saved } from '../hooks/state'
import { TRIM_MS } from '../hooks/streams/session'
import { spkiOf } from './authenticator'
import { BEARER, ORIGIN, RELAY, SESSION, TOKEN, T0, account, cycle, phone, room, snapshot, tOf } from './room'

// The relay forwards every frame and could replay, reorder or forge any of them; the session's side must let in only
// devices that paired with the QR code's secret or prove their passkey now, and run an Allow only with Face ID.
// These tests play real devices against the session's link through a fake relay (room.ts).

/** Tests that drive the engine: room to finish on a busy machine, where the default 5 s is not. */
const ENGINE = { timeoutMs: 20_000 }

describe('pairing and unlocking', () => {
  test('two devices pair with the QR code, unlock, each get their own sealed snapshot, and both send commands', () => {
    // Many phones and tablets at once is the point of the design: each has its own channel, none reads another's.
    const me = account()
    const a = phone(me, 'iPhone')
    const b = phone(me, 'iPad')
    const relay = room([a, b])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    const pairing: Pairing = { secret: randomId(32), until: T0 + PAIRING_MS }
    relay.from(a, a.hello({ now: T0, secret: pairing.secret }))
    relay.from(b, b.hello({ now: T0, secret: pairing.secret }))
    const first = cycle(link, relay, { devices: [], pairing, now: T0 })
    expect(first.paired.map(d => d.label)).toEqual(['iPhone', 'iPad'])
    expect(first.paired[0]).toMatchObject({ id: a.id, pk: a.pk, credentialId: 'cred-iPhone', pairedAt: T0 })
    expect(a.isUnlocked() && b.isUnlocked()).toBe(true)

    // The welcomes and the first snapshot go in the same tick, sealed per device: nothing readable on the wire, and
    // one device's box does not open with the other's channel.
    const boxes = first.frames.filter(f => tOf(f) === 'box')
    expect(boxes.map(f => f.to).sort()).toEqual([a.id, b.id].sort())
    expect(JSON.stringify(boxes)).not.toContain(SESSION)
    const snapshotsOf = (id: string) => (first.read.get(id) as { t: string }[]).filter(m => m.t === 'snapshot')
    expect(snapshotsOf(a.id)).toEqual([{ t: 'snapshot', snapshot: snapshot(T0) }])
    expect(snapshotsOf(b.id)).toEqual([{ t: 'snapshot', snapshot: snapshot(T0) }])
    const forB = boxes.find(f => f.to === b.id) as OutFrame
    expect(a.receive(forB.data)).toBeUndefined()

    relay.from(a, a.command({ id: 'c1', kind: 'answer', streamId: 'docs', text: 'yes, ship it' }))
    relay.from(b, b.command({ id: 'c2', kind: 'stop' }))
    const after = cycle(link, relay, { devices: first.paired, now: T0 + 1000 })
    expect(after.commands).toEqual([
      { device: a.id, command: { id: 'c1', kind: 'answer', streamId: 'docs', text: 'yes, ship it' } },
      { device: b.id, command: { id: 'c2', kind: 'stop' } },
    ])
    expect(after.paired).toEqual([])
  })

  test('a paired device unlocks with a passkey from this minute or the last, and gets snapshots again', () => {
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    // A hello waits in the room up to two minutes, so the previous minute's Face ID still counts.
    relay.from(a, a.hello({ now: T0 - 60_000 }))
    const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(r.frames.map(tOf)).toEqual(['welcome', 'box'])
    expect(r.paired).toEqual([])
    expect(a.isUnlocked()).toBe(true)
  })

  test('a device that paired twice keeps only its newest passkey, so it still unlocks', () => {
    // A double tap or a retry on a slow network paired one phone twice: the store held both passkeys, the older first,
    // and every unlock and Allow was checked against the older one the phone no longer uses.
    const me = account()
    const a = phone(me, 'iPhone')
    const other = phone(me, 'old')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    const stale = { ...a.stored(), credentialId: other.stored().credentialId, credentialKey: other.stored().credentialKey }
    const devices = devicesOf([stale, a.stored()])
    expect(devices).toEqual([a.stored()])
    relay.from(a, a.hello({ now: T0 }))
    expect(cycle(link, relay, { devices, now: T0 }).frames.map(tOf)).toEqual(['welcome', 'box'])
  })

  test('an unpaired device, or a paired id with another key, is denied and gets no channel', () => {
    // Knowing a room id (the relay does) must not be enough to read a session.
    const me = account()
    const stranger = phone(me, 'stranger')
    const a = phone(me, 'iPhone')
    const relay = room([stranger, a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    relay.from(stranger, stranger.hello({ now: T0 }))
    const forged = { ...a.hello({ now: T0 }), pk: newIdentity().pk }
    relay.from(a, forged)
    const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(r.frames.map(f => f.data)).toEqual([
      { t: 'denied', why: 'not paired' },
      { t: 'denied', why: 'not paired' },
    ])
    expect(cycle(link, relay, { devices: [a.stored()], now: T0 + 1000 }).frames).toEqual([])
  })

  test('an expired pairing, or a proof made without the secret, is denied', () => {
    // A QR code seen once (a screenshot, over a shoulder) must stop working after ten minutes.
    const me = account()
    const late = phone(me, 'late')
    const guess = phone(me, 'guess')
    const relay = room([late, guess])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    const pairing: Pairing = { secret: randomId(32), until: T0 + PAIRING_MS }
    relay.from(late, late.hello({ now: T0, secret: pairing.secret }))
    relay.from(guess, guess.hello({ now: T0, secret: randomId(32) }))
    // Someone is still paired, so the session keeps polling after the pairing closes.
    const r = cycle(link, relay, { devices: [phone(me, 'old').stored()], pairing, now: T0 + PAIRING_MS })
    expect(r.frames.map(f => f.data)).toEqual([
      { t: 'denied', why: 'pairing expired' },
      { t: 'denied', why: 'pairing expired' },
    ])
    expect(r.paired).toEqual([])
    relay.from(guess, guess.hello({ now: T0, secret: randomId(32) }))
    expect(cycle(link, relay, { devices: [], pairing, now: T0 }).frames.map(f => f.data)).toEqual([{ t: 'denied', why: 'bad pairing proof' }])
  })

  test('a registration made on another site, or for another pairing, does not pair', () => {
    // The passkey must belong to the relay's origin, or every later Face ID check would be against a phishing site.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    const pairing: Pairing = { secret: randomId(32), until: T0 + PAIRING_MS }
    relay.from(a, a.hello({ now: T0, secret: pairing.secret, origin: 'https://evil.example' }))
    relay.from(a, a.hello({ now: T0, secret: pairing.secret, challenge: passkeyChallenge('pair', randomId(), a.id, a.pk) }))
    const r = cycle(link, relay, { devices: [], pairing, now: T0 })
    expect(r.paired).toEqual([])
    expect(r.frames.map(f => f.data)).toEqual(Array(2).fill({ t: 'denied', why: 'bad registration' }))
  })

  test('a pairing hello the relay replays with its own passkey or another device\'s id is denied', () => {
    // The relay sees every hello in the clear and keeps it for the pairing's ten minutes. Swapping the passkey would
    // make a key the relay holds the one every later Face ID check trusts; swapping the id would overwrite (and lock
    // out) another paired device. The proof covers all that is stored, so neither pairs.
    const me = account()
    const a = phone(me, 'iPhone')
    const b = phone(me, 'iPad')
    const relay = room([a, b])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    const pairing: Pairing = { secret: randomId(32), until: T0 + PAIRING_MS }
    const hello = a.hello({ now: T0, secret: pairing.secret }) as { registration: Record<string, string> }
    const relayKey = spkiOf(p256.utils.randomSecretKey())
    relay.from(a, { ...hello, registration: { ...hello.registration, publicKey: relayKey } })
    relay.from(a, { ...hello, registration: { ...hello.registration, credentialId: 'cred-relay' } })
    relay.from(b, { ...hello, device: b.id })
    const r = cycle(link, relay, { devices: [b.stored()], pairing, now: T0 })
    expect(r.paired).toEqual([])
    expect(r.frames.map(f => f.data)).toEqual(Array(3).fill({ t: 'denied', why: 'bad pairing proof' }))
  })

  test('a hello passkey from an older minute, another origin or another key is denied', () => {
    // A replayed hello (the relay keeps them) or a Face ID made on a phishing page must not unlock a session.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    relay.from(a, a.hello({ now: T0 - 7 * 60_000 }))
    relay.from(a, a.hello({ now: T0 + 4 * 60_000 }))
    relay.from(a, a.hello({ now: T0, origin: 'https://evil.example' }))
    relay.from(a, a.hello({ now: T0, key: p256.utils.randomSecretKey() }))
    const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(r.frames.map(f => f.data)).toEqual(Array(4).fill({ t: 'denied', why: 'passkey not verified' }))
  })

  test('a hello that waited in the room a few minutes, or comes from a phone clock up to 3 minutes fast, still unlocks', () => {
    // A phone back from the background, or a Mac waking or backing off, must not leave Face ID failing until re-paired.
    // Phone clocks drift: one 2.5 min ahead was refused when only a minute was allowed (the chaos run's skew-ahead).
    const me = account()
    for (const at of [T0 - 4 * 60_000, T0 + 60_000, T0 + 150_000]) {
      const a = phone(me, 'iPhone')
      const relay = room([a])
      const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
      relay.from(a, a.hello({ now: at }))
      const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
      expect(r.frames.map(f => tOf(f))).toContain('welcome')
    }
  })

  test('a forgotten device loses its channel at once', () => {
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    relay.from(a, a.hello({ now: T0 }))
    cycle(link, relay, { devices: [a.stored()], now: T0 })
    relay.from(a, a.command({ id: 'c1', kind: 'stop' }))
    const pairing: Pairing = { secret: randomId(32), until: T0 + PAIRING_MS }
    const r = cycle(link, relay, { devices: [], pairing, now: T0 + HEARTBEAT_MS, snapshot: snapshot(T0, { status: [{ id: 'x', area: 'x', state: 'x', detail: 'news' }] }) })
    expect(r.commands).toEqual([])
    expect(r.frames.filter(f => tOf(f) === 'box')).toEqual([])
  })
})

describe('a phone\'s line heals itself', () => {
  // Phones drop sockets, resend, and outlive the sessions they talk to. None of that may leave the phone and a session
  // on different keys, where every command is dropped unread and the phone waits on a Mac that never answers.
  const PROJECT = '/work/claudeflow'
  const posted = (link: ReturnType<typeof createLink>, relay: ReturnType<typeof room>, a: ReturnType<typeof phone>, now: number, deliver: boolean) => {
    const post = link.next({ devices: [a.stored()], now, snapshot: snapshot(now), isHolding: true })
    if (post && deliver) relay.deliver(post.frames)
    link.answered(JSON.stringify(relay.answer()), now)
    return post
  }

  test('the same hello twice gets the same welcome: a phone that missed the first, or read both, keeps one working channel', () => {
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const hello = a.hello({ now: T0 })
    relay.from(a, hello)
    cycle(link, relay, { devices: [a.stored()], now: T0 })
    relay.from(a, a.command({ id: 'c1', kind: 'stop' }))
    expect(cycle(link, relay, { devices: [a.stored()], now: T0 + 1000 }).commands.map(c => c.command.id)).toEqual(['c1'])
    // The phone sends its hello again (it heard nothing for a while); this time the welcome is lost on the way.
    relay.from(a, hello)
    posted(link, relay, a, T0 + 2000, false)
    relay.from(a, a.command({ id: 'c2', kind: 'stop' }))
    expect(cycle(link, relay, { devices: [a.stored()], now: T0 + 3000 }).commands.map(c => c.command.id)).toEqual(['c2'])
    // And again, delivered this time: the phone reads the same welcome and keeps its channel's count.
    relay.from(a, hello)
    cycle(link, relay, { devices: [a.stored()], now: T0 + 4000 })
    relay.from(a, a.command({ id: 'c3', kind: 'stop' }))
    expect(cycle(link, relay, { devices: [a.stored()], now: T0 + 5000 }).commands.map(c => c.command.id)).toEqual(['c3'])
  })

  test('a session that restarted asks an unlocked phone to say hello again, and the same hello opens its channel', () => {
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const before = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const hello = a.hello({ now: T0 })
    relay.from(a, hello)
    cycle(before, relay, { devices: [a.stored()], now: T0 })
    expect(a.isUnlocked()).toBe(true)
    // /reload-plugins: the session's link starts over, with no channel, while the phone still holds its own. The
    // phone's command, sealed for the old channel, cannot be read: the session asks for the hello again instead.
    const after = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    relay.from(a, a.command({ id: 'c1', kind: 'stop' }))
    const asked = cycle(after, relay, { devices: [a.stored()], now: T0 + 60_000 })
    expect(asked.commands).toEqual([])
    expect([...(asked.read.get(a.id) ?? [])]).toContainEqual({ t: 'rehello', session: SESSION })
    // The phone says the same hello again and resends the command under its id: it runs, once.
    relay.from(a, hello)
    cycle(after, relay, { devices: [a.stored()], now: T0 + 62_000 })
    relay.from(a, a.command({ id: 'c1', kind: 'stop' }))
    expect(cycle(after, relay, { devices: [a.stored()], now: T0 + 63_000 }).commands.map(c => c.command.id)).toEqual(['c1'])
  })

  test('when the relay holds frames back (a photo\'s chunks), the session asks again at once rather than next tick', () => {
    const me = account()
    const a = phone(me, 'iPhone')
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const known = { devices: [a.stored()], now: T0, snapshot: snapshot(T0), isHolding: false }
    const answer = (more: boolean) => JSON.stringify({ frames: [{ seq: 1, from: a.id, data: { t: 'noise' } }], devices: [], ...(more ? { more } : {}) })
    expect(link.next(known)).toBeDefined()
    expect(link.answered(answer(true), T0).again).toBe(true)
    expect(link.next(known)?.since).toBe(1)
    expect(link.answered(answer(false), T0).again).toBe(false)
  })

  test('a quiet session with a paired phone posts every 15 s, so a phone opened just after a post is seen within 15 s', () => {
    // Unlock waited on the 30 s heartbeat: a phone opened just after a post sat on "Syncing…" for most of it.
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    let now = T0
    const posts = (step: number) => {
      now += step
      return cycle(link, relay, { devices: [a.stored()], now, snapshot: snapshot(T0), isHolding: false, active: [] }).posts.length
    }
    expect(posts(0)).toBe(1)
    expect(posts(IDLE_POLL_MS - 2000)).toBe(0)
    expect(posts(2000)).toBe(1)
  })
})

describe('allowing a tool from a phone', () => {
  function unlocked() {
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    relay.from(a, a.hello({ now: T0 }))
    cycle(link, relay, { devices: [a.stored()], now: T0 })
    const send = (...boxes: unknown[]) => {
      for (const b of boxes) relay.from(a, b)
      return cycle(link, relay, { devices: [a.stored()], now: T0 }).commands.map(x => x.command)
    }
    /** The acks the phone opened on the next post (acks found in one answer go out with the post after it). */
    const acks = () =>
      ((cycle(link, relay, { devices: [a.stored()], now: T0 }).read.get(a.id) ?? []) as { t: string; ack: Ack }[]).filter(m => m?.t === 'ack').map(m => m.ack)
    return { a, relay, link, send: (c: PhoneCommand) => send(a.command(c)), sendBox: send, acks }
  }

  test('an Allow from an unlocked device needs no Face ID of its own: the unlock opened the channel it comes on', () => {
    // Face ID is for unlocking the app, not for every prompt: asking again for each Allow made the phone a chore.
    const { send } = unlocked()
    const allow: PhoneCommand = { id: 'c1', kind: 'permission', requestId: 'toolu_1', decision: 'allow' }
    expect(send(allow)).toEqual([allow])
    expect(send({ id: 'c2', kind: 'permission', requestId: 'toolu_2', decision: 'deny' })).toEqual([{ id: 'c2', kind: 'permission', requestId: 'toolu_2', decision: 'deny' }])
  })

  test('a replayed Allow box is ignored', () => {
    // The relay keeps every box: the same one again must not open, let alone run the tool twice.
    const { a, sendBox } = unlocked()
    const box = a.command(a.allow('toolu_1'))
    expect(sendBox(box)).toHaveLength(1)
    expect(sendBox(box)).toEqual([])
  })

  test('a command sent again under the same id runs once, and is told the same ack again', () => {
    // On a laggy network the phone resends what it never heard back about. Ids make that safe: a resent Deny, answer
    // or Allow (even freshly sealed, which the channel cannot tell from new) does nothing a second time.
    const { a, link, send, acks } = unlocked()
    const allow = a.allow('toolu_1')
    expect(send(allow)).toEqual([allow])
    link.ack(a.id, { t: 'ack', id: allow.id, ok: true, why: 'allowed' })
    expect(acks()).toEqual([{ t: 'ack', id: allow.id, ok: true, why: 'allowed' }])
    expect(send(allow)).toEqual([])
    expect(acks()).toEqual([{ t: 'ack', id: allow.id, ok: true, why: 'allowed' }])
    const answer: PhoneCommand = { id: 'c-answer', kind: 'answer', streamId: 'st', text: 'yes' }
    expect(send(answer)).toEqual([answer])
    expect(send(answer)).toEqual([])
  })

  test('an ack is sealed: nothing of it travels in plaintext, and a forged plaintext ack is not read', () => {
    // The relay must not learn which request was allowed or refused, nor tell a phone its Allow went through.
    const { a, relay, link, send } = unlocked()
    const allow = a.allow('toolu_secret')
    send(allow)
    link.ack(a.id, { t: 'ack', id: allow.id, ok: true, why: 'allowed' })
    const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(r.frames.map(tOf)).toEqual(['box'])
    const wire = JSON.stringify(r.frames)
    for (const plain of [allow.id, 'ack', 'allowed', 'toolu_secret']) expect(wire).not.toContain(plain)
    expect(r.read.get(a.id)).toEqual([{ t: 'ack', ack: { t: 'ack', id: allow.id, ok: true, why: 'allowed' } }])
    expect(a.receive({ t: 'ack', id: allow.id, ok: true, why: 'allowed' })).toBeUndefined()
  })

})

/** The engine around a session: what its other modules ask at start, answered quietly. */
function session(on: On, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/Users/me/.claude-clients/macleod', HOME: '/Users/me', ...env })
  on('session.cwd', async () => ({ value: '/work/claudeflow' }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('fs.read', async () => ({ value: '{}' }) as never)
  on('prompt.submit', async (_$, e) => {
    if (promptHangs) return new Promise<never>(() => {})
    submitted.push(e.text)
    return { text: e.text }
  })
  return clock
}
/** Prompts the session submitted, in order (reset by each test that reads it). */
const submitted: string[] = []
/** While set, a prompt the session submits never comes back, as one the terminal holds. */
let promptHangs = false

type Up = { url: string; body: { token: string; session: string; since: number; frames: OutFrame[] } }

describe('what a phone may send', () => {
  test('a file name is a plain name: no folders, no way up', () => {
    // The name becomes a path on the Mac, under the uploads folder and nowhere else.
    const c = commandOf({ id: 'c', kind: 'answer', streamId: '', text: '', files: [{ blob: 'b', name: '../../.ssh/id_rsa', type: 'image/png' }] })
    expect(c && c.kind === 'answer' ? c.files?.[0]?.name : undefined).toBe('.._.._.ssh_id_rsa')
    expect(commandOf({ id: 'c', kind: 'answer', streamId: '', text: '', files: [{ blob: 'b', name: '..', type: 'image/png' }] })).toBe(undefined)
  })

  test('a chunk is base64 of bounded size, numbered within its count; a prompt needs text or a file', () => {
    expect(commandOf({ id: 'c', kind: 'chunk', blob: 'b', part: 0, of: 1, data: 'QUJD' })).toBeDefined()
    expect(commandOf({ id: 'c', kind: 'chunk', blob: 'b', part: 1, of: 1, data: 'QUJD' })).toBe(undefined)
    expect(commandOf({ id: 'c', kind: 'chunk', blob: 'b', part: 0, of: 1, data: '<script>' })).toBe(undefined)
    expect(commandOf({ id: 'c', kind: 'chunk', blob: 'b', part: 0, of: 1, data: 'A'.repeat(CHUNK_B64 + 1) })).toBe(undefined)
    expect(commandOf({ id: 'c', kind: 'answer', streamId: '', text: '  ' })).toBe(undefined)
  })
})

describe('the session on the relay', () => {
  const OPTIONS = ENGINE

  test('posts up with its token and cursor, stays quiet when nothing changed, and backs off while the relay fails', OPTIONS, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    mock.store(on, { [STORE.token]: TOKEN,  [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    let isUp = true
    const sent: Up[] = []
    on('http.fetch', async (_$, e) => {
      sent.push({ url: e.url, body: JSON.parse(String(e.init?.body)) })
      if (!isUp) return { value: { status: 503, ok: false, headers: {}, text: '' } } as never
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ frames: [{ seq: 7, from: a.id, data: { here: 1 } }], devices: [] }) } } as never
    })
    await $.session.start({ cwd: '/work/claudeflow', surface: 'terminal', isInteractive: true })
    await clock.advance(TICK_MS)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(`${RELAY}/v1/room/${me.room}/up`)
    // The guard is off: the paired phone has no relay key yet (an app from before keys), so nobody is shut out.
    expect(sent[0]?.body).toEqual({ token: me.token, session: SESSION, since: 0, frames: [], guard: { on: false, admit: [], pairs: [], told: [] } })
    // Nothing changed and no device looks: no request until the quiet pace's next post (on the first 2 s tick past
    // it), which carries the cursor on.
    const due = Math.ceil(IDLE_POLL_MS / TICK_MS) * TICK_MS
    await clock.advance(due - TICK_MS)
    expect(sent).toHaveLength(1)
    await clock.advance(TICK_MS)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.body.since).toBe(7)
    // The relay fails at the next post: retried after 4 s, then 8 s, not every tick.
    isUp = false
    await clock.advance(due)
    expect(sent).toHaveLength(3)
    await clock.advance(TICK_MS)
    expect(sent).toHaveLength(3)
    await clock.advance(TICK_MS)
    expect(sent).toHaveLength(4)
    await clock.advance(3 * TICK_MS)
    expect(sent).toHaveLength(4)
    await clock.advance(TICK_MS)
    expect(sent).toHaveLength(5)
  })

  test('a request to the relay that never comes back does not silence the session: it posts again', OPTIONS, async ($, on) => {
    // After the Mac sleeps, or the network changes, a request can hang on a dead connection with no error. Waiting
    // on it forever, the session would never post again and every phone would find the Mac gone until a restart.
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    mock.store(on, { [STORE.token]: TOKEN,  [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    let posts = 0
    on('http.fetch', async () => {
      if (++posts === 1) return new Promise<never>(() => {})
      return { value: { status: 200, ok: true, headers: {}, text: '{"frames":[],"devices":[]}' } } as never
    })
    await $.session.start({ cwd: '/work/[vault:master/CLAUDE_BIN]flow', surface: 'terminal', isInteractive: true })
    await clock.advance(TICK_MS)
    expect(posts).toBe(1)
    await clock.advance(FETCH_MS + HEARTBEAT_MS + TICK_MS)
    expect(posts).toBeGreaterThan(1)
  })

  test('a phone command that never finishes does not silence the session: it keeps posting', OPTIONS, async ($, on) => {
    // Whatever a command waits on (a prompt the terminal holds, a tool), the phone must keep hearing from the Mac.
    const { a, relay, clock, seen } = await withPhone($, on)
    promptHangs = true
    try {
      relay.from(a, a.command({ id: 'c1', kind: 'answer', streamId: '', text: 'go' }))
      await clock.advance(ACTIVE_POLL_MS)
      const before = seen.length
      await clock.advance(TICK_STUCK_MS + 2 * HEARTBEAT_MS)
      expect(seen.length).toBeGreaterThan(before)
    } finally {
      promptHangs = false
    }
  })

  test('an account with nothing paired and no pairing open never calls the relay', OPTIONS, async ($, on) => {
    // Every session of every account runs this; one that no device could answer must spend nothing.
    const clock = session(on)
    mock.store(on, { [STORE.token]: TOKEN,  [STORE.identity]: account() })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    let posts = 0
    on('http.fetch', async () => {
      posts++
      return { value: { status: 200, ok: true, headers: {}, text: '{"frames":[],"devices":[]}' } } as never
    })
    await $.session.start({ cwd: '/work/claudeflow', surface: 'terminal', isInteractive: true })
    await clock.advance(2 * HEARTBEAT_MS)
    expect(posts).toBe(0)
  })

  /**
   * A session with one paired phone that unlocks at once. The phone reads what it is sent (`seen`, `acked`) and is
   * looking while `st.isLooking`; the terminal's own AskUserQuestion dialog is `st.dialog`, answered by the test.
   */
  async function withPhone($: Engine, on: On, o: { limit?: number } = {}) {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    const kept = store(on, { [STORE.token]: TOKEN, [STORE.identity]: me, [STORE.devices]: [a.stored()] }, o.limit)
    const runs: string[][] = []
    const written: Record<string, string> = {}
    // Making a folder and decoding a file work; anything else (git, open) fails, as on a machine without them.
    on('process.run', async (_$, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: ['/bin/mkdir', '/usr/bin/base64', '/bin/rm'].includes(e.argv[0]!) ? 0 : 1, stdout: '', stderr: '' } } as never
    })
    on('fs.write', async (_$, e) => {
      written[e.path] = e.text
      return { value: undefined } as never
    })
    on('tool.check', async () => ({ decision: 'ask' }) as never)
    const st = { isLooking: true, hasWait: false, dialog: undefined as undefined | ((label: string) => void) }
    // The prompt box takes a fill: no dialog holds the keys (the engine refuses one while a dialog does).
    on('prompt.fill', async () => ({ isFilled: true, text: '' }) as never)
    on('classic.PermissionRequest', async () => ({}) as never)
    on('tool.call', async (_$, e) => {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      const label = await new Promise<string>(r => (st.dialog = r))
      return { result: { questions: (e as unknown as { questions: unknown }).questions, answers: { [q]: label } } } as never
    })
    const relay = room([a])
    const seen: Snapshot[] = []
    const acked: Ack[] = []
    relay.from(a, a.hello({ now: T0 }))
    on('http.fetch', async (_$, e) => {
      // The relay's `wait`, for a test that asks for it (`st.hasWait`): answered at once, awake when a device frame waits;
      // the real one holds it meanwhile. Otherwise 404, as an older relay answers, and the session stops asking.
      if (e.url.endsWith('/wait'))
        return { value: st.hasWait ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ wake: relay.isWaiting() }) } : { status: 404, ok: false, headers: {}, text: '' } } as never
      const body = JSON.parse(String(e.init?.body)) as Up['body']
      for (const got of relay.deliver(body.frames).values())
        for (const m of got as { t?: string; snapshot: Snapshot; ack: Ack }[]) {
          if (m?.t === 'snapshot') seen.push(m.snapshot)
          if (m?.t === 'ack') acked.push(m.ack)
        }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(relay.answer(st.isLooking ? [a] : [])) } } as never
    })
    await $.session.start({ cwd: '/work/claudeflow', surface: 'terminal', isInteractive: true })
    await clock.advance(TICK_MS)
    expect(a.isUnlocked()).toBe(true)
    /** Settles a promise into a box the test can look at without awaiting it. */
    const watch = <T,>(p: Promise<T>) => {
      const box: { value?: T } = {}
      void p.then(v => (box.value = v))
      return box
    }
    return { a, relay, clock, seen, acked, st, watch, runs, written, kept }
  }

  /** History an older session wrote back, the way plugins before 1.3 kept it: 400 long rows. */
  const oldHistory = (size: number): Saved => ({
    streams: [],
    loopStream: {},
    rows: Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, streamId: 's', kind: 'reply' as const, text: 'x'.repeat(Math.floor(size / 400)), at: i })),
  })

  test("an invite made from the phone is saved even when older sessions have filled the store with history", OPTIONS, async ($, on) => {
    // The store is shared by every session of the account. Sessions on older plugins keep writing back whole
    // histories after this one started; the invite must still be kept, or the friend's phone is never let in.
    const { a, relay, clock, acked, kept } = await withPhone($, on, { limit: STORE_LIMIT })
    kept.set(storeKey('/work/old'), oldHistory(STORE_LIMIT - 20_000))
    relay.from(a, a.command({ id: 'c1', kind: 'invite', role: 'viewer' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    const ack = acked.find(x => x.id === 'c1')
    expect(ack).toMatchObject({ ok: true })
    expect((kept.get(STORE.invites) as { secret: string }[]).map(i => i.secret)).toEqual([ack!.secret!])
    expect(kept.has(STORE.identity) && kept.has(STORE.devices)).toBe(true)
  })

  test('a tap reaches the session at once through the relay\'s wait, not at the next 6 s poll', OPTIONS, async ($, on) => {
    const { a, relay, clock, acked, st } = await withPhone($, on)
    st.hasWait = true
    await clock.advance(ACTIVE_POLL_MS)
    relay.from(a, a.command({ id: 'c1', kind: 'invite', role: 'viewer' }))
    await clock.advance(TICK_MS)
    await clock.advance(TICK_MS)
    expect(acked.find(x => x.id === 'c1')).toMatchObject({ ok: true })
  })

  test("the phone's own invite secret is the one kept: its link is already on screen, so the Mac must accept exactly it", OPTIONS, async ($, on) => {
    const { a, relay, clock, acked, kept } = await withPhone($, on)
    const secret = 'S'.repeat(43)
    relay.from(a, a.command({ id: 'c1', kind: 'invite', role: 'contributor', secret }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(acked.find(x => x.id === 'c1')).toMatchObject({ ok: true, secret })
    expect((kept.get(STORE.invites) as { secret: string; role: string }[]).map(i => [i.secret, i.role])).toEqual([[secret, 'contributor']])
  })

  test('an invite whose secret is not one the phone makes is refused, not kept: a guessable secret would let anyone in', () => {
    expect(commandOf({ id: 'c1', kind: 'invite', role: 'viewer', secret: 'abc' })).toBe(undefined)
    expect(commandOf({ id: 'c1', kind: 'invite', role: 'viewer', secret: 'S'.repeat(43) })).toMatchObject({ secret: 'S'.repeat(43) })
    expect(commandOf({ id: 'c1', kind: 'invite', role: 'viewer' })).toEqual({ id: 'c1', kind: 'invite', role: 'viewer' })
  })

  test('history an older session writes back after this one started is cut down within minutes, so the store never fills', OPTIONS, async ($, on) => {
    const { clock, kept } = await withPhone($, on, { limit: STORE_LIMIT })
    for (const name of ['a', 'b', 'c']) kept.set(storeKey(`/work/${name}`), oldHistory(1_000_000))
    await clock.advance(TRIM_MS + TICK_MS)
    const history = [...kept.entries()].filter(([k]) => k.startsWith(storeKey(''))).reduce((n, [, v]) => n + JSON.stringify(v).length, 0)
    expect(history).toBeLessThanOrEqual(STORE_HISTORY_BUDGET)
    for (const name of ['a', 'b', 'c']) {
      const v = kept.get(storeKey(`/work/${name}`))
      if (v) expect(JSON.stringify(v).length).toBeLessThanOrEqual(SAVED_BUDGET)
    }
  })

  test('a photo sent in chunks is saved on the Mac and the prompt names its path, for Claude to read', OPTIONS, async ($, on) => {
    // A plugin's prompt cannot carry an image, so the file goes to disk and the prompt points at it.
    submitted.length = 0
    const { a, relay, clock, acked, runs, written } = await withPhone($, on)
    const b64 = 'A'.repeat(CHUNK_B64 + 10)
    relay.from(a, a.command({ id: 'k0', kind: 'chunk', blob: 'b1', part: 0, of: 2, data: b64.slice(0, CHUNK_B64) }))
    relay.from(a, a.command({ id: 'k1', kind: 'chunk', blob: 'b1', part: 1, of: 2, data: b64.slice(CHUNK_B64) }))
    relay.from(a, a.command({ id: 'c1', kind: 'answer', streamId: '', text: 'what is wrong here?', files: [{ blob: 'b1', name: 'shot.png', type: 'image/png' }] }))
    // Nothing is held, so the session takes commands on its active poll, then acks on the next post.
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    const path = '/Users/me/.streams/uploads/b1/shot.png'
    expect(written[`${path}.b64`] === b64).toBe(true)
    expect(runs.map(r => [...r])).toContainEqual(['/usr/bin/base64', '-D', '-i', `${path}.b64`, '-o', path])
    expect(submitted.at(-1)).toBe(`what is wrong here?\n\n[Attached from my phone: ${path}]`)
    expect(acked.find(x => x.id === 'c1')).toMatchObject({ ok: true })
  })

  test('a swipe on the phone archives a stream, which then shows in its Archived list, and a swipe back restores it', OPTIONS, async ($, on) => {
    const { a, relay, clock, seen, acked } = await withPhone($, on)
    await $.prompt.submit({ text: '#docs tidy the readme', wait: false, origin: { kind: 'composer' } } as never)
    await clock.advance(ACTIVE_POLL_MS)
    expect(seen.at(-1)!.streams.map(s => s.id)).toContain('docs')
    relay.from(a, a.command({ id: 'c1', kind: 'archive', streamId: 'docs' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(acked.find(x => x.id === 'c1')).toMatchObject({ ok: true })
    expect(seen.at(-1)!.streams.map(s => s.id)).not.toContain('docs')
    expect(seen.at(-1)!.archived?.map(s => s.id)).toEqual(['docs'])
    // Archived again (another device swiped it too, or the phone resent it under a new id): what was asked, so done.
    relay.from(a, a.command({ id: 'c1b', kind: 'archive', streamId: 'docs' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(acked.find(x => x.id === 'c1b')).toMatchObject({ ok: true })
    relay.from(a, a.command({ id: 'c2', kind: 'restore', streamId: 'docs' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(seen.at(-1)!.streams.map(s => s.id)).toContain('docs')
    expect(seen.at(-1)!.archived ?? []).toEqual([])
  })

  test('a phone cannot archive a stream the session does not have, and is told why', OPTIONS, async ($, on) => {
    const { a, relay, clock, acked } = await withPhone($, on)
    relay.from(a, a.command({ id: 'c1', kind: 'archive', streamId: 'nope' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(acked.find(x => x.id === 'c1')).toMatchObject({ ok: false, why: 'no such stream' })
  })

  test('a prompt naming a file that has not fully arrived is not sent, and the phone is told', OPTIONS, async ($, on) => {
    submitted.length = 0
    const { a, relay, clock, acked } = await withPhone($, on)
    relay.from(a, a.command({ id: 'k0', kind: 'chunk', blob: 'b2', part: 0, of: 2, data: 'AAAA' }))
    relay.from(a, a.command({ id: 'c2', kind: 'answer', streamId: '', text: 'look', files: [{ blob: 'b2', name: 'a.png', type: 'image/png' }] }))
    // Nothing is held, so the session takes commands on its active poll, then acks on the next post.
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(submitted).toEqual([])
    expect(acked.find(x => x.id === 'c2')).toMatchObject({ ok: false, why: 'file missing' })
    // The phone resends the part that went astray, then the same prompt: it goes, once.
    relay.from(a, a.command({ id: 'k1', kind: 'chunk', blob: 'b2', part: 1, of: 2, data: 'AAAA' }))
    relay.from(a, a.command({ id: 'c2', kind: 'answer', streamId: '', text: 'look', files: [{ blob: 'b2', name: 'a.png', type: 'image/png' }] }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(submitted.length).toBe(1)
    expect(String(submitted[0])).toContain('look')
  })

  /** A Bash call the mode's decider passed on to the person: tool.check said `ask`, then PermissionRequest fired. */
  async function manualAsk($: Engine) {
    await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_1' } as never)
    return $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push' } } as never) as Promise<{ decision?: { behavior: string; message?: string } }>
  }

  test('where no dialog shows while the hook runs, it steps aside at once: the terminal never waits on a phone', OPTIONS, async ($, on) => {
    // The engine strips a hook's refusal, so a test cannot fake an open dialog: the box takes the fill, as with none.
    const { clock, seen, watch } = await withPhone($, on)
    const asked = watch(manualAsk($))
    await clock.advance(2_000)
    expect(asked.value).toEqual({})
    expect(seen.at(-1)!.permissions).toEqual([])
  })

  test('tool.check verdicts pass through untouched, so auto mode and the rules decide as without a phone', OPTIONS, async ($, on) => {
    await withPhone($, on)
    expect(await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_2' } as never)).toEqual({ decision: 'ask' })
  })

  const QUESTION = (options: string[]) => ({
    tool: 'AskUserQuestion',
    tool_use_id: 'toolu_q',
    questions: [{ question: 'Which store?', header: 'Store', options: options.map(label => ({ label, description: '' })), multiSelect: false }],
  })

  test("a question's options reach the phone, and the phone's choice answers it, closing the terminal's dialog", OPTIONS, async ($, on) => {
    const { a, relay, clock, seen, acked, watch } = await withPhone($, on)
    const r = watch($.tool.call(QUESTION(['SQLite (Recommended)', 'Postgres']) as never))
    await clock.advance(TICK_MS)
    const q = seen.at(-1)!.questions![0]!
    expect(q.options.map(o => [o.label, o.isRecommended])).toEqual([
      ['SQLite (Recommended)', true],
      ['Postgres', false],
    ])
    relay.from(a, a.command({ id: 'pick', kind: 'choose', requestId: q.id, label: 'Postgres' }))
    await clock.advance(TICK_MS)
    expect((r.value as { result: { answers: Record<string, string> } })?.result.answers).toEqual({ 'Which store?': 'Postgres' })
    expect(acked.at(-1)).toEqual({ t: 'ack', id: 'pick', ok: true, why: 'chosen' })
  })

  test('with nobody looking for 2 minutes a question takes its recommended option, and Claude and the phone are told', OPTIONS, async ($, on) => {
    const { clock, seen, st, watch } = await withPhone($, on)
    const r = watch($.tool.call(QUESTION(['Postgres', 'SQLite (Recommended)']) as never))
    await clock.advance(TICK_MS)
    st.isLooking = false
    await clock.advance(NO_DEVICE_MS + 2 * TICK_MS)
    const got = r.value as { result: { answers: Record<string, string> }; context: string[] }
    expect(got.result.answers).toEqual({ 'Which store?': 'SQLite (Recommended)' })
    expect(got.context).toEqual(['No answer from the person after 2 minutes; chose the recommended option: SQLite (Recommended)'])
    await clock.advance(TICK_MS)
    expect(seen.at(-1)!.settled).toEqual([expect.objectContaining({ why: 'chose recommended', label: 'SQLite (Recommended)' })])
  })

  test('a question with no recommended option stays with the terminal when nobody looks, and a looking device means no fallback', OPTIONS, async ($, on) => {
    const { clock, seen, st, watch } = await withPhone($, on)
    const r = watch($.tool.call(QUESTION(['Postgres', 'SQLite']) as never))
    // Twice the no-device deadline: long enough that any fallback would have fired, short enough to run fast under load.
    await clock.advance(2 * NO_DEVICE_MS)
    expect(r.value).toBeUndefined()
    expect(seen.at(-1)!.questions!.map(q => q.id)).toEqual(['toolu_q'])
    st.isLooking = false
    await clock.advance(NO_DEVICE_MS + 2 * TICK_MS)
    expect(r.value).toBeUndefined()
    expect(seen.at(-1)!.questions).toEqual([])
    expect(seen.at(-1)!.settled).toEqual([expect.objectContaining({ id: 'toolu_q', why: 'moved to Mac' })])
    st.dialog?.('SQLite')
    await clock.advance(TICK_MS)
    expect((r.value as { result: { answers: Record<string, string> } }).result.answers).toEqual({ 'Which store?': 'SQLite' })
  })

  test('with no device looking a permission prompt is not held: the Mac asks at once', OPTIONS, async ($, on) => {
    const me = account()
    session(on)
    mock.store(on, { [STORE.token]: TOKEN,  [STORE.identity]: me })
    on('tool.check', async () => ({ decision: 'ask' }) as never)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_2' } as never)
    expect(r.decision).toBe('ask')
  })
})

/** The engine's limit on a plugin's whole $.store, as compact JSON. */
const STORE_LIMIT = 4 * 1024 * 1024

/**
 * The plugin's $.store in memory, readable by the test (mock.store keeps its own out of reach). With `limit`, a write
 * that would take the whole store past it is refused, as the engine refuses it.
 */
function store(on: On, entries: Record<string, unknown> = {}, limit = Infinity): Map<string, unknown> {
  const m = new Map(Object.entries(entries))
  on('store.get', async (_$, e) => ({ value: m.get(e.key) }) as never)
  on('store.set', async (_$, e) => {
    const value = JSON.parse(JSON.stringify(e.value))
    const after = new Map(m).set(e.key, value)
    if (JSON.stringify(Object.fromEntries(after)).length > limit) throw new Error('store over 4 MiB')
    m.set(e.key, value)
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    m.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...m.keys()] }) as never)
  return m
}

describe('sharing through the session', () => {
  const OPTIONS = ENGINE

  test('the owner invites, the guest joins and moves to the Home Screen app, then is removed and told so', OPTIONS, async ($, on) => {
    // The whole share as index.tsx runs it, with $.store: what the owner and the guest each end up with.
    const me = account()
    const owner = phone(me, 'my iPhone')
    const safari = phone(me, "Sam's iPhone")
    const homeScreen = phone(me, "Sam's iPhone")
    const clock = session(on)
    // Another project's history fills the store to its limit: sharing must still be kept, history making way.
    const other = storeKey('/work/other')
    const full = { [STORE.token]: TOKEN, [STORE.identity]: me, [STORE.devices]: [owner.stored()], [other]: { streams: [], loopStream: {}, rows: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, streamId: 'a', kind: 'reply', text: 'x'.repeat(1000), at: 0 })) } }
    const kept = store(on, full, JSON.stringify(full).length + 100)
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    const relay = room([owner, safari, homeScreen])
    const read = new Map<string, unknown[]>()
    on('http.fetch', async (_$, e) => {
      const body = JSON.parse(String(e.init?.body)) as Up['body']
      for (const [id, got] of relay.deliver(body.frames)) read.set(id, [...(read.get(id) ?? []), ...got])
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(relay.answer([owner, safari, homeScreen])) } } as never
    })
    const of = <T,>(id: string, t: string) => ((read.get(id) ?? []) as ({ t: string } & T)[]).filter(m => m?.t === t)
    await $.session.start({ cwd: '/work/claudeflow', surface: 'terminal', isInteractive: true })
    relay.from(owner, owner.hello({ now: T0 }))
    await clock.advance(TICK_MS)
    relay.from(owner, owner.command({ id: 'inv', kind: 'invite', role: 'viewer' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    const secret = of<{ ack: Ack }>(owner.id, 'ack').find(m => m.ack.id === 'inv')?.ack.secret
    expect(secret).toBeDefined()

    relay.from(safari, safari.hello({ now: T0, secret }))
    await clock.advance(ACTIVE_POLL_MS)
    expect(safari.isUnlocked()).toBe(true)
    relay.from(homeScreen, homeScreen.hello({ now: T0, secret }))
    await clock.advance(ACTIVE_POLL_MS)
    expect(homeScreen.isUnlocked()).toBe(true)
    // One person: the Home Screen app took Safari's place, and the invite still names them.
    const stored = devicesOf(kept.get(STORE.devices))
    expect(stored.map(d => d.id)).toEqual([owner.id, homeScreen.id])
    expect(kept.has(other)).toBe(false)
    await clock.advance(ACTIVE_POLL_MS)
    const people = of<{ snapshot: Snapshot }>(owner.id, 'snapshot').at(-1)?.snapshot.people ?? []
    expect(people.map(x => x.id)).toEqual([homeScreen.id])

    relay.from(owner, owner.command({ id: 'rm', kind: 'forgetDevice', deviceId: homeScreen.id }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(of<{ ack: Ack }>(owner.id, 'ack').find(m => m.ack.id === 'rm')?.ack.ok).toBe(true)
    relay.from(homeScreen, homeScreen.hello({ now: T0 + 3 * ACTIVE_POLL_MS }))
    await clock.advance(ACTIVE_POLL_MS)
    expect(of<{ why: string }>(homeScreen.id, 'denied').map(m => m.why)).toContain('access removed')
    await clock.advance(ACTIVE_POLL_MS)
    expect(of<{ snapshot: Snapshot }>(owner.id, 'snapshot').at(-1)?.snapshot.people).toBeUndefined()
  })
})

describe('/streams phone', () => {
  const run = ($: Engine, args: string) =>
    $.command.run({ command: 'streams', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never) as Promise<{ text: string }>

  test('opens the pairing page with the room, the account key and a fresh ten-minute secret', ENGINE, async ($, on) => {
    // The secret travels only after `#`, so the relay never learns it; a new identity is made the first time.
    const clock = mock.clock(on, { now: T0 })
    const kept = store(on, { [STORE.token]: TOKEN })
    const opened: string[][] = []
    on('process.run', async (_$, e) => {
      opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    const r = await run($, 'phone')
    expect(r.text).toContain('Scan its QR code')
    const identity = kept.get(STORE.identity) as Identity
    const pairing = kept.get(STORE.pairing) as Pairing
    expect(identity.room).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(fromB64u(identity.token)).toHaveLength(32)
    expect(pairing.until).toBe(clock.now() + PAIRING_MS)
    expect(opened).toEqual([['/usr/bin/open', `${RELAY}/pair#r=${identity.room}&k=${publicKeyOf(identity.sk)}&s=${pairing.secret}`]])
    // A second pairing keeps the account, with a new secret.
    await run($, 'phone')
    expect((kept.get(STORE.identity) as Identity).room).toBe(identity.room)
    expect((kept.get(STORE.pairing) as Pairing).secret).not.toBe(pairing.secret)
  })


  // The address typed after the command must land in the plugin's own relayUrl option, the one /config shows, so
  // there is one value and no override to forget. A wrong one is refused before it is written: an http or pathed
  // address would make passkeys fail on the phone with no hint why.

  test('lists the paired devices and forgets one or all', ENGINE, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const b = phone(me, 'iPad')
    mock.clock(on)
    const kept = store(on, { [STORE.token]: TOKEN,  [STORE.devices]: [a.stored(), b.stored()] })
    expect((await run($, 'phone devices')).text).toContain(`iPhone  ${a.id}`)
    expect((await run($, 'phone forget nobody')).text).toContain('No device')
    await run($, `phone forget ${a.id}`)
    expect((kept.get(STORE.devices) as Device[]).map(d => d.label)).toEqual(['iPad'])
    await run($, 'phone forget all')
    expect(kept.get(STORE.devices)).toEqual([])
    expect((await run($, 'phone devices')).text).toContain('No devices paired')
  })
})

describe('/streams connect', () => {
  const run = ($: Engine, args: string) =>
    $.command.run({ command: 'streams', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never) as Promise<{ text: string }>
  /** The service's answers, by path, and every request the session made of it, with its headers. */
  const service = (on: On, answer: (path: string, body: string, n: number) => { status: number; body?: unknown }) => {
    const asked: { path: string; auth?: string; body: string }[] = []
    on('http.fetch', async (_$, e) => {
      const path = new URL(e.url).pathname
      const body = String(e.init?.body ?? '')
      const headers = (e.init?.headers ?? {}) as Record<string, string>
      asked.push({ path, ...(headers.authorization ? { auth: headers.authorization } : {}), body })
      const a = answer(path, body, asked.filter(x => x.path === path).length)
      return { value: { status: a.status, ok: a.status < 300, headers: {}, text: JSON.stringify(a.body ?? {}) } } as never
    })
    return asked
  }
  const configured = (on: On) => {
    const set: [string, unknown][] = []
    on('config.list', async () => ({ value: [{ key: 'streams.token', label: 'Streams token', kind: 'text', value: '', provider: { plugin: 'streams', tier: 'user' }, isLocked: false }] }) as never)
    on('config.set', async (_$, e) => {
      set.push([e.key, e.value])
      return { value: e.value } as never
    })
    return set
  }

  // The phone is the Streams service's: with no account, a session never reaches it, whatever it has paired.
  test('with no token the session never calls the relay, and /streams phone says to connect first', ENGINE, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    store(on, { [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    const asked = service(on, () => ({ status: 200, body: { frames: [], devices: [] } }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    await clock.advance(IDLE_POLL_MS * 2)
    expect(asked).toEqual([])
    expect((await run($, 'phone')).text).toContain('/streams connect')
  })

  test('every relay request carries the Streams token', ENGINE, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    store(on, { [STORE.token]: TOKEN,  [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    const asked = service(on, () => ({ status: 200, body: { frames: [], devices: [] } }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    await clock.advance(TICK_MS)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every(x => x.auth === `Bearer ${BEARER}`)).toBe(true)
  })

  // Signing in happens in the browser; the session polls on its own clock and keeps the token in the plugin's
  // sensitive `token` setting (secure storage), which reloads the plugin with it.
  test('connect opens the sign-in page, waits for the person, then keeps the token in $.store, never a setting', ENGINE, async ($, on) => {
    const clock = session(on)
    const kept = store(on)
    const opened: string[][] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === '/usr/bin/open') opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    const asked = service(on, (path, _body, n) =>
      path === '/v1/connect'
        ? { status: 200, body: { code: 'ABCD-EFGH', device: 'dev-secret', url: `${RELAY}/connect?code=ABCD-EFGH`, interval: 2, expiresIn: 600 } }
        : n < 3
          ? { status: 428, body: { status: 'pending' } }
          : { status: 200, body: { token: 'sr1.a.b.c', account: { login: 'octo' } } },
    )
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    const r = await run($, 'connect')
    expect(r.text).toContain('ABCD-EFGH')
    expect(opened).toEqual([['/usr/bin/open', `${RELAY}/connect?code=ABCD-EFGH`]])
    await clock.advance(TICK_MS * 4)
    expect(asked.filter(x => x.path === '/v1/connect/token').map(x => JSON.parse(x.body).device)).toEqual(['dev-secret', 'dev-secret', 'dev-secret'])
    expect(kept.get(STORE.token)).toBe(`${RELAY}#sr1.a.b.c`)
    // Kept once: no more polls after the token came.
    await clock.advance(TICK_MS * 4)
    expect(asked.filter(x => x.path === '/v1/connect/token')).toHaveLength(3)
  })

  test('a sign-in page on another site is never opened', ENGINE, async ($, on) => {
    session(on)
    store(on)
    let opened = 0
    on('process.run', async (_$, e) => {
      if (e.argv[0] === '/usr/bin/open') opened++
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    service(on, () => ({ status: 200, body: { code: 'ABCD-EFGH', device: 'd', url: 'https://evil.example/connect?code=ABCD-EFGH', interval: 2, expiresIn: 600 } }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    expect((await run($, 'connect')).text).toContain('Could not reach')
    expect(opened).toBe(0)
  })

  test('disconnect gives the token back to the service and clears it here', ENGINE, async ($, on) => {
    session(on)
    const kept = store(on, { [STORE.token]: TOKEN })
    const asked = service(on, () => ({ status: 200, body: { ok: true } }))
    expect((await run($, 'disconnect')).text).toContain('Disconnected')
    expect(asked.filter(x => x.path === '/v1/token/revoke').map(x => x.auth)).toEqual([`Bearer ${BEARER}`])
    expect(kept.get(STORE.token)).toBe('')
  })

  // A revoked token or an ended trial must not look like a relay that is down: the band says what to do.
  for (const [status, says] of [
    [401, '/streams connect'],
    [402, 'trial has ended'],
  ] as const)
    test(`a ${status} from the service is said above the prompt`, ENGINE, async ($, on) => {
      const me = account()
      const a = phone(me, 'iPhone')
      const clock = session(on)
      store(on, { [STORE.token]: TOKEN,  [STORE.identity]: me, [STORE.devices]: [a.stored()] })
      on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
      service(on, () => ({ status }))
      on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
      await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
      await clock.advance(TICK_MS)
      const band = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } as never })
      const texts = (await band.findAll({ type: 'Text' })).map(t => t.text).join('\n')
      await band.unmount()
      expect(texts).toContain(says)
    })

  // The free mod is the person's whatever their plan: a trial that ended or a plan cancelled turns the phone off, never
  // the pane, the pill bar or the streams on this computer.
  test('with the plan over (402), the free mod still works: /streams opens the navigator', ENGINE, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    store(on, { [STORE.token]: TOKEN, [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    const asked = service(on, () => ({ status: 402 }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    await clock.advance(TICK_MS)
    expect(asked.some(x => x.path.endsWith('/up'))).toBe(true)
    expect((await run($, '')).text).toContain('Streams navigator opened.')
  })

  test('a 403 (another account holds this room) is said above the prompt, not taken for a relay that is down', ENGINE, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    store(on, { [STORE.token]: TOKEN,  [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    service(on, () => ({ status: 403 }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    await clock.advance(TICK_MS)
    const band = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false } as never })
    const texts = (await band.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    await band.unmount()
    expect(texts).toContain('another Streams account holds it')
  })

  // The hosted token is a bearer for the account's plan and billing: it goes only to the relay that issued it.

  test('tokenFor: a stored token is used only with its own relay; one kept before origins were kept is the hosted relay\'s', () => {
    expect(tokenFor(`${RELAY}#sr1.x`, `${RELAY}/`)).toBe('sr1.x')
    expect(tokenFor(`${RELAY}#sr1.x`, 'https://relay.other.workers.dev')).toBe('')
    expect(tokenFor('sr1.x', HOSTED_RELAY)).toBe('sr1.x')
    expect(tokenFor('sr1.x', 'https://relay.other.workers.dev')).toBe('')
    expect(tokenFor('', RELAY)).toBe('')
  })

  test("the hosted relay's sign-in page on the Streams site is opened", ENGINE, async ($, on) => {
    session(on)
    store(on)
    configured(on)
    const opened: string[][] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === '/usr/bin/open') opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    service(on, () => ({ status: 200, body: { code: 'ABCD-EFGH', device: 'd', url: `${SITE}/connect?code=ABCD-EFGH`, interval: 2, expiresIn: 600 } }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    expect((await run($, 'connect')).text).toContain('ABCD-EFGH')
    expect(opened).toEqual([['/usr/bin/open', `${SITE}/connect?code=ABCD-EFGH`]])
  })


  test('/streams billing opens the Stripe page the service names, and nothing on any other site', ENGINE, async ($, on) => {
    session(on)
    store(on, { [STORE.token]: TOKEN })
    const opened: string[][] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === '/usr/bin/open') opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    let url = 'https://checkout.stripe.com/c/pay/cs_test_1'
    const asked = service(on, () => ({ status: 200, body: { url } }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    expect((await run($, 'billing')).text).toContain('Opened Streams billing')
    expect(opened).toEqual([['/usr/bin/open', url]])
    expect(asked.filter(x => x.path === '/v1/billing').map(x => x.auth)).toEqual([`Bearer ${BEARER}`])
    url = 'https://evil.example/pay'
    expect((await run($, 'billing')).text).toContain('Could not reach Streams billing')
    expect(opened).toHaveLength(1)
  })

  test('/streams delete-account opens the site page that asks for a fresh sign-in, and calls the service for nothing', ENGINE, async ($, on) => {
    session(on)
    store(on, { [STORE.token]: TOKEN })
    const opened: string[][] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === '/usr/bin/open') opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    const asked = service(on, () => ({ status: 200 }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    expect((await run($, 'delete-account')).text).toContain(`${SITE}/account/delete`)
    expect(opened).toEqual([['/usr/bin/open', `${SITE}/account/delete`]])
    // A session's token never deletes the account: nothing is sent to the service.
    expect(asked.filter(x => x.path.includes('delete'))).toHaveLength(0)
  })

  test('/streams billing before connecting says to connect, and calls nothing', ENGINE, async ($, on) => {
    session(on)
    store(on)
    const asked = service(on, () => ({ status: 200 }))
    await $.session.start({ cwd: '/work/p', surface: 'terminal', isInteractive: true })
    expect((await run($, 'billing')).text).toContain('/streams connect')
    expect(asked).toHaveLength(0)
  })

  // The browser page opens with the system's own opener: `open` on macOS, `xdg-open` on Linux.
  test('on Linux the sign-in page opens with xdg-open', ENGINE, async ($, on) => {
    session(on)
    store(on)
    const opened: string[][] = []
    on('process.run', async (_$, e) => {
      if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: 'Linux\n', stderr: '' } } as never
      if (e.argv[0] === 'xdg-open' || e.argv[0] === '/usr/bin/open') opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    service(on, () => ({ status: 200, body: { code: 'ABCD-EFGH', device: 'd', url: `${RELAY}/connect?code=ABCD-EFGH`, interval: 2, expiresIn: 600 } }))
    await $.session.start({ cwd: '/home/me/p', surface: 'terminal', isInteractive: true })
    await run($, 'connect')
    expect(opened).toEqual([['xdg-open', `${RELAY}/connect?code=ABCD-EFGH`]])
  })

  // Not yet on Windows: said plainly, rather than running Mac paths that fail half way.
  test('on Windows the phone side says it is not there yet, and never calls the relay', ENGINE, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on, { OS: 'Windows_NT' })
    store(on, { [STORE.token]: TOKEN,  [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    const asked = service(on, () => ({ status: 200, body: { frames: [], devices: [] } }))
    await $.session.start({ cwd: 'C:\\work\\p', surface: 'terminal', isInteractive: true })
    await clock.advance(IDLE_POLL_MS * 2)
    expect(asked).toEqual([])
    expect((await run($, 'connect')).text).toContain('Windows')
    expect((await run($, 'phone')).text).toContain('Windows')
  })
})

describe('platform commands', () => {
  test('the platform is read from OS (Windows) and uname (macOS, Linux); unknown is macOS', () => {
    expect(platformOf('Windows_NT', undefined)).toBe('win32')
    expect(platformOf(undefined, 'Linux\n')).toBe('linux')
    expect(platformOf(undefined, 'Darwin\n')).toBe('darwin')
    expect(platformOf(undefined, undefined)).toBe('darwin')
  })
  test('each platform gets its own commands, and Windows none yet', () => {
    expect(openArgv('darwin', 'https://x')).toEqual(['/usr/bin/open', 'https://x'])
    expect(openArgv('linux', 'https://x')).toEqual(['xdg-open', 'https://x'])
    expect(decodeArgv('darwin', 'a.b64', 'a')).toEqual(['/usr/bin/base64', '-D', '-i', 'a.b64', '-o', 'a'])
    // GNU base64 writes to stdout: the shell redirects it, the paths passed as arguments, never in the script.
    expect(decodeArgv('linux', 'a b.b64', 'a b')).toEqual(['sh', '-c', 'base64 -d -- "$1" > "$2"', 'sh', 'a b.b64', 'a b'])
    for (const f of [openArgv('win32', 'u'), sleepArgv('win32', 2), mkdirArgv('win32', 'd'), decodeArgv('win32', 'a', 'b'), removeArgv('win32', 'f')]) expect(f).toBeUndefined()
  })
})

describe('the relay guard: who may open the room\'s device sockets', () => {
  test("a pairing hello teaches the account the device's relay key, and the session's posts hold the room to it", () => {
    const me = account()
    const rk = randomId(32)
    const a = phone(me, 'iPhone', { relayKey: rk })
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/claudeflow' })
    const pairing: Pairing = { secret: randomId(32), until: T0 + PAIRING_MS }
    relay.from(a, a.hello({ now: T0, secret: pairing.secret }))
    const first = cycle(link, relay, { devices: [], pairing, now: T0 })
    expect(first.paired[0]!.relayKey).toBe(relayHash(rk))
    // While the pairing is open its token's hash is posted too, so a new phone can still reach the room to say hello.
    expect(first.posts[0]!.guard).toEqual({ on: false, admit: [], pairs: [relayHash(relayPairToken(pairing.secret))], told: [] })
    const later = cycle(link, relay, { devices: first.paired, now: T0 + PAIRING_MS + 1 })
    expect(later.posts[0]!.guard).toEqual({ on: true, admit: [{ id: a.id, key: relayHash(rk) }], pairs: [], told: [] })
    // An expired pairing still opens a hello-only socket for a week, so a late scan is told it expired.
    expect(guardOf({ devices: first.paired, pairing, now: T0 + PAIRING_MS + 1 }).pairs).toEqual([relayHash(relayPairToken(pairing.secret))])
    // The key itself never goes to the relay in a frame: only its hash, in the hello.
    expect(JSON.stringify(first.posts)).not.toContain(rk)
  })

  test('a phone paired before relay keys learns one at its next unlock, and only then is the guard on', () => {
    const me = account()
    const old = phone(me, 'old iPhone')
    const rk = randomId(32)
    const upgraded = phone(me, 'old iPhone', { relayKey: rk })
    const stored = old.stored()
    expect(guardOf({ devices: [stored], now: T0 })).toEqual({ on: false, admit: [], pairs: [], told: [] })
    // The same device (same keys and passkey) unlocking with a newer app: its hello carries the key's hash.
    const hello = upgraded.hello({ now: T0 })
    expect(hello.rk).toBe(relayHash(rk))
  })

  test("guardOf leaves out removed and expired guests, and an expired pairing or invite", () => {
    const d = (id: string, more: Record<string, unknown> = {}) => ({ id, pk: 'pk', credentialId: 'c', credentialKey: 'k', label: id, pairedAt: 0, relayKey: relayHash(id), ...more })
    const g = guardOf({
      devices: [d('owner-device-000001'), d('guest-removed-00001', { role: 'viewer', project: '/p', until: T0 + 1, removed: true }), d('guest-expired-00001', { role: 'viewer', project: '/p', until: T0 - 1 })],
      pairing: { secret: randomId(32), until: T0 - 8 * 86_400_000 },
      invites: [{ secret: randomId(32), until: T0 + 1000, project: '/p', role: 'viewer', days: 7 }],
      now: T0,
    })
    expect(g.admit.map(a => a.id)).toEqual(['owner-device-000001'])
    // The removed and the expired may still say hello, to be told they are out.
    expect(g.told.map(a => a.id)).toEqual(['guest-removed-00001', 'guest-expired-00001'])
    expect(g.on).toBe(true)
    // The open invite; the pairing that expired over a week ago is gone.
    expect(g.pairs).toHaveLength(1)
    // Nothing paired at all: nothing to guard, so the room stays as it was.
    expect(guardOf({ devices: [], now: T0 }).on).toBe(false)
  })

  test('a device opens its socket with its relay key, and while pairing with the pairing token, never the secret', () => {
    const secret = randomId(32)
    expect(relayProtocols('KEY', secret)).toEqual([`sr.KEY.${relayPairToken(secret)}`])
    expect(relayProtocols('KEY', secret).join()).not.toContain(secret)
    expect(relayProtocols('KEY')).toEqual(['sr.KEY'])
  })
})
