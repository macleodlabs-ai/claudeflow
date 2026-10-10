import { describe, expect, test } from 'bun:test'
import { currentOf, initial, reduce, type Snapshot } from '../src/state'
import { menuView, roleNote } from '../src/views/menu'
import { page } from '../src/views/page'
import { gates } from '../src/views/gates'

const DAY = 86_400_000
const snap = (extra: Partial<Snapshot> = {}): Snapshot => ({
  v: 1,
  session: { id: 'a', account: 'macleod', project: 'claudeflow', busy: false },
  at: 0,
  streams: [{ id: 'st', name: 'docs', color: '#7cc8ff', kind: 'waiting', state: 'WAITING', detail: '', question: 'Ship it?', agents: [], rows: [] }] as never,
  status: [],
  limits: [],
  updates: [],
  permissions: [],
  ...extra,
})
const tabOf = (x: Snapshot) => {
  const s = reduce(initial(), { type: 'snapshot', room: 'r', snapshot: x, now: 0 })
  return { s, t: currentOf(s, 0)! }
}

describe('the ☰ menu and sharing', () => {
  test("the owner's device can share the shown project and sees who it is shared with", () => {
    const { s, t } = tabOf(snap({ people: [{ id: 'dev1', label: "Sam's iPhone", role: 'viewer', until: 6 * DAY, pairedAt: 0 }] }))
    const html = menuView(s, t, true, 0, undefined)
    expect(html).toContain('data-invite="viewer"')
    expect(html).toContain("Sam&#39;s iPhone")
    expect(html).toContain('data-people-role="dev1"')
    expect(html).toContain('6d left')
  })

  test('a device the project was shared with cannot share it on: no Share section in its menu', () => {
    const { s, t } = tabOf(snap({ you: { role: 'contributor', until: 7 * DAY } }))
    expect(menuView(s, t, true, 0, undefined)).not.toContain('data-invite')
  })

  test('a shared device is told what it may do here and for how long', () => {
    const { t } = tabOf(snap({ you: { role: 'viewer', until: 3 * DAY } }))
    expect(roleNote(t, 0)).toContain('Watching · claudeflow · 3d left')
  })

  test('once shared access has ended, the project is not shown at all', () => {
    const { s } = tabOf(snap({ you: { role: 'viewer', until: 1000 } }))
    const html = page(s, 2000, true)
    expect(html).toContain('Access ended')
    expect(html).not.toContain('Ship it?')
  })

  test('a made invite shows its link with Share and Copy', () => {
    const { s, t } = tabOf(snap())
    const html = menuView(s, t, true, 0, { role: 'viewer', isBusy: false, link: 'https://relay.example/#r=x&k=y&s=z' })
    expect(html).toContain('value="https://relay.example/#r=x&amp;k=y&amp;s=z"')
    expect(html).toContain('data-share-link')
  })
})

describe('accounts on this device', () => {
  const view = (room: string, gate: 'open' | 'locked' | 'not-paired') =>
    ({ room, gate, label: room, why: '', stage: { at: 'idle' }, isSlow: false, isCeremony: false, isOnline: true, canRepair: false }) as const
  test('with an account open, a leftover that cannot pair is not shown over the streams', () => {
    // A failed or old pairing attempt must not sit on top of a working app.
    const html = gates([view('live', 'open'), view('old', 'not-paired')])
    expect(html).not.toContain('Not paired')
  })
  test('a locked account among several can be forgotten on this device', () => {
    expect(gates([view('live', 'open'), view('old', 'locked')])).toContain('data-forget-room="old"')
  })
})
