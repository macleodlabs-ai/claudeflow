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
/** The newest rows of a stream go longer, so the phone's full view shows a whole recent reply. */
const RECENT_ROWS = 3
const RECENT_ROW_CHARS = 2_500

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
  /** Permission prompts waiting on an answer, from the phone or the Mac. */
  permissions: PendingPermission[]
  /** The sticky summary: workflows running, agents running, failures shown, and the next loop tick. */
  summary?: Summary
  /** Claude's questions with options (AskUserQuestion) waiting on an answer; absent from older sessions. */
  questions?: PendingQuestion[]
  /**
   * What became of prompts and questions that left the snapshot lately (the newest few, for SETTLED_MS), so a phone
   * that was away can say "Answered on your Mac" or "Moved to your Mac" rather than guess; absent from older sessions.
   */
  settled?: Settled[]
}

export type Summary = { workflows: number; agentsRunning: number; failures: number; nextTickAt?: number }

/**
 * A permission prompt held for an answer: the call's id, the tool and what it would do, and `since`, when it was
 * raised (epoch ms). It has no deadline: it waits until the phone or the Mac answers, or no device has looked for
 * NO_DEVICE_MS. `at` is `since` again, for apps from before `since`.
 */
export type PendingPermission = { id: string; tool: string; summary: string; at: number; since?: number }

/**
 * One of Claude's questions with options, held for an answer like a permission. The option whose label ends in
 * "(Recommended)" is the one taken when nobody answers (NO_DEVICE_MS).
 */
export type PendingQuestion = { id: string; question: string; header: string; options: { label: string; description?: string; isRecommended: boolean }[]; since: number }

/** How a held prompt or question ended. `label`: the option chosen, for a question. */
export type Settled = { id: string; why: AckWhy; label?: string; at: number }

/** A file sent with a prompt: its chunks (`chunk` commands under `blob`) came first. */
export type PhoneFile = { blob: string; name: string; type: string }

/** The most a file may weigh as base64 (about 375 KB of image or file), and the chunk size the phone sends it in: sealed and base64ed again, a chunk stays under the relay's 16 KB per device message. */
export const MAX_FILE_B64 = 500_000
export const CHUNK_B64 = 8_000

/** What the phone can ask a session to do. */
export type PhoneCommand =
  /** A prompt: into `streamId`'s stream, or ('') a new one that routing files. */
  | { id: string; kind: 'answer'; streamId: string; text: string; files?: PhoneFile[] }
  /** One piece of a file to send with a prompt, as base64. */
  | { id: string; kind: 'chunk'; blob: string; part: number; of: number; data: string }
  | { id: string; kind: 'stop' }
  | { id: string; kind: 'permission'; requestId: string; decision: 'allow' | 'deny'; passkey?: PasskeyAssertion }
  /** Stop a Workflow run this session shows. */
  | { id: string; kind: 'stopTask'; taskId: string }
  /** End a stream's loop: its wakeup, cron job or monitor. */
  | { id: string; kind: 'stopLoop'; streamId: string }
  /** Run a stream's loop tick now: its prompt, submitted in its stream. */
  | { id: string; kind: 'runTick'; streamId: string }
  /** An option chosen for a held question (`requestId` its call id). */
  | { id: string; kind: 'choose'; requestId: string; label: string }

/** A WebAuthn assertion as the app sends it (fields b64u): an `allow` carries one, made with Face ID. */
export type PasskeyAssertion = { authenticatorData: string; clientDataJSON: string; signature: string }

/**
 * Why a command was or was not done, or how a held prompt ended. `allowed`, `denied`, `chosen`, `answered on Mac`,
 * `moved to Mac` (nobody answered, so the terminal asks) and `chose recommended` also answer a late tap.
 */
export type AckWhy = 'allowed' | 'denied' | 'chosen' | 'answered on Mac' | 'moved to Mac' | 'chose recommended' | 'passkey not verified' | 'unknown request' | 'file missing'
const ACK_WHY: readonly string[] = ['allowed', 'denied', 'chosen', 'answered on Mac', 'moved to Mac', 'chose recommended', 'passkey not verified', 'unknown request', 'file missing']

/**
 * The session's answer to one command (session → device, sealed like a snapshot): definite feedback for the phone on
 * a laggy network instead of a guess. `id` is the command's id. Older apps open it and ignore it.
 */
export type Ack = { t: 'ack'; id: string; ok: boolean; why?: AckWhy }

/** An ack, if it is one: it comes out of a sealed box, but the phone still draws only what it knows. */
export const ackOf = (v: unknown): Ack | undefined => {
  const x = (v ?? {}) as Record<string, unknown>
  if (x.t !== 'ack' || typeof x.id !== 'string' || x.id.length > 200 || typeof x.ok !== 'boolean') return undefined
  return { t: 'ack', id: x.id, ok: x.ok, ...(typeof x.why === 'string' && ACK_WHY.includes(x.why) ? { why: x.why as AckWhy } : {}) }
}

/** Allows one request may try, each with its own command id and Face ID: a lost or slow one can be tapped again. */
export const MAX_ALLOW_TRIES = 3

/**
 * How long a held prompt waits with no paired device looking before the session gives up on the phone: a permission
 * then goes to the terminal's own prompt (never allowed on its own), a question takes its recommended option.
 */
export const NO_DEVICE_MS = 120_000

/** How long the snapshot keeps saying what became of a prompt, for a phone that was away. */
export const SETTLED_MS = 10 * 60_000

/** The label suffix that marks an option as the one to take when nobody answers. */
export const isRecommended = (label: string): boolean => /\(recommended\)\s*$/i.test(label)

/** One line saying what a tool call would do, for the phone's Allow / Deny card. */
export const permissionSummary = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const text = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : typeof i.url === 'string' ? i.url : JSON.stringify(input ?? {})
  return oneLine(`${tool}: ${text}`, 300)
}

/** A task or stream id as the session makes them: short, no spaces, no markup. */
const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,80}$/.test(v)

/** A file reference, if well formed: a plain name (no path), a MIME type. */
const fileOf = (v: unknown): PhoneFile | undefined => {
  const f = (v ?? {}) as Record<string, unknown>
  const name = typeof f.name === 'string' ? f.name.replace(/[^\w.\- ]/g, '_').slice(0, 80) : ''
  return isId(f.blob) && name && !/^\.+$/.test(name) && typeof f.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? { blob: f.blob, name, type: f.type } : undefined
}

/**
 * An AskUserQuestion call the phone can answer, from its input: one single-choice question with 2-4 options. Anything
 * else (several questions, multi-select, free text, a number) stays with the terminal's own dialog. Labels are kept
 * exactly, since the answer must name one of them.
 */
export function questionOf(input: unknown, id: string, since: number): PendingQuestion | undefined {
  const qs = ((input ?? {}) as { questions?: unknown }).questions
  if (!Array.isArray(qs) || qs.length !== 1) return undefined
  const q = (qs[0] ?? {}) as Record<string, unknown>
  if (typeof q.question !== 'string' || q.multiSelect === true || (q.kind !== undefined && q.kind !== 'choice') || !Array.isArray(q.options)) return undefined
  const options = (q.options as Record<string, unknown>[]).filter(o => typeof o?.label === 'string' && o.label.length > 0 && o.label.length <= 200)
  if (options.length < 2 || options.length > 4 || options.length !== q.options.length) return undefined
  return {
    id,
    question: oneLine(q.question, 400),
    header: typeof q.header === 'string' ? oneLine(q.header, 24) : '',
    options: options.map(o => ({
      label: o.label as string,
      ...(typeof o.description === 'string' && o.description ? { description: oneLine(o.description, 200) } : {}),
      isRecommended: isRecommended(o.label as string),
    })),
    since,
  }
}

/** One command, if it is well formed: the phone is a remote, so nothing else runs. */
export const commandOf = (c: unknown): PhoneCommand | undefined => {
  const k = (c ?? {}) as Record<string, unknown>
  if (typeof k.id !== 'string') return undefined
  if (k.kind === 'answer') {
    const files = k.files === undefined ? [] : Array.isArray(k.files) && k.files.length <= 8 ? k.files.map(fileOf) : [undefined]
    if (files.some(f => !f) || typeof k.streamId !== 'string' || typeof k.text !== 'string' || k.text.length > 4000) return undefined
    if (!k.text.trim() && files.length === 0) return undefined
    return { id: k.id, kind: 'answer', streamId: k.streamId, text: k.text, ...(files.length ? { files: files as PhoneFile[] } : {}) }
  }
  if (k.kind === 'chunk') {
    const ok = isId(k.blob) && Number.isInteger(k.part) && Number.isInteger(k.of) && (k.of as number) >= 1 && (k.of as number) <= Math.ceil(MAX_FILE_B64 / CHUNK_B64)
    if (!ok || (k.part as number) < 0 || (k.part as number) >= (k.of as number)) return undefined
    return typeof k.data === 'string' && k.data.length <= CHUNK_B64 && /^[A-Za-z0-9+/=]*$/.test(k.data)
      ? { id: k.id, kind: 'chunk', blob: k.blob as string, part: k.part as number, of: k.of as number, data: k.data }
      : undefined
  }
  if (k.kind === 'stop') return c as PhoneCommand
  if (k.kind === 'permission') return typeof k.requestId === 'string' && (k.decision === 'allow' || k.decision === 'deny') ? (c as PhoneCommand) : undefined
  // Ids only, each its own field: the session acts only on a task or stream it shows (remote/index.tsx).
  if (k.kind === 'stopTask') return isId(k.taskId) ? { id: k.id, kind: 'stopTask', taskId: k.taskId } : undefined
  if (k.kind === 'stopLoop' || k.kind === 'runTick') return isId(k.streamId) ? { id: k.id, kind: k.kind, streamId: k.streamId } : undefined
  if (k.kind === 'choose') return typeof k.requestId === 'string' && typeof k.label === 'string' && k.label.length > 0 && k.label.length <= 400 ? (c as PhoneCommand) : undefined
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
  questions?: readonly PendingQuestion[]
  settled?: readonly Settled[]
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
        .map((r, i, all) => {
          const max = i >= all.length - RECENT_ROWS ? RECENT_ROW_CHARS : ROW_CHARS
          return { kind: r.kind, text: r.text.length > max ? `${r.text.slice(0, max)}…` : r.text, at: r.at }
        }),
    }
    return [card]
  })
  return { v: 1, session: x.session, at: x.now, streams, status: [...x.status], limits: [...x.limits], updates: x.updates, permissions: [...(x.permissions ?? [])], questions: [...(x.questions ?? [])], settled: [...(x.settled ?? [])], summary: summaryOf(streams, x.agents) }
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
