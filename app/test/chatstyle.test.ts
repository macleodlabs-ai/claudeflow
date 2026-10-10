import { describe, expect, test } from 'bun:test'
import { initial, keyOf, reduce, streamKey, type Snapshot } from '../src/state'
import { md } from '../src/views/markdown'
import { card } from '../src/views/streams'

type Stream = Snapshot['streams'][number]
const REPLY = 'Done.\n\n## Changes\n- **one** thing\n\n```ts\nconst a = 1 < 2\n```'
const x = { id: 'st', name: 'st', color: '#7cc8ff', kind: 'done', state: 'DONE', detail: '', agents: [], rows: [{ kind: 'reply', text: REPLY, at: 1 }] } as Stream
const snap: Snapshot = { v: 1, session: { id: 'a', account: 'm', project: 'p', busy: false }, at: 0, streams: [x], status: [], limits: [], updates: [], permissions: [] }
const A = keyOf('r', 'a')
const opened = () => reduce(reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap, now: 0 }), { type: 'toggle', key: streamKey(A, 'st') })

describe('compact or full, on the phone', () => {
  test('full draws a reply as markdown: headings, bold, bullets and code blocks', () => {
    const html = md(REPLY)
    expect(html).toContain('<b class="h">Changes</b>')
    expect(html).toContain('<b>one</b>')
    expect(html).toContain('<span class="li">•</span>')
    expect(html).toContain('<pre class="code"><code>const a = 1 &lt; 2</code></pre>')
  })

  test('markdown never becomes live markup: html in a reply stays text, links show only their words', () => {
    // A reply can quote anything, including pages and scripts; the phone must only ever show it.
    expect(md('<img src=x onerror=alert(1)> see [docs](javascript:alert(1))')).toBe('&lt;img src=x onerror=alert(1)&gt; see docs')
  })

  test('the ≡/▤ switch on an open stream flips every stream between full and compact, full first', () => {
    let s = opened()
    expect(card(s, A, x, 0)).toContain('data-chat-style')
    expect(card(s, A, x, 0)).toContain('class="card st-done open full')
    s = reduce(s, { type: 'chat-style' })
    const compact = card(s, A, x, 0)
    expect(compact).toContain('compact')
    expect(compact).not.toContain('<b class="h">')
  })

  test('a closed stream has no switch: it costs the list no room', () => {
    const s = reduce(initial(), { type: 'snapshot', room: 'r', snapshot: snap, now: 0 })
    expect(card(s, A, x, 0)).not.toContain('data-chat-style')
  })
})
