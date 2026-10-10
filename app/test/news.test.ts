import { describe, expect, test } from 'bun:test'
import { initial, keyOf, newsOf, reduce, streamKey, type Snapshot, type State } from '../src/state'
import { switcher } from '../src/views/page'
import { card } from '../src/views/streams'

type Stream = Snapshot['streams'][number]
const stream = (id: string, kind = 'running', rows: { at: number }[] = [], extra: Partial<Stream> = {}): Stream =>
  ({ id, name: id, color: '#7cc8ff', kind, state: kind.toUpperCase(), detail: '', agents: [], rows: rows.map(r => ({ kind: 'reply', text: 'x', ...r })), ...extra }) as Stream
const snap = (id: string, project: string, streams: Stream[]): Snapshot => ({
  v: 1,
  session: { id, account: 'macleod', project, busy: false },
  at: 0,
  streams,
  status: [],
  limits: [],
  updates: [],
  permissions: [],
})
const post = (s: State, id: string, project: string, streams: Stream[]) => reduce(s, { type: 'snapshot', room: 'r', snapshot: snap(id, project, streams), now: 0 })
const A = keyOf('r', 'a')
const B = keyOf('r', 'b')

/** Two projects seen once each, the app on project a. */
const twoProjects = () => {
  let s = post(initial(), 'a', 'claudeflow', [stream('s1')])
  s = post(s, 'b', 'tensorlot', [stream('t1', 'running', [{ at: 1 }])])
  return reduce(s, { type: 'choose', key: A })
}

describe('news across projects', () => {
  test('what a project did before this device first saw it is not news', () => {
    expect(newsOf(twoProjects(), B)).toBe(0)
  })

  test('a stream that changes in another project is news, and the header says how many projects have some', () => {
    let s = twoProjects()
    s = post(s, 'b', 'tensorlot', [stream('t1', 'waiting', [{ at: 2 }], { question: 'Deploy?' })])
    expect(newsOf(s, B)).toBe(1)
    expect(switcher(s, 0)).toContain('class="switch-news"')
  })

  test('a new stream in another project is news', () => {
    let s = twoProjects()
    s = post(s, 'b', 'tensorlot', [stream('t1', 'running', [{ at: 1 }]), stream('t2')])
    expect(newsOf(s, B)).toBe(1)
  })

  test('muted, the header says nothing of other projects, but what changed is still marked when you go there', () => {
    let s = reduce(twoProjects(), { type: 'mute' })
    s = post(s, 'b', 'tensorlot', [stream('t1', 'error', [{ at: 2 }])])
    expect(switcher(s, 0)).not.toContain('switch-news')
    s = reduce(s, { type: 'choose', key: B })
    expect(card(s, B, s.sessions[B]!.snapshot.streams[0]!, 0)).toContain('new-dot')
  })

  test('opening a changed stream clears its dot; leaving a project counts as having viewed it', () => {
    let s = twoProjects()
    s = post(s, 'b', 'tensorlot', [stream('t1', 'done', [{ at: 2 }]), stream('t2')])
    s = reduce(s, { type: 'choose', key: B })
    s = reduce(s, { type: 'toggle', key: streamKey(B, 't1') })
    expect(newsOf(s, B)).toBe(1)
    s = reduce(s, { type: 'choose', key: A })
    expect(newsOf(s, B)).toBe(0)
  })

  test('a stream that only ages is no news: clocks are not changes', () => {
    let s = twoProjects()
    s = post(s, 'b', 'tensorlot', [stream('t1', 'running', [{ at: 1 }], { since: 99 })])
    expect(newsOf(s, B)).toBe(0)
  })
})
