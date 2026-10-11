import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { PANE, PANE_KEY, savedOf, historyToDrop, jobs, mem, storeKey, unmatched, type PaneSaved, type Saved } from '../state'
import { ago } from '../classify'
import { ARCHIVE_LOOK_MS, archivableOf } from './archive'
import { colorOf, streamsNow, type Facts } from './model'

// A session's start (its streams restored, the commands declared, the pane opened) and its heartbeat, which also
// archives finished streams left alone for `autoArchiveHours` (archive.ts).

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
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

/** The `autoArchiveHours` setting (0: off), and when the heartbeat last looked for streams to archive. */
let archiveHours = 24
let archiveLookedAt = 0

/**
 * Archives what archive.ts says is finished and long quiet, as the pane's ✕ does: off the bar and the list, out of
 * focus and the pane's detail, and saved, so it stays archived after a reload and is restorable from "archived".
 */
async function autoArchive($: $, ids: string[]) {
  await update($, streamsA, list => list.map(s => (ids.includes(s.id) ? { ...s, archived: true } : s)))
  if (ids.includes(await read($, focusA))) {
    await update($, focusA, () => '')
  }
  if (ids.includes(await read($, viewA))) await update($, viewA, () => '')
  const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
  await $.store.set(storeKey(cwd), savedOf(streams, rows, loopStream))
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
  const n = streamsNow(facts, streams)
  const after = n.health
  for (const s of streams) {
    const was = before[s.id]
    // A stream that wakes up opens again, whatever it was folded to.
    if (was !== 'running' && after[s.id] === 'running') await update($, foldA, ({ [s.id]: _, ...rest }) => rest)
    if (was !== 'stalled' && after[s.id] === 'stalled') $.ui.toast(`stream ${s.id} looks stalled: nothing for ${ago(now - s.lastAt)}`)
    if (was === 'running' && after[s.id] === 'done' && s.id !== current) $.ui.toast(`stream ${s.id} finished`)
  }
  const changed = streams.some(s => before[s.id] !== after[s.id])
  if (changed) await update($, healthA, () => after)
  if (archiveHours > 0 && now - archiveLookedAt >= ARCHIVE_LOOK_MS) {
    archiveLookedAt = now
    const ids = archivableOf({ now: n, streams, loops: facts.loops, hours: archiveHours, at: now })
    if (ids.length) await autoArchive($, ids)
  }
}

export function wireSession(on: On, opts: { autoArchiveHours: number }) {
  archiveHours = opts.autoArchiveHours
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(storeKey(e.cwd))) as Saved | undefined
    if (saved && (await read($, streamsA)).length === 0) {
      await update($, streamsA, () => saved.streams)
      await update($, rowsA, () => saved.rows)
      await update($, loopStreamA, () => saved.loopStream)
    }
    // Keep the shared store well under the engine's 4 MiB: cut other projects' history saved by older versions
    // to what savedOf keeps, and drop scratch folders and the largest when all of it is still over budget.
    const sizes: { key: string; size: number }[] = []
    for (const key of (await $.store.keys()).filter(k => k.startsWith(storeKey('')))) {
      const old = (await $.store.get(key)) as Saved | undefined
      if (!old?.rows) continue
      const size = JSON.stringify(old).length
      const cut = savedOf(old.streams, old.rows, old.loopStream)
      const cutSize = JSON.stringify(cut).length
      if (cutSize < size) await $.store.set(key, cut)
      sizes.push({ key, size: cutSize })
    }
    for (const key of historyToDrop(sizes, storeKey(e.cwd))) await $.store.delete(key)
    await $.command.register({ name: 'streams', description: 'Open the streams navigator' })
    await $.command.register({
      name: 'stream',
      description: 'Focus a stream (/stream <name>), or show everything again (/stream off)',
    })
    const streams = await read($, streamsA)
    await Promise.all(streams.map(s => $.state.set({ ...COLOR, id: s.id }, colorOf(s))))
    // The stream shows in the bar and the pane, not the status line: clear what an earlier version left there.
    $.ui.status(undefined)
    const pane = (await $.store.get(PANE_KEY)) as PaneSaved | undefined
    if (pane?.collapsed) await update($, paneCollapsedA, () => true)
    else if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Streams' })
    $.clock.every(5000, () => void beat($).catch(() => {}))
    return next(e)
  })
}
