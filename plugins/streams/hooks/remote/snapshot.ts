import type { AgentRun, Stream, StreamRow } from '../../types'
import { oneLine } from '../classify'
import type { LimitView, StatusKind, StatusLine } from '../status'
import { foldQuiet, lapsed, loopView, type Loops, type LoopView } from '../streams/loops'
import { runOf, workflowView, type Workflows, type WorkflowView } from '../streams/workflows'

/** The longest a session stays quiet, so the devices know it is alive: a snapshot is resent this often unchanged. */
export const HEARTBEAT_MS = 30_000

/** Rows a stream's card carries to the phone, each cut to a readable length. */
export const PHONE_ROWS = 12
const ROW_CHARS = 600

/** A subagent's card. Its start and end, not its running time: a running clock would make every snapshot news. */
export type PhoneAgent = { id: string; description: string; status: AgentRun['status']; tools: number; startedAt: number; endedAt?: number; last: string }
export type PhoneRow = { kind: StreamRow['kind']; text: string; at: number }
export type PhoneStream = {
  id: string
  name: string
  color: string
  kind: StatusKind
  state: string
  /** What it is about, without the clocks below: the phone keeps those running itself (status.ts `lineText`). */
  detail: string
  /** When it was last active, for "· 12s ago"; absent while it runs or waits. */
  since?: number
  /** When a self-paced loop ticks next. */
  nextAt?: number
  /** The question it waits on you for; absent unless it waits. */
  question?: string
  /** Its loop, when one is armed: clocks as times, the quiet streak and the last real change, for `loopLines`. */
  loop?: LoopView
  /** Its Workflow run, running or last: phases with counts, no labels or ids but the task's, to stop it by. */
  workflow?: WorkflowView
  agents: PhoneAgent[]
  rows: PhoneRow[]
}

/** What one session sends each device: everything the phone draws for it, and nothing it would not show. */
export type Snapshot = {
  v: 1
  session: { id: string; account: string; project: string; busy: boolean }
  at: number
  streams: PhoneStream[]
  /** Git and ticket rows, as the status card shows them. */
  status: StatusLine[]
  limits: LimitView[]
  updates: { id: string; from: string; to: string }[]
  /** Permission prompts waiting on the phone's answer. */
  permissions: PendingPermission[]
  /** The sticky summary: workflows running, agents running, failures shown, and the next loop tick. */
  summary?: Summary
}

export type Summary = { workflows: number; agentsRunning: number; failures: number; nextTickAt?: number }

/** A permission prompt held for the phone: the call's id, the tool and what it would do. */
export type PendingPermission = { id: string; tool: string; summary: string; at: number }

/** What the phone can ask a session to do. */
export type PhoneCommand =
  | { id: string; kind: 'answer'; streamId: string; text: string }
  | { id: string; kind: 'stop' }
  | { id: string; kind: 'permission'; requestId: string; decision: 'allow' | 'deny'; passkey?: PasskeyAssertion }
  /** Stop a Workflow run this session shows. */
  | { id: string; kind: 'stopTask'; taskId: string }
  /** End a stream's loop: its wakeup, cron job or monitor. */
  | { id: string; kind: 'stopLoop'; streamId: string }
  /** Run a stream's loop tick now: its prompt, submitted in its stream. */
  | { id: string; kind: 'runTick'; streamId: string }

/** A WebAuthn assertion as the app sends it (fields b64u): an `allow` carries one, made with Face ID. */
export type PasskeyAssertion = { authenticatorData: string; clientDataJSON: string; signature: string }

/** How long a permission prompt waits on the phone before it goes to the Mac as usual. */
export const PHONE_PERMISSION_MS = 60_000

/** One line saying what a tool call would do, for the phone's Allow / Deny card. */
export const permissionSummary = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const text = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : typeof i.url === 'string' ? i.url : JSON.stringify(input ?? {})
  return oneLine(`${tool}: ${text}`, 300)
}

/** A task or stream id as the session makes them: short, no spaces, no markup. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,80}$/.test(v)

/** One command, if it is well formed: the phone is a remote, so nothing else runs. */
export const commandOf = (c: unknown): PhoneCommand | undefined => {
  const k = (c ?? {}) as Record<string, unknown>
  if (typeof k.id !== 'string') return undefined
  if (k.kind === 'answer') return typeof k.streamId === 'string' && typeof k.text === 'string' && k.text.trim().length > 0 && k.text.length <= 4000 ? (c as PhoneCommand) : undefined
  if (k.kind === 'stop') return c as PhoneCommand
  if (k.kind === 'permission') return typeof k.requestId === 'string' && (k.decision === 'allow' || k.decision === 'deny') ? (c as PhoneCommand) : undefined
  // Ids only, each its own field: the session acts only on a task or stream it shows (remote/index.ts).
  if (k.kind === 'stopTask') return isId(k.taskId) ? { id: k.id, kind: 'stopTask', taskId: k.taskId } : undefined
  if (k.kind === 'stopLoop' || k.kind === 'runTick') return isId(k.streamId) ? { id: k.id, kind: k.kind, streamId: k.streamId } : undefined
  return undefined
}

export type SnapshotInput = {
  session: Snapshot['session']
  lines: readonly StatusLine[]
  streams: readonly Stream[]
  colorOf: (s: Stream) => string
  agents: readonly AgentRun[]
  rows: readonly StreamRow[]
  status: readonly StatusLine[]
  limits: readonly LimitView[]
  updates: Snapshot['updates']
  permissions?: readonly PendingPermission[]
  /** Loops armed, per stream. */
  loops?: Loops
  /** Workflow runs this session, by task id. */
  workflows?: Workflows
  now: number
}

/** The account a session runs as: the last folder of its config dir (`~/.claude-clients/macleod` is macleod). */
export const accountOf = (configDir: string): string => configDir.replace(/\/+$/, '').split('/').pop() || 'default'

/** The streams in status order, each with its live agents and latest rows; code bodies stay on the Mac. */
export function snapshotOf(x: SnapshotInput): Snapshot {
  const streams = x.lines.flatMap(l => {
    const s = x.streams.find(st => st.id === l.id)
    if (!s) return []
    const kind = l.kind ?? 'idle'
    const loop = x.loops?.[s.id]
    const run = x.workflows ? runOf(x.workflows, s.id) : undefined
    const card: PhoneStream = {
      id: s.id,
      name: s.name,
      color: x.colorOf(s),
      kind,
      state: l.state,
      detail: oneLine(l.detail, 240),
      ...(l.since !== undefined ? { since: l.since } : {}),
      ...(l.nextAt !== undefined ? { nextAt: l.nextAt } : {}),
      ...(kind === 'waiting' ? { question: l.detail } : {}),
      ...(loop && !lapsed(loop, x.now) ? { loop: loopView(loop) } : {}),
      ...(run ? { workflow: workflowView(run) } : {}),
      agents: x.agents
        .filter(a => a.streamId === s.id && (a.status === 'running' || x.now - (a.endedAt ?? a.lastAt) < 10 * 60_000))
        .sort((a, b) => b.lastAt - a.lastAt)
        .map(a => ({
          id: a.id,
          description: a.description,
          status: a.status,
          tools: a.tools,
          startedAt: a.startedAt,
          ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
          last: oneLine(a.last, 160),
        })),
      // Quiet ticks folded first, so a loop that found nothing for an hour leaves room for what did happen.
      rows: foldQuiet(x.rows.filter(r => r.streamId === s.id))
        .slice(-PHONE_ROWS)
        .map(r => ({ kind: r.kind, text: r.text.length > ROW_CHARS ? `${r.text.slice(0, ROW_CHARS)}…` : r.text, at: r.at })),
    }
    return [card]
  })
  return { v: 1, session: x.session, at: x.now, streams, status: [...x.status], limits: [...x.limits], updates: x.updates, permissions: [...(x.permissions ?? [])], summary: summaryOf(streams, x.agents) }
}

/**
 * The sticky summary, from what the cards show: runs going, agents running (subagents and runs' agents), failures
 * (failed subagents, runs' failed agents, streams in error), and the soonest loop tick. Counts and a time, no clock.
 */
export function summaryOf(streams: readonly PhoneStream[], agents: readonly AgentRun[]): Summary {
  const runs = streams.flatMap(s => (s.workflow ? [s.workflow] : []))
  const ticks = streams.flatMap(s => (s.loop?.nextAt !== undefined ? [s.loop.nextAt] : []))
  return {
    workflows: runs.filter(r => r.status === 'running').length,
    agentsRunning: agents.filter(a => a.status === 'running').length + runs.reduce((n, r) => n + r.agents.run, 0),
    failures: streams.reduce((n, s) => n + s.agents.filter(a => a.status === 'error').length + (s.kind === 'error' ? 1 : 0), 0) + runs.reduce((n, r) => n + r.agents.err, 0),
    ...(ticks.length ? { nextTickAt: Math.min(...ticks) } : {}),
  }
}
