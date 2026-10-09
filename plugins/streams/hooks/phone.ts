import type { AgentRun, Stream, StreamRow } from '../types'
import { oneLine, type LimitView, type StatusKind, type StatusLine } from './classify'

/** Where the phone bridge listens for sessions: a Unix socket only this user's processes reach. */
export const BRIDGE_SOCKET = '/tmp/claudeflow-bridge.sock'

/** How often the mod looks for a change to send, and the longest it stays quiet so the bridge knows it is alive. */
export const PUSH_EVERY_MS = 2000
export const HEARTBEAT_MS = 30_000
/** After the bridge did not answer, how long before trying again: a session with no bridge costs one call a while. */
export const RETRY_MS = 15_000

/** Rows a stream's card carries to the phone, each cut to a readable length. */
export const PHONE_ROWS = 12
const ROW_CHARS = 600

export type PhoneAgent = { id: string; description: string; status: AgentRun['status']; tools: number; ms: number; last: string }
export type PhoneRow = { kind: StreamRow['kind']; text: string; at: number }
export type PhoneStream = {
  id: string
  name: string
  color: string
  kind: StatusKind
  state: string
  /** What it is about, without the clocks below: the phone keeps those running itself. */
  detail: string
  lastAt: number
  /** When a self-paced loop ticks next. */
  nextAt?: number
  /** The question it waits on you for; absent unless it waits. */
  question?: string
  agents: PhoneAgent[]
  rows: PhoneRow[]
}

/** What one session sends the bridge: everything the phone draws for it, and nothing it would not show. */
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
}

/** A permission prompt held for the phone: the call's id, the tool and what it would do. */
export type PendingPermission = { id: string; tool: string; summary: string; at: number }

/** What the phone can ask a session to do. */
export type PhoneCommand =
  | { id: string; kind: 'answer'; streamId: string; text: string }
  | { id: string; kind: 'stop' }
  | { id: string; kind: 'permission'; requestId: string; decision: 'allow' | 'deny' }

/** How long a permission prompt waits on the phone before it goes to the Mac as usual. */
export const PHONE_PERMISSION_MS = 60_000

/** One line saying what a tool call would do, for the phone's Allow / Deny card. */
export const permissionSummary = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const text = typeof i.command === 'string' ? i.command : typeof i.file_path === 'string' ? i.file_path : typeof i.url === 'string' ? i.url : JSON.stringify(input ?? {})
  return oneLine(`${tool}: ${text}`, 300)
}

/** The commands a bridge reply carries, keeping only well-formed ones: the phone is a remote, so nothing else runs. */
export const commandsOf = (body: string): { commands: PhoneCommand[]; isPhoneActive: boolean } => {
  try {
    const x = JSON.parse(body) as { commands?: unknown[]; phoneActive?: unknown }
    const commands = (x.commands ?? []).filter((c): c is PhoneCommand => {
      const k = c as Record<string, unknown>
      if (typeof k.id !== 'string') return false
      if (k.kind === 'answer') return typeof k.streamId === 'string' && typeof k.text === 'string' && k.text.trim().length > 0 && k.text.length <= 4000
      if (k.kind === 'stop') return true
      if (k.kind === 'permission') return typeof k.requestId === 'string' && (k.decision === 'allow' || k.decision === 'deny')
      return false
    })
    return { commands, isPhoneActive: x.phoneActive === true }
  } catch {
    return { commands: [], isPhoneActive: false }
  }
}

export type SnapshotInput = {
  session: Snapshot['session']
  lines: readonly StatusLine[]
  streams: readonly Stream[]
  colorOf: (s: Stream) => string
  loops: Record<string, { kind: string; nextAt: number }>
  agents: readonly AgentRun[]
  rows: readonly StreamRow[]
  status: readonly StatusLine[]
  limits: readonly LimitView[]
  updates: Snapshot['updates']
  permissions?: readonly PendingPermission[]
  now: number
}

/** The account a session runs as: the last folder of its config dir (`~/.claude-clients/macleod` is macleod). */
export const accountOf = (configDir: string): string => configDir.replace(/\/+$/, '').split('/').pop() || 'default'

/** A status detail without its clock, which changes every second and would make every snapshot news. */
export const timeless = (detail: string): string => detail.replace(/ · \d+[smhd] ago$/, '').replace(/^next tick in [^·]+ · /, '')

/** The streams in status order, each with its live agents and latest rows; code bodies stay on the Mac. */
export function snapshotOf(x: SnapshotInput): Snapshot {
  const streams = x.lines.flatMap(l => {
    const s = x.streams.find(st => st.id === l.id)
    if (!s) return []
    const kind = l.kind ?? 'idle'
    const loop = x.loops[s.id]
    const card: PhoneStream = {
      id: s.id,
      name: s.name,
      color: x.colorOf(s),
      kind,
      state: l.state,
      detail: oneLine(timeless(l.detail), 240),
      lastAt: s.lastAt,
      ...(kind === 'loop' && loop?.kind === 'wakeup' ? { nextAt: loop.nextAt } : {}),
      ...(kind === 'waiting' ? { question: l.detail } : {}),
      agents: x.agents
        .filter(a => a.streamId === s.id && (a.status === 'running' || x.now - (a.endedAt ?? a.lastAt) < 10 * 60_000))
        .sort((a, b) => b.lastAt - a.lastAt)
        .map(a => ({
          id: a.id,
          description: a.description,
          status: a.status,
          tools: a.tools,
          ms: (a.endedAt ?? x.now) - a.startedAt,
          last: oneLine(a.last, 160),
        })),
      rows: x.rows
        .filter(r => r.streamId === s.id)
        .slice(-PHONE_ROWS)
        .map(r => ({ kind: r.kind, text: r.text.length > ROW_CHARS ? `${r.text.slice(0, ROW_CHARS)}…` : r.text, at: r.at })),
    }
    return [card]
  })
  return { v: 1, session: x.session, at: x.now, streams, status: [...x.status], limits: [...x.limits], updates: x.updates, permissions: [...(x.permissions ?? [])] }
}

/** Whether a snapshot is worth sending: it changed, or the bridge has not heard from the session for a while. */
export const isDue = (body: string, last: { body: string; at: number }, now: number): boolean =>
  body !== last.body || now - last.at >= HEARTBEAT_MS

/** The bridge's files as the plugin ships them, copied to `~/.claudeflow/bridge` where launchd runs them: a plugin update moves its own folder. */
export const BRIDGE_FILES = ['server.ts', 'remote.ts', 'seal.js', 'app.html', 'install.sh'] as const
export const BRIDGE_LABEL = 'ai.macleodlabs.claudeflow-bridge'
export const BRIDGE_PORT = 7878
/** Where Tailscale's command line is: inside the Mac app, or on PATH from Homebrew. */
export const TAILSCALE_BINS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale'] as const

/** The tailnet address of this Mac from `tailscale status --json`, or undefined while signed out. */
export const tailnetHostOf = (statusJson: string): string | undefined => {
  try {
    const s = JSON.parse(statusJson) as { BackendState?: string; Self?: { DNSName?: string } }
    const host = (s.Self?.DNSName ?? '').replace(/\.$/, '')
    return s.BackendState === 'Running' && host ? host : undefined
  } catch {
    return undefined
  }
}
