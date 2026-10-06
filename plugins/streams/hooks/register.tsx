import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { AgentRun, Folded, Health, Stream, StreamRow, StreamRowKind } from '../types'
import type { BadgeKind, Fold, HistoryItem } from './classify'
import {
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
const MAX_ROWS = 1500
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
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const agentStreamA = atom({ plugin: 'streams', key: 'agentStream' } as const, {})
const liveA = atom({ plugin: 'streams', key: 'live' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const healthA = atom({ plugin: 'streams', key: 'health' } as const, {})
const historyFiledA = atom({ plugin: 'streams', key: 'historyFiled' } as const, false)
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
  | { kind: 'import'; path: string }
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
      if (job.kind === 'import') await importHistory($, job.path)
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
  const recent = [...streams].sort((a, b) => b.lastAt - a.lastAt).slice(0, 15)
  const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt: buildPrompt(recent, current, text), maxTokens: 150 })
  const v = r.isAnswered ? parseVerdict(r.text, recent) : undefined
  if (!v) return current || ensureStream($, fallbackName(text), oneLine(text, 120))
  if (v.kind === 'new') return ensureStream($, v.name, v.summary)
  if (v.summary) await touch($, v.id, () => ({ summary: v.summary }))
  return v.id
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
          : { ...base, kind: 'tool', text: `${b.name} ${oneLine(JSON.stringify(b.input ?? {}), 100)}` },
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
  await writeDiagnostics($).catch(() => {})
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

/**
 * Files this session's transcript into streams: each turn's prompt is classified as it would be live, prompts
 * sent into a turn get their own streams, and the turn's replies are split between them in one model call.
 * It writes turn by turn and is marked done only at the end, so a reload mid-way simply starts it again:
 * every run first clears this session's rows from before it began, its own earlier partial run's included.
 */
async function importHistory($: $, path: string) {
  if (importing) return
  importing = true
  try {
    const [jsonl, { startedAt }, began] = await Promise.all([readWhole($, path), $.session.usage(), $.clock.now()])
    await update($, rowsA, list => list.filter(row => row.at < startedAt || row.at >= began))
    const turns = turnsOf(readTranscript(String(jsonl)).slice(-1500))
    let at = startedAt
    let n = 0
    for (const turn of turns) {
      // One turn that cannot be filed is skipped, not the whole history: it was cleared above.
      try {
        const rows: StreamRow[] = []
        const fileRow = async (item: HistoryItem, sid: string, kind: StreamRowKind, text: string) => {
          await fileAs($, item.kind === 'tool' ? item.id : item.uuid, sid)
          if (item.kind === 'reply') await fileAs($, textKey(item.text), sid)
          rows.push({ id: `h:${item.uuid}:${at}`, streamId: sid, kind, text, at: at++ })
        }
        const promptOf = async (text: string) => {
          const tag = parseTag(text)
          const rest = tag ? tag.rest : text
          return { rest, sid: tag ? await ensureStream($, tag.name, oneLine(rest, 120)) : await classify($, rest) }
        }
        const head = await promptOf(turn.prompt.text)
        const turnSid = head.sid
        await update($, currentA, () => turnSid)
        await fileRow(turn.prompt, turnSid, 'prompt', head.rest)
        n += 1
        const folded: Folded[] = []
        const replies: HistoryItem[] = []
        for (const item of turn.items) if (item.kind === 'prompt') folded.push({ streamId: (await promptOf(item.text)).sid, text: item.text })
        // Replies before the first prompt sent into the turn are the turn's own; the rest are asked about at once.
        const firstFolded = turn.items.findIndex(i => i.kind === 'prompt')
        let picks: string[] = []
        if (firstFolded >= 0) {
          for (const item of turn.items.slice(firstFolded)) if (item.kind === 'reply') replies.push(item)
          if (replies.length > 0) {
            const self = { streamId: turnSid, text: head.rest }
            const texts = replies.map(i => (i.kind === 'reply' ? i.text : ''))
            const r = await $.model.complete({ model: 'haiku', system: REPLIES_SYSTEM, prompt: buildRepliesPrompt(self, folded, texts), maxTokens: 400 })
            picks = r.isAnswered ? pickReplyStreams(r.text, self, folded, replies.length) : replies.map(() => turnSid)
          }
        }
        let k = 0
        for (const item of turn.items) {
          if (item.kind === 'prompt') {
            const sid = folded[k++]?.streamId ?? turnSid
            await fileRow(item, sid, 'prompt', item.text)
            n += 1
          } else if (item.kind === 'reply') {
            const j = replies.indexOf(item)
            await fileRow(item, j >= 0 ? (picks[j] ?? turnSid) : turnSid, 'reply', item.text)
          } else {
            const input = (item.input ?? {}) as { description?: string }
            await (item.name === 'Agent'
              ? fileRow(item, turnSid, 'agent', input.description ?? 'subagent')
              : fileRow(item, turnSid, 'tool', `${item.name} ${oneLine(JSON.stringify(item.input ?? {}), 100)}`))
          }
        }
        await update($, rowsA, list => [...list, ...rows].sort((a, b) => a.at - b.at).slice(-MAX_ROWS))
      } catch (err) {
        lastError = `skipped a turn: ${String(err)}`.slice(0, 600)
      }
    }
    const counts: Record<string, number> = {}
    for (const row of await read($, rowsA)) counts[row.streamId] = (counts[row.streamId] ?? 0) + 1
    await update($, streamsA, list => list.map(s => ({ ...s, rows: counts[s.id] ?? 0 })))
    await update($, historyFiledA, () => true)
    await save($)
    $.ui.toast(`streams: filed ${n} prompts from this session into streams`)
  } finally {
    importing = false
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

type LoopArgs = { delaySeconds?: number; stop?: boolean; cron?: string; reason?: string }

/** A self-paced wakeup or a cron job arms a loop in its stream; stopping or deleting it disarms it. */
async function noteLoop($: $, sid: string, tool: string, args: LoopArgs) {
  if (tool === 'ScheduleWakeup') {
    if (args.stop) return update($, loopsA, ({ [sid]: _, ...rest }) => rest)
    const nextAt = (await $.clock.now()) + (args.delaySeconds ?? 60) * 1000
    return update($, loopsA, m => ({ ...m, [sid]: { kind: 'wakeup' as const, nextAt, label: args.reason ?? '' } }))
  }
  if (tool === 'CronCreate') return update($, loopsA, m => ({ ...m, [sid]: { kind: 'cron' as const, nextAt: 0, label: args.cron ?? '' } }))
  if (tool === 'CronDelete') return update($, loopsA, ({ [sid]: _, ...rest }) => rest)
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

export const register: Register = on => {
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
    if (transcript && !(await read($, historyFiledA))) work($, { kind: 'import', path: transcript })
    if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Streams' })
    $.clock.every(5000, () => void beat($).catch(() => {}))
    work($)
    return next(e)
  })

  on('command.run', { command: 'streams' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Streams', focus: true })
    await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
    return { text: 'Streams navigator opened.' }
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
    const id = await ensureStream($, arg, '')
    await update($, currentA, () => id)
    await update($, viewA, () => id)
    await focusOn($, id)
    return { text: `Focused on ${id}. Rows from other streams collapse; ctrl+o expands them.` }
  })

  on('prompt.submit', async ($, e, next) => {
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
      work($, { kind: 'import', path: e.transcript_path })
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
    await update($, busyA, () => true)
    const startedAt = await $.clock.now()
    await update($, turnStartedAtA, () => startedAt)
    const sid = await read($, currentA)
    if (sid) await update($, outcomeA, ({ [sid]: _, ...rest }) => rest)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
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
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [streams, focus, live] = await Promise.all([read($, streamsA), read($, focusA), read($, liveA)])
    const health = await healthNow($, streams)
    if (e.props.hasSurvey || !streams.some(s => !s.archived)) return next(e)
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
    const pick = async (id: string) => {
      await openStream($, focus === id ? '' : id)
      await $.ui.open({ id: PANE, title: 'Streams' })
    }
    const loops = await read($, loopsA)
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
        <Button key="pane" plain label="≡" hotkey="s" onPress={() => $.ui.open({ id: PANE, title: 'Streams', focus: true })} />
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
    const { Box, Text, Button } = $.ui.resolve(e)
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
    const loops = await read($, loopsA)
    // Read only to move the clocks: it changes once a second while something runs.
    await read($, tickA)
    Object.assign(health, await healthNow($, streams))
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 8)
    const shown = streams.find(s => s.id === view)
    const rows = await read($, rowsA)

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
            {oneLine(l.label, width - 20)}
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

    if (shown) {
      const verdict = health[shown.id] ?? 'idle'
      const activity = workOf(shown, 8)
      const own = rows.filter(r => r.streamId === shown.id).slice(-Math.max(3, room - activity.length * 2))
      return (
        <Box flexDirection="column">
          <Button key="back" plain label="← all streams" onPress={() => openStream($, '')} />
          <Box gap={1} marginTop={1}>
            <Text color={HEALTH_TEXT[verdict]}>{HEALTH_GLYPH[verdict]}</Text>
            <Text bold color={colorOf(shown)}>
              {shown.name}
            </Text>
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
          {own.map(r => (
            <Text key={r.id} dimColor={r.kind === 'tool' || r.kind === 'notice'} wrap="truncate">
              {GLYPH[r.kind]} {r.agentId ? `[${r.agentId.slice(0, 6)}] ` : ''}
              {oneLine(r.text, width)}
            </Text>
          ))}
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
        <Box gap={1}>
          <Text dimColor>
            {active.length} streams · {focus ? `focused on ${focus}` : 'showing all'}
          </Text>
          {focus ? <Button key="unfocus" plain dimColor label="show all" onPress={() => focusOn($, '')} /> : null}
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
const STATUS_TEXT: Record<AgentRun['status'], string> = { running: '#f2cc60', done: '#7ee787', error: '#ff7b72' }
const STATUS_GLYPH: Record<AgentRun['status'], string> = { running: '●', done: '✓', error: '✗' }

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
