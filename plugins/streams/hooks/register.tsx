import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentRun, ChatStyle, Folded, Health, Stream, StreamRow, StreamRowKind } from '../types'
import type { Installed, MarketEntry, Update } from './updates'
import { CHECK_EVERY_MS, manifestPathOf, pluginsDirOf, updatesOf } from './updates'
import type { PendingPermission, PhoneCommand, Snapshot } from './phone'
import { BRIDGE_FILES, BRIDGE_LABEL, BRIDGE_PORT, BRIDGE_SOCKET, HEARTBEAT_MS, PUSH_EVERY_MS, RETRY_MS, TAILSCALE_BINS, PHONE_PERMISSION_MS, accountOf, commandsOf, isDue, permissionSummary, snapshotOf, tailnetHostOf } from './phone'
import type { BadgeKind, Fold, HistoryItem, HistoryTurn, Proposal, StatusKind, StatusLine } from './classify'
import {
  BATCH_SYSTEM,
  MERGE_SYSTEM,
  buildBatchPrompt,
  buildMergePrompt,
  inParallel,
  parseBatch,
  parseMerge,
  BADGE_BG,
  BADGE_FG,
  FOLD_LABEL,
  HEALTH_TEXT,
  NEXT_FOLD,
  clockOf,
  rowKey,
  REPLIES_SYSTEM,
  buildRepliesPrompt,
  pickReplyStreams,
  turnsOf,
  nextPastel,
  pastelOf,
  partialTag,
  gitStatus,
  sortStatus,
  statusOf,
  ticketLines,
  limitView,
  codeOf,
  toolLine,
  tagMatches,
  completeTag,
  REPLY_SYSTEM,
  buildReplyPrompt,
  pickReplyStream,
  readTranscript,
  HEALTH_COLOR,
  HEALTH_GLYPH,
  SYSTEM,
  healthOf,
  ago,
  buildPrompt,
  fallbackName,
  isFollowUp,
  loopKey,
  oneLine,
  parseTag,
  parseVerdict,
  slug,
  textKey,
} from './classify'

const PANE = 'streams'
const MAX_ROWS = 4000
const SAVED_ROWS = 400

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
const showArchivedA = atom({ plugin: 'streams', key: 'showArchived' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const foldA = atom({ plugin: 'streams', key: 'fold' } as const, {})
const turnStartedAtA = atom({ plugin: 'streams', key: 'turnStartedAt' } as const, 0)
const tickA = atom({ plugin: 'streams', key: 'tick' } as const, 0)
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const chatStyleA = atom({ plugin: 'streams', key: 'chatStyle' } as const, '')
const tagHintA = atom({ plugin: 'streams', key: 'tagHint' } as const, null)
const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
const updatingA = atom({ plugin: 'streams', key: 'updating' } as const, false)
const mobileOpenA = atom({ plugin: 'streams', key: 'mobileOpen' } as const, '')
const paneCollapsedA = atom({ plugin: 'streams', key: 'paneCollapsed' } as const, false)
const statusOpenA = atom({ plugin: 'streams', key: 'statusOpen' } as const, false)
const statusGitA = atom({ plugin: 'streams', key: 'statusGit' } as const, [])
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const agentStreamA = atom({ plugin: 'streams', key: 'agentStream' } as const, {})
const liveA = atom({ plugin: 'streams', key: 'live' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const healthA = atom({ plugin: 'streams', key: 'health' } as const, {})
const historyFiledA = atom({ plugin: 'streams', key: 'historyFiled' } as const, false)
const importProgressA = atom({ plugin: 'streams', key: 'importProgress' } as const, { label: '', done: 0, total: 0 })
const keyVersionA = atom({ plugin: 'streams', key: 'keyVersion' } as const, 0)
/** 2: rows keyed by rowKey (a uuid by its first four groups). Bump when the keys change. */
const KEY_VERSION = 2
const transcriptA = atom({ plugin: 'streams', key: 'transcript' } as const, '')
const foldedA = atom({ plugin: 'streams', key: 'folded' } as const, [])
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const ROW = { plugin: 'streams', key: 'rowStream' } as const
const COLOR = { plugin: 'streams', key: 'streamColor' } as const

type Saved = { streams: Stream[]; rows: StreamRow[]; loopStream: Record<string, string> }
type $ = EngineInterface

/**
 * Slow work (model calls, the history import) cannot run in the hook that asks for it: the engine cuts a
 * dispatch's calls once its hook returns. So hooks queue it here and session.start's timer drains it.
 */
type Job =
  | { kind: 'route'; uuid: string; rowId: string; text: string; turnSid: string; folded: readonly Folded[] }
  | { kind: 'import'; path: string; isCurrent: boolean }
const jobs: Job[] = []
let draining = false
/** The last failure of background work, for the diagnostics file. */
let lastError = ''
let isWorking = false

/** Starts the worker's timer once per load, from whichever hook first has work: timers outlive the hook. */
function work($: $, job?: Job) {
  if (job) jobs.push(job)
  if (isWorking) return
  isWorking = true
  $.clock.every(1000, () => {
    void drain($).catch(err => {
      lastError = `${String(err)} ${(err as Error)?.stack ?? ''}`.slice(0, 600)
      $.ui.log(`streams: background work failed: ${String(err)}`)
    })
    void tick($).catch(() => {})
  })
}

async function drain($: $) {
  if (draining) return
  draining = true
  try {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      if (job.kind === 'import') await importHistory($, job.path, job.isCurrent)
      else await reroute($, job)
    }
  } finally {
    draining = false
  }
}

/** Moves the pane's clocks once a second, only while something runs. */
async function tick($: $) {
  const [busy, agents, loops] = await Promise.all([read($, busyA), read($, agentsA), read($, loopsA)])
  if (!busy && !Object.values(agents).some(a => a.status === 'running') && Object.keys(loops).length === 0) return
  const now = await $.clock.now()
  if (Object.values(loops).some(l => lapsed(l, now)))
    await update($, loopsA, m => Object.fromEntries(Object.entries(m).filter(([, l]) => !lapsed(l, now))))
  await update($, tickA, () => now)
}

/** A reply filed under the turn's stream moves to the mid-turn prompt it answers, if it answers one. */
async function reroute($: $, job: Job & { kind: 'route' }) {
  const sid = await routeReply($, job.turnSid, job.folded, job.text)
  if (sid === job.turnSid) return
  await fileAs($, job.uuid, sid)
  await fileAs($, textKey(job.text), sid)
  await update($, rowsA, list => list.map(row => (row.id === job.rowId ? { ...row, streamId: sid } : row)))
  await touch($, sid, s => ({ rows: s.rows + 1 }))
  await touch($, job.turnSid, s => ({ rows: Math.max(0, s.rows - 1) }))
}

// Diagnostics while the matching is being proven: transcript rows drawn with no stream, written by the heartbeat.
const unmatched = new Map<string, { component: string; requestId: string; head: string }>()

function noteMatched(component: string, requestId: string) {
  unmatched.delete(`${component}:${requestId}`)
}

function noteUnmatched(component: string, requestId: string, text: string) {
  if (unmatched.size >= 60) return
  unmatched.set(`${component}:${requestId}`, { component, requestId, head: text.slice(0, 80) })
}

/** Off unless the `diagnostics` setting is on: an installed copy should not write into its own folder. */
let isDiagnosing = false

async function writeDiagnostics($: $) {
  const [rows, streams, historyFiled] = await Promise.all([read($, rowsA), read($, streamsA), read($, historyFiledA)])
  const perStream: Record<string, number> = {}
  for (const row of rows) perStream[row.streamId] = (perStream[row.streamId] ?? 0) + 1
  await $.fs.write(
    `${$.plugin.root}/debug.json`,
    JSON.stringify(
      {
        at: await $.clock.now(),
        historyFiled,
        importing,
        lastError,
        lastPane,
        queuedJobs: jobs.map(j => j.kind),
        streams: streams.map(s => s.id),
        rowsPerStream: perStream,
        lastRows: rows.slice(-15).map(r => ({ id: r.id, streamId: r.streamId, kind: r.kind, head: r.text.slice(0, 60) })),
        unmatched: [...unmatched.values()],
      },
      null,
      2,
    ),
  )
}

/**
 * The pane's window is the engine's: scrolled down while the pane was long, it stays put when the content
 * shrinks, and the pane looks empty. Past the last drawn row, bring it back to the top.
 */
async function unstick($: $) {
  const scroll = lastPane.scroll as { offset: number } | undefined
  const rows = Number(lastPane.rows ?? 0)
  lastPane = { ...lastPane, panes: await $.ui.panes() }
  if (scroll && scroll.offset > 0 && scroll.offset >= rows) {
    const r = await $.ui.scroll({ in: PANE, to: 'start' })
    lastPane = { ...lastPane, unstuck: r }
  }
}

/** The docked pane's width as last drawn: what it reopens at after being folded to the side tab. */
let dockColumns = 0
const PANE_KEY = 'streams:pane'
type PaneSaved = { collapsed: boolean; columns: number }

/** Folds the docked pane away to a tab at the bar's right end, keeping its width for when it comes back. */
async function collapsePane($: $) {
  await $.store.set(PANE_KEY, { collapsed: true, columns: dockColumns } satisfies PaneSaved)
  await update($, paneCollapsedA, () => true)
  await $.ui.close({ id: PANE })
}

/** Brings the pane back from the side tab at the width it had (a width the person dragged to wins anyway). */
async function expandPane($: $, focus = false) {
  const saved = (await $.store.get(PANE_KEY)) as PaneSaved | undefined
  await update($, paneCollapsedA, () => false)
  await $.store.set(PANE_KEY, { collapsed: false, columns: saved?.columns ?? 0 } satisfies PaneSaved)
  await $.ui.open({ id: PANE, title: 'Streams', ...(saved?.columns ? { columns: saved.columns } : {}), ...(focus ? { focus: true as const } : {}) })
}

/** The pane's last draw, for the diagnostics file: when, how long, what it drew, or what it threw. */
let lastPane: Record<string, unknown> = {}

type PaneRender = Parameters<$['ui']['resolve']>[0] & {
  props: { bodyColumns: number; placement: string; scroll?: { offset: number; bodyRows: number } }
}

async function timedPane($: $, e: PaneRender, draw: () => Promise<RenderElement>): Promise<RenderElement> {
  const began = Date.now()
  const view = await read($, viewA)
  try {
    const tree = await draw()
    const drawn = JSON.stringify(tree)
    // An upper bound on the rows drawn: every Text and Button is at most a row.
    const rows = (drawn.match(/"type":"(Text|Button)"/g) ?? []).length
    if (e.props.placement === 'dock') dockColumns = e.props.bodyColumns
    lastPane = { at: began, ms: Date.now() - began, view, columns: e.props.bodyColumns, placement: e.props.placement, surface: e.surface, size: drawn.length, rows, scroll: e.props.scroll }
    return tree
  } catch (err) {
    lastPane = { at: began, ms: Date.now() - began, view, columns: e.props.bodyColumns, error: `${String(err)} ${(err as Error)?.stack ?? ''}`.slice(0, 600) }
    throw err
  }
}

// Lost on reload, and that is fine: both only bridge a moment.
let pendingSpawn = ''
let pendingKind: StreamRowKind = 'prompt'

const storeKey = (cwd: string) => `streams:v1:${cwd}`

async function ensureStream($: $, name: string, summary: string): Promise<string> {
  const id = slug(name)
  const now = await $.clock.now()
  await update($, streamsA, list =>
    list.some(s => s.id === id)
      ? list
      : [
          ...list,
          {
            id,
            name,
            summary,
            createdAt: now,
            lastAt: now,
            rows: 0,
            agents: 0,
            loops: 0,
            color: nextPastel(list.filter(s => !s.archived).map(s => s.color)),
          },
        ],
  )
  await paintStreams($)
  return id
}

/** Files a transcript row (by uuid, tool_use_id or text key) under a stream. */
const fileAs = ($: $, id: string, sid: string) => $.state.set({ ...ROW, id: rowKey(id) }, sid)

const colorOf = (s: Stream): string => s.color ?? pastelOf(s.id)

/** Mirrors each stream's colour where transcript rows read it, each its own. */
async function paintStreams($: $) {
  const streams = await read($, streamsA)
  await Promise.all(streams.map(s => $.state.set({ ...COLOR, id: s.id }, colorOf(s))))
}

async function touch($: $, id: string, patch: (s: Stream) => Partial<Stream> = () => ({})) {
  const now = await $.clock.now()
  await update($, streamsA, list => list.map(s => (s.id === id ? { ...s, lastAt: now, ...patch(s) } : s)))
}

async function refreshStatus($: $) {
  const [focus, current] = await Promise.all([read($, focusA), read($, currentA)])
  $.ui.status(focus ? `◉ stream ${focus}` : current ? `stream ${current}` : undefined)
}

/** Hybrid routing: follow-ups stay put, everything else asks Haiku which stream it continues. */
async function classify($: $, text: string): Promise<string> {
  const [streams, current] = await Promise.all([read($, streamsA), read($, currentA)])
  if (current && isFollowUp(text)) return current
  // Archived streams are put away: only a #tag brings one back. The rest are offered with their state, so a
  // finished side task is not taken for open work in the same area.
  const recent = streams.filter(s => !s.archived).sort((a, b) => b.lastAt - a.lastAt).slice(0, 15)
  const [now, health] = await Promise.all([$.clock.now(), healthNow($, recent)])
  const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt: buildPrompt(recent, current, text, now, health), maxTokens: 150 })
  const v = r.isAnswered ? parseVerdict(r.text, recent) : undefined
  if (!v) return current || ensureStream($, fallbackName(text), oneLine(text, 120))
  if (v.kind === 'new') return ensureStream($, v.name, v.summary)
  // A stream keeps the goal it was created with: a summary rewritten on every match drifts wider until it
  // matches everything nearby.
  return v.id
}

/** The transcript id a row was filed under: its message's uuid. */
const uuidOf = (row: StreamRow): string => (row.id.startsWith('h:') ? row.id.split(':')[1] : row.id.split(':')[0]) ?? row.id

/**
 * `/stream move <name>`: the current stream's last prompt, and everything after it (replies, tools,
 * subagents), filed under `<name>` instead, created when no stream has that name. Fixes a wrong guess.
 */
async function moveLast($: $, name: string): Promise<string> {
  const [rows, from, streams] = await Promise.all([read($, rowsA), read($, currentA), read($, streamsA)])
  if (!from) return 'No prompt has been filed yet.'
  const known = streams.find(s => s.id === slug(name) || s.name.toLowerCase() === name.trim().toLowerCase())
  const own = rows.filter(r => r.streamId === from)
  const start = own.findLastIndex(r => r.kind === 'prompt' && !r.agentId)
  if (start < 0) return `Nothing in ${from} to move.`
  const moving = own.slice(start)
  const to = known?.id ?? (await ensureStream($, name.trim(), oneLine(moving[0]?.text ?? '', 120)))
  if (to === from) return `That prompt is already in ${to}.`
  const ids = new Set(moving.map(r => r.id))
  const agentIds = new Set(moving.flatMap(r => (r.agentId ? [r.agentId] : [])))
  await update($, rowsA, list => list.map(r => (ids.has(r.id) ? { ...r, streamId: to } : r)))
  await Promise.all(
    moving.flatMap(r => [
      fileAs($, uuidOf(r), to),
      ...(r.toolId ? [fileAs($, r.toolId, to)] : []),
      ...(r.kind === 'reply' ? [fileAs($, textKey(r.text), to)] : []),
    ]),
  )
  if (agentIds.size) await update($, agentStreamA, m => Object.fromEntries(Object.entries(m).map(([a, sid]) => [a, agentIds.has(a) ? to : sid])))
  await touch($, to, s => ({ rows: s.rows + moving.length, archived: false }))
  await touch($, from, s => ({ rows: Math.max(0, s.rows - moving.length) }))
  await update($, currentA, () => to)
  await paintStreams($)
  await refreshStatus($)
  await save($)
  return `Moved the last prompt and ${moving.length - 1} row${moving.length === 2 ? '' : 's'} after it from ${from} to ${to}.`
}

/** A background task's notification names its task; route it to whoever spawned that. */
async function streamOfNotification($: $, text: string): Promise<string> {
  const map = await read($, agentStreamA)
  const hit = Object.keys(map).find(id => text.includes(id))
  return (hit && map[hit]) || read($, currentA)
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown }

type AppendedRow = {
  message: { type: string; role?: string; isMeta?: true; content: readonly unknown[] }
  agentId?: string
}

async function record($: $, e: AppendedRow, uuid: string) {
  const msg = e.message
  if (msg.type === 'attachment') {
    // A prompt sent mid-turn is stored as this row: link it to the stream prompt.submit filed it in.
    const prompt = (msg.content as readonly Block[]).find(b => b.type === 'text')?.text ?? ''
    const hit = (await read($, foldedA)).findLast(f => prompt.includes(f.text) || f.text.includes(prompt.trim()))
    // Matched to the prompt it carries; any other attachment wears the current stream's line.
    await fileAs($, uuid, hit && prompt.trim() ? hit.streamId : await inStream($, e.agentId))
    return
  }
  if (msg.isMeta) {
    // Notices, reminders and deliveries are not activity, but they sit in the stream's part of the transcript.
    const sid = await inStream($, e.agentId)
    if (sid) await fileAs($, uuid, sid)
    return
  }
  let sid: string
  let folded: readonly Folded[] = []
  if (e.agentId) {
    const map = await read($, agentStreamA)
    sid = map[e.agentId] ?? (pendingSpawn || (await read($, currentA)))
    if (!map[e.agentId] && sid) await update($, agentStreamA, m => ({ ...m, [e.agentId as string]: sid }))
  } else {
    sid = await read($, currentA)
    if (msg.role === 'assistant') folded = await read($, foldedA)
  }
  if (!sid) return
  const marks: Promise<unknown>[] = [fileAs($, uuid, sid)]
  const now = await $.clock.now()
  const rows: StreamRow[] = []
  const blocks = msg.content as readonly Block[]
  blocks.forEach((b, i) => {
    const id = `${uuid}:${i}`
    const base = { id, streamId: sid, agentId: e.agentId, at: now }
    if (b.type === 'text' && b.text) {
      if (msg.type === 'system') rows.push({ ...base, kind: 'notice', text: b.text })
      else if (msg.role === 'assistant') {
        rows.push({ ...base, kind: 'reply', text: b.text })
        marks.push(fileAs($, textKey(b.text), sid))
        // Filed under the turn now; the worker moves it if it answers a prompt sent mid-turn.
        if (folded.length > 0) work($, { kind: 'route', uuid, rowId: id, text: b.text, turnSid: sid, folded })
      } else if (msg.role === 'user' && !b.text.trim().startsWith('<')) {
        // A typed shell command and its output (<bash-input>, <bash-stdout>) are not prompts, as the import has it.
        rows.push({ ...base, kind: e.agentId ? 'prompt' : pendingKind, text: b.text })
      }
    } else if (b.type === 'tool_use' && b.id) {
      marks.push(fileAs($, b.id, sid))
      const input = (b.input ?? {}) as { description?: string }
      rows.push(
        b.name === 'Agent'
          ? { ...base, kind: 'agent', text: input.description ?? 'subagent' }
          : { ...base, kind: 'tool', text: toolLine(b.name ?? '', b.input), toolId: b.id, ...withCode(b.name ?? '', b.input) },
      )
    }
  })
  await Promise.all(marks)
  if (rows.length === 0) return
  const agentId = e.agentId
  const latest = rows.at(-1)
  if (agentId && latest) {
    const tools = rows.filter(r => r.kind === 'tool').length
    await update($, agentsA, m =>
      m[agentId] ? { ...m, [agentId]: { ...m[agentId], lastAt: now, last: oneLine(latest.text, 120), tools: m[agentId].tools + tools } } : m,
    )
  }
  await update($, rowsA, list => [...list, ...rows].slice(-MAX_ROWS))
  await touch($, sid, s => ({ rows: s.rows + rows.length }))
}

/** While prompts wait in the running turn, a reply piece goes to whichever of them, or the turn's own task, it answers. */
async function routeReply($: $, turnSid: string, folded: readonly Folded[], text: string): Promise<string> {
  const turn = { streamId: turnSid, text: (await read($, streamsA)).find(s => s.id === turnSid)?.summary ?? turnSid }
  const r = await $.model.complete({ model: 'haiku', system: REPLY_SYSTEM, prompt: buildReplyPrompt(turn, folded, text), maxTokens: 20 })
  return r.isAnswered ? pickReplyStream(r.text, turn, folded) : turnSid
}

async function save($: $) {
  const [cwd, streams, rows, loopStream] = await Promise.all([
    $.session.cwd(),
    read($, streamsA),
    read($, rowsA),
    read($, loopStreamA),
  ])
  const saved: Saved = { streams, rows: rows.slice(-SAVED_ROWS), loopStream }
  await $.store.set(storeKey(cwd), saved)
}

/** Every few seconds: recompute each stream's health, and say so when one stalls or background work finishes. */
async function beat($: $) {
  await unstick($).catch(() => {})
  if (isDiagnosing) await writeDiagnostics($).catch(() => {})
  const [streams, current, busy, live, inflight, outcome, before, now] = await Promise.all([
    read($, streamsA),
    read($, currentA),
    read($, busyA),
    read($, liveA),
    read($, inflightA),
    read($, outcomeA),
    read($, healthA),
    $.clock.now(),
  ])
  const after: Record<string, Health> = {}
  for (const s of streams) {
    after[s.id] = healthOf({
      now,
      lastAt: s.lastAt,
      isTurnOn: busy && s.id === current,
      liveAgents: Object.values(live).filter(id => id === s.id).length,
      inflight: inflight[s.id] ?? 0,
      outcome: outcome[s.id],
    })
    const was = before[s.id]
    // A stream that wakes up opens again, whatever it was folded to.
    if (was !== 'running' && after[s.id] === 'running') await update($, foldA, ({ [s.id]: _, ...rest }) => rest)
    if (was !== 'stalled' && after[s.id] === 'stalled') $.ui.toast(`stream ${s.id} looks stalled: nothing for ${ago(now - s.lastAt)}`)
    if (was === 'running' && after[s.id] === 'done' && s.id !== current) $.ui.toast(`stream ${s.id} finished`)
  }
  const changed = streams.some(s => before[s.id] !== after[s.id])
  if (changed) await update($, healthA, () => after)
}

/** Under this, one read; over it (a long session's transcript), the file is streamed: a read refuses past 4 MiB. */
const READ_LIMIT = 4_000_000

/** A file's whole text, however long: long transcripts are exactly the sessions that need filing. */
async function readWhole($: $, path: string): Promise<string> {
  const { size } = await $.fs.stat(path)
  if (size < READ_LIMIT) return String(await $.fs.read(path))
  const parts: string[] = []
  for await (const piece of $.process.spawn({ argv: ['cat', path] })) {
    if ('text' in piece && piece.stream === 'stdout') parts.push(piece.text)
  }
  return parts.join('')
}

// One import at a time in this environment; a reload starts a fresh one, which is safe (see below).
let importing = false

/** Model calls in flight at once while filing history. */
const LANES = 5
/** Prompts per classifying call: enough for context, few enough to answer reliably. */
const BATCH = 25

const progress = ($: $, label: string, done: number, total: number) => update($, importProgressA, () => ({ label, done, total }))

/**
 * Files a transcript into streams, in parallel: prompts are classified in batches several calls at once, the
 * names each batch proposed are merged in one pass, and turns with prompts sent mid-turn have their replies
 * routed several at once. Then every row is filed, newest stream state saved, progress shown in the pane.
 *
 * This session's own transcript (isCurrent) first clears the rows this session recorded, so a run cut short
 * by a reload is simply run again; another session's rows keep their own times and replace an earlier
 * import of the same rows rather than doubling them.
 */
async function importHistory($: $, path: string, isCurrent: boolean) {
  if (importing) return
  importing = true
  try {
    await progress($, 'reading', 0, 1)
    const [jsonl, { startedAt }, began] = await Promise.all([readWhole($, path), $.session.usage(), $.clock.now()])
    const turns = turnsOf(readTranscript(String(jsonl)))
    const prompts = turns.flatMap(t => [t.prompt, ...t.items.filter(i => i.kind === 'prompt')]) as (HistoryItem & { kind: 'prompt' })[]

    // 1. Prompts that need no model: #tags, and follow-ups (which take the stream of the prompt before them).
    const sids = new Map<HistoryItem, string>()
    const texts = new Map<HistoryItem, string>()
    for (const p of prompts) {
      const tag = parseTag(p.text)
      texts.set(p, tag ? tag.rest : p.text)
      if (tag) sids.set(p, await ensureStream($, tag.name, oneLine(tag.rest, 120)))
    }
    const open = prompts.filter(p => !sids.has(p) && !isFollowUp(p.text))

    // 2. The rest, classified in batches, several at once.
    const streams = await read($, streamsA)
    const batches = Array.from({ length: Math.ceil(open.length / BATCH) }, (_, i) => open.slice(i * BATCH, (i + 1) * BATCH))
    let done = 0
    await progress($, 'sorting prompts', 0, open.length)
    const labels = (
      await inParallel(batches, LANES, async batch => {
        const said = batch.map(p => texts.get(p) ?? p.text)
        const r = await $.model.complete({ model: 'haiku', system: BATCH_SYSTEM, prompt: buildBatchPrompt(streams, said), maxTokens: 60 + batch.length * 16 })
        done += batch.length
        await progress($, 'sorting prompts', done, open.length)
        return r.isAnswered ? parseBatch(r.text, batch.length) : batch.map(() => '')
      })
    ).flat()

    // 3. One pass merges the names the batches proposed on their own.
    const known = new Set(streams.map(s => s.id))
    const proposals = new Map<string, Proposal>()
    open.forEach((p, i) => {
      const label = labels[i] || fallbackName(texts.get(p) ?? p.text)
      labels[i] = label
      if (known.has(label)) return
      const one = proposals.get(label) ?? { name: label, count: 0, samples: [] }
      one.count += 1
      if (one.samples.length < 2) one.samples.push(texts.get(p) ?? p.text)
      proposals.set(label, one)
    })
    let merged: Record<string, string> = {}
    if (proposals.size > 1) {
      await progress($, 'merging streams', 0, 1)
      const names = [...proposals.keys()]
      const r = await $.model.complete({ model: 'haiku', system: MERGE_SYSTEM, prompt: buildMergePrompt(streams, [...proposals.values()]), maxTokens: 80 + names.length * 24 })
      merged = r.isAnswered ? parseMerge(r.text, names) : {}
    }
    for (const [i, p] of open.entries()) {
      const label = labels[i] ?? ''
      const final = merged[label] ?? label
      sids.set(p, known.has(final) ? final : await ensureStream($, final, oneLine(texts.get(p) ?? p.text, 120)))
    }
    // Follow-ups, in order: the stream of the prompt before them.
    let previous = await read($, currentA)
    for (const p of prompts) {
      const sid = sids.get(p) ?? previous
      sids.set(p, sid)
      previous = sid
    }

    // 4. Replies in turns that had prompts sent mid-turn: which thread each answers, several turns at once.
    const mixed = turns.filter(t => t.items.some(i => i.kind === 'prompt') && t.items.some(i => i.kind === 'reply'))
    const replyTo = new Map<HistoryItem, string>()
    done = 0
    await progress($, 'routing replies', 0, mixed.length)
    await inParallel(mixed, LANES, async (turn: HistoryTurn) => {
      const turnSid = sids.get(turn.prompt) ?? previous
      const first = turn.items.findIndex(i => i.kind === 'prompt')
      const folded: Folded[] = turn.items.filter(i => i.kind === 'prompt').map(i => ({ streamId: sids.get(i) ?? turnSid, text: texts.get(i) ?? '' }))
      const replies = turn.items.slice(first).filter(i => i.kind === 'reply') as (HistoryItem & { kind: 'reply' })[]
      const self = { streamId: turnSid, text: texts.get(turn.prompt) ?? '' }
      const r = await $.model.complete({ model: 'haiku', system: REPLIES_SYSTEM, prompt: buildRepliesPrompt(self, folded, replies.map(i => i.text)), maxTokens: 40 + replies.length * 16 })
      const picks = r.isAnswered ? pickReplyStreams(r.text, self, folded, replies.length) : []
      replies.forEach((item, j) => replyTo.set(item, picks[j] ?? turnSid))
      done += 1
      await progress($, 'routing replies', done, mixed.length)
    })

    // 5. File every row.
    await progress($, 'filing rows', 0, turns.length)
    const rows: StreamRow[] = []
    let at = startedAt
    for (const turn of turns) {
      const turnSid = sids.get(turn.prompt) ?? previous
      for (const item of [turn.prompt, ...turn.items]) {
        try {
          const sid = item.kind === 'prompt' ? (sids.get(item) ?? turnSid) : item.kind === 'reply' ? (replyTo.get(item) ?? turnSid) : turnSid
          const when = isCurrent ? at++ : (item.at ?? at++)
          await fileAs($, item.kind === 'tool' ? item.id : item.uuid, sid)
          if (item.kind === 'reply') await fileAs($, textKey(item.text), sid)
          const input = (item.kind === 'tool' ? item.input ?? {} : {}) as { description?: string }
          const text =
            item.kind === 'prompt'
              ? (texts.get(item) ?? item.text)
              : item.kind === 'reply'
                ? item.text
                : item.name === 'Agent'
                  ? (input.description ?? 'subagent')
                  : toolLine(item.name, item.input)
          const kind: StreamRowKind = item.kind === 'tool' ? (item.name === 'Agent' ? 'agent' : 'tool') : item.kind
          const code = kind === 'tool' && item.kind === 'tool' ? withCode(item.name, item.input) : {}
          const toolId = item.kind === 'tool' ? { toolId: item.id } : {}
          rows.push({ id: `h:${item.uuid}:${item.kind === 'tool' ? item.id : rows.length}`, streamId: sid, kind, text, at: when, ...code, ...toolId })
        } catch (err) {
          lastError = `skipped a row: ${String(err)}`.slice(0, 600)
        }
      }
    }
    const imported = new Set(rows.map(r => r.id))
    await update($, rowsA, list =>
      [
        ...list.filter(row => !imported.has(row.id) && (!isCurrent || row.at < startedAt || row.at >= began)),
        ...rows,
      ]
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_ROWS),
    )
    const counts: Record<string, number> = {}
    for (const row of await read($, rowsA)) counts[row.streamId] = (counts[row.streamId] ?? 0) + 1
    await update($, streamsA, list => list.map(s => ({ ...s, rows: counts[s.id] ?? 0 })))
    if (isCurrent) {
      await update($, currentA, () => previous)
      await update($, historyFiledA, () => true)
    }
    await save($)
    $.ui.toast(`streams: filed ${prompts.length} prompts into ${new Set(sids.values()).size} streams`)
  } finally {
    importing = false
    await progress($, '', 0, 0).catch(() => {})
  }
}

/**
 * Each stream's health as of now, for drawing: from the same live facts the agent rows show, so a header
 * never says idle beside a running agent. The heartbeat's stored verdict only drives its notices.
 */
async function healthNow($: $, streams: readonly Stream[]): Promise<Record<string, Health>> {
  const [busy, current, agents, inflight, outcome, now] = await Promise.all([
    read($, busyA),
    read($, currentA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, tickA).then(() => $.clock.now()),
  ])
  const running = Object.values(agents).filter(a => a.status === 'running')
  return Object.fromEntries(
    streams.map(s => [
      s.id,
      healthOf({
        now,
        lastAt: Math.max(s.lastAt, ...running.filter(a => a.streamId === s.id).map(a => a.lastAt)),
        isTurnOn: busy && s.id === current,
        liveAgents: running.filter(a => a.streamId === s.id).length,
        inflight: inflight[s.id] ?? 0,
        outcome: outcome[s.id],
      }),
    ]),
  )
}

type Loops = Record<string, { kind: 'wakeup' | 'cron'; nextAt: number; label: string }>

/** A wakeup that fired this long ago without re-arming ended by not scheduling another tick. */
const LAPSE_MS = 10 * 60_000
const lapsed = (l: { kind: string; nextAt: number }, now: number) => l.kind === 'wakeup' && now > l.nextAt + LAPSE_MS

type LoopArgs = { delaySeconds?: number; stop?: boolean; cron?: string; reason?: string }

/** A self-paced wakeup or a cron job arms a loop in its stream; stopping or deleting it disarms it. */
async function noteLoop($: $, sid: string, tool: string, args: LoopArgs) {
  if (tool === 'ScheduleWakeup') {
    // A session has one self-paced loop: stopping it clears it whichever stream it was filed under, and
    // re-arming it from another stream moves it there.
    const others = (m: Loops): Loops => Object.fromEntries(Object.entries(m).filter(([, l]) => l.kind !== 'wakeup'))
    if (args.stop) return update($, loopsA, others)
    const nextAt = (await $.clock.now()) + (args.delaySeconds ?? 60) * 1000
    return update($, loopsA, m => ({ ...others(m), [sid]: { kind: 'wakeup' as const, nextAt, label: args.reason ?? '' } }))
  }
  if (tool === 'CronCreate') return update($, loopsA, m => ({ ...m, [sid]: { kind: 'cron' as const, nextAt: 0, label: args.cron ?? '' } }))
  if (tool === 'CronDelete') return update($, loopsA, ({ [sid]: _, ...rest }) => rest)
}

/**
 * `/streams import` lists this project's past sessions; `/streams import <id>` (or a transcript path) files
 * that session into streams in the background, its progress in the pane.
 */
async function importCommand($: $, arg: string): Promise<string> {
  const transcript = await read($, transcriptA)
  if (!transcript) return 'Send any prompt first: the session list comes from where this session keeps its transcript.'
  const dir = transcript.slice(0, transcript.lastIndexOf('/'))
  if (!arg) {
    const now = await $.clock.now()
    const sessions = (await $.fs.list(dir))
      .filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 12)
    if (sessions.length === 0) return 'No past sessions found for this project.'
    const lines = sessions.map(f => {
      const id = f.name.replace(/\.jsonl$/, '')
      const mark = `${dir}/${f.name}` === transcript ? '  (this session)' : ''
      return `  ${id}  ${(f.size / 1_048_576).toFixed(1)} MB  ${ago(now - f.mtimeMs)} ago${mark}`
    })
    return `This project's sessions, newest first:\n${lines.join('\n')}\n\nFile one into streams: /streams import <id>`
  }
  const path = arg.includes('/') ? arg : `${dir}/${arg.replace(/\.jsonl$/, '')}.jsonl`
  if (!(await $.fs.exists(path))) return `No transcript at ${path}.`
  work($, { kind: 'import', path, isCurrent: path === transcript })
  await $.ui.open({ id: PANE, title: 'Streams' })
  return `Filing ${arg} into streams in the background; the pane shows its progress.`
}

async function inStream($: $, agentId: string | undefined): Promise<string> {
  if (agentId) {
    const map = await read($, agentStreamA)
    if (map[agentId]) return map[agentId]
  }
  return read($, currentA)
}

/** Opening a stream shows it in the pane and focuses the transcript on it: one act, as the bar's pills do. */
async function openStream($: $, id: string) {
  await update($, viewA, () => id)
  await focusOn($, id)
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
}

async function setArchived($: $, id: string, archived: boolean) {
  await update($, streamsA, list => list.map(s => (s.id === id ? { ...s, archived } : s)))
  if (archived) {
    if ((await read($, focusA)) === id) await focusOn($, '')
    if ((await read($, viewA)) === id) await update($, viewA, () => '')
  }
  await save($)
}

async function focusOn($: $, id: string) {
  await update($, focusA, () => id)
  await refreshStatus($)
}

/** Every ticket named in a prompt or an agent's task, with its state and latest news. */
async function ticketStatus($: $, streamLines: readonly StatusLine[], now: number): Promise<StatusLine[]> {
  const [rows, agents] = await Promise.all([read($, rowsA), read($, agentsA)])
  return ticketLines({
    rows,
    agents: Object.values(agents),
    streamKind: Object.fromEntries(streamLines.map(l => [l.id, l.kind ?? 'idle'])),
    now,
  })
}

/** A typed `status` or `status?` is a request for the card, answered here without a model turn. */
const STATUS_ASK = /^\s*status\s*\??\s*$/i

/** Shows the status card above the prompt, its git rows read now; the stream rows stay live as it shows. */
async function openStatus($: $, band = '') {
  await update($, statusOpenA, () => true)
  // Opened from the bar, the band holds the keys: its ring goes to the card, so ↑↓ scroll it and Esc closes it.
  if (band) void $.ui.focus({ requestId: band, key: 'status-close' }).catch(() => {})
  const git = await $.process
    .run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 })
    .then(r => (r.exitCode === 0 ? gitStatus(r.stdout) : []))
    .catch(() => [])
  await update($, statusGitA, () => git)
}

/** Every stream's status row, in the order that needs the person first. */
async function streamStatus($: $, streams: readonly Stream[], health: Record<string, Health>, now: number): Promise<StatusLine[]> {
  const [agents, rows, loops] = await Promise.all([read($, agentsA), read($, rowsA), read($, loopsA)])
  const lines = streams
    .filter(s => !s.archived)
    .map(s => {
      const loop = loops[s.id]
      return statusOf({
        stream: s,
        health: health[s.id] ?? 'idle',
        ...(loop && !lapsed(loop, now) ? { loop } : {}),
        running: Object.values(agents)
          .filter(a => a.streamId === s.id && a.status === 'running')
          .sort((a, b) => b.lastAt - a.lastAt),
        lastSaid: rows.findLast(r => r.streamId === s.id && (r.kind === 'prompt' || r.kind === 'reply')),
        now,
      })
    })
  return sortStatus(lines, Object.fromEntries(streams.map(s => [s.id, s.lastAt])))
}

const UPDATE_CHECK_KEY = 'streams:updates:checkedAt'

/**
 * Which installed plugins have a newer release: each marketplace refreshed at most every six hours,
 * then every installed plugin's version held against the one its marketplace now lists.
 */
async function checkUpdates($: $, force = false): Promise<Update[]> {
  const run = (argv: string[], timeoutMs = 30_000) => $.process.run(argv, { timeoutMs })
  const now = await $.clock.now()
  const last = Number((await $.store.get(UPDATE_CHECK_KEY)) ?? 0)
  if (force || now - last > CHECK_EVERY_MS) {
    await run(['claude', 'plugin', 'marketplace', 'update'], 180_000).catch(() => undefined)
    await $.store.set(UPDATE_CHECK_KEY, now)
  }
  const listed = await run(['claude', 'plugin', 'list', '--json'])
  // `plugin list --json` is a bare list; with `--available` it is `{ installed, available }`.
  const parsed = JSON.parse(listed.stdout || '[]') as Installed[] | { installed?: Installed[] }
  const installed = (Array.isArray(parsed) ? parsed : (parsed.installed ?? [])).filter(p => p.id.includes('@'))
  const readJson = async (path: string): Promise<unknown> => JSON.parse(String(await $.fs.read(path)))
  const markets = new Map<string, MarketEntry[]>()
  const latest: Record<string, string | undefined> = {}
  for (const p of installed) {
    const [name = '', market = ''] = p.id.split('@')
    const dir = pluginsDirOf(p.installPath)
    if (!dir) continue
    const marketDir = `${dir}/marketplaces/${market}`
    if (!markets.has(market)) {
      const manifest = (await readJson(`${marketDir}/.claude-plugin/marketplace.json`).catch(() => ({}))) as { plugins?: MarketEntry[] }
      markets.set(market, manifest.plugins ?? [])
    }
    const entry = markets.get(market)?.find(e => e.name === name)
    if (!entry) continue
    const path = manifestPathOf(marketDir, entry)
    latest[p.id] = entry.version ?? (path ? ((await readJson(path).catch(() => ({}))) as { version?: string }).version : undefined)
  }
  const found = updatesOf(installed, latest)
  const before = (await read($, updatesA)).map(u => u.id).join()
  await update($, updatesA, () => found)
  if (found.length && found.map(u => u.id).join() !== before)
    $.ui.toast(`${found.length} plugin update${found.length === 1 ? '' : 's'} ready: press ⬆ update`)
  return found
}

/** Installs every update found, then reloads the plugins into this session: no restart, from any surface. */
async function applyUpdates($: $): Promise<string> {
  const updates = await read($, updatesA)
  if (!updates.length || (await read($, updatingA))) return updates.length ? 'An update is already running.' : 'Every plugin is up to date.'
  await update($, updatingA, () => true)
  const done: string[] = []
  const failed: string[] = []
  for (const u of updates) {
    const r = await $.process
      .run(['claude', 'plugin', 'update', u.id], { timeoutMs: 180_000 })
      .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    if (r.exitCode === 0) done.push(`${u.id} ${u.from} → ${u.to}`)
    else failed.push(`${u.id}: ${oneLine(r.stderr || r.stdout, 160)}`)
  }
  await update($, updatesA, list => list.filter(u => !done.some(d => d.startsWith(`${u.id} `))))
  await update($, updatingA, () => false)
  const said = [done.length ? `Updated ${done.join(', ')}.` : '', failed.length ? `Failed: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ')
  if (done.length) {
    $.ui.toast(`${said} Reloading plugins…`)
    // The reload replaces this module, so it runs once this press or command has answered.
    void $.clock
      .sleep(300)
      .then(() => $.command.run({ command: 'reload-plugins' }))
      .catch(() => $.ui.toast('Updated: run /reload-plugins to load it'))
  } else $.ui.toast(said)
  return said
}

/** What this session last sent the phone bridge, and when the bridge may next be tried after it did not answer. */
let phoneLast = { body: '', at: 0 }
let phoneRetryAt = 0
let phoneSession: Snapshot['session'] | undefined
let phoneGit: { lines: StatusLine[]; at: number } = { lines: [], at: 0 }
/** Whether the bridge says a phone has the page open now: only then do permission prompts go to it. */
let isPhoneActive = false
/** The main turn running now, for the phone's stop. */
let runningTurn = ''
/** Permission prompts held for the phone, by call id, each with the answer that releases it. */
const heldPermissions = new Map<string, { ask: PendingPermission; answer: (d: 'allow' | 'deny') => void }>()

/** Who this session is, for the phone's session list: its id, the account it runs as and its project folder. */
async function phoneSessionOf($: $, cwd: string): Promise<Snapshot['session']> {
  const [id, configDir] = await Promise.all([
    $.session.id(),
    $.process
      .run(['/usr/bin/printenv', 'CLAUDE_CONFIG_DIR'], { timeoutMs: 3000 })
      .then(r => r.stdout.trim())
      .catch(() => ''),
  ])
  return { id, account: accountOf(configDir), project: cwd.split('/').pop() || cwd, busy: false }
}

/** A command that could not start, read as one that failed: setup reports it instead of throwing. */
const failed = (err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) })

/**
 * Puts the phone bridge where launchd runs it at login (`~/.claudeflow/bridge`) and starts it, when it is
 * missing, stopped, or older than this plugin's copy. Says what it did, or what is missing.
 */
async function ensureBridge($: $): Promise<{ ok: boolean; said: string; home: string }> {
  const [home, uid, bun] = await Promise.all([
    $.process.run(['/usr/bin/printenv', 'HOME'], { timeoutMs: 10_000 }).catch(failed).then(r => r.stdout.trim()),
    $.process.run(['/usr/bin/id', '-u'], { timeoutMs: 10_000 }).catch(failed).then(r => r.stdout.trim()),
    $.process.run(['/bin/sh', '-c', 'command -v bun'], { timeoutMs: 10_000 }).catch(failed).then(r => r.stdout.trim()),
  ])
  if (!home || !uid) return { ok: false, said: 'could not find your home folder', home }
  if (!bun) return { ok: false, said: 'needs Bun: install it from https://bun.sh, then run `/streams phone`', home }
  const dir = `${home}/.claudeflow/bridge`
  let isChanged = false
  for (const f of BRIDGE_FILES) {
    const want = String(await $.fs.read(`${$.plugin.root}/bridge/${f}`))
    const have = await $.fs.read(`${dir}/${f}`).then(String).catch(() => '')
    if (want !== have) {
      await $.fs.write(`${dir}/${f}`, want)
      isChanged = true
    }
  }
  const isRunning = (await $.process.run(['/bin/launchctl', 'print', `gui/${uid}/${BRIDGE_LABEL}`], { timeoutMs: 10_000 }).catch(failed)).exitCode === 0
  if (!isChanged && isRunning) return { ok: true, said: 'running', home }
  const r = await $.process.run(['/bin/sh', `${dir}/install.sh`], { timeoutMs: 30_000 }).catch(failed)
  return r.exitCode === 0
    ? { ok: true, said: isRunning ? 'updated and restarted' : 'installed: it starts at login', home }
    : { ok: false, said: `did not start: ${oneLine(r.stderr || r.stdout, 200)}`, home }
}

/** Serves the bridge over Tailscale (HTTPS, your devices only) when Tailscale is signed in; says how it stands. */
async function ensureTailnet($: $, home: string): Promise<{ url?: string; said: string }> {
  for (const bin of TAILSCALE_BINS) {
    const s = await $.process.run([bin, 'status', '--json'], { timeoutMs: 10_000 }).catch(failed)
    if (s.exitCode !== 0 && !s.stdout) continue
    const host = tailnetHostOf(s.stdout)
    if (!host) return { said: 'installed but signed out: open the Tailscale app and sign in, then run `/streams phone` again' }
    const served = await $.process.run([bin, 'serve', '--bg', String(BRIDGE_PORT)], { timeoutMs: 20_000 }).catch(failed)
    // A new tailnet has Serve off: the command waits for a one-click approval at a link it prints, and times out here.
    if (served.exitCode !== 0)
      return {
        said: /enable|time|still running/i.test(served.stderr + served.stdout)
          ? `Serve is not enabled on your tailnet yet: run \`! ${bin} serve --bg ${BRIDGE_PORT}\` and open the link it prints, then \`/streams phone\` again`
          : `could not serve the bridge: ${oneLine(served.stderr || served.stdout, 200)}`,
      }
    // The bridge's pairing page reads it here: under launchd it cannot ask the Tailscale app itself.
    await $.fs.write(`${home}/.claudeflow/phone-url`, `https://${host}\n`)
    return { url: `https://${host}`, said: `serving at https://${host}` }
  }
  return { said: 'not installed: run `! brew install --cask tailscale-app`, open Tailscale and sign in (on your phone too), then `/streams phone`' }
}

/** Sends the bridge this session's streams when they changed (or as a heartbeat); quiet when no bridge runs. */
async function pushPhone($: $) {
  const now = await $.clock.now()
  if (!phoneSession || now < phoneRetryAt) return
  const [streams, busy, agents, rows, updates, loops] = await Promise.all([
    read($, streamsA),
    read($, busyA),
    read($, agentsA),
    read($, rowsA),
    read($, updatesA),
    read($, loopsA),
  ])
  if (now - phoneGit.at >= HEARTBEAT_MS) {
    const r = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 }).catch(() => undefined)
    phoneGit = { lines: r?.exitCode === 0 ? gitStatus(r.stdout) : [], at: now }
  }
  const lines = await streamStatus($, streams, await healthNow($, streams), now)
  const limits = ((await $.session.usage().catch(() => undefined))?.rateLimits ?? []).map(l => limitView(l, now))
  const snap = snapshotOf({
    session: { ...phoneSession, busy },
    lines,
    streams,
    colorOf,
    loops,
    agents: Object.values(agents),
    rows,
    status: [...phoneGit.lines, ...(await ticketStatus($, lines, now))],
    limits,
    updates,
    permissions: [...heldPermissions.values()].map(h => h.ask),
    now,
  })
  // The send time is left out of the comparison: only a change in what the phone draws is news.
  const body = JSON.stringify({ ...snap, at: 0 })
  if (!isDue(body, phoneLast, now)) return
  const sent = await $.http
    .fetch(`http://bridge/sessions/${encodeURIComponent(phoneSession.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snap),
      socketPath: BRIDGE_SOCKET,
    })
    .then(r => r.ok)
    .catch(() => false)
  if (sent) phoneLast = { body, at: now }
  else phoneRetryAt = now + RETRY_MS
  if (sent || phoneLast.at) await takeCommands($)
}

/** Fetches what the phone asked of this session since the last tick, and does it. */
async function takeCommands($: $) {
  if (!phoneSession || (await $.clock.now()) < phoneRetryAt) return
  const reply = await $.http
    .fetch(`http://bridge/sessions/${encodeURIComponent(phoneSession.id)}/commands`, { socketPath: BRIDGE_SOCKET })
    .then(r => (r.ok ? r.text : ''))
    .catch(() => '')
  const { commands, isPhoneActive: active } = commandsOf(reply)
  isPhoneActive = active
  for (const c of commands) await doCommand($, c).catch(err => $.ui.log(`phone command ${c.kind} failed: ${String(err)}`))
}

/** One thing the phone asked: an answer filed in its stream, a stop, or a permission decided. */
async function doCommand($: $, c: PhoneCommand) {
  if (c.kind === 'permission') {
    heldPermissions.get(c.requestId)?.answer(c.decision)
    return
  }
  if (c.kind === 'stop') {
    if (runningTurn) await $.turn.abort({ turnId: runningTurn })
    return
  }
  // The stream is made current first, so the answer is filed where it was asked, as the phone's yes is.
  if ((await read($, streamsA)).some(st => st.id === c.streamId)) await update($, currentA, () => c.streamId)
  await $.prompt.submit({ text: c.text, asUser: true })
}

export const register: Register = (on, options) => {
  isDiagnosing = options.diagnostics === true
  defaultStyle = options.chatStyle === 'compact' ? 'compact' : 'full'

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(storeKey(e.cwd))) as Saved | undefined
    if (saved && (await read($, streamsA)).length === 0) {
      await update($, streamsA, () => saved.streams)
      await update($, rowsA, () => saved.rows)
      await update($, loopStreamA, () => saved.loopStream)
    }
    await $.command.register({ name: 'streams', description: 'Open the streams navigator' })
    await $.command.register({
      name: 'stream',
      description: 'Focus a stream (/stream <name>), or show everything again (/stream off)',
    })
    await paintStreams($)
    await refreshStatus($)
    // Rows filed under an older key scheme are not found by today's lookups: file the history again.
    if ((await read($, keyVersionA)) !== KEY_VERSION) {
      await update($, historyFiledA, () => false)
      await update($, keyVersionA, () => KEY_VERSION)
    }
    const transcript = await read($, transcriptA)
    if (transcript && !(await read($, historyFiledA))) work($, { kind: 'import', path: transcript, isCurrent: true })
    const pane = (await $.store.get(PANE_KEY)) as PaneSaved | undefined
    if (pane?.collapsed) await update($, paneCollapsedA, () => true)
    else if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Streams' })
    $.clock.every(5000, () => void beat($).catch(() => {}))
    if (e.isInteractive) {
      void checkUpdates($).catch(() => {})
      $.clock.every(CHECK_EVERY_MS, () => void checkUpdates($).catch(() => {}))
      // The phone bridge, installed and kept current from here, shows these streams on the phone.
      void ensureBridge($)
        .then(b => (b.said.startsWith('installed') ? $.ui.toast('Phone bridge installed: /streams phone pairs your phone') : undefined))
        .catch(() => {})
      phoneSession = await phoneSessionOf($, e.cwd).catch(() => undefined)
      $.clock.every(PUSH_EVERY_MS, () => void pushPhone($).catch(() => {}))
    }
    work($)
    return next(e)
  })

  // A phone joining the session gets the streams accordion without asking for it.
  on('session.attach', { surface: 'mobile' }, async ($, e, next) => {
    const r = await next(e)
    void $.ui.open({ id: PANE, title: 'Streams' }).catch(() => {})
    return r
  })

  on('command.run', { command: 'streams' }, async ($, e) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb === 'import') return { text: await importCommand($, rest.join(' ')) }
    if (verb === 'status') {
      await openStatus($)
      return { text: 'Status card shown above the prompt.' }
    }
    if (verb === 'update') {
      await checkUpdates($, true)
      return { text: await applyUpdates($) }
    }
    if (verb === 'phone' && rest[0] === 'relay') {
      // `/streams phone relay <url>` sends the phone through a hosted relay, sealed end to end; `off` goes back to Tailscale.
      const url = rest[1] ?? ''
      const home = (await $.process.run(['/usr/bin/printenv', 'HOME'], { timeoutMs: 5000 }).catch(failed)).stdout.trim()
      const uid = (await $.process.run(['/usr/bin/id', '-u'], { timeoutMs: 5000 }).catch(failed)).stdout.trim()
      if (!home || !uid) return { text: 'Could not find your home folder.' }
      if (url !== 'off' && !/^https?:\/\/[^\s]+$/.test(url)) return { text: 'Usage: `/streams phone relay https://relay.example.com`, or `/streams phone relay off`.' }
      await $.fs.write(`${home}/.claudeflow/relay-url`, url === 'off' ? '' : `${url}\n`)
      await $.process.run(['/bin/launchctl', 'kickstart', '-k', `gui/${uid}/${BRIDGE_LABEL}`], { timeoutMs: 10_000 }).catch(failed)
      return { text: url === 'off' ? 'Phone relay off: the bridge serves your phone over Tailscale again.' : `Phone relay set to ${url}. Run \`/streams phone\` to pair your phone through it.` }
    }
    if (verb === 'phone') {
      const bridge = await ensureBridge($)
      phoneRetryAt = 0
      const tailnet = bridge.ok ? await ensureTailnet($, bridge.home) : { said: 'waits for the bridge' }
      const lines = [`Phone bridge: ${bridge.said}.`, `Tailscale: ${tailnet.said}.`]
      if (bridge.ok) {
        // The pairing page opens on this Mac, already paired, and shows the phone's link as a QR code. It opens at a
        // `.localhost` name, which browsers send to this Mac: another VPN on the Mac can keep it off its own tailnet name.
        const token = await $.fs.read(`${bridge.home}/.claudeflow/bridge-token`).then(t => String(t).trim()).catch(() => '')
        const opened = token
          ? await $.process.run(['/usr/bin/open', `http://claudeflow.localhost:${BRIDGE_PORT}/?t=${token}&next=/pair`], { timeoutMs: 10_000 }).catch(failed)
          : undefined
        lines.push(
          opened?.exitCode === 0
            ? 'Opened the pairing page in your browser: scan its QR code with your phone, then Add to Home Screen.'
            : 'Run `! bun ~/.claudeflow/bridge/server.ts pair` for the pairing link.',
        )
      }
      return { text: lines.join('\n') }
    }
    await update($, paneCollapsedA, () => false)
    const opened = await $.ui.open({ id: PANE, title: 'Streams', focus: true })
    await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
    const surfaces = await $.session.surfaces().catch(() => [] as const)
    const where = `Attached: ${surfaces.join(', ') || 'none reported'}. Pane ${opened.isPlaced ? 'drawn' : `waiting: ${opened.reason}`}.`
    return { text: `Streams navigator opened. ${where} \`/streams import\` files a past session of this project into streams.` }
  })

  on('command.run', { command: 'stream' }, async ($, e) => {
    const arg = e.args.trim()
    if (!arg) {
      const streams = await read($, streamsA)
      return { text: streams.length ? streams.map(s => `${s.id}: ${s.summary}`).join('\n') : 'No streams yet.' }
    }
    if (arg === 'off') {
      await focusOn($, '')
      return { text: 'Showing every stream.' }
    }
    const move = /^move\s+(.+)$/.exec(arg)
    if (move?.[1]) return { text: await moveLast($, move[1]) }
    const id = await ensureStream($, arg, '')
    await update($, currentA, () => id)
    await update($, viewA, () => id)
    await focusOn($, id)
    return { text: `Focused on ${id}. Rows from other streams collapse; ctrl+o expands them.` }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, tagHintA, () => null)
    // From the phone the card only helps where the app draws it; otherwise the question goes to Claude as asked.
    const phoneDraws = e.origin.kind === 'bridge' && (await $.session.surfaces().catch((): readonly string[] => [])).includes('mobile')
    if (STATUS_ASK.test(e.text) && (e.origin.kind === 'composer' || phoneDraws)) {
      await openStatus($)
      if (phoneDraws) void $.ui.open({ id: PANE, title: 'Streams' }).catch(() => {})
      return { drop: 'status shown above the prompt' }
    }
    await update($, statusOpenA, () => false)
    let text = e.text
    let id: string
    pendingKind = 'prompt'
    const tag = parseTag(text)
    if (tag) {
      id = await ensureStream($, tag.name, oneLine(tag.rest, 120))
      text = tag.rest
    } else if (e.origin.kind === 'scheduled-trigger') {
      const key = loopKey(text)
      const known = (await read($, loopStreamA))[key]
      id = known ?? (await classify($, text))
      if (!known) await update($, loopStreamA, m => ({ ...m, [key]: id }))
      await touch($, id, s => ({ loops: s.loops + 1 }))
      pendingKind = 'loop'
    } else if (e.origin.kind === 'task-notification') {
      id = await streamOfNotification($, text)
      pendingKind = 'notice'
    } else {
      id = await classify($, text)
    }
    if (!id) return next(text === e.text ? e : { ...e, text })
    if ((await read($, streamsA)).find(s => s.id === id)?.archived) {
      await setArchived($, id, false)
      $.ui.toast(`stream ${id} restored: a new prompt belongs to it`)
    }
    if (e.turnId && e.origin.kind !== 'task-notification') {
      // Sent mid-turn: filed in its own stream now (its row is an attachment the recorder skips),
      // and the running turn keeps its stream; replies are split between them as they come.
      const now = await $.clock.now()
      await update($, foldedA, list => [...list, { streamId: id, text }])
      await update($, rowsA, list => [...list, { id: `q:${now}`, streamId: id, kind: 'prompt' as const, text, at: now }].slice(-MAX_ROWS))
      await touch($, id, s => ({ rows: s.rows + 1 }))
    } else {
      await update($, currentA, () => id)
      await touch($, id)
      await refreshStatus($)
    }
    return next(text === e.text ? e : { ...e, text })
  }).catch(($, e, next) => next(e))

  // The prompt hook is the one place the transcript's path is named: keep it, and file the history once.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.transcript_path) await update($, transcriptA, () => e.transcript_path)
    if (e.transcript_path && !(await read($, historyFiledA)) && !jobs.some(j => j.kind === 'import')) {
      work($, { kind: 'import', path: e.transcript_path, isCurrent: true })
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const map = await read($, agentStreamA)
    const sid = (e.parentAgentId && map[e.parentAgentId]) || (await read($, currentA))
    pendingSpawn = sid
    const r = await next(e)
    // The agent has started: a failure here must not fail the hook (a .catch would spawn it twice).
    if (r.agentId && sid) {
      const agentId = r.agentId
      const now = await $.clock.now()
      const run: AgentRun = { id: agentId, streamId: sid, description: e.description || e.subagentType, status: 'running', startedAt: now, lastAt: now, last: 'starting', tools: 0 }
      await update($, agentStreamA, m => ({ ...m, [agentId]: sid }))
        .then(() => update($, liveA, m => ({ ...m, [agentId]: sid })))
        .then(() => update($, agentsA, m => ({ ...m, [agentId]: run })))
        .then(() => touch($, sid, s => ({ agents: s.agents + 1 })))
        .catch(err => $.ui.log(`streams: could not file an agent: ${String(err)}`))
    }
    return r
  })

  // While the phone has the page open, a permission prompt goes to it first; unanswered, it comes to the Mac as usual.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (verdict.decision !== 'ask' || !isPhoneActive || !id) return verdict
    const ask: PendingPermission = { id, tool: e.tool, summary: permissionSummary(e.tool, e.input), at: await $.clock.now() }
    let answer: (d: 'allow' | 'deny') => void = () => {}
    const answered = new Promise<'allow' | 'deny'>(resolve => (answer = resolve))
    heldPermissions.set(id, { ask, answer })
    // Sent on the next tick, not after the heartbeat: the phone shows the prompt within two seconds.
    phoneLast = { body: '', at: phoneLast.at }
    try {
      const decision = await Promise.race([answered, $.clock.sleep(PHONE_PERMISSION_MS).then(() => undefined)])
      return decision ? { ...verdict, decision, reason: `${decision === 'allow' ? 'Allowed' : 'Denied'} on your phone` } : verdict
    } finally {
      heldPermissions.delete(id)
      phoneLast = { body: '', at: phoneLast.at }
    }
  })

  on('tool.call', async ($, e, next) => {
    const sid = await inStream($, e.agentId)
    if (sid) await noteLoop($, sid, String(e.tool), e as unknown as LoopArgs).catch(() => {})
    const bump = (d: number) => (sid ? update($, inflightA, m => ({ ...m, [sid]: Math.max(0, (m[sid] ?? 0) + d) })) : Promise.resolve())
    await bump(1)
    try {
      return await next(e)
    } finally {
      await bump(-1).catch(() => {})
    }
  })

  on('session.append', async ($, e, next) => {
    const r = await next(e)
    // The row is stored by now: a failure here must not fail the hook (a .catch would append it twice).
    await record($, e, e.uuid).catch(err => $.ui.log(`streams: could not file a row: ${String(err)}`))
    return r
  })

  on('turn.start', async ($, e, next) => {
    runningTurn = e.turnId
    await update($, busyA, () => true)
    const startedAt = await $.clock.now()
    await update($, turnStartedAtA, () => startedAt)
    const sid = await read($, currentA)
    if (sid) await update($, outcomeA, ({ [sid]: _, ...rest }) => rest)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.turnId === runningTurn) runningTurn = ''
    // A subagent's run is one turn of its loop: its end is the agent's end.
    const agentId = e.agentId
    if (agentId) {
      await update($, liveA, ({ [agentId]: _, ...rest }) => rest)
      const endedAt = await $.clock.now()
      const status: AgentRun['status'] = e.reason === 'answer' ? 'done' : 'error'
      await update($, agentsA, m => (m[agentId] ? { ...m, [agentId]: { ...m[agentId], status, endedAt } } : m))
    }
    if (!e.agentId) {
      await update($, foldedA, () => [])
      const sid = await read($, currentA)
      if (sid) await update($, outcomeA, m => ({ ...m, [sid]: e.reason }))
      await update($, busyA, () => false)
      await save($)
    }
    return r
  })

  // The shortcut bar: every stream a colour-coded pill, its colour the heartbeat's verdict.
  // `#` at the start of the prompt completes stream names: the bar lists the matches, Tab takes the first,
  // and a tag naming a known stream is painted in that stream's colour.
  on('prompt.edit', async ($, e, next) => {
    const streams = await read($, streamsA)
    const typing = partialTag(e.text, e.cursor)
    if (e.key?.key === 'tab' && !e.key.shift && typing !== undefined) {
      const [first] = tagMatches(streams, typing)
      if (first) {
        await update($, tagHintA, () => null)
        return completeTag(e.text, e.cursor, first)
      }
    }
    const box = await next(e)
    const partial = partialTag(box.text, box.cursor)
    const matches = partial === undefined ? [] : tagMatches(streams, partial)
    await update($, tagHintA, () => (partial === undefined ? null : { partial, matches }))
    const named = /^\s*#([\w-]+)/.exec(box.text)
    const known = named?.[1] && streams.find(s => s.id === named[1])
    if (!named || !known) return box
    const start = box.text.indexOf('#')
    return { ...box, decorations: [...(box.decorations ?? []), { start, end: start + named[0].trim().length, color: colorOf(known), bold: true }] }
  })

  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.element && (await read($, statusOpenA))) await update($, statusOpenA, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [streams, focus, live] = await Promise.all([read($, streamsA), read($, focusA), read($, liveA)])
    const health = await healthNow($, streams)
    const hint = await read($, tagHintA)
    if (hint && !e.props.hasSurvey) {
      const { Box, Text } = $.ui.resolve(e)
      if (hint.matches.length === 0)
        return <Text dimColor>{`#${hint.partial}  new stream`}</Text>
      return (
        <Box gap={1}>
          <Text dimColor>{`#${hint.partial} →`}</Text>
          {hint.matches.map((id, i) => {
            const s = streams.find(x => x.id === id)
            return (
              <Text key={`tag:${id}`} color={s ? colorOf(s) : undefined} bold={i === 0}>
                {id}
              </Text>
            )
          })}
          <Text dimColor>tab to complete</Text>
        </Box>
      )
    }
    if (!e.props.hasSurvey && e.surface !== 'mobile' && (await read($, statusOpenA))) {
      const { Box, Button, Text } = $.ui.resolve(e)
      await read($, tickA)
      const now = await $.clock.now()
      const git: StatusLine[] = await read($, statusGitA)
      const streamLines = await streamStatus($, streams, health, now)
      const tickets = (await ticketStatus($, streamLines, now)).slice(0, TICKET_ROWS)
      const lines = [...git, ...tickets, ...streamLines]
      const shown = lines.slice(0, STATUS_ROWS + tickets.length)
      const limits = ((await $.session.usage().catch(() => undefined))?.rateLimits ?? []).map(l => limitView(l, now))
      const width = e.props.bodyColumns
      const areaW = Math.min(24, Math.max(10, ...shown.map(l => l.area.length + 2)))
      // 16: room for a limit's bar and percent (`▰▰▰▰▱▱▱▱▱▱ 38%`).
      const stateW = Math.min(28, Math.max(limits.length ? 16 : 8, ...shown.map(l => l.state.length + 2)))
      const close = () => update($, statusOpenA, () => false)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="#8b949e" paddingX={1}>
          <Box key="st-title" gap={1}>
            <Text bold>Status</Text>
            <Text dimColor>
              {streams.filter(s => !s.archived).length} streams · {new Date(now).toTimeString().slice(0, 5)}
            </Text>
            <Text dimColor>· ctrl+x tab, then ↑↓ scroll · q close</Text>
            <Box flexGrow={1} />
            <Button key="status-close" plain dimColor label="✕ close" hotkey="q" onPress={close} />
          </Box>
          <Box key="st-head">
            <Box width={areaW} flexShrink={0}>
              <Text dimColor bold>Area</Text>
            </Box>
            <Box width={stateW} flexShrink={0}>
              <Text dimColor bold>State</Text>
            </Box>
            <Text dimColor bold>Detail</Text>
          </Box>
          {shown.flatMap((l, i) => {
            // With tickets on the card, tickets and streams each get a heading; without, the card reads as before.
            const heading =
              tickets.length && (l.id.startsWith('ticket:') ? i === git.length : i === git.length + tickets.length) ? (
                <Box key={`st-h:${l.id}`} marginTop={1}>
                  <Text bold color="#d0bfff">{l.id.startsWith('ticket:') ? 'Tickets' : 'Streams'}</Text>
                </Box>
              ) : null
            const isStream = !l.id.startsWith('git:') && !l.id.startsWith('ticket:')
            const s = isStream ? streams.find(x => x.id === l.id) : undefined
            return [
              heading,
              <Box key={`st:${l.id}`}>
                <Box width={areaW} flexShrink={0}>
                  {s ? (
                    <Button
                      key={`st-open:${l.id}`}
                      plain
                      hover={{ bold: true }}
                      label={oneLine(l.area, areaW - 2)}
                      onPress={async () => {
                        await openStream($, l.id)
                        await $.ui.open({ id: PANE, title: 'Streams' })
                      }}
                    />
                  ) : (
                    <Text wrap="truncate">{l.area}</Text>
                  )}
                </Box>
                <Box width={stateW} flexShrink={0}>
                  <Text wrap="truncate" bold={!!l.kind} color={l.kind ? STATE_COLOR[l.kind] : '#a5d8ff'}>
                    {l.state}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="wrap">{oneLine(l.detail, Math.max(20, (width - areaW - stateW) * (l.id.startsWith('ticket:') ? 3 : 2)))}</Text>
                </Box>
              </Box>,
            ]
          })}
          {lines.length > shown.length ? <Text dimColor>+{lines.length - shown.length} more in the streams pane</Text> : null}
          {lines.length === 0 ? <Text dimColor>Nothing yet: streams appear as you prompt.</Text> : null}
          {limits.length ? (
            <Box key="limits" flexDirection="column" marginTop={1}>
              {limits.map(l => (
                <Box key={`limit:${l.label}`}>
                  <Box width={areaW} flexShrink={0}>
                    <Text dimColor>{`Limit ${l.label}`}</Text>
                  </Box>
                  <Box width={stateW} flexShrink={0}>
                    <Text color={limitColor(l.percent)} bold>
                      {`${l.bar} ${l.percent}%`}
                    </Text>
                  </Box>
                  <Text>{l.resetsIn ? `resets in ${l.resetsIn}` : ''}</Text>
                  <Text dimColor>{l.resetsAt ? ` · ${l.resetsAt}` : ''}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    }
    if (e.props.hasSurvey) return next(e)
    if (!streams.some(s => !s.archived)) return (await updateControl($, e)) ?? next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const pills: { s: Stream; label: string; health: Health }[] = []
    let used = 16
    for (const [i, s] of streams.filter(s => !s.archived).sort((a, b) => b.lastAt - a.lastAt).slice(0, 9).entries()) {
      const verdict = health[s.id] ?? 'idle'
      const n = Object.values(live).filter(id => id === s.id).length
      const label = `${s.id}${n ? ` ⟳${n}` : ''}${focus === s.id ? ' ◉' : ''}`
      if (used + label.length + 8 > width) break
      used += label.length + 8
      pills.push({ s, label, health: verdict })
    }
    const updateButton = await updateControl($, e)
    const pick = async (id: string) => {
      await openStream($, focus === id ? '' : id)
      await $.ui.open({ id: PANE, title: 'Streams' })
    }
    const now = await $.clock.now()
    const loops = Object.fromEntries(Object.entries(await read($, loopsA)).filter(([, l]) => !lapsed(l, now)))
    return (
      <Box gap={1}>
        <Button key="all" plain label={focus ? 'all' : 'all ◉'} hotkey="0" onPress={() => focusOn($, '')} />
        {pills.map((pill, i) => {
          // A pending loop lights its pill like running work: something is going to move there.
          const kind: BadgeKind = loops[pill.s.id] && pill.health !== 'running' && pill.health !== 'error' ? 'loop' : pill.health
          return (
            <Box key={`pill:${pill.s.id}`} gap={0}>
              <Button key={`chip:${pill.s.id}`} plain label={String(i + 1)} hotkey={String(i + 1)} onPress={() => pick(pill.s.id)} />
              <Text backgroundColor={BADGE_BG[kind]} color={BADGE_FG[kind]} bold={kind === 'running' || kind === 'loop'}>
                {' '}
                {kind === 'loop' ? '↻' : HEALTH_GLYPH[pill.health]} {pill.label}{' '}
              </Text>
            </Box>
          )
        })}
        <Button key="status" plain label="status" hotkey="t" onPress={() => openStatus($, e.requestId)} />
        {updateButton}
        {(await read($, paneCollapsedA)) ? (
          <Box key="tab-box" flexGrow={1} justifyContent="flex-end">
            <Button key="tab" label="◂ streams" hotkey="s" onPress={() => expandPane($, true)} />
          </Box>
        ) : (
          <Button key="pane" plain label="≡" hotkey="s" onPress={() => expandPane($, true)} />
        )}
        {pills.length === 0 ? <Text dimColor>widen the terminal to see streams</Text> : null}
      </Box>
    )
  })

  // Collapse: with a stream focused, rows of other streams shrink to one dim line.
  // Every transcript row of a stream wears its colour down the left; with a stream focused, other streams' rows shrink to a stub.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const sid = await streamOf($, e.requestId)
    if (sid) noteMatched('UserMessage', e.requestId)
    else noteUnmatched('UserMessage', e.requestId, e.props.text)
    if (!e.props.isExpanded && (await isHidden($, sid))) return stripe($, e, sid, stub($, e, sid, oneLine(e.props.text, 70)))
    return stripe($, e, sid, await next(e))
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const sid = (await streamOf($, e.requestId)) || (await streamOf($, textKey(e.props.text)))
    if (sid) noteMatched('AssistantMessage', e.requestId)
    else noteUnmatched('AssistantMessage', e.requestId, e.props.text)
    if (await isHidden($, sid)) return stripe($, e, sid, stub($, e, sid, oneLine(e.props.text, 70)))
    return stripe($, e, sid, await next(e))
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const first = e.props.calls.find(c => c.tool_use_id)?.tool_use_id
    const sid = first ? await streamOf($, first) : ''
    if (!e.props.isExpanded && (await isHidden($, sid))) return stripe($, e, sid, stub($, e, sid, `${e.props.calls.length} tool calls`))
    return stripe($, e, sid, await next(e))
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const sid = await streamOf($, e.props.tool_use_id)
    if (await isHidden($, sid)) return stripe($, e, sid, stub($, e, sid, e.props.tool))
    return stripe($, e, sid, await next(e))
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    timedPane($, e, async () => {
    const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
    const [streams, view, focus, health, showArchived, agents, fold, busy, current, turnStartedAt, outcome] = await Promise.all([
      read($, streamsA),
      read($, viewA),
      read($, focusA),
      Promise.resolve({} as Record<string, Health>),
      read($, showArchivedA),
      read($, agentsA),
      read($, foldA),
      read($, busyA),
      read($, currentA),
      read($, turnStartedAtA),
      read($, outcomeA),
    ])
    const filing = await read($, importProgressA)
    // Read only to move the clocks: it changes once a second while something runs.
    await read($, tickA)
    Object.assign(health, await healthNow($, streams))
    const now = await $.clock.now()
    const loops = Object.fromEntries(Object.entries(await read($, loopsA)).filter(([, l]) => !lapsed(l, now)))
    const width = Math.max(20, e.props.bodyColumns)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 8)
    const shown = streams.find(s => s.id === view)
    const rows = await read($, rowsA)
    // Docked beside the transcript, the pane folds away to a tab in the bar and comes back at its width.
    const hideButton = e.props.placement === 'dock' ? <Button key="collapse" plain dimColor label="⇥ hide" hotkey="h" onPress={() => collapsePane($)} /> : null

    // Status words as bold coloured text: the pane's rows stay one Text per line, the shape known to paint.
    const badge = (kind: BadgeKind, text: string) => (
      <Text color={STATUS_WORD[kind]} bold>
        {text}
      </Text>
    )
    const loopBadge = (s: Stream) => {
      const loop = loops[s.id]
      if (!loop) return null
      return badge('loop', loop.kind === 'cron' ? `↻ LOOP ${loop.label}` : `↻ LOOP next ${clockOf(Math.max(0, loop.nextAt - now))}`)
    }

    const archiveButton = (s: Stream) =>
      s.archived ? (
        <Button key={`restore:${s.id}`} plain dimColor label="restore" onPress={() => setArchived($, s.id, false)} />
      ) : (
        <Button key={`archive:${s.id}`} plain dimColor label="✕" onPress={() => setArchived($, s.id, true)} />
      )

    // The work in a stream, live: its main turn and its subagents, yellow running, green done, red failed.
    const workOf = (s: Stream, limit: number) => {
      const lines: { key: string; status: AgentRun['status']; label: string; clock: string; last: string }[] = []
      if (s.id === current && (busy || outcome[s.id])) {
        const status = busy ? 'running' : outcome[s.id] === 'answer' ? 'done' : 'error'
        lines.push({ key: `main:${s.id}`, status, label: 'main turn', clock: busy ? clockOf(now - turnStartedAt) : '', last: '' })
      }
      const runs = Object.values(agents)
        .filter(a => a.streamId === s.id && (a.status === 'running' || now - (a.endedAt ?? a.lastAt) < 600_000))
        .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.lastAt - a.lastAt)
      for (const a of runs) {
        lines.push({
          key: `agent:${a.id}`,
          status: a.status,
          label: a.description,
          clock: clockOf((a.endedAt ?? now) - a.startedAt),
          last: a.status === 'running' ? (a.tools || a.last !== 'starting' ? `${a.tools} tools · ${a.last}` : 'starting up…') : '',
        })
      }
      return lines.slice(0, limit).flatMap(l => [
        <Text key={l.key} wrap="truncate">
          {'  '}
          {badge(l.status, `${STATUS_GLYPH[l.status]} ${l.status.toUpperCase()}${l.clock ? ` ${l.clock}` : ''}`)}
          <Text bold={l.status === 'running'} dimColor={l.status !== 'running'}>
            {'  '}
            {oneLine(l.label, 120)}
          </Text>
        </Text>,
        l.last ? (
          <Text key={`${l.key}:last`} color={STATUS_WORD.running} wrap="truncate">
            {'    ↳ '}
            {oneLine(l.last, width - 7)}
          </Text>
        ) : null,
      ])
    }

    const fullRow = (r: StreamRow, s: Stream) => {
      const who = r.agentId ? `[${r.agentId.slice(0, 6)}] ` : ''
      // Prompts and replies through the session's own markdown renderer; a tool call as its name
      // and one line, with the command, file or edit beneath in the engine's highlighter.
      if (r.kind === 'prompt' || r.kind === 'reply')
        return (
          <Box key={r.id} flexDirection="row" marginTop={1}>
            <Text bold color={r.kind === 'prompt' ? colorOf(s) : undefined}>
              {r.kind === 'prompt' ? '❯ ' : '⏺ '}
            </Text>
            <Box flexDirection="column" flexGrow={1}>
              {who ? <Text dimColor>{who}</Text> : null}
              <Markdown key={`md:${r.id}`} text={markdownOf(r.text)} />
            </Box>
          </Box>
        )
      if (r.kind === 'tool') {
        const cut = r.text.search(/[( ]/)
        const name = cut < 0 ? r.text : r.text.slice(0, cut)
        const rest = [cut < 0 ? '' : r.text.slice(cut).trim()]
        return (
          <Box key={r.id} flexDirection="column" marginTop={1}>
            <Text wrap="truncate">
              <Text color={STATUS_WORD.done}>⏺ </Text>
              <Text bold>{name}</Text>
              <Text dimColor>
                {rest[0]?.startsWith('(') && !who ? '' : ' '}
                {who}
                {oneLine(rest.join(' '), width - name.length - 4)}
              </Text>
            </Text>
            {r.code ? (
              <Box marginLeft={2}>
                <Code
                  source={r.code.source}
                  {...(r.code.language ? { language: r.code.language } : {})}
                  {...(r.code.path ? { path: r.code.path } : {})}
                  {...(r.code.format ? { format: r.code.format } : {})}
                />
              </Box>
            ) : null}
          </Box>
        )
      }
      return (
        <Text key={r.id} dimColor wrap="truncate">
          {GLYPH[r.kind]} {who}
          {oneLine(r.text, width)}
        </Text>
      )
    }

    // The phone: an accordion of colour-bordered cards, what needs the person first; one card open at a time.
    if (e.surface === 'mobile') {
      const { Svg } = $.ui.resolve(e as PaneRender & { surface: 'mobile' })
      const openId = await read($, mobileOpenA)
      const lines = await streamStatus($, streams, health, now)
      const counts = (['running', 'waiting', 'loop', 'error', 'done'] as const)
        .map(k => ({ k, n: lines.filter(l => l.kind === k).length }))
        .filter(c => c.n)
      const toggle = (id: string) => update($, mobileOpenA, v => (v === id ? '' : id))
      // The status card, on the phone, heads the accordion: the pane scrolls by touch.
      const isStatus = await read($, statusOpenA)
      const statusRows: StatusLine[] = isStatus ? [...(await read($, statusGitA)), ...(await ticketStatus($, lines, now)).slice(0, TICKET_ROWS)] : []
      const limits = isStatus ? ((await $.session.usage().catch(() => undefined))?.rateLimits ?? []).map(l => limitView(l, now)) : []
      return (
        <Box flexDirection="column">
          {await updateControl($, e)}
          {isStatus ? (
            <Box key="m-status" flexDirection="column" borderStyle="round" borderColor="#8b949e" paddingX={1} marginBottom={1}>
              <Box gap={1}>
                <Text bold>Status</Text>
                <Button key="m-status-close" plain dimColor label="✕ close" onPress={() => update($, statusOpenA, () => false)} />
              </Box>
              {statusRows.map(l => (
                <Box key={`m-st:${l.id}`} flexDirection="column" marginTop={1}>
                  <Box gap={1}>
                    <Text bold>{l.area}</Text>
                    <Text bold color={l.kind ? STATE_COLOR[l.kind] : '#a5d8ff'}>{l.state}</Text>
                  </Box>
                  <Text dimColor>{oneLine(l.detail, 240)}</Text>
                </Box>
              ))}
              {limits.map(l => (
                <Box key={`m-limit:${l.label}`} flexDirection="column" marginTop={1}>
                  <Box gap={1}>
                    <Text dimColor>{`Limit ${l.label}`}</Text>
                    <Text color={limitColor(l.percent)} bold>{`${l.bar} ${l.percent}%`}</Text>
                  </Box>
                  <Text dimColor>{l.resetsIn ? `resets in ${l.resetsIn} · ${l.resetsAt}` : ''}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
          <Box gap={1}>
            <Text bold>Streams</Text>
            <Text dimColor>{lines.length} live</Text>
            {isStatus ? null : <Button key="m-status-open" plain label="status" onPress={() => openStatus($)} />}
            {openId ? <Button key="m-collapse" plain dimColor label="collapse all" onPress={() => update($, mobileOpenA, () => '')} /> : null}
          </Box>
          <Box gap={1} flexWrap="wrap" marginTop={1}>
            {counts.map(c => (
              <Text key={`chip:${c.k}`} backgroundColor={MOBILE_BG[c.k]} color={MOBILE_FG[c.k]} bold>
                {` ${MOBILE_GLYPH[c.k]} ${c.n} ${c.k} `}
              </Text>
            ))}
          </Box>
          {lines.length === 0 ? <Text dimColor>Streams appear as you prompt.</Text> : null}
          {lines.map(l => {
            const s = streams.find(x => x.id === l.id)
            if (!s) return null
            const kind: StatusKind = l.kind ?? 'idle'
            const isOpen = openId === s.id
            const question = kind === 'waiting' ? l.detail : ''
            return (
              <Box key={`m:${s.id}`} flexDirection="column" borderStyle="round" borderColor={colorOf(s)} paddingX={1} marginTop={1}>
                <Box gap={1}>
                  <Svg source={iconSvg(kind, colorOf(s))} alt={kind} width={28} height={28} {...(kind === 'running' ? { isInteractive: true as const } : {})} />
                  <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                    <Button key={`m-open:${s.id}`} plain label={`${isOpen ? '▾' : '▸'} ${s.name}`} onPress={() => toggle(s.id)} />
                    {question ? null : <Text dimColor wrap="truncate">{oneLine(l.detail, 80)}</Text>}
                  </Box>
                  <Text backgroundColor={MOBILE_BG[kind]} color={MOBILE_FG[kind]} bold>
                    {` ${kind === 'waiting' ? 'WAITING' : l.state} `}
                  </Text>
                </Box>
                {question ? (
                  <Box flexDirection="column" borderStyle="round" borderColor={MOBILE_BG.waiting} paddingX={1} marginTop={1}>
                    <Text>{question}</Text>
                    <Box gap={2}>
                      <Button key={`m-yes:${s.id}`} label="yes" onPress={() => answerYes($, s.id)} />
                      {isOpen ? null : <Button key={`m-see:${s.id}`} plain label="open stream" onPress={() => toggle(s.id)} />}
                    </Box>
                  </Box>
                ) : null}
                {isOpen ? (
                  <Box flexDirection="column">
                    {workOf(s, 6)}
                    {rows
                      .filter(r => r.streamId === s.id)
                      .slice(-MOBILE_ROWS)
                      .map(r => fullRow(r, s))}
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      )
    }

    if (shown) {
      const verdict = health[shown.id] ?? 'idle'
      const activity = workOf(shown, 8)
      const style: ChatStyle = (await read($, chatStyleA)) || defaultStyle
      // Full rows run several lines each, so fewer of them fit; the pane scrolls for the rest.
      const own = rows.filter(r => r.streamId === shown.id).slice(style === 'full' ? -FULL_ROWS : -Math.max(3, room - activity.length * 2))
      const nextStyle: ChatStyle = style === 'full' ? 'compact' : 'full'
      return (
        <Box flexDirection="column">
          <Box gap={2}>
            <Button key="back" plain label="← all streams" onPress={() => openStream($, '')} />
            {hideButton}
          </Box>
          <Box gap={1} marginTop={1}>
            <Text color={HEALTH_TEXT[verdict]}>{HEALTH_GLYPH[verdict]}</Text>
            <Text bold color={colorOf(shown)}>
              {shown.name}
            </Text>
            <Text dimColor>│ view</Text>
            {(['full', 'compact'] as const).map(s => (
              // Both choices always drawn, the current one lit: `v` switches to the other.
              <Button
                key={`style:${s}`}
                plain
                dimColor={s !== style}
                label={`${s === style ? '◉' : '○'} ${s}`}
                {...(s === nextStyle ? { hotkey: 'v' } : {})}
                onPress={() => update($, chatStyleA, () => s)}
              />
            ))}
            {archiveButton(shown)}
          </Box>
          <Text wrap="truncate">
            {badge(verdict, verdict.toUpperCase())}
            {loops[shown.id] ? '  ' : ''}
            {loopBadge(shown)}
          </Text>
          <Text dimColor wrap="truncate">{oneLine(shown.summary, width) || ' '}</Text>
          {activity}
          {own.length === 0 && <Text dimColor>Nothing recorded yet.</Text>}
          {style === 'compact' &&
            own.map(r => (
              <Text key={r.id} dimColor={r.kind === 'tool' || r.kind === 'notice'} wrap="truncate">
                {GLYPH[r.kind]} {r.agentId ? `[${r.agentId.slice(0, 6)}] ` : ''}
                {oneLine(r.text, width)}
              </Text>
            ))}
          {style === 'full' && own.map(r => fullRow(r, shown))}
        </Box>
      )
    }

    const byRecent = [...streams].sort((a, b) => b.lastAt - a.lastAt)
    const active = byRecent.filter(s => !s.archived)
    const archived = byRecent.filter(s => s.archived)
    // Folded by hand wins; otherwise an idle stream shows its header alone and the rest share the pane.
    const foldOf = (s: Stream): Fold => fold[s.id] ?? ((health[s.id] ?? 'idle') === 'idle' ? 'none' : 'all')
    const open = active.filter(s => foldOf(s) === 'all').length
    const perStream = Math.max(2, Math.floor(room / Math.max(1, open)) - 3)
    const card = (s: Stream, isArchived: boolean) => {
      const verdict = health[s.id] ?? 'idle'
      const f: Fold = isArchived ? 'none' : foldOf(s)
      const count = f === 'all' ? perStream : f === '10' ? 10 : f === '1' ? 1 : 0
      const recent = count ? rows.filter(row => row.streamId === s.id).slice(-count) : []
      return (
        <Box key={s.id} flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text backgroundColor={isArchived ? undefined : colorOf(s)}> </Text>
            <Text color={isArchived ? undefined : HEALTH_TEXT[verdict]} dimColor={isArchived}>
              {HEALTH_GLYPH[verdict]}
            </Text>
            <Button
              key={`open:${s.id}`}
              plain
              dimColor={isArchived}
              hover={{ color: colorOf(s), bold: true }}
              label={`${s.name}${focus === s.id ? ' ◉' : ''}`}
              onPress={() => openStream($, s.id)}
            />
            {isArchived ? null : (
              <Button key={`fold:${s.id}`} plain dimColor label={FOLD_LABEL[f]} onPress={() => update($, foldA, m => ({ ...m, [s.id]: NEXT_FOLD[f] }))} />
            )}
            {archiveButton(s)}
          </Box>
          <Text wrap="truncate">
            {isArchived ? <Text dimColor>{verdict}</Text> : badge(verdict, verdict.toUpperCase())}
            {!isArchived && loops[s.id] ? '  ' : ''}
            {isArchived ? null : loopBadge(s)}
            <Text dimColor>
              {' '}
              · {s.rows} rows · {s.agents} agents · {ago(now - s.lastAt)} ago
            </Text>
          </Text>
          {f === 'none' ? null : (
            <Box flexDirection="column">
              {s.summary ? <Text dimColor wrap="truncate">{oneLine(s.summary, width)}</Text> : null}
              {workOf(s, f === '1' ? 2 : 5)}
              {recent.map(row => (
                <Text key={row.id} color={row.kind === 'prompt' ? colorOf(s) : undefined} dimColor={row.kind !== 'prompt'} wrap="truncate">
                  {'  '}
                  {GLYPH[row.kind]} {oneLine(row.text, width - 4)}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {filing.total > 0 ? (
          <Text color={STATUS_WORD.running} bold wrap="truncate">
            ⟳ filing history: {filing.label}
            {filing.total > 1 ? ` ${filing.done}/${filing.total}` : '…'}
          </Text>
        ) : null}
        {await updateControl($, e)}
        <Box gap={1}>
          <Text dimColor>
            {active.length} streams · {focus ? `focused on ${focus}` : 'showing all'}
          </Text>
          {focus ? <Button key="unfocus" plain dimColor label="show all" onPress={() => focusOn($, '')} /> : null}
          {hideButton}
        </Box>
        <Box gap={1}>
          <Button key="fold-all" plain dimColor label="collapse all" onPress={() => update($, foldA, () => Object.fromEntries(active.map(s => [s.id, 'none' as const])))} />
          <Button key="unfold-all" plain dimColor label="expand all" onPress={() => update($, foldA, () => Object.fromEntries(active.map(s => [s.id, 'all' as const])))} />
        </Box>
        {active.length === 0 && <Text dimColor>Streams appear as you prompt. Tag one by hand with #name.</Text>}
        {active.map(s => card(s, false))}
        {archived.length > 0 ? (
          <Box marginTop={1}>
            <Button
              key="archived"
              plain
              dimColor
              label={`${showArchived ? '▾' : '▸'} archived (${archived.length})`}
              onPress={() => update($, showArchivedA, v => !v)}
            />
          </Box>
        ) : null}
        {showArchived ? archived.map(s => card(s, true)) : null}
      </Box>
    )
    }),
  )
}

const STATUS_WORD: Record<BadgeKind, string> = {
  running: '#ffd33d',
  loop: '#ffd33d',
  stalled: '#ff9500',
  done: '#7ee787',
  error: '#ff7b72',
  idle: '#8b949e',
}
/** The phone's badge colours: the pane's, and a blue for a stream waiting on the person. */
const MOBILE_BG: Record<StatusKind, string> = { ...BADGE_BG, waiting: '#79c0ff' }
const MOBILE_FG: Record<StatusKind, string> = { ...BADGE_FG, waiting: '#08203a' }
const MOBILE_GLYPH: Record<StatusKind, string> = { running: '●', loop: '↻', waiting: '?', error: '✗', stalled: '◌', done: '✓', idle: '○' }
/** Rows an open card shows on the phone. */
const MOBILE_ROWS = 12

/** A card's icon: a spinning ring while the stream runs, else a tile in its colour with the status glyph. */
const iconSvg = (kind: StatusKind, color: string): string =>
  kind === 'running'
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="11" stroke="#3a3a46" stroke-width="4" fill="none"/>' +
      '<circle cx="14" cy="14" r="11" stroke="#ffd33d" stroke-width="4" fill="none" stroke-dasharray="48 69" stroke-linecap="round">' +
      '<animateTransform attributeName="transform" type="rotate" from="0 14 14" to="360 14 14" dur="1.2s" repeatCount="indefinite"/></circle></svg>'
    : `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="${color}"/>` +
      `<text x="14" y="19" text-anchor="middle" font-family="-apple-system,Helvetica,sans-serif" font-size="14" font-weight="800" fill="#111">${MOBILE_GLYPH[kind]}</text></svg>`

/** The phone's one-tap answer: the stream is made current first, so the bare `yes` is filed where it was asked. */
async function answerYes($: $, id: string) {
  await update($, currentA, () => id)
  await $.prompt.submit({ text: 'yes', asUser: true })
}

/** The ⬆ update button while any installed plugin has a newer release; a progress word while one installs. */
async function updateControl($: $, e: Parameters<$['ui']['resolve']>[0]): Promise<RenderElement | null> {
  const [updates, updating] = await Promise.all([read($, updatesA), read($, updatingA)])
  const { Button, Text } = $.ui.resolve(e)
  if (updating) return <Text color={STATUS_WORD.running} bold>⟳ updating…</Text>
  if (!updates.length) return null
  const label = updates.length === 1 ? `⬆ update ${updates[0]?.id.split('@')[0]} ${updates[0]?.to}` : `⬆ update ${updates.length} plugins`
  return <Button key="update" label={label} hotkey="u" onPress={() => applyUpdates($)} />
}

/** The status card's state words: the pane's status colours, and a blue that asks for the person. */
const STATE_COLOR: Record<StatusKind, string> = { ...STATUS_WORD, waiting: '#79c0ff' }
/** Rows the status card shows before pointing to the pane. */
const STATUS_ROWS = 14
/** A limit's colour by how much of it is used: green, then yellow from half, red from 80%. */
const limitColor = (percent: number): string => (percent >= 80 ? '#ff7b72' : percent >= 50 ? '#ffd33d' : '#7ee787')
/** Tickets the status card shows, on top of its stream rows. */
const TICKET_ROWS = 8
const STATUS_TEXT: Record<AgentRun['status'], string> = { running: '#f2cc60', done: '#7ee787', error: '#ff7b72' }
const STATUS_GLYPH: Record<AgentRun['status'], string> = { running: '●', done: '✓', error: '✗' }

/** A tool row's code for the full chat style, as a spread: nothing when the tool has none. */
const withCode = (tool: string, input: unknown): { code?: StreamRow['code'] } => {
  const code = codeOf(tool, input)
  return code ? { code } : {}
}

/** Rows the full chat style draws in a stream's view; older ones stay in compact. */
const FULL_ROWS = 30

/** Markdown text within the element's bound, control characters but tab and newline removed. */
const markdownOf = (text: string): string => {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return clean.length <= 9000 ? clean : `${clean.slice(0, 9000)}\n\n…`
}

/** The `chatStyle` setting: how a stream's own view draws its rows until the pane's toggle says otherwise. */
let defaultStyle: ChatStyle = 'full'

const GLYPH: Record<StreamRowKind, string> = { prompt: '>', reply: '⏺', tool: '⎿', agent: '↳', loop: '↻', notice: '·' }

/** The stream a transcript row was filed in; '' when it was not. */
async function streamOf($: $, id: string): Promise<string> {
  const { value } = await $.state.get({ ...ROW, id: rowKey(id) })
  return value ?? ''
}

/** Whether focus on another stream shrinks this row to a stub. */
async function isHidden($: $, sid: string): Promise<boolean> {
  if (!sid) return false
  const focus = await read($, focusA)
  return focus !== '' && focus !== sid
}

const BAR = Array.from({ length: 400 }, () => '▏').join('\n')

type RowRender = Parameters<$["ui"]["resolve"]>[0]

/** The row as drawn, behind a one-cell strip of its stream's colour. Unfiled rows are left as they are. */
async function stripe($: $, e: RowRender, sid: string, tree: RenderElement): Promise<RenderElement> {
  if (!sid) return tree
  const { value } = await $.state.get({ ...COLOR, id: sid })
  const { Box } = $.ui.resolve(e)
  const { Text } = $.ui.resolve(e)
  // A thin glyph column laid over the row's left edge: absolute, so it takes the row's height and adds none.
  return (
    <Box flexDirection="row">
      <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden" flexDirection="column">
        <Text color={value ?? pastelOf(sid)}>{BAR}</Text>
      </Box>
      <Box marginLeft={2} flexGrow={1} flexShrink={1} flexDirection="column">
        {tree}
      </Box>
    </Box>
  )
}

function stub($: $, e: RowRender, streamId: string, gist: string): RenderElement {
  const { Text } = $.ui.resolve(e)
  return (
    <Text dimColor wrap="truncate">
      ▸ [{streamId}] {gist}
    </Text>
  )
}
