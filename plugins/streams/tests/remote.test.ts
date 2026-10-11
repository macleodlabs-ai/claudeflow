import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { p256 } from '../hooks/vendor/noble'
import { fromB64u, newIdentity, passkeyChallenge, publicKeyOf, randomId } from '../hooks/remote/seal'
import { ACTIVE_POLL_MS, PAIRING_MS, createLink, devicesOf, type Device, type Identity, type OutFrame, type Pairing } from '../hooks/remote/link'
import { CHUNK_B64, HEARTBEAT_MS, NO_DEVICE_MS, commandOf, type Ack, type PhoneCommand, type Snapshot } from '../hooks/remote/snapshot'
import { STORE, TICK_MS } from '../hooks/remote/index'
import { spkiOf } from './authenticator'
import { ORIGIN, RELAY, SESSION, T0, account, cycle, phone, room, snapshot, tOf } from './room'

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
    relay.from(a, a.hello({ now: T0 + 2 * 60_000 }))
    relay.from(a, a.hello({ now: T0, origin: 'https://evil.example' }))
    relay.from(a, a.hello({ now: T0, key: p256.utils.randomSecretKey() }))
    const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(r.frames.map(f => f.data)).toEqual(Array(4).fill({ t: 'denied', why: 'passkey not verified' }))
  })

  test('a hello that waited in the room a few minutes, or comes from a phone clock a minute fast, still unlocks', () => {
    // A phone back from the background, or a Mac waking or backing off, must not leave Face ID failing until re-paired.
    const me = account()
    for (const at of [T0 - 4 * 60_000, T0 + 60_000]) {
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
function session(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/Users/me/.claude-clients/macleod', HOME: '/Users/me' })
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
    submitted.push(e.text)
    return { text: e.text }
  })
  return clock
}
/** Prompts the session submitted, in order (reset by each test that reads it). */
const submitted: string[] = []

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
  const OPTIONS = { ...ENGINE, options: { relayUrl: RELAY } }

  test('posts up with its token and cursor, stays quiet when nothing changed, and backs off while the relay fails', OPTIONS, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    mock.store(on, { [STORE.identity]: me, [STORE.devices]: [a.stored()] })
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
    expect(sent[0]?.body).toEqual({ token: me.token, session: SESSION, since: 0, frames: [] })
    // Nothing changed and no device looks: no request until the heartbeat, which carries the cursor on.
    await clock.advance(HEARTBEAT_MS - TICK_MS)
    expect(sent).toHaveLength(1)
    await clock.advance(TICK_MS)
    expect(sent).toHaveLength(2)
    expect(sent[1]?.body.since).toBe(7)
    // The relay fails at the next heartbeat: retried after 4 s, then 8 s, not every tick.
    isUp = false
    await clock.advance(HEARTBEAT_MS)
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

  test('an account with nothing paired and no pairing open never calls the relay', OPTIONS, async ($, on) => {
    // Every session of every account runs this; one that no device could answer must spend nothing.
    const clock = session(on)
    mock.store(on, { [STORE.identity]: account() })
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
  async function withPhone($: Engine, on: On) {
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    mock.store(on, { [STORE.identity]: me, [STORE.devices]: [a.stored()] })
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
    const st = { isLooking: true, dialog: undefined as undefined | ((label: string) => void) }
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
    return { a, relay, clock, seen, acked, st, watch, runs, written }
  }

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
    const path = '/Users/me/.claudeflow/uploads/b1/shot.png'
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
    relay.from(a, a.command({ id: 'c2', kind: 'restore', streamId: 'docs' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(seen.at(-1)!.streams.map(s => s.id)).toContain('docs')
    expect(seen.at(-1)!.archived ?? []).toEqual([])
  })

  test('a phone cannot archive a stream the session does not have', OPTIONS, async ($, on) => {
    const { a, relay, clock, acked } = await withPhone($, on)
    relay.from(a, a.command({ id: 'c1', kind: 'archive', streamId: 'nope' }))
    await clock.advance(ACTIVE_POLL_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(acked.find(x => x.id === 'c1')).toMatchObject({ ok: false })
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
    await clock.advance(10 * 60_000)
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
    mock.store(on, { [STORE.identity]: me })
    on('tool.check', async () => ({ decision: 'ask' }) as never)
    const r = await $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_2' } as never)
    expect(r.decision).toBe('ask')
  })
})

/** The plugin's $.store in memory, readable by the test (mock.store keeps its own out of reach). */
function store(on: On, entries: Record<string, unknown> = {}): Map<string, unknown> {
  const m = new Map(Object.entries(entries))
  on('store.get', async (_$, e) => ({ value: m.get(e.key) }) as never)
  on('store.set', async (_$, e) => {
    m.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    m.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...m.keys()] }) as never)
  return m
}

describe('/streams phone', () => {
  const run = ($: Engine, args: string) =>
    $.command.run({ command: 'streams', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never) as Promise<{ text: string }>

  test('opens the pairing page with the room, the account key and a fresh ten-minute secret', { ...ENGINE, options: { relayUrl: `${RELAY}/` } }, async ($, on) => {
    // The secret travels only after `#`, so the relay never learns it; a new identity is made the first time.
    const clock = mock.clock(on, { now: T0 })
    const kept = store(on)
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

  test('with the relay turned off it says exactly what to set, and opens nothing', { ...ENGINE, options: { relayUrl: '' } }, async ($, on) => {
    mock.clock(on)
    const kept = store(on)
    let opened = 0
    on('process.run', async () => {
      opened++
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    })
    const r = await run($, 'phone')
    // Both ways to set it, since typing the address after the command is what people try first.
    expect(r.text).toContain('/streams phone relay https://')
    expect(r.text).toContain('relayUrl')
    expect(opened).toBe(0)
    expect(kept.get(STORE.identity)).toBe(undefined)
  })

  // The address typed after the command must land in the plugin's own relayUrl option, the one /config shows, so
  // there is one value and no override to forget. A wrong one is refused before it is written: an http or pathed
  // address would make passkeys fail on the phone with no hint why.
  test('`phone relay <url>` sets the relayUrl option, `off` clears it, and http or junk is refused', ENGINE, async ($, on) => {
    mock.clock(on)
    store(on)
    const set: unknown[] = []
    on('config.list', async () => ({ value: [{ key: 'streams.relayUrl', label: 'Relay address', kind: 'text', value: '', provider: { plugin: 'streams', tier: 'user' }, isLocked: false }] }) as never)
    on('config.set', async (_$, e) => {
      set.push([e.key, e.value])
      return { value: e.value } as never
    })
    expect((await run($, `phone relay ${RELAY}/`)).text).toContain(`Relay set to ${RELAY}`)
    expect((await run($, 'phone relay off')).text).toContain('Relay cleared')
    expect(set).toEqual([
      ['streams.relayUrl', RELAY],
      ['streams.relayUrl', ''],
    ])
    expect((await run($, 'phone relay http://relay.example.workers.dev')).text).toContain('must be https')
    expect((await run($, `phone relay ${RELAY}/v1/room`)).text).toContain('no path')
    expect((await run($, 'phone relay relay.example')).text).toContain('is not a relay address')
    expect((await run($, 'phone relay https://localhost')).text).toContain('is not a relay address')
    expect(set).toHaveLength(2)
  })

  test('lists the paired devices and forgets one or all', { ...ENGINE, options: { relayUrl: RELAY } }, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const b = phone(me, 'iPad')
    mock.clock(on)
    const kept = store(on, { [STORE.devices]: [a.stored(), b.stored()] })
    expect((await run($, 'phone devices')).text).toContain(`iPhone  ${a.id}`)
    expect((await run($, 'phone forget nobody')).text).toContain('No device')
    await run($, `phone forget ${a.id}`)
    expect((kept.get(STORE.devices) as Device[]).map(d => d.label)).toEqual(['iPad'])
    await run($, 'phone forget all')
    expect(kept.get(STORE.devices)).toEqual([])
    expect((await run($, 'phone devices')).text).toContain('No devices paired')
  })
})
