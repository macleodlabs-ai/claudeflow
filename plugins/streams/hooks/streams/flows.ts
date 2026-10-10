import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import { oneLine, slug } from '../classify'
import { colorOf, touched, withStream } from './model'
import { afterTaskNotice, agentEnded, agentSeen, fromJournal, fromRunFile, launched, metaOf, ownerOf, runFileOf } from './workflows'

// Workflow tool runs, filed as they happen: the run as a stream named after its meta.name, each of its agents filed
// there (they carry ids no `$.agent.list()` names, so without this they landed in whatever stream was current), its
// journal read while it runs for labels and phases, and its record read once it ends. Registered before filing.ts,
// so an agent is claimed for its run before filing asks which stream it belongs to.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const agentStreamA = atom({ plugin: 'streams', key: 'agentStream' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const COLOR = { plugin: 'streams', key: 'streamColor' } as const

/** How often a running run's journal is read: local file reads, and the run changes only when the journal does. */
const JOURNAL_MS = 3000
/** Reads of a finished run's record before its live counts are kept as they are (still marked inferred). */
const RECORD_TRIES = 10

let poller: Timer | undefined
const recordTries = new Map<string, number>()

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

async function ensureStream($: $, name: string, summary: string): Promise<string> {
  const now = await $.clock.now()
  await update($, streamsA, list => withStream(list, name, summary, now))
  const streams = await read($, streamsA)
  await Promise.all(streams.map(s => $.state.set({ ...COLOR, id: s.id }, colorOf(s))))
  return slug(name)
}

/**
 * The Workflow tool answered: its run is filed under a stream named after the script's `meta.name` (made when there
 * is none), with the phases the meta lists. The script is read as the tool reads it: `scriptPath` first.
 */
async function launch($: $, input: Record<string, unknown>, result: unknown) {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const taskId = str(r.taskId)
  // A remote run's agents run elsewhere: nothing of it reaches this session's events.
  if (!taskId || r.status === 'remote_launched') return
  const asked = str(input.scriptPath)
  const scriptPath = asked ?? str(r.scriptPath)
  const script = (asked ? undefined : str(input.script)) ?? (scriptPath ? await $.fs.read(scriptPath).then(String).catch(() => undefined) : undefined)
  const meta = script ? metaOf(script) : undefined
  const name = meta?.name ?? str(r.workflowName) ?? str(input.name) ?? 'workflow'
  const streamId = await ensureStream($, name, oneLine(meta?.description ?? '', 120))
  const now = await $.clock.now()
  const runId = str(r.runId)
  const transcriptDir = str(r.transcriptDir)
  await update($, workflowsA, m =>
    launched(m, { taskId, name, streamId, phases: meta?.phases ?? [], startedAt: now, ...(runId ? { runId } : {}), ...(transcriptDir ? { transcriptDir } : {}), ...(scriptPath ? { scriptPath } : {}) }),
  )
  // Its end notice names the task: routing files that notice under the run's stream (routing.ts, streamOfNotification).
  await update($, agentStreamA, m => ({ ...m, [taskId]: streamId }))
  await update($, outcomeA, ({ [streamId]: _, ...rest }) => rest)
  await update($, streamsA, touched(streamId, now))
  startPolling($)
}

/**
 * An agent's step (a tool call, or a row): an agent of a run is counted there, and an id no stream knows, seen
 * while a run is going, is taken for that run's and filed under its stream. An ordinary subagent is left alone.
 */
async function claim($: $, agentId: string, isTool: boolean) {
  const runs = await read($, workflowsA)
  if (Object.keys(runs).length === 0) return
  const map = await read($, agentStreamA)
  const run = ownerOf(runs, agentId, map[agentId] !== undefined)
  if (!run) return
  const now = await $.clock.now()
  const isNew = !run.agents[agentId]
  await update($, workflowsA, m => agentSeen(m, run.taskId, agentId, now, isTool))
  if (map[agentId] === undefined) await update($, agentStreamA, m => ({ ...m, [agentId]: run.streamId }))
  if (isNew) await update($, streamsA, touched(run.streamId, now, s => ({ agents: s.agents + 1 })))
}

/** A running run's journal, read: its agents' labels, phases and ends, as the run itself wrote them. */
async function readJournal($: $, taskId: string) {
  const run = (await read($, workflowsA))[taskId]
  if (!run?.transcriptDir) return
  const text = await $.fs
    .read(`${run.transcriptDir.replace(/\/+$/, '')}/journal.jsonl`)
    .then(String)
    .catch(() => undefined)
  if (text === undefined) return
  const now = await $.clock.now()
  await update($, workflowsA, m => {
    const was = m[taskId]
    const next = was && fromJournal(was, text, now)
    return next && next !== was ? { ...m, [taskId]: next } : m
  })
}

/** A finished run's record, read when it is there: the final word on every agent. Tried a few times, then left. */
async function readRecord($: $, taskId: string) {
  const run = (await read($, workflowsA))[taskId]
  const path = run && runFileOf(run)
  const tries = (recordTries.get(taskId) ?? 0) + 1
  recordTries.set(taskId, path ? tries : RECORD_TRIES)
  if (!path) return
  const json = await $.fs.read(path).then(String).catch(() => undefined)
  if (json === undefined) return
  recordTries.set(taskId, RECORD_TRIES)
  await update($, workflowsA, m => (m[taskId] ? { ...m, [taskId]: fromRunFile(m[taskId], json) } : m))
}

/** The poller's tick: journals of running runs, records of ended ones not yet read; it stops when neither is left. */
async function pollRuns($: $) {
  let isBusy = false
  for (const run of Object.values(await read($, workflowsA))) {
    if (run.status === 'running') {
      isBusy = isBusy || !!run.transcriptDir
      await readJournal($, run.taskId)
    } else if ((recordTries.get(run.taskId) ?? 0) < RECORD_TRIES) {
      isBusy = true
      await readRecord($, run.taskId)
    }
  }
  if (!isBusy) {
    poller?.cancel()
    poller = undefined
  }
}

/** A background task's notice: one ending a run ends it (after a last read of its journal), and its stream with it. */
async function noticed($: $, text: string) {
  const now = await $.clock.now()
  const { ended } = afterTaskNotice(await read($, workflowsA), text, now)
  if (!ended) return
  // The journal's last word first: the notice then ends only the agents it did not already end.
  await readJournal($, ended)
  const { runs } = afterTaskNotice(await read($, workflowsA), text, now)
  await update($, workflowsA, () => runs)
  const run = runs[ended]
  if (!run) return
  const outcome = run.status === 'completed' ? ('answer' as const) : run.status === 'failed' ? ('error' as const) : ('aborted' as const)
  await update($, outcomeA, m => ({ ...m, [run.streamId]: outcome }))
  await update($, streamsA, touched(run.streamId, now))
  await readRecord($, ended)
  startPolling($)
}

/** Reads journals and records every few seconds until no run needs it (`pollRuns` stops it). */
function startPolling($: $) {
  poller ??= $.clock.every(JOURNAL_MS, () => void pollRuns($).catch(err => $.ui.log(`streams: could not read a workflow: ${String(err)}`)))
}

export function wireFlows(on: On) {
  on('tool.call', {}, async ($, e, next) => {
    if (e.agentId) await claim($, e.agentId, true).catch(err => $.ui.log(`streams: could not file a workflow agent: ${String(err)}`))
    if (e.tool !== 'Workflow') return next(e)
    const r = await next(e)
    // The run has started: filing it must not fail the call.
    if (r.deny === undefined && !r.isError) await launch($, e as unknown as Record<string, unknown>, r.result).catch(err => $.ui.log(`streams: could not file a workflow: ${String(err)}`))
    return r
  })

  on('session.append', {}, async ($, e, next) => {
    // Claimed before filing.ts files the row, so a run's agent never lands in the current stream.
    if (e.agentId) await claim($, e.agentId, false).catch(err => $.ui.log(`streams: could not file a workflow agent: ${String(err)}`))
    return next(e)
  })

  on('turn.complete', {}, async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId
    if (!id) return r
    const run = ownerOf(await read($, workflowsA), id, true)
    if (run) {
      const now = await $.clock.now()
      await update($, workflowsA, m => agentEnded(m, run.taskId, id, e.reason === 'answer', now))
    }
    return r
  })

  on('prompt.submit', {}, async ($, e, next) => {
    if (e.origin.kind === 'task-notification') await noticed($, e.text).catch(err => $.ui.log(`streams: could not end a workflow: ${String(err)}`))
    return next(e)
  })
}
