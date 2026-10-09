export type StreamRowKind = 'prompt' | 'reply' | 'tool' | 'agent' | 'loop' | 'notice'

/** What the heartbeat makes of a stream: working, quiet too long while working, finished lately, failed, or asleep. */
export type Health = 'running' | 'stalled' | 'done' | 'error' | 'idle'

/** A prompt sent while a turn ran: it waits, filed in its own stream, for the reply that answers it. */
export type Folded = { streamId: string; text: string }

/** A subagent's run, as the pane shows it live. */
export type AgentRun = {
  id: string
  streamId: string
  description: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  lastAt: number
  /** What it did last: a tool call or the head of its latest text. */
  last: string
  tools: number
}

export type Stream = {
  id: string
  name: string
  summary: string
  createdAt: number
  lastAt: number
  rows: number
  agents: number
  loops: number
  /** The stream's own pastel, fixed at creation: its line down the transcript, its name in the pane. */
  color?: string
  /** Hidden from the bar and the list until restored; its history stays. */
  archived?: boolean
}

/** A tool call's input as the full chat style draws it: highlighted source, or a unified diff. */
export type RowCode = { source: string; language?: string; path?: string; format?: 'diff' }

export type StreamRow = {
  id: string
  streamId: string
  kind: StreamRowKind
  text: string
  agentId?: string
  at: number
  code?: RowCode
  /** A tool row's call id: the key its transcript row is filed under. */
  toolId?: string
}

/** How a stream's own view draws its rows: one line each, or as the session's transcript draws them. */
export type ChatStyle = 'compact' | 'full'

declare module 'claude-code' {
  interface PluginState {
    streams: {
      streams: Stream[]
      /** The stream the main loop is working on now; '' before the first prompt. */
      current: string
      /** The stream the transcript is focused on; '' shows everything. */
      focus: string
      /** The stream the pane shows in detail; '' shows the list. */
      view: string
      /** Whether a main-loop turn is running. */
      busy: boolean
      /** Subagent runs by id. */
      agents: Record<string, AgentRun>
      /** How much of each stream the pane shows. */
      fold: Record<string, 'all' | '10' | '1' | 'none'>
      /** When the main turn started, for its running clock. */
      turnStartedAt: number
      /** A clock the pane reads while anything runs, so elapsed times move. */
      tick: number
      /** Loops waiting to fire, per stream: a self-paced wakeup or a cron job. */
      loops: Record<string, { kind: 'wakeup' | 'cron'; nextAt: number; label: string }>
      /** The chat style chosen in the pane this session; '' follows the `chatStyle` setting. */
      chatStyle: ChatStyle | ''
      /** The `#tag` being typed at the start of the prompt box and the streams it could complete to. */
      tagHint: { partial: string; matches: string[] } | null
      /** Installed plugins with a newer release in their marketplace. */
      updates: { id: string; from: string; to: string }[]
      /** Whether an update is being installed now. */
      updating: boolean
      /** Whether the docked pane is folded away to the bar's side tab. */
      paneCollapsed: boolean
      /** Whether the status card is up above the prompt. */
      statusOpen: boolean
      /** The card's git rows, read as it opened: branch against upstream and what is uncommitted. */
      statusGit: { id: string; area: string; state: string; detail: string }[]
      /** Whether the pane lists archived streams too. */
      showArchived: boolean
      /** Whether this session's transcript has been filed into streams (once per session). */
      historyFiled: boolean
      /** The row-key scheme this session's rows were filed under; an older one means file them again. */
      keyVersion: number
      /** A history import under way: what it is doing and how far it has got; total 0 when none runs. */
      importProgress: { label: string; done: number; total: number }
      /** This session's transcript file, as the prompt hook names it. */
      transcript: string
      /** Prompts sent into the running turn, still waiting for the reply that answers them. */
      folded: Folded[]
      rows: StreamRow[]
      agentStream: Record<string, string>
      /** Subagents still running, by id, to the stream they work for. */
      live: Record<string, string>
      /** Tool calls running now, per stream. */
      inflight: Record<string, number>
      /** How each stream's last main-loop turn ended. */
      outcome: Record<string, 'answer' | 'aborted' | 'refusal' | 'error'>
      /** The heartbeat's verdict per stream. */
      health: Record<string, Health>
      loopStream: Record<string, string>
      /** Which stream each transcript row (message uuid, tool_use_id, text key) belongs to. */
      rowStream: StateFamily<string>
      /** Each stream's colour by stream id, so a transcript row reads its own and redraws on nothing else. */
      streamColor: StateFamily<string>
    }
  }
}
