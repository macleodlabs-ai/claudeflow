import { describe, expect, test } from 'claude-code/testing'
import { historyToDrop, SAVED_BUDGET, SAVED_ROW_CHARS, savedOf, STORE_HISTORY_BUDGET, storeKey } from '../hooks/state'
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
