// What the phone shows while a line heals: a swipe that stays put until the Mac answers, an unlock that says where it
// is instead of going quiet, and a word when a restarted session needs one more unlock. Waiting must read as progress,
// and nothing the person did may silently undo itself.
import { describe, expect, test } from 'bun:test'
import type { PhoneCommand } from '../../plugins/streams/hooks/remote/snapshot'
import { keyOf, reduce, initial, settled, SETTLE_MS, streamKey, type Tap } from '../src/state'
import { ELAPSED_AFTER_MS, gates, type GateView } from '../src/views/gates'
import { card } from '../src/views/streams'
import type { Snapshot } from '../src/state'

const T = 1_700_000_000_000
const SK = keyOf('r', 's1')
const tap = (command: PhoneCommand, stage: Tap['stage'], at: number, extra: Partial<Tap> = {}): Tap => ({ command, room: 'r', sessionId: 's1', stage, at, ...extra })
const stream = (id: string, kind = 'done') => ({ id, name: id, color: '#a5d8ff', kind, state: kind.toUpperCase(), detail: '', agents: [], rows: [] }) as Snapshot['streams'][number]
const archiveTap = (id: string, stage: Tap['stage'], at: number, extra: Partial<Tap> = {}) =>
  reduce(initial(), { type: 'tap', key: `${streamKey(SK, id)}|archive`, tap: tap({ id: `a-${id}`, kind: 'archive', streamId: id }, stage, at, extra) })

describe('a swipe that sticks', () => {
  // The card slid out, then the next snapshot (which still listed the stream) drew it back: a bounce that read as
  // "the swipe did not work" though the archive was on its way.
  test('an archive on its way stands at once: the stream is under Archived, not back in the list', () => {
    const s = archiveTap('docs', 'sent', T)
    const shown = settled(s, SK, [stream('docs'), stream('ci')], [], T + 2000)
    expect(shown.streams.map(x => x.id)).toEqual(['ci'])
    expect(shown.archived.map(x => x.id)).toEqual(['docs'])
  })

  test('an archive the Mac acked stands until the snapshot catches up, then the snapshot rules', () => {
    const s = reduce(archiveTap('docs', 'sent', T), { type: 'ack', ack: { t: 'ack', id: 'a-docs', ok: true }, now: T + 1000 })
    expect(settled(s, SK, [stream('docs')], [], T + 5000).streams).toEqual([])
    expect(settled(s, SK, [stream('docs')], [], T + 1000 + SETTLE_MS + 1).streams.map(x => x.id)).toEqual(['docs'])
  })

  test('an archive the Mac refused puts the card back and says why on it', () => {
    const s = reduce(archiveTap('docs', 'sent', T), { type: 'ack', ack: { t: 'ack', id: 'a-docs', ok: false }, now: T + 1000 })
    expect(settled(s, SK, [stream('docs')], [], T + 2000).streams.map(x => x.id)).toEqual(['docs'])
    expect(card(s, SK, stream('docs'), T + 2000)).toContain('Not archived:')
    expect(card(s, SK, stream('docs'), T + 20_000)).not.toContain('Not archived:')
    const gone = reduce(archiveTap('docs', 'sent', T), { type: 'ack', ack: { t: 'ack', id: 'a-docs', ok: false, why: 'no such stream' }, now: T + 1000 })
    expect(card(gone, SK, stream('docs'), T + 2000)).toContain('Not archived: That stream is no longer on your Mac.')
  })

  test('a restore on its way takes the stream off the Archived list at once', () => {
    const s = reduce(initial(), { type: 'tap', key: `${streamKey(SK, 'docs')}|restore`, tap: tap({ id: 'r1', kind: 'restore', streamId: 'docs' }, 'sent', T) })
    expect(settled(s, SK, [], [{ id: 'docs', name: 'docs', color: '#a5d8ff' }], T + 1000).archived).toEqual([])
  })
})

describe('an unlock that says where it is', () => {
  const view = (extra: Partial<GateView> = {}): GateView => ({
    room: 'r', gate: 'locked', label: 'macleod', why: '', stage: { at: 'idle' }, isSlow: false, isCeremony: false, isOnline: true, canRepair: false, ...extra,
  })
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  test('while the hello is on its way the steps show, the one under way marked, with its seconds after a while', () => {
    const early = gates([view({ stage: { at: 'checking', kind: 'unlock', since: T }, elapsed: 2000 })])
    expect(text(early)).toContain('Connecting')
    expect(early).toMatch(/<li class="now" aria-current="step"><i aria-hidden="true"><\/i>Reaching your Mac<\/li>/)
    expect(early).toContain('<li class="done"><i aria-hidden="true"></i>Face ID</li>')
    const later = gates([view({ stage: { at: 'checking', kind: 'unlock', since: T }, elapsed: ELAPSED_AFTER_MS + 7000 })])
    expect(text(later)).toContain('Reaching your Mac 12 s')
  })

  test('Unlock can be tapped while the line is still coming up: Face ID goes ahead and the hello follows', () => {
    // A disabled Unlock while the socket reconnected read as a dead app.
    const html = gates([view({ isOnline: false })])
    expect(html).toMatch(/data-gate="unlock"(?![^>]*disabled)/)
  })

  test('a long wait says it is still trying, with what to check, instead of an error', () => {
    const html = gates([view({ stage: { at: 'checking', kind: 'unlock', since: T }, isSlow: true, elapsed: 50_000 })])
    expect(text(html)).toContain('Still trying.')
    expect(html).toContain('data-gate="retry"')
  })

  test('an open room a restarted session cannot reach asks for one more unlock, in a line, not a gate', () => {
    const html = gates([view({ gate: 'open', unreached: 1 })])
    expect(text(html)).toContain('A Claude session restarted')
    expect(html).toContain('data-gate="unlock"')
    expect(gates([view({ gate: 'open' })])).toBe('')
  })
})
