import { describe, expect, test } from 'bun:test'
import { gateOf, linkFragment, parseLink, refused, withLink } from '../src/links'
import { gates, type GateView } from '../src/views/gates'
import { forGuest, OLD_TEXT, SLOW_TEXT } from '../src/views/util'
import { menuView } from '../src/views/menu'
import { currentOf, initial, reduce, type Snapshot } from '../src/state'

// Someone a project is shared with has never set up Claude Code: nothing they see may send them to "your Mac",
// "pairing" or /streams. They know the project, who shared it, and Face ID.

const room = 'AAAAAAAAAAAAAAAAAAAAAA'
const pk = 'B'.repeat(43)
const secret = 'C'.repeat(43)
const guest = { project: 'claudeflow', owner: 'Steve' }
/** Words that mean nothing to a guest. */
const JARGON = /\bMac\b|pair|\/streams|passkey|Claude Code/i

describe('an invite link', () => {
  test('carries the project and who shared it, round-tripping through the fragment', () => {
    const link = parseLink(linkFragment({ room, pk, secret, guest }))
    expect(link).toEqual({ room, pk, secret, guest })
  })

  test('names are shown as text only: cut short, with no control characters', () => {
    const link = parseLink(`#r=${room}&k=${pk}&s=${secret}&p=${encodeURIComponent('a\u0000b'.repeat(40))}&o=Sam`)
    expect(link?.guest?.project).toBe('ab'.repeat(30))
    expect(link?.guest?.owner).toBe('Sam')
  })

  test("a refusal while joining keeps a guest's invite, so Try again works once the project is online", () => {
    // Another of the owner's sessions can turn the hello away before the project's own session welcomes it.
    const rooms = withLink({}, { room, pk, secret, guest })
    expect(rooms[room]!.guest).toEqual(guest)
    expect(gateOf(refused(rooms[room]!), false)).toBe('pair')
  })
})

describe('what a guest sees before the project opens', () => {
  const view = (gate: GateView['gate'], extra: Partial<GateView> = {}): GateView => ({
    room, gate, label: 'macleod', why: '', stage: { at: 'idle' }, isSlow: false, isCeremony: false, isOnline: true, canRepair: false, guest, ...extra,
  })
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ')
  const WHYS = ['not paired', 'passkey not verified', 'access expired', 'access removed', 'pairing expired', 'bad pairing proof', 'bad registration',
    'The connection dropped before your Mac answered. Try again once it is back.', 'Reconnecting… tap again in a moment.']

  test('joining asks for their name and Face ID, naming the project and who shared it', () => {
    const html = gates([view('pair')])
    expect(text(html)).toContain('Join claudeflow')
    expect(text(html)).toContain('Steve')
    expect(html).toContain('data-guest-name')
    expect(text(html)).not.toMatch(JARGON)
  })

  test('every gate, refusal and wait reads without jargon and offers no code to scan', () => {
    for (const gate of ['pair', 'locked', 'not-paired'] as const)
      for (const why of ['', ...WHYS])
        for (const isSlow of [false, true]) {
          const html = gates([view(gate, { why, isSlow, stage: isSlow ? { at: 'checking', kind: 'unlock', since: 0 } : { at: 'idle' } })])
          expect(text(html)).not.toMatch(JARGON)
          expect(html).not.toContain('data-scan')
        }
  })

  test('a refusal says what happened and who to ask', () => {
    expect(text(gates([view('locked', { why: 'access removed' })]))).toContain('Steve removed your access to claudeflow')
    expect(text(gates([view('locked', { why: 'access expired' })]))).toContain('Your access to claudeflow has ended')
    expect(text(gates([view('not-paired', { why: 'pairing expired' })]))).toContain('Ask Steve for a new link')
  })

  test('a project not open right now is waited for, not blamed on a computer', () => {
    const html = gates([view('locked', { isSlow: true, stage: { at: 'checking', kind: 'unlock', since: 0 } })])
    expect(text(html)).toContain("claudeflow isn't online right now")
    expect(html).toContain('data-gate="retry"')
  })
})

describe('what a guest sees inside the project', () => {
  test("every line that speaks of the owner's Mac speaks of the owner instead", () => {
    const lines = [
      'Sent: waiting for your Mac…',
      'Answered on your Mac',
      'Moved to your Mac',
      'Hide this here (it stays open on your Mac)',
      SLOW_TEXT,
      OLD_TEXT,
      "Your Mac couldn't do that. Try again.",
      'Face ID was not accepted. Answer on your Mac.',
      'Nothing flowing yet. Start Claude Code on your Mac.',
    ]
    for (const line of lines) expect(forGuest(line, 'Steve')).not.toMatch(JARGON)
    expect(forGuest('Sent: waiting for your Mac…', 'Steve')).toBe('Sent: waiting for Steve…')
  })
})

describe("a guest's menu", () => {
  test('offers Lock now and nothing about pairing devices', () => {
    const snap = {
      v: 1, session: { id: 'a', account: 'Steve', project: 'docs', busy: false }, at: 0, streams: [], status: [], limits: [], updates: [], permissions: [],
      you: { role: 'contributor', until: 86_400_000 },
    } as unknown as Snapshot
    const s = reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap, now: 0 })
    const html = menuView(s, currentOf(s, 0), true, 0, undefined)
    expect(html).toContain('data-lock')
    expect(html).not.toContain('data-scan')
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(JARGON)
  })
})
