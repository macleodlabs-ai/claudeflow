import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { p256 } from '../hooks/vendor/noble'
import { fromB64u, newIdentity, passkeyChallenge, publicKeyOf, randomId } from '../hooks/remote/seal'
import { PAIRING_MS, createLink, type Device, type Identity, type OutFrame, type Pairing } from '../hooks/remote/link'
import { HEARTBEAT_MS, PHONE_PERMISSION_MS, type PhoneCommand, type Snapshot } from '../hooks/remote/snapshot'
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
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
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
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    // A hello waits in the room up to two minutes, so the previous minute's Face ID still counts.
    relay.from(a, a.hello({ now: T0 - 60_000 }))
    const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(r.frames.map(tOf)).toEqual(['welcome', 'box'])
    expect(r.paired).toEqual([])
    expect(a.isUnlocked()).toBe(true)
  })

  test('an unpaired device, or a paired id with another key, is denied and gets no channel', () => {
    // Knowing a room id (the relay does) must not be enough to read a session.
    const me = account()
    const stranger = phone(me, 'stranger')
    const a = phone(me, 'iPhone')
    const relay = room([stranger, a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
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
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
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
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
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
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
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
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    relay.from(a, a.hello({ now: T0 - 120_000 }))
    relay.from(a, a.hello({ now: T0 + 60_000 }))
    relay.from(a, a.hello({ now: T0, origin: 'https://evil.example' }))
    relay.from(a, a.hello({ now: T0, key: p256.utils.randomSecretKey() }))
    const r = cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(r.frames.map(f => f.data)).toEqual(Array(4).fill({ t: 'denied', why: 'passkey not verified' }))
  })

  test('a forgotten device loses its channel at once', () => {
    const me = account()
    const a = phone(me, 'iPhone')
    const relay = room([a])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
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
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN })
    relay.from(a, a.hello({ now: T0 }))
    cycle(link, relay, { devices: [a.stored()], now: T0 })
    const send = (...boxes: unknown[]) => {
      for (const b of boxes) relay.from(a, b)
      return cycle(link, relay, { devices: [a.stored()], now: T0 }).commands.map(x => x.command)
    }
    return { a, relay, link, send: (c: PhoneCommand) => send(a.command(c)), sendBox: send }
  }

  test('an Allow without Face ID, or with someone else\'s, is ignored; a Deny needs none', () => {
    // A stolen unlocked phone (or a bug in the app) must not run tools on the Mac without the owner's face.
    const { a, send } = unlocked()
    expect(send({ id: 'c1', kind: 'permission', requestId: 'toolu_1', decision: 'allow' })).toEqual([])
    expect(send(a.allow('toolu_2', p256.utils.randomSecretKey()))).toEqual([])
    const good = a.allow('toolu_3')
    expect(send(good)).toEqual([good])
    expect(send({ id: 'c4', kind: 'permission', requestId: 'toolu_4', decision: 'deny' })).toEqual([{ id: 'c4', kind: 'permission', requestId: 'toolu_4', decision: 'deny' }])
  })

  test('a replayed Allow is ignored, and a request is checked only once', () => {
    // Each Face ID is for one request: the same box again, or a second Allow for the same request, does nothing.
    const { a, send, sendBox } = unlocked()
    const box = a.command(a.allow('toolu_1'))
    expect(sendBox(box)).toHaveLength(1)
    expect(sendBox(box)).toEqual([])
    expect(send(a.allow('toolu_1'))).toEqual([])
  })

  test('an Allow made for another connection is ignored', () => {
    // The challenge holds the connection's key, so an Allow captured on one connection fails on the next.
    const { a, relay, link, send } = unlocked()
    const old = a.allow('toolu_9')
    relay.from(a, a.hello({ now: T0 }))
    cycle(link, relay, { devices: [a.stored()], now: T0 })
    expect(send(old)).toEqual([])
  })
})

/** The engine around a session: what its other modules ask at start, answered quietly. */
function session(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/Users/me/.claude-clients/macleod' })
  on('session.cwd', async () => ({ value: '/work/claudeflow' }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('command.register', async () => ({ value: undefined }) as never)
  on('fs.read', async () => ({ value: '{}' }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  return clock
}

type Up = { url: string; body: { token: string; session: string; since: number; frames: OutFrame[] } }

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

  test('a looking device unlocks, sees a held permission in its snapshot, and its Face ID Allow answers it', OPTIONS, async ($, on) => {
    // The whole remote in one: hello, welcome, sealed snapshots every tick while looking, and an Allow taken.
    const me = account()
    const a = phone(me, 'iPhone')
    const clock = session(on)
    mock.store(on, { [STORE.identity]: me, [STORE.devices]: [a.stored()] })
    on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
    on('tool.check', async () => ({ decision: 'ask' }) as never)
    const relay = room([a])
    const seen: Snapshot[] = []
    const allowed = new Set<string>()
    relay.from(a, a.hello({ now: T0 }))
    on('http.fetch', async (_$, e) => {
      const body = JSON.parse(String(e.init?.body)) as Up['body']
      for (const got of relay.deliver(body.frames).values())
        for (const m of got as { t?: string; snapshot: Snapshot }[]) if (m.t === 'snapshot') seen.push(m.snapshot)
      // The person taps Allow and passes Face ID for each prompt the phone shows.
      for (const p of seen.at(-1)?.permissions ?? [])
        if (!allowed.has(p.id)) {
          allowed.add(p.id)
          relay.from(a, a.command(a.allow(p.id)))
        }
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(relay.answer()) } } as never
    })
    await $.session.start({ cwd: '/work/claudeflow', surface: 'terminal', isInteractive: true })
    await clock.advance(TICK_MS)
    expect(a.isUnlocked()).toBe(true)
    expect(seen).toHaveLength(1)
    const asked = $.tool.check({ tool: 'Bash', input: { command: 'git push' }, tool_use_id: 'toolu_1' } as never)
    await clock.advance(TICK_MS)
    expect(seen.at(-1)?.permissions.map(p => p.id)).toEqual(['toolu_1'])
    await clock.advance(TICK_MS)
    expect((await asked).decision).toBe('allow')
    expect(PHONE_PERMISSION_MS).toBe(60_000)
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

  test('with no relay set it says exactly what to set, and opens nothing', ENGINE, async ($, on) => {
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
