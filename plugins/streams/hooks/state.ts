import type { ChatStyle, Folded, Stream, StreamRow, StreamRowKind } from '../types'

// What the modules share without the engine. The engine reads a state reference (an atom) only from the file
// that uses it, and follows `$` only into functions of the same file: so each module declares the atoms it
// reads (their keys and types are in types/index.d.ts) and keeps the small engine helpers it needs. What is
// here is plain data and plain values.

/** The navigator pane's id. */
export const PANE = 'streams'
export const MAX_ROWS = 4000
export const SAVED_ROWS = 400
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
