import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { PANE, PANE_KEY, jobs, mem, storeKey, unmatched, type PaneSaved, type Saved } from '../state'
import { ago } from '../classify'
import { colorOf, streamsNow, type Facts } from './model'

// A session's start (its streams restored, the commands declared, the pane opened) and its heartbeat.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const verdictsA = atom({ plugin: 'streams', key: 'verdicts' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const healthA = atom({ plugin: 'streams', key: 'health' } as const, {})
const foldA = atom({ plugin: 'streams', key: 'fold' } as const, {})
const historyFiledA = atom({ plugin: 'streams', key: 'historyFiled' } as const, false)
const paneCollapsedA = atom({ plugin: 'streams', key: 'paneCollapsed' } as const, false)
const COLOR = { plugin: 'streams', key: 'streamColor' } as const

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
        importing: mem.importing,
        lastError: mem.lastError,
        lastPane: mem.lastPane,
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
  const scroll = mem.lastPane.scroll as { offset: number } | undefined
  const rows = Number(mem.lastPane.rows ?? 0)
  mem.lastPane = { ...mem.lastPane, panes: await $.ui.panes() }
  if (scroll && scroll.offset > 0 && scroll.offset >= rows) {
    const r = await $.ui.scroll({ in: PANE, to: 'start' })
    mem.lastPane = { ...mem.lastPane, unstuck: r }
  }
}

async function factsOf($: $): Promise<Facts> {
  const [busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts, now] = await Promise.all([
    read($, busyA),
    read($, currentA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, rowsA),
    read($, loopsA),
    read($, workflowsA),
    read($, verdictsA),
    $.clock.now(),
  ])
  return { busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts, now }
}

/**
 * Every few seconds: each stream's health as the pane draws it (model.ts, `streamsNow`), and a notice when one
 * stalls or background work finishes.
 */
async function beat($: $) {
  await unstick($).catch(() => {})
  if (mem.isDiagnosing) await writeDiagnostics($).catch(() => {})
  const [streams, before, facts] = await Promise.all([read($, streamsA), read($, healthA), factsOf($)])
  const { now, current } = facts
  const after = streamsNow(facts, streams).health
  for (const s of streams) {
    const was = before[s.id]
    // A stream that wakes up opens again, whatever it was folded to.
    if (was !== 'running' && after[s.id] === 'running') await update($, foldA, ({ [s.id]: _, ...rest }) => rest)
    if (was !== 'stalled' && after[s.id] === 'stalled') $.ui.toast(`stream ${s.id} looks stalled: nothing for ${ago(now - s.lastAt)}`)
    if (was === 'running' && after[s.id] === 'done' && s.id !== current) $.ui.toast(`stream ${s.id} finished`)
  }
  const changed = streams.some(s => before[s.id] !== after[s.id])
  if (changed) await update($, healthA, () => after)
}

export function wireSession(on: On) {
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
    const streams = await read($, streamsA)
    await Promise.all(streams.map(s => $.state.set({ ...COLOR, id: s.id }, colorOf(s))))
    const [focus, current] = await Promise.all([read($, focusA), read($, currentA)])
    $.ui.status(focus ? `◉ stream ${focus}` : current ? `stream ${current}` : undefined)
    const pane = (await $.store.get(PANE_KEY)) as PaneSaved | undefined
    if (pane?.collapsed) await update($, paneCollapsedA, () => true)
    else if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Streams' })
    $.clock.every(5000, () => void beat($).catch(() => {}))
    return next(e)
  })
}
