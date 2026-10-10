import { describe, expect, test } from 'claude-code/testing'

import { MAX_ROWS, ROWS_BUDGET, keepRows } from '../hooks/state'

// The engine refuses a state value over 4,194,304 characters. Past it, no row is ever filed again: the panes and
// the phone freeze on old work while the session goes on. So rows are kept by size as well as by count.
describe('keeping rows', () => {
  const row = (i: number, size = 10) => ({ id: `r${i}`, streamId: 's', kind: 'reply', text: 'x'.repeat(size), at: i })

  test('long replies never push the rows past what the engine stores; the newest are the ones kept', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i, 10_000))
    const kept = keepRows(rows)
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(ROWS_BUDGET)
    expect(ROWS_BUDGET).toBeLessThan(4_194_304)
    expect(kept.at(-1)).toBe(rows.at(-1))
    expect(kept[0]?.at).toBe(rows.length - kept.length)
  })

  test('short rows are still kept to MAX_ROWS, oldest dropped first', () => {
    const rows = Array.from({ length: MAX_ROWS + 50 }, (_, i) => row(i))
    const kept = keepRows(rows)
    expect(kept).toHaveLength(MAX_ROWS)
    expect(kept[0]?.at).toBe(50)
  })
})
