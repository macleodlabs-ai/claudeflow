import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Stream } from '../../types'
import { keepRows, savedOf, mem, storeKey, type Saved } from '../state'
import { buildPrompt, systemFor, type Grouping, fallbackName, isFollowUp, loopKey, oneLine, parseTag, parseVerdict, rowKey, slug, textKey } from '../classify'
import { colorOf, streamsNow, touched, uuidOf, withStream, type Facts } from './model'
import { merged, undone, type MergeResult, type MergeState } from './merge'
import { afterNotification, loopsAt } from './loops'

// Which stream a prompt belongs to: by #tag, a loop's own stream, the task that sent a notice, or Haiku's
// guess; and by hand, `/stream`.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const sourcesA = atom({ plugin: 'streams', key: 'sources' } as const, { since: 0, files: [] as string[] })
const foldedA = atom({ plugin: 'streams', key: 'folded' } as const, [])
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const agentStreamA = atom({ plugin: 'streams', key: 'agentStream' } as const, {})
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const verdictsA = atom({ plugin: 'streams', key: 'verdicts' } as const, {})
/** Merges done this session, newest last: what `/stream undo` puts back. */
const mergesA = atom({ plugin: 'streams', key: 'merges' } as const, [])
const ROW = { plugin: 'streams', key: 'rowStream' } as const
const COLOR = { plugin: 'streams', key: 'streamColor' } as const

async function ensureStream($: $, name: string, summary: string): Promise<string> {
  const now = await $.clock.now()
  await update($, streamsA, list => withStream(list, name, summary, now))
  await paintStreams($)
  return slug(name)
}

/** Mirrors each stream's colour where transcript rows read it, each its own. */
async function paintStreams($: $) {
  const streams = await read($, streamsA)
  await Promise.all(streams.map(s => $.state.set({ ...COLOR, id: s.id }, colorOf(s))))
}

/** Files a transcript row (by uuid, tool_use_id or text key) under a stream. */
const fileAs = ($: $, id: string, sid: string) => $.state.set({ ...ROW, id: rowKey(id) }, sid)

async function touch($: $, id: string, patch?: (s: Stream) => Partial<Stream>) {
  const now = await $.clock.now()
  await update($, streamsA, touched(id, now, patch))
}

async function save($: $) {
  const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
  await $.store.set(storeKey(cwd), savedOf(streams, rows, loopStream, await read($, sourcesA)))
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

/** Hybrid routing: follow-ups stay put, everything else asks Haiku which stream it continues. */
/** The longest a prompt waits for Haiku to pick its stream before it goes on to Claude. */
export const CLASSIFY_WAIT_MS = 1500

async function classify($: $, text: string): Promise<string> {
  const [streams, current] = await Promise.all([read($, streamsA), read($, currentA)])
  if (current && isFollowUp(text)) return current
  // Archived streams are put away: only a #tag brings one back. The rest are offered with their state, so a
  // finished side task is not taken for open work in the same area.
  const recent = streams.filter(s => !s.archived).sort((a, b) => b.lastAt - a.lastAt).slice(0, 15)
  const facts = await factsOf($)
  const { health } = streamsNow(facts, recent)
  const r = await $.model.complete({ model: 'haiku', system: systemFor(grouping), prompt: buildPrompt(recent, current, text, facts.now, health), maxTokens: 150 })
  const v = r.isAnswered ? parseVerdict(r.text, recent) : undefined
  if (!v) return current || ensureStream($, fallbackName(text), oneLine(text, 120))
  if (v.kind === 'new') return ensureStream($, v.name, v.summary)
  // A stream keeps the goal it was created with: a summary rewritten on every match drifts wider until it
  // matches everything nearby.
  return v.id
}

/** A background task's notification names its task; route it to whoever spawned that. */
async function streamOfNotification($: $, text: string): Promise<string> {
  const map = await read($, agentStreamA)
  const hit = Object.keys(map).find(id => text.includes(id))
  return (hit && map[hit]) || read($, currentA)
}

async function focusOn($: $, id: string) {
  await update($, focusA, () => id)
}

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
  await save($)
  return `Moved the last prompt and ${moving.length - 1} row${moving.length === 2 ? '' : 's'} after it from ${from} to ${to}.`
}

/** Writes what a merge or its undo made (streams/merge.ts): state, transcript lines, the stream in view, and the save. */
async function applyMerge($: $, r: MergeResult) {
  await update($, streamsA, () => [...r.streams])
  await update($, rowsA, () => [...r.rows])
  await update($, agentStreamA, () => ({ ...r.agentStream }))
  await update($, agentsA, () => ({ ...r.agents }))
  await update($, mergesA, () => [...r.merges])
  await Promise.all(r.files.map(f => fileAs($, f.key, f.streamId)))
  if ((await read($, currentA)) === r.from) await update($, currentA, () => r.to)
  if ((await read($, focusA)) === r.from) await update($, focusA, () => r.to)
  if ((await read($, viewA)) === r.from) await update($, viewA, () => r.to)
  await paintStreams($)
  await save($)
}

/** The state a merge reads. */
async function mergeState($: $): Promise<MergeState> {
  const [streams, rows, agentStream, agents, merges] = await Promise.all([read($, streamsA), read($, rowsA), read($, agentStreamA), read($, agentsA), read($, mergesA)])
  return { streams, rows, agentStream, agents, merges }
}

/** The `streamGrouping` setting, as register.tsx read it. */
let grouping: Grouping = 'broad'

export function wireRouting(on: On, opts: { grouping?: Grouping } = {}) {
  grouping = opts.grouping ?? 'broad'
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
    // `/stream merge <from> <into>` folds a stream into another; `/stream undo` puts the last merge back (merge.ts).
    if (arg === 'undo' || /^merge\b/.test(arg)) {
      const [, from, into] = arg.split(/\s+/)
      if (arg !== 'undo' && !(from && into)) return { text: 'Usage: /stream merge <stream> <into stream>' }
      const state = await mergeState($)
      const r = arg === 'undo' ? undone(state) : merged(state, from!, into!, Object.keys(await read($, loopsA)))
      if (typeof r === 'string') return { text: r }
      await applyMerge($, r)
      return { text: r.text }
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
    mem.pendingKind = 'prompt'
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
      // A cron that just fired counts down to its next match from now.
      const now = await $.clock.now()
      await update($, loopsA, m => loopsAt(m, now))
      mem.pendingKind = 'loop'
    } else if (e.origin.kind === 'task-notification') {
      id = await streamOfNotification($, text)
      // A monitor's event is its latest change; its end notice ends it.
      const now = await $.clock.now()
      await update($, loopsA, m => afterNotification(m, text, now))
      mem.pendingKind = 'notice'
    } else if (e.origin.kind === 'plugin' && e.origin.name === 'streams' && mem.runNow.text && mem.runNow.text === text) {
      // A tick the phone asked to run now (remote/index.tsx): filed as that loop's tick in its own stream, like one
      // the schedule fired, so it is no person's prompt (it answers no question) and Haiku does not route it.
      id = mem.runNow.streamId
      mem.runNow = { streamId: '', text: '' }
      await touch($, id, s => ({ loops: s.loops + 1 }))
      mem.pendingKind = 'loop'
    } else {
      // Claude is never kept waiting on Haiku: past CLASSIFY_WAIT_MS the prompt is filed in the current stream.
      const pick = classify($, text).catch(() => '')
      id = (await Promise.race([pick, $.clock.sleep(CLASSIFY_WAIT_MS).then(() => undefined)])) ?? (await read($, currentA))
    }
    if (!id) return next(text === e.text ? e : { ...e, text })
    if ((await read($, streamsA)).find(s => s.id === id)?.archived) {
      await update($, streamsA, list => list.map(s => (s.id === id ? { ...s, archived: false } : s)))
      await save($)
      $.ui.toast(`stream ${id} restored: a new prompt belongs to it`)
    }
    if (e.turnId && e.origin.kind !== 'task-notification') {
      // Sent mid-turn: filed in its own stream now (its row is an attachment the recorder skips),
      // and the running turn keeps its stream; replies are split between them as they come.
      const now = await $.clock.now()
      await update($, foldedA, list => [...list, { streamId: id, text }])
      await update($, rowsA, list => keepRows([...list, { id: `q:${now}`, streamId: id, kind: 'prompt' as const, text, at: now }]))
      await touch($, id, s => ({ rows: s.rows + 1 }))
    } else {
      await update($, currentA, () => id)
      await touch($, id, s => (s.startedAt === undefined ? { startedAt: s.lastAt } : {}))
    }
    return next(text === e.text ? e : { ...e, text })
  }).catch(($, e, next) => next(e))
}
