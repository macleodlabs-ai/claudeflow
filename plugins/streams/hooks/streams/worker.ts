import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Folded, Stream, StreamRow, StreamRowKind } from '../../types'
import { KEY_VERSION, MAX_ROWS, PANE, SAVED_ROWS, jobs, mem, storeKey, type Job, type Saved } from '../state'
import {
  REPLIES_SYSTEM,
  REPLY_SYSTEM,
  ago,
  buildRepliesPrompt,
  buildReplyPrompt,
  fallbackName,
  isFollowUp,
  oneLine,
  parseTag,
  pickReplyStream,
  pickReplyStreams,
  rowKey,
  slug,
  textKey,
} from '../classify'
import {
  BATCH_SYSTEM,
  MERGE_SYSTEM,
  buildBatchPrompt,
  buildMergePrompt,
  inParallel,
  parseBatch,
  parseMerge,
  readTranscript,
  turnsOf,
  type HistoryItem,
  type HistoryTurn,
  type Proposal,
} from '../history'
import { toolLine, withCode } from '../tools'
import { colorOf, lapsed, touched, withStream } from './model'

// The background worker: files a session's history into streams, and moves a reply filed under the running
// turn to the mid-turn prompt it answers. Hooks queue the work (`jobs`); a timer drains it.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const tickA = atom({ plugin: 'streams', key: 'tick' } as const, 0)
const transcriptA = atom({ plugin: 'streams', key: 'transcript' } as const, '')
const historyFiledA = atom({ plugin: 'streams', key: 'historyFiled' } as const, false)
const keyVersionA = atom({ plugin: 'streams', key: 'keyVersion' } as const, 0)
const importProgressA = atom({ plugin: 'streams', key: 'importProgress' } as const, { label: '', done: 0, total: 0 })
const ROW = { plugin: 'streams', key: 'rowStream' } as const
const COLOR = { plugin: 'streams', key: 'streamColor' } as const

async function ensureStream($: $, name: string, summary: string): Promise<string> {
  const now = await $.clock.now()
  await update($, streamsA, list => withStream(list, name, summary, now))
  const streams = await read($, streamsA)
  await Promise.all(streams.map(s => $.state.set({ ...COLOR, id: s.id }, colorOf(s))))
  return slug(name)
}

/** Files a transcript row (by uuid, tool_use_id or text key) under a stream. */
const fileAs = ($: $, id: string, sid: string) => $.state.set({ ...ROW, id: rowKey(id) }, sid)

async function touch($: $, id: string, patch?: (s: Stream) => Partial<Stream>) {
  const now = await $.clock.now()
  await update($, streamsA, touched(id, now, patch))
}

async function save($: $) {
  const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
  await $.store.set(storeKey(cwd), { streams, rows: rows.slice(-SAVED_ROWS), loopStream } satisfies Saved)
}

let draining = false
let isWorking = false

/** Starts the worker's timer once per load, from whichever hook first has work: timers outlive the hook. */
function work($: $, job?: Job) {
  if (job) jobs.push(job)
  if (isWorking) return
  isWorking = true
  $.clock.every(1000, () => {
    void drain($).catch(err => {
      mem.lastError = `${String(err)} ${(err as Error)?.stack ?? ''}`.slice(0, 600)
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

/** While prompts wait in the running turn, a reply piece goes to whichever of them, or the turn's own task, it answers. */
async function routeReply($: $, turnSid: string, folded: readonly Folded[], text: string): Promise<string> {
  const turn = { streamId: turnSid, text: (await read($, streamsA)).find(s => s.id === turnSid)?.summary ?? turnSid }
  const r = await $.model.complete({ model: 'haiku', system: REPLY_SYSTEM, prompt: buildReplyPrompt(turn, folded, text), maxTokens: 20 })
  return r.isAnswered ? pickReplyStream(r.text, turn, folded) : turnSid
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
  if (mem.importing) return
  mem.importing = true
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
          mem.lastError = `skipped a row: ${String(err)}`.slice(0, 600)
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
    mem.importing = false
    await progress($, '', 0, 0).catch(() => {})
  }
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

export function wireWorker(on: On) {
  on('session.start', {}, async ($, e, next) => {
    // Rows filed under an older key scheme are not found by today's lookups: file the history again.
    if ((await read($, keyVersionA)) !== KEY_VERSION) {
      await update($, historyFiledA, () => false)
      await update($, keyVersionA, () => KEY_VERSION)
    }
    const transcript = await read($, transcriptA)
    work($, transcript && !(await read($, historyFiledA)) ? { kind: 'import', path: transcript, isCurrent: true } : undefined)
    return next(e)
  })

  // The prompt hook is the one place the transcript's path is named: keep it, and file the history once.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.transcript_path) await update($, transcriptA, () => e.transcript_path)
    if (e.transcript_path && !(await read($, historyFiledA)) && !jobs.some(j => j.kind === 'import')) {
      work($, { kind: 'import', path: e.transcript_path, isCurrent: true })
    }
    return next(e)
  })

  // A filed reply may queue a move for the worker: its timer must run, as after a reload it may not yet.
  on('session.append', {}, async ($, e, next) => {
    work($)
    return next(e)
  })

  on('command.run', { command: 'streams' }, async ($, e, next) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb !== 'import') return next(e)
    return { text: await importCommand($, rest.join(' ')) }
  })
}
