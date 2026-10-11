import type { ChatStyle, Folded, Stream, StreamRow, StreamRowKind } from '../types'

// What the modules share without the engine. The engine reads a state reference (an atom) only from the file
// that uses it, and follows `$` only into functions of the same file: so each module declares the atoms it
// reads (their keys and types are in types/index.d.ts) and keeps the small engine helpers it needs. What is
// here is plain data and plain values.

/** The navigator pane's id. */
export const PANE = 'streams'
export const MAX_ROWS = 4000
/**
 * The most row text the session keeps, in characters of JSON. The engine refuses a state value over 4,194,304
 * characters, and then no row is filed again; long replies reach that well before MAX_ROWS.
 */
export const ROWS_BUDGET = 3_000_000

/** The newest rows that fit MAX_ROWS and ROWS_BUDGET, oldest first: the oldest go first when either is reached. */
export function keepRows<T>(rows: readonly T[]): T[] {
  let size = 2
  let from = rows.length
  while (from > 0 && rows.length - from < MAX_ROWS) {
    const next = JSON.stringify(rows[from - 1]).length + 1
    if (size + next > ROWS_BUDGET) break
    size += next
    from--
  }
  return rows.slice(from)
}
export const SAVED_ROWS = 400
/**
 * One $.store holds every project's history and the phone's pairing (identity, devices). The engine refuses any
 * write once the store passes 4 MiB, and then a new pairing is never saved: so a project keeps at most this much
 * history, each row's text cut to SAVED_ROW_CHARS, and the projects together at most STORE_HISTORY_BUDGET.
 */
export const SAVED_BUDGET = 150_000
export const SAVED_ROW_CHARS = 4_000
export const STORE_HISTORY_BUDGET = 2_000_000

/** What a project keeps between sessions: its newest rows, cut to fit SAVED_ROWS and SAVED_BUDGET. */
export function savedOf(streams: Stream[], rows: readonly StreamRow[], loopStream: Record<string, string>): Saved {
  const kept: StreamRow[] = []
  let size = JSON.stringify({ streams, loopStream }).length
  for (let i = rows.length - 1; i >= 0 && kept.length < SAVED_ROWS; i--) {
    const r = rows[i]!
    const row = r.text.length > SAVED_ROW_CHARS ? { ...r, text: `${r.text.slice(0, SAVED_ROW_CHARS)}…` } : r
    size += JSON.stringify(row).length + 1
    if (size > SAVED_BUDGET) break
    kept.push(row)
  }
  return { streams, rows: kept.reverse(), loopStream }
}

/**
 * Which other projects' history to drop so all of it fits STORE_HISTORY_BUDGET: scratch folders first, then the
 * largest. `sizes` is each `streams:v1:` key with its size in characters; `own` (this session's) is never dropped.
 */
export function historyToDrop(sizes: readonly { key: string; size: number }[], own: string): string[] {
  const isScratch = (k: string) => /^streams:v1:\/(private\/)?tmp\//.test(k)
  const order = sizes.filter(s => s.key !== own).sort((a, b) => Number(isScratch(b.key)) - Number(isScratch(a.key)) || b.size - a.size)
  let total = sizes.reduce((n, s) => n + s.size, 0)
  const drop: string[] = []
  for (const s of order) {
    if (!isScratch(s.key) && total <= STORE_HISTORY_BUDGET) break
    drop.push(s.key)
    total -= s.size
  }
  return drop
}
/** 2: rows keyed by rowKey (a uuid by its first four groups). Bump when the keys change. */
export const KEY_VERSION = 2

/** Where the docked pane's fold and width are kept. */
export const PANE_KEY = 'streams:pane'
export type PaneSaved = { collapsed: boolean; columns: number }

/** Where a project's streams are kept between sessions, and what is kept. */
export const storeKey = (cwd: string) => `streams:v1:${cwd}`
export type Saved = { streams: Stream[]; rows: StreamRow[]; loopStream: Record<string, string> }

/**
 * Slow work (model calls, the history import) cannot run in the hook that asks for it: the engine cuts a
 * dispatch's calls once its hook returns. So hooks queue it here and the worker's timer drains it.
 */
export type Job =
  | { kind: 'route'; uuid: string; rowId: string; text: string; turnSid: string; folded: readonly Folded[] }
  | { kind: 'import'; path: string; isCurrent: boolean }
export const jobs: Job[] = []

/** What this load knows beside the state. Lost on reload, and that is fine: each only bridges a moment. */
export const mem = {
  /** The stream a subagent being spawned works for, until its first row names its id. */
  pendingSpawn: '',
  /** What the next main-loop user row is: a prompt, a loop's tick or a task notice. */
  pendingKind: 'prompt' as StreamRowKind,
  /** The main turn running now, for a remote stop. */
  runningTurn: '',
  /** A loop tick a phone asked to run now (remote `runTick`): routing files that prompt as the loop's tick in its stream. */
  runNow: { streamId: '', text: '' },
  /** One history import at a time; a reload starts a fresh one, which is safe. */
  importing: false,
  /** The last failure of background work, for the diagnostics file. */
  lastError: '',
  /** The pane's last draw, for the diagnostics file: when, how long, what it drew, or what it threw. */
  lastPane: {} as Record<string, unknown>,
  /** The docked pane's width as last drawn: what it reopens at after being folded to the side tab. */
  dockColumns: 0,
  /** The `diagnostics` setting: off, an installed copy does not write into its own folder. */
  isDiagnosing: false,
  /** The `chatStyle` setting: how a stream's own view draws its rows until the pane's toggle says otherwise. */
  defaultStyle: 'full' as ChatStyle,
}

// Diagnostics while the matching is being proven: transcript rows drawn with no stream, written by the heartbeat.
export const unmatched = new Map<string, { component: string; requestId: string; head: string }>()

export function noteMatched(component: string, requestId: string) {
  unmatched.delete(`${component}:${requestId}`)
}

export function noteUnmatched(component: string, requestId: string, text: string) {
  if (unmatched.size >= 60) return
  unmatched.set(`${component}:${requestId}`, { component, requestId, head: text.slice(0, 80) })
}
