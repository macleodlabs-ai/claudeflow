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
/** `shell`: a `!` command run from a phone, or what it printed (remote/index.tsx): never sent to a guest. */
export type PhoneRow = { kind: StreamRow['kind']; text: string; at: number; shell?: true }
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
/**
 * The phone-command set this plugin answers. A Claude session keeps the plugin it started with until it reloads, so
 * the phone tells a command to an older session apart from a Mac that is not there.
 */
export const PROTO = 3
/** An invite's secret, as `randomId(32)` makes it: the phone's own (PROTO 3) is taken only in this shape. */
export const isInviteSecret = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{43}$/.test(v)

export type Snapshot = {
  v: 1
  /** `model`: what the session runs on (e.g. claude-opus-5-5); absent from older sessions. */
  /** `proto`: which phone commands this session answers (PROTO); a session started on an older plugin sends none. */
  /** `version`: the Streams mod this computer runs, for the phone to show beside its own build. */
  session: { id: string; account: string; project: string; busy: boolean; model?: string; proto?: number; version?: string }
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
  /** For a device the project was shared with: what it may do, and when its access ends. Absent for the owner's. */
  you?: { role: 'viewer' | 'contributor'; until: number }
  /** For the owner's devices only: who this project is shared with. */
  people?: Person[]
  /** Archived streams, newest last, for the phone's Archived list (swipe right to restore); absent from older sessions. */
  archived?: { id: string; name: string; color: string }[]
  /** The last merge this session, while it can be undone: the phone offers Undo. */
  merged?: { stream: string; into: string }
  /** A merge the session suggests (streams/suggest.ts): the phone offers Merge or Dismiss. */
  suggestion?: { into: string; from: string[] }
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
export type PendingPermission = { id: string; tool: string; summary: string; at: number; since?: number } & Held & {
  /** Why: the tool's own `description` (Bash, Task), else what Claude said in this turn; one line, ≤200. */
  why?: string
  /** The fuller request, plain text, ≤1,500 (permissionDetail). */
  detail?: string
}

/**
 * Where a held prompt or question comes from, for a phone that sees several sessions and streams: `stream` the call
 * is filed in (absent when the session cannot tell), `agent` the subagent's description when a subagent made it
 * (≤80, one line), `project` the session's folder name.
 */
export type Held = { stream?: { id: string; name: string }; agent?: string; project?: string }

/**
 * One of Claude's questions with options, held for an answer like a permission. The option whose label ends in
 * "(Recommended)" is the one taken when nobody answers (NO_DEVICE_MS).
 */
export type PendingQuestion = { id: string; question: string; header: string; options: { label: string; description?: string; isRecommended: boolean }[]; since: number } & Held

/** How a held prompt or question ended. `label`: the option chosen, for a question. */
export type Settled = { id: string; why: AckWhy; label?: string; at: number }

/** Someone this project is shared with, as the owner's People list shows them. */
/** Someone the project is shared with. `browserKey`: joined without a passkey, so they can only watch. */
export type Person = { id: string; label: string; role: 'viewer' | 'contributor'; until: number; pairedAt: number; browserKey?: boolean }

/** A file sent with a prompt: its chunks (`chunk` commands under `blob`) came first. */
export type PhoneFile = { blob: string; name: string; type: string }

/** The most a file may weigh as base64 (about 375 KB of image or file), and the chunk size the phone sends it in: sealed and base64ed again, a chunk stays under the relay's 16 KB per device message. */
export const MAX_FILE_B64 = 500_000
export const CHUNK_B64 = 8_000

/** What the phone can ask a session to do. */
export type PhoneCommand =
  /** A prompt: into `streamId`'s stream, or ('') a new one that routing files. */
  | { id: string; kind: 'answer'; streamId: string; text: string; files?: PhoneFile[] }
  /**
   * The owner shares this project: a one-time invite for `role`, its secret in the ack. From PROTO 3 the phone makes
   * the secret and shows the link at once; the session keeps that one (an older session makes its own).
   */
  | { id: string; kind: 'invite'; role: 'viewer' | 'contributor'; secret?: string }
  /** The owner changes what a shared device may do, gives it SHARE_DAYS more, or removes it. */
  | { id: string; kind: 'setRole'; deviceId: string; role: 'viewer' | 'contributor' }
  | { id: string; kind: 'extend'; deviceId: string }
  | { id: string; kind: 'forgetDevice'; deviceId: string }
  /** Archive a stream (a swipe left on the phone), or restore an archived one (a swipe right). */
  | { id: string; kind: 'archive'; streamId: string }
  | { id: string; kind: 'restore'; streamId: string }
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
  /** Take a ticket off the status card (a swipe on the phone), as ✕ hide does on the computer. */
  | { id: string; kind: 'hideTicket'; ticket: string }
  /** Merge stream `streamId` into `into` (a drag on the phone), as /stream merge; and undo the last merge. */
  | { id: string; kind: 'merge'; streamId: string; into: string }
  | { id: string; kind: 'undoMerge' }
  /** Merge the group the session suggests (`suggestion`), or put the suggestion away for good. */
  | { id: string; kind: 'acceptSuggestion' }
  | { id: string; kind: 'dismissSuggestion' }

/** A WebAuthn assertion as the app sends it (fields b64u): an `allow` carries one, made with Face ID. */
export type PasskeyAssertion = { authenticatorData: string; clientDataJSON: string; signature: string }

/**
 * Why a command was or was not done, or how a held prompt ended. `allowed`, `denied`, `chosen`, `answered on Mac`,
 * `moved to Mac` (nobody answered, so the terminal asks) and `chose recommended` also answer a late tap.
 * `unknown command` and `command failed`: a slash command sent from the phone; the phone names it from what it sent.
 */
export type AckWhy =
  | 'allowed'
  | 'denied'
  | 'chosen'
  | 'answered on Mac'
  | 'moved to Mac'
  | 'chose recommended'
  | 'passkey not verified'
  | 'unknown request'
  | 'file missing'
  | 'read only'
  | 'no such stream'
  | 'unknown command'
  | 'command failed'
const ACK_WHY: readonly string[] = ['allowed', 'denied', 'chosen', 'answered on Mac', 'moved to Mac', 'chose recommended', 'passkey not verified', 'unknown request', 'file missing', 'read only', 'no such stream', 'unknown command', 'command failed']

/**
 * The session's answer to one command (session → device, sealed like a snapshot): definite feedback for the phone on
 * a laggy network instead of a guess. `id` is the command's id. Older apps open it and ignore it.
 */
/** `secret`: an invite's, for the owner's phone to make the link from. */
export type Ack = { t: 'ack'; id: string; ok: boolean; why?: AckWhy; secret?: string }

/** An ack, if it is one: it comes out of a sealed box, but the phone still draws only what it knows. */
export const ackOf = (v: unknown): Ack | undefined => {
  const x = (v ?? {}) as Record<string, unknown>
  if (x.t !== 'ack' || typeof x.id !== 'string' || x.id.length > 200 || typeof x.ok !== 'boolean') return undefined
  const secret = typeof x.secret === 'string' && /^[\w-]{43}$/.test(x.secret) ? { secret: x.secret } : {}
  return { t: 'ack', id: x.id, ok: x.ok, ...(typeof x.why === 'string' && ACK_WHY.includes(x.why) ? { why: x.why as AckWhy } : {}), ...secret }
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

/** The longest detail a held permission carries. */
export const DETAIL_CHARS = 1_500
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g
/** Plain text over lines: no terminal escapes or control characters, at most `n` characters. */
const clip = (text: string, n: number): string => {
  const t = text.replace(ESCAPES, '').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** What a tool call asks to do, in full (as `clip` allows): a command, a file and its change, a URL and its question. */
export const permissionDetail = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  const change = (o: unknown, n: unknown) => `- ${oneLine(s(o), 200)}\n+ ${oneLine(s(n), 200)}`
  const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]).slice(0, 3) : []
  const lines = s(i.content).split('\n')
  const text =
    tool === 'Bash' ? s(i.command)
    : tool === 'Edit' ? `${s(i.file_path)}\n${change(i.old_string, i.new_string)}`
    : tool === 'MultiEdit' ? [s(i.file_path), ...edits.map(e => change(e?.old_string, e?.new_string))].join('\n')
    : tool === 'Write' ? [s(i.file_path), ...lines.slice(0, 10), ...(lines.length > 10 ? ['…'] : [])].join('\n')
    : tool === 'WebFetch' ? [s(i.url), s(i.prompt)].filter(Boolean).join('\n')
    : tool === 'Read' || tool === 'NotebookEdit' ? s(i.file_path) || s(i.notebook_path)
    : tool === 'Glob' || tool === 'Grep' ? `${s(i.pattern)}${s(i.path) ? ` in ${s(i.path)}` : ''}`
    : tool.startsWith('mcp__') ? `${tool} ${JSON.stringify(input ?? {})}`
    : JSON.stringify(input ?? {})
  return clip(text, DETAIL_CHARS)
}

/** What the session knows that places a held call: its streams, rows and agents, and the stream current now. */
export type HeldFacts = {
  /** The subagent that made the call, when one did (PermissionRequest `agent_id`, tool.call `agentId`). */
  agentId?: string
  agentStream: Readonly<Record<string, string>>
  agents: Readonly<Record<string, AgentRun>>
  current: string
  streams: readonly Stream[]
  rows: readonly StreamRow[]
  project?: string
}

/**
 * Where a held call comes from (Held), why (`why`) and what it asks (`detail`). A subagent's call is in the stream
 * that agent was filed in; the main turn's in the current stream; an agent never filed has none (no guess). The
 * reason is the tool's `description`, else the latest reply since the last prompt in that stream (that agent's own).
 */
export function heldOf(tool: string, input: unknown, f: HeldFacts): Held & { why?: string; detail?: string } {
  const sid = f.agentId ? f.agentStream[f.agentId] : f.current
  const st = sid ? f.streams.find(x => x.id === sid) : undefined
  const agent = f.agentId && st ? f.agents[f.agentId]?.description : undefined
  const mine = st ? f.rows.filter(r => r.streamId === st.id && (f.agentId ? r.agentId === f.agentId : !r.agentId)) : []
  const lastPrompt = mine.findLastIndex(r => r.kind === 'prompt')
  const said = mine.slice(lastPrompt + 1).findLast(r => r.kind === 'reply')?.text
  const description = (input as { description?: unknown } | undefined)?.description
  const why = typeof description === 'string' && description.trim() ? description : said
  return {
    ...(st ? { stream: { id: st.id, name: oneLine(st.name, 80) } } : {}),
    ...(agent ? { agent: oneLine(agent, 80) } : {}),
    ...(f.project ? { project: oneLine(f.project, 80) } : {}),
    ...(why && oneLine(why, 200) ? { why: oneLine(why, 200) } : {}),
    detail: permissionDetail(tool, input),
  }
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
  if (k.kind === 'merge') return isId(k.streamId) && isId(k.into) ? { id: k.id, kind: 'merge', streamId: k.streamId, into: k.into } : undefined
  if (k.kind === 'undoMerge' || k.kind === 'acceptSuggestion' || k.kind === 'dismissSuggestion') return { id: k.id, kind: k.kind }
  if (k.kind === 'hideTicket') return typeof k.ticket === 'string' && /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/.test(k.ticket) ? { id: k.id, kind: 'hideTicket', ticket: k.ticket } : undefined
  if (k.kind === 'stopLoop' || k.kind === 'runTick' || k.kind === 'archive' || k.kind === 'restore') return isId(k.streamId) ? { id: k.id, kind: k.kind, streamId: k.streamId } : undefined
  const isRole = (r: unknown): r is 'viewer' | 'contributor' => r === 'viewer' || r === 'contributor'
  if (k.kind === 'invite') {
    if (!isRole(k.role) || (k.secret !== undefined && !isInviteSecret(k.secret))) return undefined
    return { id: k.id, kind: 'invite', role: k.role, ...(k.secret !== undefined ? { secret: k.secret as string } : {}) }
  }
  if (k.kind === 'setRole') return isId(k.deviceId) && isRole(k.role) ? { id: k.id, kind: 'setRole', deviceId: k.deviceId, role: k.role } : undefined
  if (k.kind === 'extend' || k.kind === 'forgetDevice') return isId(k.deviceId) ? ({ id: k.id, kind: k.kind, deviceId: k.deviceId } as PhoneCommand) : undefined
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
  archived?: Snapshot['archived']
  merged?: Snapshot['merged']
  suggestion?: Snapshot['suggestion']
  questions?: readonly PendingQuestion[]
  settled?: readonly Settled[]
  now: number
}

/** The account a session runs as: the last folder of its config dir (`~/.claude-clients/macleod` is macleod). */
export const accountOf = (configDir: string): string => configDir.replace(/\/+$/, '').split('/').pop() || 'default'

/** A row of a `!` command run from a phone, or of its output (remote/index.tsx `sh:`, `sho:`). */
export const isShellRow = (id: string): boolean => /^sho?:/.test(id)

/**
 * A snapshot as a guest's device gets it: no `!` command or its output, a permission prompt's tool and not what it
 * would run (a command's text carries tokens, hosts and paths), and every row at the short length, recent replies
 * included.
 */
export function forGuest(s: Snapshot): Snapshot {
  return {
    ...s,
    permissions: s.permissions.map(({ why: _why, detail: _detail, ...p }) => ({ ...p, summary: p.tool })),
    streams: s.streams.map(st => ({
      ...st,
      rows: st.rows.filter(r => !r.shell).map(r => (r.text.length > ROW_CHARS + 1 ? { ...r, text: `${r.text.slice(0, ROW_CHARS)}…` } : r)),
    })),
  }
}

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
          return { kind: r.kind, text: r.text.length > max ? `${r.text.slice(0, max)}…` : r.text, at: r.at, ...(isShellRow(r.id) ? { shell: true as const } : {}) }
        }),
    }
    return [card]
  })
  return { v: 1, session: x.session, at: x.now, streams, status: [...x.status], limits: [...x.limits], updates: x.updates, permissions: [...(x.permissions ?? [])], questions: [...(x.questions ?? [])], settled: [...(x.settled ?? [])], summary: summaryOf(streams, x.agents), ...(x.archived?.length ? { archived: [...x.archived] } : {}), ...(x.merged ? { merged: x.merged } : {}), ...(x.suggestion ? { suggestion: { into: x.suggestion.into, from: [...x.suggestion.from] } } : {}) }
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
