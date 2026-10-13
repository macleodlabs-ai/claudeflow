import type { AgentRun, Loop, Stream, StreamRow, StreamsCard, StreamsStatusLine, Workflow } from '../types'
import { oneLine } from './classify'
import { foldQuiet, lapsed, loopView } from './streams/loops'
import { runOf, workflowView } from './streams/workflows'

/** A subagent stays on its stream's card this long after it ended. */
export const AGENT_KEPT_MS = 10 * 60_000

export type CardsInput = {
  /** The status card's stream lines, in status order. */
  lines: readonly StreamsStatusLine[]
  streams: readonly Stream[]
  colorOf: (s: Stream) => string
  agents: readonly AgentRun[]
  rows: readonly StreamRow[]
  loops?: Record<string, Loop>
  workflows?: Record<string, Workflow>
  now: number
}

/** The streams in status order as `$.streams.view()` gives them: each with its loop, run, live agents and rows. */
export function cardsOf(x: CardsInput): StreamsCard[] {
  return x.lines.flatMap((l): StreamsCard[] => {
    const s = x.streams.find(st => st.id === l.id)
    if (!s) return []
    const loop = x.loops?.[s.id]
    const run = x.workflows ? runOf(x.workflows, s.id) : undefined
    return [
      {
        id: s.id,
        name: s.name,
        color: x.colorOf(s),
        kind: l.kind ?? 'idle',
        state: l.state,
        detail: oneLine(l.detail, 240),
        ...(l.since !== undefined ? { since: l.since } : {}),
        ...(l.nextAt !== undefined ? { nextAt: l.nextAt } : {}),
        ...(loop && !lapsed(loop, x.now) ? { loop: loopView(loop) } : {}),
        ...(run ? { run: workflowView(run) } : {}),
        agents: x.agents.filter(a => a.streamId === s.id && (a.status === 'running' || x.now - (a.endedAt ?? a.lastAt) < AGENT_KEPT_MS)).sort((a, b) => b.lastAt - a.lastAt),
        // Quiet ticks folded, so a loop that found nothing for an hour leaves room for what did happen.
        rows: foldQuiet(x.rows.filter(r => r.streamId === s.id)),
      },
    ]
  })
}
