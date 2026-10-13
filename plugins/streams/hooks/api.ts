import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Streams, StreamsDone, StreamsView } from '../types'
import { mem, savedOf, storeKey } from './state'
import { gitStatus } from './status'
import { afterCall } from './streams/loops'
import { cardOf, colorOf, streamsNow, type Facts } from './streams/model'
import { cardsOf } from './view'

type $ = EngineInterface

// `$.streams` (types/index.d.ts, Streams): what the pane shows, as data, and the pane's own actions, for other
// plugins. The phone add-on reads and drives the session only through this.

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const verdictsA = atom({ plugin: 'streams', key: 'verdicts' } as const, {})
const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
const statusGitA = atom({ plugin: 'streams', key: 'statusGit' } as const, { lines: [], at: 0 })
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const sourcesA = atom({ plugin: 'streams', key: 'sources' } as const, { since: 0, files: [] as string[] })

/** Git rows are read again once they are this old. */
export const GIT_FRESH_MS = 30_000
/** Taps on "run now" within this long run the tick once. */
export const RUN_NOW_GAP_MS = 30_000
const ranNowAt = new Map<string, number>()

export async function viewOf($: $): Promise<StreamsView> {
  const [streams, busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts, updates, now] = await Promise.all([
    read($, streamsA),
    read($, busyA),
    read($, currentA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, rowsA),
    read($, loopsA),
    read($, workflowsA),
    read($, verdictsA),
    read($, updatesA),
    $.clock.now(),
  ])
  const facts: Facts = { busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts, now }
  let git = await read($, statusGitA)
  if (now - git.at >= GIT_FRESH_MS) {
    const r = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 }).catch(() => undefined)
    git = { lines: r?.exitCode === 0 ? gitStatus(r.stdout) : [], at: now }
    await update($, statusGitA, () => git)
  }
  const card = cardOf(streamsNow(facts, streams), { git: git.lines, rateLimits: (await $.session.usage().catch(() => undefined))?.rateLimits })
  const model = await $.session.model().catch(() => undefined)
  const all = Object.values(agents)
  const cards = cardsOf({ lines: card.lines, streams, colorOf, agents: all, rows, loops, workflows, now })
  return {
    now,
    busy,
    current,
    ...(model ? { model } : {}),
    streams: cards,
    archived: streams.filter(s => s.archived).slice(-30).map(s => ({ id: s.id, name: s.name, color: colorOf(s) })),
    agents: all,
    status: [...card.git, ...card.tickets],
    limits: card.limits,
    updates,
  }
}

export async function select($: $, streamId: string): Promise<StreamsDone> {
  if (!(await read($, streamsA)).some(s => s.id === streamId)) return { ok: false, why: 'no such stream' }
  await update($, currentA, () => streamId)
  return { ok: true }
}

export async function archive($: $, streamId: string, archived: boolean): Promise<StreamsDone> {
  const st = (await read($, streamsA)).find(s => s.id === streamId)
  if (!st) return { ok: false, why: 'no such stream' }
  // Already so (asked twice, or another device did it first) is what was asked.
  if (!!st.archived === archived) return { ok: true }
  // As the pane's ✕ and restore do (ui/pane.tsx setArchived); $ calls stay in this file, at the call site.
  const now = await $.clock.now()
  await update($, streamsA, list => list.map(s => (s.id === streamId ? { ...s, archived, ...(archived ? {} : { restoredAt: now }) } : s)))
  if (archived && (await read($, focusA)) === streamId) await update($, focusA, () => '')
  if (archived && (await read($, viewA)) === streamId) await update($, viewA, () => '')
  const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
  // Kept for the next session when the store has room; the archive itself holds either way.
  await $.store.set(storeKey(cwd), savedOf(streams, rows, loopStream, await read($, sourcesA))).catch(() => undefined)
  return { ok: true }
}

export async function runTick($: $, streamId: string): Promise<StreamsDone> {
  const loop = (await read($, loopsA))[streamId]
  if (!loop) return { ok: false }
  // A tick is its prompt run in its stream: a slash command (a /loop) runs as one, other text is submitted. An
  // autonomous loop's sentinel is no prompt to send.
  const text = loop.prompt?.trim() ?? ''
  if (!text || /^<<[\w-]+>>$/.test(text)) return { ok: false }
  // Each tick is a model turn the person pays for: none while that stream's turn runs, and repeated taps within
  // RUN_NOW_GAP_MS run it once.
  const now = await $.clock.now()
  const [busy, current] = await Promise.all([read($, busyA), read($, currentA)])
  if ((busy && current === streamId) || now - (ranNowAt.get(streamId) ?? 0) < RUN_NOW_GAP_MS) return { ok: false }
  ranNowAt.set(streamId, now)
  await update($, currentA, () => streamId)
  const slash = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(text)
  if (slash?.[1]) await $.command.run({ command: slash[1], args: slash[2] ?? '' })
  else {
    // Routing (streams/routing.ts) files it as this loop's tick, not as something the person typed.
    mem.runNow = { streamId, text }
    await $.prompt.submit({ text, asUser: true })
  }
  return { ok: true }
}

export async function stopLoop($: $, streamId: string): Promise<StreamsDone> {
  const loop = (await read($, loopsA))[streamId]
  if (!loop) return { ok: false }
  // Ended as the model would end it. A plugin's own call skips its own hooks, so the loop is cleared here too.
  const input =
    loop.kind === 'wakeup'
      ? { tool: 'ScheduleWakeup' as const, stop: true }
      : loop.kind === 'cron' && loop.id
        ? { tool: 'CronDelete' as const, id: loop.id }
        : loop.kind === 'monitor' && loop.id
          ? { tool: 'TaskStop' as const, task_id: loop.id }
          : undefined
  if (!input) return { ok: false }
  const r = await $.tool.call(input)
  const now = await $.clock.now()
  await update($, loopsA, m => afterCall(m, streamId, { tool: input.tool, input, result: r.deny === undefined ? r.result : undefined, isError: r.isError === true, now }))
  return { ok: r.deny === undefined && r.isError !== true }
}

export async function stopTask($: $, taskId: string): Promise<StreamsDone> {
  // Only a run this session shows and is still going: a caller cannot stop any task it names.
  if ((await read($, workflowsA))[taskId]?.status !== 'running') return { ok: false }
  const r = await $.tool.call({ tool: 'TaskStop', task_id: taskId })
  return { ok: r.deny === undefined && r.isError !== true }
}

/** The noun's stand-in methods: each call is the `streams.<method>` event, which the hooks below answer with `$`. */
const notReady = async (): Promise<never> => {
  throw new Error('streams: not ready')
}
const STUB: Streams = { view: notReady, select: notReady, setArchived: notReady, runTick: notReady, stopLoop: notReady, stopTask: notReady, stopTurn: notReady, handOver: notReady }

/** What Streams kept for the phone before it was an add-on: only these keys ever leave this plugin's store. */
const PHONE_KEYS = 'remote:'

/** What `/streams phone` says: the phone is the Streams Remote add-on, which answers `/phone` once installed. */
export const PHONE_NOTE =
  'Streams on your phone (watch every stream, answer questions and prompts, send prompts and photos) is the Streams Remote add-on, with a 3-day free trial. Once it is installed, run `/phone` to pair your phone.'

export function wireApi(on: On) {
  // Before the pane answers `/streams`: `phone` is the add-on's.
  on('command.run', { command: 'streams' }, async (_$, e, next) => (e.args.trim().split(/\s+/)[0] === 'phone' ? { text: PHONE_NOTE } : next(e)))
  on('engine.create', async (_$, e, next) => ({ ...(await next(e)), streams: STUB }))
  on('streams.view', async $ => ({ value: await viewOf($) }))
  on('streams.select', async ($, e) => ({ value: await select($, e.streamId) }))
  on('streams.setArchived', async ($, e) => ({ value: await archive($, e.streamId, e.archived) }))
  on('streams.runTick', async ($, e) => ({ value: await runTick($, e.streamId) }))
  on('streams.stopLoop', async ($, e) => ({ value: await stopLoop($, e.streamId) }))
  on('streams.stopTask', async ($, e) => ({ value: await stopTask($, e.taskId) }))
  on('streams.handOver', async $ => {
    const keys = (await $.store.keys()).filter(k => k.startsWith(PHONE_KEYS))
    const taken: Record<string, unknown> = {}
    for (const k of keys) {
      taken[k] = await $.store.get(k)
      await $.store.delete(k)
    }
    return { value: taken }
  })
  on('streams.stopTurn', async $ => {
    if (mem.runningTurn) await $.turn.abort({ turnId: mem.runningTurn })
    return { value: { ok: true } }
  })
}
