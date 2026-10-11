import { describe, expect, test } from 'claude-code/testing'
import { passkeyChallenge, randomId, verifyPasskey } from '../hooks/remote/seal'
import { authenticator } from './authenticator'
import { DAY_MS, INVITE_MS, SHARE_DAYS, createLink, withPaired, type Device, type Invite } from '../hooks/remote/link'
import type { Ack, Snapshot } from '../hooks/remote/snapshot'
import { ORIGIN, SESSION, T0, account, cycle, phone, room, snapshot } from './room'

const PROJECT = '/work/claudeflow'
const inviteFor = (role: Invite['role'], project = PROJECT): Invite => ({ secret: randomId(32), until: T0 + INVITE_MS, project, role, days: SHARE_DAYS })

/** The owner's account, its phone already paired, and a friend's phone joining by an invite. */
function shared(role: Invite['role'], project = PROJECT) {
  const me = account()
  const owner = phone(me, 'my iPhone')
  const friend = phone(me, "Sam's iPhone")
  const relay = room([owner, friend])
  const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
  const invite = inviteFor(role, project)
  relay.from(owner, owner.hello({ now: T0 }))
  relay.from(friend, friend.hello({ now: T0, secret: invite.secret }))
  const first = cycle(link, relay, { devices: [owner.stored()], invites: [invite], now: T0 })
  return { me, owner, friend, relay, link, invite, first }
}

const snapshotsTo = (read: Map<string, unknown[]>, id: string) =>
  ((read.get(id) ?? []) as { t: string; snapshot: Snapshot }[]).filter(m => m.t === 'snapshot').map(m => m.snapshot)
const acksTo = (read: Map<string, unknown[]>, id: string) => ((read.get(id) ?? []) as { t: string; ack: Ack }[]).filter(m => m.t === 'ack').map(m => m.ack)

describe('sharing a project', () => {
  test('an invite pairs one device for this project, as a watcher by default, for SHARE_DAYS, bound to that invite', () => {
    const { friend, invite, first } = shared('viewer')
    const joined = first.paired.find(d => d.id === friend.id) as Device
    expect(joined).toMatchObject({ role: 'viewer', project: PROJECT, until: T0 + SHARE_DAYS * DAY_MS, via: invite.secret })
    expect(friend.isUnlocked()).toBe(true)
  })

  test('the guest opening the invite again (the Home Screen app after Safari) moves their access there: still one person', () => {
    // On an iPhone the Home Screen app keeps its own storage, so it must join again. A one-use invite turned it away
    // ("pairing expired") with no way back but a new invite from the owner.
    const me = account()
    const owner = phone(me, 'my iPhone')
    const safari = phone(me, "Sam's iPhone")
    const homeScreen = phone(me, "Sam's iPhone")
    const relay = room([owner, safari, homeScreen])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const invite = inviteFor('contributor')
    relay.from(safari, safari.hello({ now: T0, secret: invite.secret }))
    const first = cycle(link, relay, { devices: [owner.stored()], invites: [invite], now: T0 })
    const devices = withPaired([owner.stored()], first.paired)
    // The owner made Sam a watcher meanwhile: the move keeps the role and the end date, it does not renew them.
    const watching = devices.map(d => (d.id === safari.id ? { ...d, role: 'viewer' as const } : d))
    relay.from(homeScreen, homeScreen.hello({ now: T0 + 60 * 60_000, secret: invite.secret }))
    const again = cycle(link, relay, { devices: watching, invites: [invite], now: T0 + 60 * 60_000 })
    expect(homeScreen.isUnlocked()).toBe(true)
    const after = withPaired(watching, again.paired)
    expect(after.map(d => d.id)).toEqual([owner.id, homeScreen.id])
    expect(after[1]).toMatchObject({ role: 'viewer', until: T0 + SHARE_DAYS * DAY_MS, via: invite.secret })
  })

  test('an invite opened after its day is turned away as expired', () => {
    const me = account()
    const owner = phone(me, 'my iPhone')
    const friend = phone(me, "Sam's iPhone")
    const relay = room([owner, friend])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const invite = inviteFor('viewer')
    relay.from(friend, friend.hello({ now: T0 + INVITE_MS, secret: invite.secret }))
    const got = cycle(link, relay, { devices: [owner.stored()], invites: [invite], now: T0 + INVITE_MS })
    expect(got.paired).toEqual([])
    expect(got.read.get(friend.id)).toContainEqual({ t: 'denied', why: 'pairing expired', isPairing: true })
  })

  test('a guest with no authenticator joins with a browser key, and only ever watches, whatever the invite said', () => {
    // Linux or an old Windows: no passkey to make. The key its browser keeps proves the device, not the person, so it
    // gets no say: its commands are refused and it is told it watches.
    const me = account()
    const owner = phone(me, 'my iPhone')
    const laptop = phone(me, "Sam's laptop", { browser: true })
    const relay = room([owner, laptop])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const invite = inviteFor('contributor')
    relay.from(laptop, laptop.hello({ now: T0, secret: invite.secret }))
    const first = cycle(link, relay, { devices: [owner.stored()], invites: [invite], now: T0 })
    expect(first.paired.find(d => d.id === laptop.id)).toMatchObject({ browserKey: true, role: 'contributor' })
    expect(laptop.isUnlocked()).toBe(true)
    const devices = withPaired([owner.stored()], first.paired)
    // Back later: it unlocks with the browser key (present, not verified), and what it sends is refused.
    const again = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    relay.from(laptop, laptop.hello({ now: T0 + 60_000 }))
    const back = cycle(again, relay, { devices, now: T0 + 60_000 })
    expect(laptop.isUnlocked()).toBe(true)
    expect(snapshotsTo(back.read, laptop.id).at(-1)?.you?.role).toBe('viewer')
    relay.from(laptop, laptop.command({ id: 'c1', kind: 'answer', streamId: 'docs', text: 'ship it' }))
    const got = cycle(again, relay, { devices, now: T0 + 61_000 })
    expect(got.commands).toEqual([])
  })

  test("the owner's own devices cannot use a browser key: pairing needs a passkey", () => {
    const me = account()
    const laptop = phone(me, 'my laptop', { browser: true })
    const relay = room([laptop])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const pairing = { secret: randomId(32), until: T0 + 60_000 }
    relay.from(laptop, laptop.hello({ now: T0, secret: pairing.secret }))
    const got = cycle(link, relay, { devices: [], pairing, now: T0 })
    expect(got.paired).toEqual([])
    expect(got.read.get(laptop.id)).toContainEqual({ t: 'denied', why: 'bad registration', isPairing: true })
  })

  test('the kind of key is in the proof: a relay cannot pass a passkey off as a browser key', () => {
    const me = account()
    const owner = phone(me, 'my iPhone')
    const friend = phone(me, "Sam's iPhone")
    const relay = room([owner, friend])
    const link = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: PROJECT })
    const invite = inviteFor('viewer')
    const hello = friend.hello({ now: T0, secret: invite.secret }) as { registration: Record<string, unknown> }
    relay.from(friend, { ...hello, registration: { ...hello.registration, browser: true } })
    expect(cycle(link, relay, { devices: [owner.stored()], invites: [invite], now: T0 }).paired).toEqual([])
  })

  test("a browser key's signature (user present, not verified) opens only a device that joined with one", () => {
    const key = authenticator(ORIGIN, 'k', true)
    const challenge = passkeyChallenge('hello', 'room', 'eph', 1)
    expect(verifyPasskey(key.assert(challenge), key.spki, challenge, ORIGIN)).toBe(false)
    expect(verifyPasskey(key.assert(challenge), key.spki, challenge, ORIGIN, false)).toBe(true)
  })

  test("another project's news wakes the owner's devices, never a guest's", () => {
    // A push says something needs you: a guest of one project must not be woken for the owner's other work.
    const me = account()
    const owner = phone(me, 'my iPhone')
    const friend = phone(me, "Sam's iPhone")
    const relay = room([owner, friend])
    const elsewhere = createLink({ identity: me, session: SESSION, origin: ORIGIN, project: '/work/other' })
    const guestDevice: Device = { ...friend.stored(), role: 'contributor', project: PROJECT, until: T0 + DAY_MS }
    const devices = [owner.stored(), guestDevice]
    cycle(elsewhere, relay, { devices, now: T0, active: [] })
    const ask = snapshot(T0 + 40_000, { permissions: [{ id: 'toolu_1', tool: 'Bash', summary: 'Bash: rm', at: T0 }] })
    const got = cycle(elsewhere, relay, { devices, now: T0 + 40_000, snapshot: ask, active: [] })
    const notified = got.posts.flatMap(p => p.notify ?? [])
    expect(notified).toContain(owner.id)
    expect(notified).not.toContain(friend.id)
  })

  test('a guest the owner removed is told so, not that it is unknown, and no session posts for it', () => {
    // "Not paired" sent a guest to instructions for the owner's Mac.
    const { owner, friend, relay, link, first } = shared('viewer')
    const removed: Device = { ...first.paired.find(d => d.id === friend.id)!, removed: true, until: T0 + 1000 }
    relay.from(friend, friend.hello({ now: T0 + 2000 }))
    const got = cycle(link, relay, { devices: [owner.stored(), removed], now: T0 + 2000 })
    expect(got.read.get(friend.id)).toContainEqual({ t: 'denied', why: 'access removed', isPairing: false })
    expect(link.isQuiet({ devices: [removed], now: T0 + 2000 })).toBe(true)
  })

  test('a watcher sees the project and is told it watches; the owner alone sees who it is shared with', () => {
    const { owner, friend, relay, link, first } = shared('viewer')
    const devices = [owner.stored(), first.paired.find(d => d.id === friend.id)!]
    const people = [{ id: friend.id, label: "Sam's iPhone", role: 'viewer' as const, until: T0 + SHARE_DAYS * DAY_MS, pairedAt: T0 }]
    const next = cycle(link, relay, { devices, now: T0 + 1000, snapshot: { ...snapshotsTo(first.read, owner.id)[0]!, at: T0 + 1000, people } })
    expect(snapshotsTo(next.read, friend.id).at(-1)).toMatchObject({ you: { role: 'viewer' } })
    expect(snapshotsTo(next.read, friend.id).at(-1)?.people).toBeUndefined()
    expect(snapshotsTo(next.read, owner.id).at(-1)?.people).toEqual(people)
  })

  test("a watcher's commands are refused on the Mac and it is told why, whatever its app shows", () => {
    // Watch only must hold even against a modified app: the session is the one that refuses.
    const { owner, friend, relay, link, first } = shared('viewer')
    const devices = [owner.stored(), first.paired.find(d => d.id === friend.id)!]
    relay.from(friend, friend.command({ id: 'c1', kind: 'answer', streamId: 'docs', text: 'ship it' }))
    const got = cycle(link, relay, { devices, now: T0 + 1000 })
    expect(got.commands).toEqual([])
    const later = cycle(link, relay, { devices, now: T0 + 7000 })
    expect([...acksTo(got.read, friend.id), ...acksTo(later.read, friend.id)]).toContainEqual(expect.objectContaining({ id: 'c1', ok: false, why: 'read only' }))
  })

  test('a contributor acts as the owner does in the project, permissions included, but cannot share it further', () => {
    const { owner, friend, relay, link, first } = shared('contributor')
    const devices = [owner.stored(), first.paired.find(d => d.id === friend.id)!]
    relay.from(friend, friend.command({ id: 'c1', kind: 'permission', requestId: 'toolu_1', decision: 'allow' }))
    relay.from(friend, friend.command({ id: 'c2', kind: 'invite', role: 'contributor' }))
    const got = cycle(link, relay, { devices, now: T0 + 1000 })
    expect(got.commands.map(c => c.command.id)).toEqual(['c1'])
  })

  test("another project's sessions neither admit the invite nor send its device anything", () => {
    // Sharing one project must not show the account's other work.
    const me = account()
    const friend = phone(me, "Sam's iPhone")
    const relay = room([friend])
    const elsewhere = createLink({ identity: me, session: 'other-session', origin: ORIGIN, project: '/work/secret-project' })
    const invite = inviteFor('viewer')
    relay.from(friend, friend.hello({ now: T0, secret: invite.secret }))
    const got = cycle(elsewhere, relay, { devices: [], invites: [invite], now: T0 })
    expect(got.paired).toEqual([])
    expect(got.frames).toEqual([])
    // Paired by its own project, it is still nothing to this one.
    const device: Device = { ...friend.stored(), role: 'viewer', project: PROJECT, until: T0 + DAY_MS }
    relay.from(friend, friend.hello({ now: T0 + 1000 }))
    expect(cycle(elsewhere, relay, { devices: [device], now: T0 + 1000 }).frames).toEqual([])
  })

  test('access ends when it expires: the session goes quiet for that device, sending it nothing more', () => {
    // With no one else to talk to, the session does not even call the relay; the app knows the date and says so.
    const { friend, relay, link, first } = shared('viewer')
    const device = first.paired.find(d => d.id === friend.id)!
    const after = (device.until ?? 0) + 1000
    relay.from(friend, friend.hello({ now: after }))
    expect(link.isQuiet({ devices: [device], now: after })).toBe(true)
    expect(cycle(link, relay, { devices: [device], now: after }).frames).toEqual([])
  })
})
