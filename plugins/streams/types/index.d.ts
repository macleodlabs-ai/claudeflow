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
  /**
   * When the person last restored it (epoch ms): a restored stream is not archived on its own again until it has
   * been active since (`autoArchiveHours`).
   */
  restoredAt?: number
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
  /** On a loop tick's row: the tick changed nothing (its ScheduleWakeup said `noop`), so views fold it away. */
  quiet?: boolean
}

/**
 * A loop armed in a stream: a self-paced wakeup, a cron job, or a Monitor watching a command. Its clocks are times
 * (`nextAt`, `until`; epoch ms), never text, so it changes only when the loop does; each screen counts as it draws.
 */
export type Loop = {
  kind: 'wakeup' | 'cron' | 'monitor'
  /** When it fires next: a wakeup's `scheduledFor` (after the runtime's clamp), a cron's next match. */
  nextAt?: number
  /** How often, in words: a cron's `humanSchedule`. */
  every?: string
  /** Why: a wakeup's reason, a cron's prompt, a monitor's description. */
  reason?: string
  /** Ticks in a row that changed nothing (ScheduleWakeup `noop: true`). */
  noopStreak: number
  /** The last tick that did change something: when, and what it said. */
  lastChange?: { at: number; text: string }
  /** What ends it: a cron's job id, a monitor's task id. */
  id?: string
  /** What a tick submits (a wakeup's or a cron's prompt), so the phone can run one now; never sent to the phone. */
  prompt?: string
  /** A cron's expression, to find its next match after each fire; `recurring: false` fires once. */
  cron?: string
  recurring?: boolean
  /** When a monitor times out; absent while it runs until stopped. */
  until?: number
}

/**
 * One agent of a Workflow run. Seen live from its tool calls (its id is one `$.agent.list()` never names), labelled
 * and put in its phase once the run's journal or record names it.
 */
export type WorkflowAgent = {
  id: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  lastAt: number
  tools: number
  label?: string
  phase?: string
  /** What a checking agent concluded, when its structured output says (`verdict`, `pass`): `pass`, `fail`, … */
  verdict?: string
}

/** A Workflow tool run, filed as a stream named after its `meta.name`. */
export type Workflow = {
  taskId: string
  name: string
  streamId: string
  runId?: string
  /** Where the run writes its agents' transcripts and its journal. */
  transcriptDir?: string
  scriptPath?: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  startedAt: number
  endedAt?: number
  /** `meta.phases[].title`, in order: the skeleton the agents fill. */
  phases: string[]
  agents: Record<string, WorkflowAgent>
  /** True while the counts are only what the plugin saw; false once the run's journal or record confirmed them. */
  inferred: boolean
}

/**
 * What the fast model made of a stream that showed WAITING or stalled (streams/completion.ts): finished, really
 * waiting on the person, or still working, and why in a few words. `rowId` is the stream's last row when it was
 * asked: the verdict holds only while that is still the last row, so anything new there asks again.
 */
export type Verdict = { rowId: string; state: 'done' | 'waiting' | 'running'; reason: string; at: number }

/** How a stream's own view draws its rows: one line each, or as the session's transcript draws them. */
export type ChatStyle = 'compact' | 'full'

/** A stream's badge in the status card: its health, an armed loop, or waiting on the person. */
export type StreamsKind = Health | 'loop' | 'waiting'

/** One row of the status card: a stream, a git line or a ticket. Clocks are times, so it changes only when they do. */
export type StreamsStatusLine = { id: string; area: string; kind?: StreamsKind; state: string; detail: string; since?: number; nextAt?: number; quietSince?: number }

/** A rate limit as the status card shows it. */
export type StreamsLimit = { label: string; percent: number; bar: string; until?: number; resetsAt: string }

/** A stream's loop as a card shows it: clocks as times, the quiet streak and the last real change. */
export type StreamsLoopView = Pick<Loop, 'kind' | 'nextAt' | 'every' | 'reason' | 'noopStreak' | 'lastChange'> & { canStop?: false }

/** One agent of a Workflow run as a card shows it. */
export type StreamsRunAgent = { id: string; label?: string; status: WorkflowAgent['status']; tools: number; startedAt: number; endedAt?: number; verdict?: string }

/** One phase of a Workflow run: its counts, verdicts and agents. */
export type StreamsPhaseView = { title: string; done: number; total: number; err: number; verdicts?: Record<string, number>; agents?: StreamsRunAgent[] }

/** A stream's Workflow run, running or last: phases with counts, no labels or ids but the task's, to stop it by. */
export type StreamsRunView = {
  name: string
  taskId: string
  status: Workflow['status']
  startedAt: number
  endedAt?: number
  agents: { run: number; done: number; err: number }
  phases: StreamsPhaseView[]
  /** The counts are what the plugin saw, not the run's own record, and phases are waves of start times. */
  inferred: boolean
}

/** One stream as the pane and the status card show it, in status order. */
export type StreamsCard = {
  id: string
  name: string
  color: string
  kind: StreamsKind
  state: string
  /** What it is about, without clocks: `since` and `nextAt` are times, for the reader to count. */
  detail: string
  since?: number
  nextAt?: number
  /** Its loop, while one is armed and not lapsed. */
  loop?: StreamsLoopView
  /** Its Workflow run, running or last. */
  run?: StreamsRunView
  /** Its subagents running, and those that ended in the last 10 minutes; newest first. */
  agents: AgentRun[]
  /** Its rows, oldest first, quiet loop ticks folded. */
  rows: StreamRow[]
}

/** Everything the Streams pane and status card show for this session now, as data. */
export type StreamsView = {
  now: number
  busy: boolean
  /** The stream the main loop is working on; '' before the first prompt. */
  current: string
  /** What the session runs on, when it says. */
  model?: string
  streams: StreamsCard[]
  /** Archived streams, newest last (at most 30). */
  archived: { id: string; name: string; color: string }[]
  /** Every subagent run this session knows. */
  agents: AgentRun[]
  /** Git and ticket rows, as the status card shows them. */
  status: StreamsStatusLine[]
  limits: StreamsLimit[]
  /** Installed plugins with a newer release. */
  updates: { id: string; from: string; to: string }[]
}

/** What an action did: `ok: false` when it was not done, with `why` when there is more to say. */
export type StreamsDone = { ok: boolean; why?: string }

/**
 * `$.streams`: this session's streams for other plugins (the phone add-on reads and drives the session through it).
 * Reads are snapshots; each action does what the pane's own control does.
 */
export type Streams = {
  /** What the pane and status card show now. */
  view(): Promise<StreamsView>
  /** Makes a stream current, so the next prompt is filed there. Not done for a stream this session does not have. */
  select(args: { streamId: string }): Promise<StreamsDone>
  /** Archives or restores a stream, as the pane's ✕ and restore do. Already so is done. */
  setArchived(args: { streamId: string; archived: boolean }): Promise<StreamsDone>
  /** Runs a loop's tick now, filed as that loop's tick. Not done while that stream's turn runs, or twice within a few seconds. */
  runTick(args: { streamId: string }): Promise<StreamsDone>
  /** Ends a stream's loop as the model would end it. */
  stopLoop(args: { streamId: string }): Promise<StreamsDone>
  /** Stops a Workflow run this session shows running. */
  stopTask(args: { taskId: string }): Promise<StreamsDone>
  /** Stops the main loop's running turn, if one runs. */
  stopTurn(): Promise<StreamsDone>
  /**
   * The phone pairing Streams kept before the phone became an add-on (its `remote:` keys), handed over once: returned,
   * then deleted here. Empty once taken.
   */
  handOver(): Promise<Record<string, unknown>>
}

declare module 'claude-code' {
  interface EngineInterface {
    streams: Streams
  }
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
      /** Loops armed, per stream: a self-paced wakeup, a cron job or a monitor. */
      loops: Record<string, Loop>
      /** Workflow tool runs this session, by task id. */
      workflows: Record<string, Workflow>
      /** The completion check's verdicts, by stream id (`completionCheck`). */
      verdicts: Record<string, Verdict>
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
      /**
       * The card's git rows (branch against upstream, what is uncommitted) and when they were read: shared by the
       * card, which reads them as it opens, and the phone's snapshot, which reuses them while fresh.
       */
      statusGit: { lines: { id: string; area: string; state: string; detail: string }[]; at: number }
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
      /** The transcripts this project's saved rows can be read back from (state.ts, Sources). */
      sources: { since: number; files: string[] }
      /** Prompts sent into the running turn, still waiting for the reply that answers them. */
      folded: Folded[]
      rows: StreamRow[]
      agentStream: Record<string, string>
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
