import type { AgentRun, Health, Stream, StreamRow } from '../../types'
import { healthOf, nextPastel, pastelOf, slug, type Pulse } from '../classify'
import { sortStatus, statusOf, ticketLines, type StatusLine } from '../status'

// The streams as data: what the hooks change and what the views read, with no engine in sight.

export type Loops = Record<string, { kind: 'wakeup' | 'cron'; nextAt: number; label: string }>
export type LoopArgs = { delaySeconds?: number; stop?: boolean; cron?: string; reason?: string }

/** A wakeup that fired this long ago without re-arming ended by not scheduling another tick. */
export const LAPSE_MS = 10 * 60_000
export const lapsed = (l: { kind: string; nextAt: number }, now: number) => l.kind === 'wakeup' && now > l.nextAt + LAPSE_MS

export const colorOf = (s: Stream): string => s.color ?? pastelOf(s.id)

/** The list with a stream of this name, made with the next free pastel when there was none. */
export const withStream = (list: Stream[], name: string, summary: string, now: number): Stream[] => {
  const id = slug(name)
  if (list.some(s => s.id === id)) return list
  const color = nextPastel(list.filter(s => !s.archived).map(s => s.color))
  return [...list, { id, name, summary, createdAt: now, lastAt: now, rows: 0, agents: 0, loops: 0, color }]
}

/** Marks a stream active now, with whatever else changed about it. */
export const touched =
  (id: string, now: number, patch: (s: Stream) => Partial<Stream> = () => ({})) =>
  (list: Stream[]): Stream[] =>
    list.map(s => (s.id === id ? { ...s, lastAt: now, ...patch(s) } : s))

/** The transcript id a row was filed under: its message's uuid. */
export const uuidOf = (row: StreamRow): string => (row.id.startsWith('h:') ? row.id.split(':')[1] : row.id.split(':')[0]) ?? row.id

/** What a view needs to say how each stream is doing. */
export type Facts = {
  busy: boolean
  current: string
  agents: Record<string, AgentRun>
  inflight: Record<string, number>
  outcome: Record<string, NonNullable<Pulse['outcome']>>
  rows: readonly StreamRow[]
  loops: Loops
  now: number
}

/**
 * Each stream's health as of now, for drawing: from the same live facts the agent rows show, so a header
 * never says idle beside a running agent. The heartbeat's stored verdict only drives its notices.
 */
export function healthsOf(f: Facts, streams: readonly Stream[]): Record<string, Health> {
  const running = Object.values(f.agents).filter(a => a.status === 'running')
  return Object.fromEntries(
    streams.map(s => [
      s.id,
      healthOf({
        now: f.now,
        lastAt: Math.max(s.lastAt, ...running.filter(a => a.streamId === s.id).map(a => a.lastAt)),
        isTurnOn: f.busy && s.id === f.current,
        liveAgents: running.filter(a => a.streamId === s.id).length,
        inflight: f.inflight[s.id] ?? 0,
        outcome: f.outcome[s.id],
      }),
    ]),
  )
}

/** Every stream's status row, in the order that needs the person first. */
export function statusLinesOf(f: Facts, streams: readonly Stream[], health: Record<string, Health>): StatusLine[] {
  const lines = streams
    .filter(s => !s.archived)
    .map(s => {
      const loop = f.loops[s.id]
      return statusOf({
        stream: s,
        health: health[s.id] ?? 'idle',
        ...(loop && !lapsed(loop, f.now) ? { loop } : {}),
        running: Object.values(f.agents)
          .filter(a => a.streamId === s.id && a.status === 'running')
          .sort((a, b) => b.lastAt - a.lastAt),
        lastSaid: f.rows.findLast(r => r.streamId === s.id && (r.kind === 'prompt' || r.kind === 'reply')),
      })
    })
  return sortStatus(lines, Object.fromEntries(streams.map(s => [s.id, s.lastAt])))
}

/** Every ticket named in a prompt or an agent's task, with its state and latest news. */
export const ticketsOf = (f: Facts, streamLines: readonly StatusLine[]): StatusLine[] =>
  ticketLines({
    rows: f.rows,
    agents: Object.values(f.agents),
    streamKind: Object.fromEntries(streamLines.map(l => [l.id, l.kind ?? 'idle'])),
    now: f.now,
  })
