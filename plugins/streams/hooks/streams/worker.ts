import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Folded, Stream } from '../../types'
import { KEY_VERSION, keepRows, PANE, SAVED_ROWS, jobs, mem, storeKey, type Job, type Saved } from '../state'
import { REPLY_SYSTEM, ago, buildReplyPrompt, pickReplyStream, rowKey, slug, textKey } from '../classify'
import { inParallel, readTranscript } from '../history'
import { importPlan } from './importPlan'
import { colorOf, touched, uuidOf, withStream } from './model'
import { loopsAt } from './loops'

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
  // A loop that lapsed is dropped and a cron that fired moves on: once per fire, not once per second.
  if (loopsAt(loops, now) !== loops) await update($, loopsA, m => loopsAt(m, now))
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

const progress = ($: $, label: string, done: number, total: number) => update($, importProgressA, () => ({ label, done, total }))

/**
 * Files a transcript into streams: the decisions are importPlan.ts's; this runs the model calls it asks for,
 * several at once with the progress in the pane, then makes its streams and files its rows.
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
    const [jsonl, { startedAt }, began, streams, current] = await Promise.all([readWhole($, path), $.session.usage(), $.clock.now(), read($, streamsA), read($, currentA)])
    const steps = importPlan({ items: readTranscript(String(jsonl)), streams, current, startedAt, isCurrent, now: began })
    let step = steps.next()
    while (!step.done) {
      const { label, asks } = step.value
      let done = 0
      await progress($, label, 0, asks.length)
      const replies = await inParallel(asks, LANES, async ask => {
        const r = await $.model.complete({ model: 'haiku', system: ask.system, prompt: ask.prompt, maxTokens: ask.maxTokens })
        done += 1
        await progress($, label, done, asks.length)
        return r.isAnswered ? r.text : undefined
      })
      step = steps.next(replies)
    }
    const plan = step.value
    await progress($, 'filing rows', 0, 1)
    for (const s of plan.newStreams) await ensureStream($, s.name, s.summary)
    for (const [id, sid] of plan.marks) await fileAs($, id, sid)
    if (plan.skipped.length) mem.lastError = `skipped a row: ${plan.skipped[0]}`.slice(0, 600)
    const rows = plan.rows
    // Rows of the same messages already kept, under today's ids or the import's older `h:` ones, are replaced.
    const imported = new Set(rows.map(uuidOf))
    await update($, rowsA, list =>
      keepRows(
        [
          ...list.filter(row => !imported.has(uuidOf(row)) && (!isCurrent || row.at < startedAt || row.at >= began)),
          ...rows,
        ].sort((a, b) => a.at - b.at),
      ),
    )
    const counts: Record<string, number> = {}
    for (const row of await read($, rowsA)) counts[row.streamId] = (counts[row.streamId] ?? 0) + 1
    await update($, streamsA, list => list.map(s => ({ ...s, rows: counts[s.id] ?? 0 })))
    if (isCurrent) {
      await update($, currentA, () => plan.current)
      await update($, historyFiledA, () => true)
    }
    await save($)
    $.ui.toast(`streams: filed ${plan.prompts} prompts into ${plan.streams} streams`)
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
