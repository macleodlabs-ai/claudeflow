import { describe, expect, test } from 'bun:test'
import { CHUNK_B64, commandOf } from '../../plugins/streams/hooks/remote/snapshot'
import { initial, keyOf, reduce, streamKey, type Snapshot } from '../src/state'
import { dock, targetOf } from '../src/views/compose'
import { b64Of, chunksOf, sendFiles } from '../src/upload'

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

  test('the thin lines under a focused composer show each limit used', () => {
    const s = reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap([], [{ label: 'Session', percent: 64 } as never]), now: 0 })
    expect(dock(s, A, s.sessions[A]!.snapshot, NONE, [])).toContain('width:64%')
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
