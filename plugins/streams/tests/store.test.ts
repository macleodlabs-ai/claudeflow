import { describe, expect, test } from 'claude-code/testing'
import { historyToDrop, KEEP_TEXT_ROWS, SAVED_BUDGET, SAVED_ROW_CHARS, savedOf, STORE_HISTORY_BUDGET, storeKey } from '../hooks/state'
import { GONE_TEXT, readTranscript, rowOf, withTexts } from '../hooks/history'
import type { StreamRow } from '../types'

// One $.store holds every project's history and the phone's pairing. Past 4 MiB the engine refuses every write,
// and a phone that just paired is never saved: history must stay small enough that pairing always fits.
const row = (i: number, text: string): StreamRow => ({ id: `r${i}`, streamId: 's', kind: 'reply', text, at: i })

describe('history kept in the shared store', () => {
  test('a project keeps its newest rows within its budget, however long the replies', () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(i, 'x'.repeat(50_000)))
    const saved = savedOf([], rows, {})
    expect(JSON.stringify(saved).length).toBeLessThanOrEqual(SAVED_BUDGET)
    expect(saved.rows.at(-1)!.id).toBe('r399')
    expect(saved.rows.every(r => r.text.length <= SAVED_ROW_CHARS + 1)).toBe(true)
  })

  test('scratch folders go first, then the largest other projects, never this session’s own', () => {
    const big = STORE_HISTORY_BUDGET / 2
    const sizes = [
      { key: storeKey('/work/mine'), size: big },
      { key: storeKey('/work/a'), size: big },
      { key: storeKey('/work/b'), size: big / 2 },
      { key: storeKey('/private/tmp/x/scratchpad'), size: 10 },
    ]
    expect(historyToDrop(sizes, storeKey('/work/mine'))).toEqual([storeKey('/private/tmp/x/scratchpad'), storeKey('/work/a')])
  })

  test('within budget, nothing but scratch folders is dropped', () => {
    expect(historyToDrop([{ key: storeKey('/work/a'), size: 100 }], storeKey('/work/b'))).toEqual([])
  })
})

describe('history saved as keys into the transcripts', () => {
  const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  const line = (i: number) => JSON.stringify({ type: 'assistant', uuid: uuid(i), message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${'words '.repeat(200)}` }] } })
  const jsonl = Array.from({ length: 100 }, (_, i) => line(i)).join('\n')
  const items = readTranscript(jsonl)
  const live = items.map((it, i) => rowOf(it, 's', 1000 + i))
  const sources = { since: 1000, files: ['/t/a.jsonl'] }

  test('older rows are saved as their key alone, the newest keep their words', () => {
    const saved = savedOf([], live, {}, sources)
    expect(saved.rows).toHaveLength(100)
    expect(saved.rows.slice(-KEEP_TEXT_ROWS).every(r => r.text)).toBe(true)
    expect(saved.rows.slice(0, -KEEP_TEXT_ROWS).every(r => r.text === '')).toBe(true)
    // The whole point: the store holds keys, not the words, so it stays small however long the replies.
    expect(JSON.stringify(saved).length).toBeLessThan(JSON.stringify(savedOf([], live, {})).length / 2)
  })

  test('read back from the transcript, every row has exactly the words it was filed with', () => {
    expect(withTexts(savedOf([], live, {}, sources).rows, items)).toEqual(live)
  })

  test('a row whose transcript is gone says so instead of showing blank', () => {
    const back = withTexts(savedOf([], live, {}, sources).rows, [])
    expect(back[0]!.text).toBe(GONE_TEXT)
  })

  test('rows from before the transcripts were listed keep their words: nothing could read them back', () => {
    const saved = savedOf([], live, {}, { since: 5000, files: ['/t/a.jsonl'] })
    expect(saved.rows.every(r => r.text)).toBe(true)
  })
})
