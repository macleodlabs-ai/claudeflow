import { describe, expect, test } from 'claude-code/testing'
import { randomId } from '../hooks/remote/seal'
import { DAY_MS, INVITE_MS, SHARE_DAYS, createLink, type Device, type Invite } from '../hooks/remote/link'
import type { Ack, Snapshot } from '../hooks/remote/snapshot'
import { ORIGIN, SESSION, T0, account, cycle, phone, room } from './room'

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
  test('an invite pairs one device for this project, as a watcher by default, for SHARE_DAYS, and is used up', () => {
    const { friend, invite, first } = shared('viewer')
    const joined = first.paired.find(d => d.id === friend.id) as Device
    expect(joined).toMatchObject({ role: 'viewer', project: PROJECT, until: T0 + SHARE_DAYS * DAY_MS })
    expect(first.used).toEqual([invite.secret])
    expect(friend.isUnlocked()).toBe(true)
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
