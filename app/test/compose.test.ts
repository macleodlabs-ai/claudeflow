import { describe, expect, test } from 'bun:test'
import { CHUNK_B64, commandOf } from '../../plugins/streams/hooks/remote/snapshot'
import { initial, keyOf, reduce, streamKey, type Snapshot } from '../src/state'
import { dock, targetOf } from '../src/views/compose'
import { usageBar } from '../src/views/usage'
import { b64Of, chunksOf, sendFiles } from '../src/upload'
import { archivedList, card } from '../src/views/streams'

type Stream = Snapshot['streams'][number]
const stream = (id: string): Stream => ({ id, name: id, color: '#7cc8ff', kind: 'running', state: 'RUNNING', detail: '', agents: [], rows: [] }) as Stream
const snap = (streams: Stream[], limits: Snapshot['limits'] = []): Snapshot =>
  ({ v: 1, session: { id: 'a', account: 'macleod', project: 'claudeflow', busy: false }, at: 0, streams, status: [], limits, updates: [], permissions: [] })
const A = keyOf('r', 'a')
const NONE = { files: [], isListening: false, hasMic: false, why: '' }
const withStreams = (...ids: string[]) => reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap(ids.map(stream)), now: 0 })

describe('the composer in the dock', () => {
  test('it writes to the stream being viewed: the last opened card that still exists', () => {
    // The input is always on screen, so it must be plain where a message goes.
    let s = withStreams('docs', 'relay')
    s = reduce(s, { type: 'toggle', key: streamKey(A, 'docs') })
    s = reduce(s, { type: 'toggle', key: streamKey(A, 'relay') })
    expect(targetOf(s, A, s.sessions[A]!.snapshot.streams)).toBe('relay')
    expect(dock(s, A, s.sessions[A]!.snapshot, NONE, [])).toContain('→ <b>relay</b>')
  })

  test('with no stream open it sends a new prompt, which streams routes as if typed on the Mac', () => {
    const s = withStreams('docs')
    expect(targetOf(s, A, s.sessions[A]!.snapshot.streams)).toBe('')
    const html = dock(s, A, s.sessions[A]!.snapshot, NONE, [])
    expect(html).toContain('→ new prompt')
    expect(html).toContain(`data-send="${streamKey(A, '')}"`)
  })

  test('the composer is the first slide, with plan usage and the runs line a swipe away', () => {
    const s = withStreams('docs')
    const html = dock(s, A, s.sessions[A]!.snapshot, NONE, ['<div class="usage">u</div>', '', '<div class="flowsum">f</div>'])
    expect(html.indexOf('slide compose')).toBeLessThan(html.indexOf('slide info'))
    expect(html.match(/class="slide info"/g)).toHaveLength(2)
  })

  test('plan usage shows as small marks on the target line above the input: percent, colour and reset', () => {
    // A glance while writing, on a line that is there anyway: no extra row, no extra height.
    const s = reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap([], [{ label: 'Session', percent: 64, resetsAt: '18:00' } as never]), now: 0 })
    const html = dock(s, A, s.sessions[A]!.snapshot, NONE, [])
    const to = html.slice(html.indexOf('class="to"'), html.indexOf('compose-row'))
    expect(to).toContain('64%<small>18:00</small>')
    expect(to).toContain('color:var(--running-ink)')
  })

  test('plan usage is always shown in full, with the model the session runs on', () => {
    const x = { ...snap([], [{ label: 'Session', percent: 64, resetsAt: '18:00', until: 3_600_000 } as never]), session: { id: 'a', account: 'm', project: 'p', busy: false, model: 'claude-opus-5-5' } }
    const html = usageBar(x, 0)
    expect(html).toContain('claude-opus-5-5')
    expect(html).toContain('resets in')
    expect(html).not.toContain('aria-expanded')
  })
})

describe('archiving by swipe', () => {
  test('a finished phone card swipes left to archive; an active one, or the wide layout list, does not', () => {
    // Archiving is only for what is over: a running, looping or waiting stream never moves under a thumb.
    const s = withStreams('docs')
    const running = s.sessions[A]!.snapshot.streams[0]!
    const done = { ...running, kind: 'done', state: 'DONE' } as typeof running
    expect(card(s, A, done, 0)).toContain('data-swipe="archive"')
    expect(card(s, A, done, 0, 'list')).not.toContain('data-swipe')
    for (const kind of ['running', 'loop', 'waiting']) expect(card(s, A, { ...running, kind } as typeof running, 0)).not.toContain('data-swipe')
  })

  test('archived streams fold under the list; opened, each swipes right or taps ↺ to restore', () => {
    let s = withStreams('docs')
    const archived = [{ id: 'old', name: 'old chore', color: '#ff94d1' }]
    expect(archivedList(s, A, archived)).toContain('Archived · 1')
    expect(archivedList(s, A, archived)).not.toContain('data-restore')
    s = reduce(s, { type: 'toggle', key: `${A}|#archived` })
    const open = archivedList(s, A, archived)
    expect(open).toContain('data-swipe="restore"')
    expect(open).toContain(`data-restore="${streamKey(A, 'old')}"`)
    expect(archivedList(s, A, [])).toBe('')
  })
})

describe('sending a photo or file', () => {
  test('a file goes as chunks the session takes, each under the relay cap, in order, then the prompt names it', async () => {
    const b64 = b64Of(new Uint8Array(20_000).fill(7))
    const parts = chunksOf(b64)
    expect(parts.join('')).toBe(b64)
    expect(parts.every(p => p.length <= CHUNK_B64)).toBe(true)
    const sent: unknown[] = []
    const r = await sendFiles([{ name: 'shot.jpg', type: 'image/jpeg', b64 }], async c => (sent.push(c), { ok: true }))
    expect(sent.every(c => commandOf(c) !== undefined)).toBe(true)
    expect(r).toEqual({ files: [{ blob: expect.any(String), name: 'shot.jpg', type: 'image/jpeg' }] })
  })

  test('if a chunk cannot go, nothing names the file and the person is told to try again', async () => {
    const r = await sendFiles([{ name: 'a.pdf', type: 'application/pdf', b64: 'QUJD' }], async () => ({ ok: false, why: 'offline', isOffline: true }))
    expect(r).toEqual({ why: expect.stringContaining('Try again') })
  })
})
