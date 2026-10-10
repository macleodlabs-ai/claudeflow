import type { Health, Stream, StreamRow, Verdict } from '../../types'
import { oneLine } from '../classify'

// The completion check, pure: which streams to ask the fast model about, what to ask, and what its answer means.
// A stream often shows WAITING (its last reply ended on a question) or stalled (a turn went quiet) when the work is
// in fact finished. The model reads each one's last rows; a 'done' verdict clears WAITING and stalled everywhere the
// streams are drawn (model.ts `streamsNow`). Each verdict holds for the row it read, so a stream is asked again only
// after something new happens there, and time alone never changes what is shown.

/** A stream that has shown WAITING or stalled this long is checked even when nothing opened the status card. */
export const CHECK_STALE_MS = 5 * 60_000
/** How many of a stream's last rows the model reads. */
export const CHECK_ROWS = 6
/** How long a failed call waits before the check is tried again, so a down API is not asked every tick. */
export const CHECK_RETRY_MS = 60_000

export const COMPLETION_SYSTEM = `You read the last few messages of workstreams in a developer's session with a coding agent.
Each stream is marked as waiting on the developer or stalled. Say for each whether its work is actually finished.
Reply with JSON only: an array of {"id":"<stream id>","state":"done"|"waiting"|"running","reason":"<at most 8 words>"}.
"done": the task is complete; any closing question is a courtesy ("anything else?", "want me to also…?").
"waiting": the agent cannot go on without the developer's answer or decision.
"running": work is still under way.
When unsure, say "waiting".`

/** The last row filed in a stream, if any. */
export const lastRowOf = (rows: readonly StreamRow[], id: string): StreamRow | undefined => rows.findLast(r => r.streamId === id)

/** A verdict that still holds: given for the stream's last row as it is now. */
export const verdictOf = (verdicts: Readonly<Record<string, Verdict>>, rows: readonly StreamRow[], id: string): Verdict | undefined => {
  const v = verdicts[id]
  return v && v.rowId === lastRowOf(rows, id)?.id ? v : undefined
}

/** The reason to show for a stream the model found finished; undefined unless a holding verdict says 'done'. */
export const checkedDone = (verdicts: Readonly<Record<string, Verdict>> | undefined, rows: readonly StreamRow[], id: string): string | undefined => {
  const v = verdicts && verdictOf(verdicts, rows, id)
  return v?.state === 'done' ? v.reason : undefined
}

export type Suspect = { id: string; name: string; rowId: string; rows: StreamRow[] }

/**
 * The streams to ask about now: each shown WAITING or stalled (before any verdict is applied), with rows, and no
 * verdict for its last row yet. `isStaleOnly` keeps only those whose last row is CHECK_STALE_MS old (the periodic
 * look); an opened status card or a quiet moment asks about all of them.
 */
export function suspectsOf(x: {
  streams: readonly Stream[]
  rows: readonly StreamRow[]
  /** Stream ids whose status line says WAITING. */
  waiting: ReadonlySet<string>
  health: Readonly<Record<string, Health>>
  verdicts: Readonly<Record<string, Verdict>>
  now: number
  isStaleOnly: boolean
}): Suspect[] {
  return x.streams.flatMap(s => {
    if (s.archived || !(x.waiting.has(s.id) || x.health[s.id] === 'stalled')) return []
    const rows = x.rows.filter(r => r.streamId === s.id).slice(-CHECK_ROWS)
    const last = rows.at(-1)
    if (!last || verdictOf(x.verdicts, x.rows, s.id)) return []
    if (x.isStaleOnly && x.now - last.at < CHECK_STALE_MS) return []
    return [{ id: s.id, name: s.name, rowId: last.id, rows }]
  })
}

/** One prompt for every suspect: the model is asked once, however many streams look stuck. */
export const checkPrompt = (suspects: readonly Suspect[]): string =>
  suspects
    .map(s => `Stream id: ${s.id} (${s.name})\n${s.rows.map(r => `[${r.kind}] ${oneLine(r.text, 600)}`).join('\n')}`)
    .join('\n\n')

const STATES = new Set(['done', 'waiting', 'running'])

/** The verdicts in the model's reply, only for the streams asked about; anything unreadable is left out. */
export function parseCheck(reply: string, suspects: readonly Suspect[], now: number): Record<string, Verdict> {
  const m = /\[[\s\S]*\]/.exec(reply)
  if (!m) return {}
  let list: unknown
  try {
    list = JSON.parse(m[0])
  } catch {
    return {}
  }
  if (!Array.isArray(list)) return {}
  const out: Record<string, Verdict> = {}
  for (const v of list as Record<string, unknown>[]) {
    const s = suspects.find(x => x.id === v?.id)
    if (!s || typeof v.state !== 'string' || !STATES.has(v.state)) continue
    out[s.id] = { rowId: s.rowId, state: v.state as Verdict['state'], reason: typeof v.reason === 'string' ? oneLine(v.reason, 80) : '', at: now }
  }
  return out
}
