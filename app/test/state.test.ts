import { describe, expect, test } from 'bun:test'
import { currentOf, FORGET_MS, initial, isStopConfirmed, keyOf, reduce, STALE_MS, streamKey, tabsOf, type Snapshot } from '../src/state'
import { replyBox } from '../src/views/streams'

const snap = (id: string, account = 'macleod', streams: Snapshot['streams'] = []): Snapshot => ({
  v: 1,
  session: { id, account, project: 'claudeflow', busy: false },
  at: 0,
  streams,
  status: [],
  limits: [],
  updates: [],
  permissions: [],
})

describe('sessions across rooms', () => {
  test('the same session id in two rooms is two tabs: accounts never mix', () => {
    let s = initial()
    s = reduce(s, { type: 'snapshot', room: 'roomA', snapshot: snap('s1', 'a'), now: 0 })
    s = reduce(s, { type: 'snapshot', room: 'roomB', snapshot: snap('s1', 'b'), now: 0 })
    expect(tabsOf(s, 0).map(t => t.snapshot.session.account)).toEqual(['a', 'b'])
  })

  test('a quiet session is marked stale, then forgotten, so ended sessions do not pile up', () => {
    let s = reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap('old'), now: 0 })
    expect(tabsOf(s, STALE_MS - 1)[0]!.isStale).toBe(false)
    expect(tabsOf(s, STALE_MS + 1)[0]!.isStale).toBe(true)
    s = reduce(s, { type: 'snapshot', room: 'r', snapshot: snap('new'), now: FORGET_MS + 1 })
    expect(tabsOf(s, FORGET_MS + 1).map(t => t.snapshot.session.id)).toEqual(['new'])
  })

  test('the chosen tab falls back to the first when it is gone', () => {
    let s = reduce(initial({ chosen: 'gone' }), { type: 'snapshot', room: 'r', snapshot: snap('s1'), now: 0 })
    expect(currentOf(s, 0)?.key).toBe(keyOf('r', 's1'))
    s = reduce(s, { type: 'snapshot', room: 'r', snapshot: snap('s2'), now: 0 })
    s = reduce(s, { type: 'choose', key: keyOf('r', 's2') })
    expect(currentOf(s, 0)?.key).toBe(keyOf('r', 's2'))
  })
})

describe('reply drafts', () => {
  const key = streamKey(keyOf('r', 's1'), 'st1')

  test('a draft survives the redraw a new snapshot causes', () => {
    let s = reduce(initial(), { type: 'draft', key, text: 'half a <thought>' })
    s = reduce(s, { type: 'snapshot', room: 'r', snapshot: snap('s1'), now: 0 })
    // Drawn again from the state, escaped: typed text is never markup.
    expect(replyBox(s, key)).toContain('half a &lt;thought&gt;</textarea>')
  })

  test('sending clears only that stream\'s draft and shows it was sent', () => {
    const other = streamKey(keyOf('r', 's1'), 'st2')
    let s = reduce(initial(), { type: 'draft', key, text: 'go' })
    s = reduce(s, { type: 'draft', key: other, text: 'keep me' })
    s = reduce(s, { type: 'sent', key, now: 5 })
    expect(s.drafts).toEqual({ [other]: 'keep me' })
    expect(s.sentAt[key]).toBe(5)
  })
})

test('Stop takes two taps within 4 s, so a stray touch does not stop a turn', () => {
  let s = initial()
  expect(isStopConfirmed(s, 10_000)).toBe(false)
  s = reduce(s, { type: 'stop-armed', now: 10_000 })
  expect(isStopConfirmed(s, 12_000)).toBe(true)
  expect(isStopConfirmed(s, 15_000)).toBe(false)
})
