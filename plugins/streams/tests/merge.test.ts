import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Stream, StreamRow } from '../types'
import { storeKey, type Saved } from '../hooks/state'

// A long session sorts work into many small streams that are really one goal. Merging folds one stream into another:
// its rows, its transcript lines and its agents go to the stream kept, and the merged one leaves the list. A merge
// done by mistake is undone exactly: the stream comes back with the same rows, and nothing of the kept one moves.

const ENGINE = { timeoutMs: 20_000 }
const T0 = Date.UTC(2026, 9, 14, 12)
const stream = (id: string, lastAt: number): Stream => ({ id, name: id, summary: `${id} work`, createdAt: 0, lastAt, rows: 2, agents: 0, loops: 0 }) as Stream
const row = (id: string, streamId: string, kind: StreamRow['kind'], text: string, at: number): StreamRow => ({ id, streamId, kind, text, at }) as StreamRow
const STREAMS = [stream('launch', T0 - 1000), stream('badges', T0 - 500)]
const ROWS = [
  row('p1', 'launch', 'prompt', 'ship the relay', T0 - 3000),
  row('r1', 'launch', 'reply', 'Shipped.', T0 - 2000),
  row('p2', 'badges', 'prompt', 'fix the README badges', T0 - 900),
  row('r2', 'badges', 'reply', 'Fixed.', T0 - 800),
]

/** The store, readable by the test: what the session saved. */
function store(on: On, entries: Record<string, unknown>): Map<string, unknown> {
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

function session(on: On) {
  const kept = store(on, { [storeKey('/project')]: { streams: STREAMS, rows: ROWS, loopStream: {} } })
  mock.clock(on, { now: T0 })
  on('session.cwd', async () => ({ value: '/project' }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('fs.read', async () => ({ value: '{}' }) as never)
  return kept
}
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'stream', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never) as Promise<{ text: string }>
const saved = (kept: Map<string, unknown>) => kept.get(storeKey('/project')) as Saved

describe('merging streams', () => {
  test('/stream merge moves every row into the stream kept and drops the merged one; /stream undo puts it back', ENGINE, async ($, on) => {
    const kept = session(on)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    expect((await run($, 'merge badges launch')).text).toBe('Merged badges into launch (2 rows). /stream undo puts it back.')
    let s = saved(kept)
    expect(s.streams.map(x => x.id)).toEqual(['launch'])
    expect(s.rows.filter(r => r.streamId === 'launch').map(r => r.id).sort()).toEqual(['p1', 'p2', 'r1', 'r2'])
    expect((await run($, 'undo')).text).toBe('Undid the merge: badges is back with its 2 rows.')
    s = saved(kept)
    expect(s.streams.map(x => x.id).sort()).toEqual(['badges', 'launch'])
    expect(s.rows.filter(r => r.streamId === 'badges').map(r => r.id).sort()).toEqual(['p2', 'r2'])
    expect(s.rows.filter(r => r.streamId === 'launch').map(r => r.id).sort()).toEqual(['p1', 'r1'])
    expect((await run($, 'undo')).text).toBe('Nothing to undo.')
  })

  test('a merge names streams that exist and are two', ENGINE, async ($, on) => {
    session(on)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    expect((await run($, 'merge nope launch')).text).toBe('No stream named nope.')
    expect((await run($, 'merge launch launch')).text).toBe('A stream cannot merge into itself.')
    expect((await run($, 'merge launch')).text).toBe('Usage: /stream merge <stream> <into stream>')
  })
})
