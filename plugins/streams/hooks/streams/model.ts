import type { AgentRun, Health, Stream, StreamRow, Verdict } from '../../types'
import { healthOf, nextPastel, pastelOf, slug, type Pulse } from '../classify'
import { limitsOf, sortStatus, statusOf, ticketLines, type LimitView, type StatusLine } from '../status'
import { checkedDone } from './completion'
import { lapsed, type Loops } from './loops'
import type { Workflows } from './workflows'

// The streams as data: what the hooks change and what the views read, with no engine in sight.

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
  /** Workflow runs: their running agents keep their stream running, as a subagent's do. */
  workflows: Workflows
  /**
   * The completion check's verdicts (completion.ts): one saying 'done' for a stream's last row turns its stalled into
   * done and its WAITING into DONE, "checked ✓", on every screen.
   */
  verdicts: Record<string, Verdict>
  now: number
}

/**
 * Each stream's health as of now: from the same live facts the agent rows show, so a header never says idle beside a
 * running agent, and the heartbeat's notices never contradict what is drawn.
 */
function healthsOf(f: Facts, streams: readonly Stream[]): Record<string, Health> {
  const running = [
    ...Object.values(f.agents).filter(a => a.status === 'running'),
    ...Object.values(f.workflows).flatMap(r => Object.values(r.agents).flatMap(a => (a.status === 'running' ? [{ streamId: r.streamId, lastAt: a.lastAt }] : []))),
  ]
  return Object.fromEntries(
    streams.map(s => [
      s.id,
      checkedHealth(f, s.id, healthOf({
        now: f.now,
        lastAt: Math.max(s.lastAt, ...running.filter(a => a.streamId === s.id).map(a => a.lastAt)),
        isTurnOn: f.busy && s.id === f.current,
        liveAgents: running.filter(a => a.streamId === s.id).length,
        inflight: f.inflight[s.id] ?? 0,
        outcome: f.outcome[s.id],
      })),
    ]),
  )
}

/** Stalled, unless the completion check found the stream's work finished since its last row. */
const checkedHealth = (f: Facts, id: string, h: Health): Health => (h === 'stalled' && checkedDone(f.verdicts, f.rows, id) !== undefined ? 'done' : h)

/** Every stream's status row, in the order that needs the person first. */
function statusLinesOf(f: Facts, streams: readonly Stream[], health: Record<string, Health>): StatusLine[] {
  const lastPromptAt = Math.max(0, ...f.rows.filter(r => r.kind === 'prompt').map(r => r.at))
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
        lastPromptAt,
        checked: checkedDone(f.verdicts, f.rows, s.id),
      })
    })
  return sortStatus(lines, Object.fromEntries(streams.map(s => [s.id, s.lastAt])))
}

/** How the streams are doing now: each one's health, its status row, and a row per ticket being worked on. */
export type StreamsNow = { health: Record<string, Health>; lines: StatusLine[]; tickets: StatusLine[] }

/**
 * The one reading of the facts that every view, the heartbeat, routing and the phone share. Lines and tickets are
 * worked out when first asked for: the pane and the heartbeat need only the health.
 */
export function streamsNow(f: Facts, streams: readonly Stream[]): StreamsNow {
  const health = healthsOf(f, streams)
  let lines: StatusLine[] | undefined
  let tickets: StatusLine[] | undefined
  return {
    health,
    get lines() {
      return (lines ??= statusLinesOf(f, streams, health))
    },
    get tickets() {
      return (tickets ??= ticketLines({
        rows: f.rows,
        agents: Object.values(f.agents),
        streamKind: Object.fromEntries(this.lines.map(l => [l.id, l.kind ?? 'idle'])),
      }))
    },
  }
}

/** The status card, as the terminal and the phone both show it: git, tickets, the streams, and the plan limits. */
export type CardRows = { git: StatusLine[]; tickets: StatusLine[]; lines: StatusLine[]; limits: LimitView[] }

export const cardOf = (n: StreamsNow, x: { git: readonly StatusLine[]; rateLimits?: Parameters<typeof limitsOf>[0] }): CardRows => ({
  git: [...x.git],
  tickets: n.tickets,
  lines: n.lines,
  limits: limitsOf(x.rateLimits),
})
