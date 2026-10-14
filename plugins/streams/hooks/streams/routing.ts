import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Stream } from '../../types'
import { keepRows, savedOf, mem, storeKey, type Saved } from '../state'
import { buildPrompt, systemFor, type Grouping, fallbackName, isFollowUp, loopKey, oneLine, parseTag, parseVerdict, rowKey, slug, textKey } from '../classify'
import { colorOf, streamsNow, touched, uuidOf, withStream, type Facts } from './model'
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

/**
 * `/stream merge <from> <into>`: every row of `from`, its transcript lines and its agents, filed under `into`, and
 * `from` taken off the list. The pane's and the phone's merge run this command. `/stream undo` reverses it.
 */
async function mergeStreams($: $, fromName: string, intoName: string): Promise<string> {
  const streams = await read($, streamsA)
  const find = (n: string) => streams.find(s => s.id === slug(n) || s.name.toLowerCase() === n.trim().toLowerCase())
  const from = find(fromName)
  const into = find(intoName)
  if (!from) return `No stream named ${fromName}.`
  if (!into) return `No stream named ${intoName}.`
  if (from.id === into.id) return 'A stream cannot merge into itself.'
  if ((await read($, loopsA))[from.id]) return `${from.id} has a loop running: stop it first.`
  const rows = (await read($, rowsA)).filter(r => r.streamId === from.id)
  const agentIds = Object.entries(await read($, agentStreamA)).flatMap(([a, sid]) => (sid === from.id ? [a] : []))
  await update($, rowsA, list => list.map(r => (r.streamId === from.id ? { ...r, streamId: into.id } : r)))
  await Promise.all(
    rows.flatMap(r => [fileAs($, uuidOf(r), into.id), ...(r.toolId ? [fileAs($, r.toolId, into.id)] : []), ...(r.kind === 'reply' ? [fileAs($, textKey(r.text), into.id)] : [])]),
  )
  if (agentIds.length) await update($, agentStreamA, m => ({ ...m, ...Object.fromEntries(agentIds.map(a => [a, into.id])) }))
  await update($, agentsA, m => Object.fromEntries(Object.entries(m).map(([k, a]) => [k, a.streamId === from.id ? { ...a, streamId: into.id } : a])))
  await update($, streamsA, list =>
    list
      .filter(s => s.id !== from.id)
      .map(s => (s.id === into.id ? { ...s, rows: s.rows + rows.length, agents: s.agents + from.agents, lastAt: Math.max(s.lastAt, from.lastAt), archived: false } : s)),
  )
  if ((await read($, currentA)) === from.id) await update($, currentA, () => into.id)
  if ((await read($, focusA)) === from.id) await update($, focusA, () => into.id)
  if ((await read($, viewA)) === from.id) await update($, viewA, () => into.id)
  await update($, mergesA, list => [...list.slice(-19), { stream: from, into: into.id, rows: rows.map(r => r.id), agents: agentIds }])
  await paintStreams($)
  await save($)
  return `Merged ${from.id} into ${into.id} (${rows.length} row${rows.length === 1 ? '' : 's'}). /stream undo puts it back.`
}

/** `/stream undo`: the last merge reversed: the stream back on the list, with exactly the rows and agents that left it. */
async function undoMerge($: $): Promise<string> {
  const last = (await read($, mergesA)).at(-1)
  if (!last) return 'Nothing to undo.'
  const back = last.stream.id
  const ids = new Set(last.rows)
  const agents = new Set(last.agents)
  const rows = (await read($, rowsA)).filter(r => ids.has(r.id))
  await update($, rowsA, list => list.map(r => (ids.has(r.id) ? { ...r, streamId: back } : r)))
  await Promise.all(
    rows.flatMap(r => [fileAs($, uuidOf(r), back), ...(r.toolId ? [fileAs($, r.toolId, back)] : []), ...(r.kind === 'reply' ? [fileAs($, textKey(r.text), back)] : [])]),
  )
  if (agents.size) await update($, agentStreamA, m => ({ ...m, ...Object.fromEntries([...agents].map(a => [a, back])) }))
  await update($, agentsA, m => Object.fromEntries(Object.entries(m).map(([k, a]) => [k, agents.has(k) ? { ...a, streamId: back } : a])))
  await update($, streamsA, list => [
    ...list.map(s => (s.id === last.into ? { ...s, rows: Math.max(0, s.rows - rows.length), agents: Math.max(0, s.agents - last.stream.agents) } : s)),
    ...(list.some(s => s.id === back) ? [] : [last.stream]),
  ])
  await update($, mergesA, list => list.slice(0, -1))
  await paintStreams($)
  await save($)
  return `Undid the merge: ${back} is back with its ${rows.length} row${rows.length === 1 ? '' : 's'}.`
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
    if (arg === 'undo') return { text: await undoMerge($) }
    if (/^merge\b/.test(arg)) {
      const [, from, into] = arg.split(/\s+/)
      return { text: from && into ? await mergeStreams($, from, into) : 'Usage: /stream merge <stream> <into stream>' }
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
