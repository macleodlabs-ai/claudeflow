import type { Loop, StreamRow } from '../../types'
import { clockOf, oneLine } from '../classify'

// Loops as data: what each loop tool call, notification and passing minute does to the loops armed, what a quiet
// tick folds into, and the lines a screen draws for a loop. No engine in sight: the hooks run these.

export type Loops = Record<string, Loop>

/**
 * What a phone is told of a loop: its clocks as times, so an unchanged loop is not news while time passes.
 * `canStop: false` for a cron or monitor whose id the session never learned: the phone then offers no Stop loop.
 */
export type LoopView = Pick<Loop, 'kind' | 'nextAt' | 'every' | 'reason' | 'noopStreak' | 'lastChange'> & { canStop?: false }

/** A wakeup that fired this long ago without re-arming ended by not scheduling another tick. */
export const LAPSE_MS = 10 * 60_000
/** The runtime clamps a wakeup's delay to this range (ScheduleWakeup `delaySeconds`). */
const WAKE_MIN_S = 60
const WAKE_MAX_S = 3600
/** A Monitor's deadline when none is given, and the most it may be. */
const MONITOR_DEFAULT_MS = 300_000
const MONITOR_MAX_MS = 1_800_000

/** Whether a loop has ended without saying so: a wakeup that did not re-arm, a monitor or one-shot cron long past. */
export const lapsed = (l: Loop, now: number): boolean => {
  if (l.kind === 'wakeup') return now > (l.nextAt ?? 0) + LAPSE_MS
  if (l.kind === 'monitor') return l.until !== undefined && now > l.until + LAPSE_MS
  return l.recurring === false && l.nextAt !== undefined && now > l.nextAt + LAPSE_MS
}

// ── cron ─────────────────────────────────────────────────────────────────────────────────────────

const FIELDS: readonly [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week, 0 and 7 both Sunday
]

/** One field's matching values (`*`, `n`, `a-b`, `*\/n`, `a-b/n`, lists of those); undefined when malformed. */
function fieldOf(text: string, [lo, hi]: [number, number]): Set<number> | undefined {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return undefined
    const step = m[4] ? Number(m[4]) : 1
    const from = m[1] === '*' ? lo : Number(m[2])
    const to = m[1] === '*' ? hi : m[3] !== undefined ? Number(m[3]) : m[4] ? hi : from
    if (step < 1 || from < lo || to > hi || from > to) return undefined
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

/**
 * The next time a 5-field cron expression matches after `after`, in local time (as CronCreate reads it), to the
 * minute; undefined when the expression is malformed or matches nothing within five years. When both day fields are
 * restricted a day matching either one fires, as cron has it.
 */
export function nextFire(expr: string, after: number): number | undefined {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  const sets = parts.map((p, i) => fieldOf(p, FIELDS[i] as [number, number]))
  if (sets.some(s => !s)) return undefined
  const [mins, hours, doms, months, dows] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (dows.has(7)) dows.add(0)
  const domAny = parts[2] === '*'
  const dowAny = parts[4] === '*'
  const dayOk = (d: Date) => {
    const dom = doms.has(d.getDate())
    const dow = dows.has(d.getDay())
    return domAny || dowAny ? dom && dow : dom || dow
  }
  const d = new Date(after)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  const end = after + 5 * 366 * 86_400_000
  while (d.getTime() < end) {
    if (!months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
    } else if (!dayOk(d)) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
    } else if (!hours.has(d.getHours())) d.setHours(d.getHours() + 1, 0, 0, 0)
    else if (!mins.has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1, 0, 0)
    else return d.getTime()
  }
  return undefined
}

// ── what changes the loops ───────────────────────────────────────────────────────────────────────

/** A finished tool call, as `tool.call` saw it: the arguments, and what `next(e)` answered (absent on a deny). */
export type LoopCall = {
  tool: string
  input: Record<string, unknown>
  result?: unknown
  isError?: boolean
  now: number
  /** The stream's latest reply, for a tick that changed something but gave no reason. */
  lastReply?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const without = (m: Loops, drop: (l: Loop, sid: string) => boolean): Loops => {
  const kept = Object.entries(m).filter(([sid, l]) => !drop(l, sid))
  return kept.length === Object.keys(m).length ? m : Object.fromEntries(kept)
}

/** The loops after a tool call in stream `sid`: armed, re-armed, ended, or as they were. */
export function afterCall(m: Loops, sid: string, c: LoopCall): Loops {
  const r = (c.result && typeof c.result === 'object' ? c.result : {}) as Record<string, unknown>
  const answered = c.result !== undefined && !c.isError
  if (c.tool === 'ScheduleWakeup') {
    // A session has one self-paced loop: stopping it ends it whichever stream it was filed under, and re-arming it
    // from another stream moves it there.
    const others = without(m, l => l.kind === 'wakeup')
    if (c.input.stop === true || r.stopped === true) return others
    if (!answered) return m
    const was = Object.values(m).find(l => l.kind === 'wakeup')
    // The runtime's clamped time, not the request: the person plans around when it really fires.
    const asked = Math.min(WAKE_MAX_S, Math.max(WAKE_MIN_S, num(c.input.delaySeconds) ?? WAKE_MIN_S))
    const nextAt = num(r.scheduledFor) ?? c.now + (num(r.clampedDelaySeconds) ?? asked) * 1000
    const reason = str(c.input.reason)
    const isNoop = c.input.noop === true
    const text = reason ?? (c.lastReply ? oneLine(c.lastReply.split('\n')[0] ?? '', 120) : undefined)
    const lastChange = isNoop ? was?.lastChange : text ? { at: c.now, text: oneLine(text, 120) } : was?.lastChange
    const loop: Loop = { kind: 'wakeup', nextAt, noopStreak: isNoop ? (was?.noopStreak ?? 0) + 1 : 0 }
    if (reason) loop.reason = oneLine(reason, 160)
    if (lastChange) loop.lastChange = lastChange
    const prompt = str(c.input.prompt)
    if (prompt) loop.prompt = prompt
    return { ...others, [sid]: loop }
  }
  if (c.tool === 'CronCreate') {
    if (!answered) return m
    const cron = str(c.input.cron) ?? ''
    const recurring = typeof r.recurring === 'boolean' ? r.recurring : c.input.recurring !== false
    const loop: Loop = { kind: 'cron', cron, recurring, every: str(r.humanSchedule) ?? cron, noopStreak: 0 }
    const nextAt = nextFire(cron, c.now)
    if (nextAt !== undefined) loop.nextAt = nextAt
    const id = str(r.id)
    if (id) loop.id = id
    const prompt = str(c.input.prompt)
    if (prompt) {
      loop.reason = oneLine(prompt.split('\n')[0] ?? '', 160)
      loop.prompt = prompt
    }
    return { ...m, [sid]: loop }
  }
  if (c.tool === 'CronDelete') {
    const id = str(c.input.id)
    // A cron armed before its id was known is ended by any delete from its own stream.
    return without(m, (l, at) => l.kind === 'cron' && (l.id ? l.id === id : at === sid))
  }
  if (c.tool === 'Monitor') {
    const id = str(r.taskId)
    if (!answered || !id) return m
    const timeoutMs = num(r.timeoutMs) ?? Math.min(MONITOR_MAX_MS, num(c.input.timeout_ms) ?? MONITOR_DEFAULT_MS)
    const loop: Loop = { kind: 'monitor', id, noopStreak: 0 }
    if (r.persistent !== true && timeoutMs > 0) loop.until = c.now + timeoutMs
    const what = str(c.input.description)
    if (what) loop.reason = oneLine(what, 160)
    return { ...m, [sid]: loop }
  }
  if (c.tool === 'TaskStop') {
    const id = str(c.input.task_id) ?? str(c.input.shell_id) ?? str(r.task_id)
    return id ? without(m, l => l.kind === 'monitor' && l.id === id) : m
  }
  return m
}

/**
 * The loops after a background task's notification. A monitor's events come as notifications naming its task id
 * with no `<status>`: each is its latest change. Its end comes as one naming the id with a `<status>` (completed,
 * stopped, failed, killed), which ends it. Ids are matched whole, inside their tags, so no event is taken for
 * another task's.
 */
export function afterNotification(m: Loops, text: string, now: number): Loops {
  const ids = new Set([...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(x => x[1]))
  if (!Object.values(m).some(l => l.kind === 'monitor' && l.id && ids.has(l.id))) return m
  const mine = (l: Loop) => l.kind === 'monitor' && !!l.id && ids.has(l.id)
  if (/<status>[^<]+<\/status>/.test(text)) return without(m, mine)
  const summary = /<summary>([\s\S]*?)(?:<\/summary>|$)/.exec(text)?.[1] ?? ''
  const said = oneLine(summary.replace(/^Monitor event:\s*/, '').replace(/^["“]|["”]$/g, ''), 120)
  if (!said) return m
  return Object.fromEntries(Object.entries(m).map(([sid, l]) => [sid, mine(l) ? { ...l, lastChange: { at: now, text: said } } : l]))
}

/** The loops as of `now`: lapsed ones dropped, a cron that fired moved on to its next match. Unchanged, the same map. */
export function loopsAt(m: Loops, now: number): Loops {
  let changed = false
  const out: Loops = {}
  for (const [sid, l] of Object.entries(m)) {
    if (lapsed(l, now)) {
      changed = true
      continue
    }
    if (l.kind === 'cron' && l.recurring !== false && l.cron && l.nextAt !== undefined && l.nextAt <= now) {
      const nextAt = nextFire(l.cron, now)
      out[sid] = nextAt === undefined ? (({ nextAt: _, ...rest }) => rest)(l) : { ...l, nextAt }
      changed = true
      continue
    }
    out[sid] = l
  }
  return changed ? out : m
}

/** What the phone is told of a loop: no ids, no expressions, only what it draws. */
export const loopView = (l: Loop): LoopView => ({
  kind: l.kind,
  ...(l.nextAt !== undefined ? { nextAt: l.nextAt } : {}),
  ...(l.every ? { every: l.every } : {}),
  ...(l.reason ? { reason: l.reason } : {}),
  noopStreak: l.noopStreak,
  ...(l.lastChange ? { lastChange: l.lastChange } : {}),
  ...(l.kind !== 'wakeup' && !l.id ? { canStop: false as const } : {}),
})

// ── quiet ticks ──────────────────────────────────────────────────────────────────────────────────

/** The rows once the tick running in `sid` said it changed nothing: its loop row is marked quiet. */
export function markQuiet(rows: StreamRow[], sid: string): StreamRow[] {
  const at = rows.findLastIndex(r => r.streamId === sid && !r.agentId && (r.kind === 'loop' || r.kind === 'prompt'))
  const row = rows[at]
  if (!row || row.kind !== 'loop' || row.quiet) return rows
  return rows.map((r, i) => (i === at ? { ...r, quiet: true } : r))
}

const opensTurn = (r: StreamRow) => !r.agentId && (r.kind === 'loop' || r.kind === 'prompt')
const ticks = (n: number) => `··· ${n} quiet tick${n === 1 ? '' : 's'}`

/**
 * One stream's rows with each run of quiet ticks (a quiet loop row and everything up to the next prompt or tick)
 * folded into one line: a loop that checks every minute and finds nothing would otherwise bury what happened.
 */
export function foldQuiet(rows: readonly StreamRow[]): StreamRow[] {
  const out: StreamRow[] = []
  for (let i = 0; i < rows.length; ) {
    const first = rows[i] as StreamRow
    if (!(first.kind === 'loop' && first.quiet)) {
      out.push(first)
      i++
      continue
    }
    let n = 0
    let last = first
    while (i < rows.length && (rows[i] as StreamRow).kind === 'loop' && (rows[i] as StreamRow).quiet) {
      n++
      last = rows[i] as StreamRow
      i++
      while (i < rows.length && !opensTurn(rows[i] as StreamRow)) last = rows[i++] as StreamRow
    }
    out.push({ id: `quiet:${first.id}`, streamId: first.streamId, kind: 'loop', text: ticks(n), at: last.at })
  }
  return out
}

// ── how a loop reads ─────────────────────────────────────────────────────────────────────────────

/** A time of day as the person's clock shows it, 24-hour: `12:04`. */
export const timeOfDay = (at: number): string => {
  const d = new Date(at)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * A loop's lines, fitted to `width` columns: what it waits for and when it fires next, then, after quiet ticks, how
 * many and what the last real change was. The terminal and the phone both draw these, counting from the loop's times.
 *
 *   ↻ LOOP next 4:10 (CI still running)
 *     ··· 3 quiet ticks · last change 12:04 "PR merged"
 */
export function loopLines(l: LoopView, now: number, width: number): string[] {
  const head =
    l.kind === 'monitor'
      ? '↻ LOOP watching'
      : `↻ LOOP ${l.nextAt !== undefined ? `next ${clockOf(Math.max(0, l.nextAt - now))}` : 'armed'}${l.kind === 'cron' && l.every ? ` · ${l.every}` : ''}`
  const room = width - head.length - 3
  const lines = [l.reason && room >= 6 ? `${head} (${oneLine(l.reason, room)})` : oneLine(head, width)]
  if (l.noopStreak > 0) {
    // Indented under the head; the quoted change takes what room is left, and is left out when too little is.
    const body = `${ticks(l.noopStreak)}${l.lastChange ? ` · last change ${timeOfDay(l.lastChange.at)}` : ''}`
    const left = width - 2 - body.length - 3
    const said = l.lastChange && left >= 6 ? ` "${oneLine(l.lastChange.text, left)}"` : ''
    lines.push(`  ${body.length + 2 > width ? oneLine(body, width - 2) : `${body}${said}`}`)
  }
  return lines
}
