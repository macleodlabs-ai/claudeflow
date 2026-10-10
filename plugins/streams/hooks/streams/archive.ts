import type { Stream } from '../../types'
import type { Loops } from './loops'
import type { StreamsNow } from './model'

// Auto-archive, pure (the `autoArchiveHours` setting): a stream whose work is finished and that nobody has touched for
// that long leaves the bar and the list on its own, as if its ✕ had been pressed; it stays under "archived", restorable.
// Only finished work goes: a stream still running, waiting on the person, looping or failed is exactly what the person
// must still see.

/** How often the session looks for streams to archive. */
export const ARCHIVE_LOOK_MS = 60_000
export const HOUR_MS = 3_600_000

/** The setting as a number of hours; anything not a positive number is off (0). */
export const archiveHoursOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : v === undefined ? 24 : 0)

/**
 * The streams to archive now: not archived, quiet for `hours`, and finished as every screen shows them (`now.lines`,
 * which already take the completion check's 'done' verdicts: a WAITING the check found finished is DONE there), so
 * never running, stalled, waiting, looping or in error. A loop armed on it keeps it, even one between ticks. One the
 * person restored stays until it has been active since.
 */
export function archivableOf(x: { now: StreamsNow; streams: readonly Stream[]; loops: Loops; hours: number; at: number }): string[] {
  if (!(x.hours > 0)) return []
  const kind = new Map(x.now.lines.map(l => [l.id, l.kind ?? 'idle']))
  return x.streams
    .filter(s => {
      if (s.archived || x.loops[s.id]) return false
      if (s.restoredAt !== undefined && s.restoredAt >= s.lastAt) return false
      const k = kind.get(s.id)
      return (k === 'done' || k === 'idle') && x.at - s.lastAt >= x.hours * HOUR_MS
    })
    .map(s => s.id)
}
