import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Stream } from '../../types'
import { MAX_ROWS, SAVED_ROWS, mem, storeKey, type Saved } from '../state'
import { SYSTEM, buildPrompt, fallbackName, isFollowUp, loopKey, oneLine, parseTag, parseVerdict, rowKey, slug, textKey } from '../classify'
import { colorOf, streamsNow, touched, uuidOf, withStream, type Facts } from './model'

// Which stream a prompt belongs to: by #tag, a loop's own stream, the task that sent a notice, or Haiku's
// guess; and by hand, `/stream`.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const foldedA = atom({ plugin: 'streams', key: 'folded' } as const, [])
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const agentStreamA = atom({ plugin: 'streams', key: 'agentStream' } as const, {})
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
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

async function refreshStatus($: $) {
  const [focus, current] = await Promise.all([read($, focusA), read($, currentA)])
  $.ui.status(focus ? `◉ stream ${focus}` : current ? `stream ${current}` : undefined)
}

async function save($: $) {
  const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
  await $.store.set(storeKey(cwd), { streams, rows: rows.slice(-SAVED_ROWS), loopStream } satisfies Saved)
}

async function factsOf($: $): Promise<Facts> {
  const [busy, current, agents, inflight, outcome, rows, loops, now] = await Promise.all([
    read($, busyA),
    read($, currentA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, rowsA),
    read($, loopsA),
    $.clock.now(),
  ])
  return { busy, current, agents, inflight, outcome, rows, loops, now }
}

/** Hybrid routing: follow-ups stay put, everything else asks Haiku which stream it continues. */
async function classify($: $, text: string): Promise<string> {
  const [streams, current] = await Promise.all([read($, streamsA), read($, currentA)])
  if (current && isFollowUp(text)) return current
  // Archived streams are put away: only a #tag brings one back. The rest are offered with their state, so a
  // finished side task is not taken for open work in the same area.
  const recent = streams.filter(s => !s.archived).sort((a, b) => b.lastAt - a.lastAt).slice(0, 15)
  const facts = await factsOf($)
  const { health } = streamsNow(facts, recent)
  const r = await $.model.complete({ model: 'haiku', system: SYSTEM, prompt: buildPrompt(recent, current, text, facts.now, health), maxTokens: 150 })
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
  await refreshStatus($)
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
  await refreshStatus($)
  await save($)
  return `Moved the last prompt and ${moving.length - 1} row${moving.length === 2 ? '' : 's'} after it from ${from} to ${to}.`
}

export function wireRouting(on: On) {
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
      mem.pendingKind = 'loop'
    } else if (e.origin.kind === 'task-notification') {
      id = await streamOfNotification($, text)
      mem.pendingKind = 'notice'
    } else {
      id = await classify($, text)
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
      await update($, rowsA, list => [...list, { id: `q:${now}`, streamId: id, kind: 'prompt' as const, text, at: now }].slice(-MAX_ROWS))
      await touch($, id, s => ({ rows: s.rows + 1 }))
    } else {
      await update($, currentA, () => id)
      await touch($, id)
      await refreshStatus($)
    }
    return next(text === e.text ? e : { ...e, text })
  }).catch(($, e, next) => next(e))
}
