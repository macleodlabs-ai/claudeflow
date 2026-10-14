import type { AgentRun, Stream, StreamRow } from '../../types'
import { slug, textKey } from '../classify'
import { uuidOf } from './model'

// Merging streams, pure: what a merge or its undo makes of the session's streams, rows and agents. The callers
// (/stream merge in routing.ts, the pane's drop, the phone's drag) write the result with their own $ calls, since a
// hook's $ never crosses an import.

/** One merge, enough to undo it exactly: the stream as it was, and the rows and agents that left it. */
export type Merge = { stream: Stream; into: string; rows: string[]; agents: string[] }

/** The state a merge reads and writes. */
export type MergeState = {
  streams: readonly Stream[]
  rows: readonly StreamRow[]
  agentStream: Readonly<Record<string, string>>
  agents: Readonly<Record<string, AgentRun>>
  merges: readonly Merge[]
}

/** The state after, the transcript keys to file under a stream, and what to tell the person. */
export type MergeResult = MergeState & { files: { key: string; streamId: string }[]; from: string; to: string; text: string }

/** A row's transcript keys: its line, its tool call, and a reply's text. */
const keysOf = (r: StreamRow): string[] => [uuidOf(r), ...(r.toolId ? [r.toolId] : []), ...(r.kind === 'reply' ? [textKey(r.text)] : [])]

const plural = (n: number) => `${n} row${n === 1 ? '' : 's'}`

/** `from` folded into `into`, both named by id or name; a string says why not. `looping`: streams with a loop armed. */
export function merged(x: MergeState, fromName: string, intoName: string, looping: readonly string[] = []): MergeResult | string {
  const find = (n: string) => x.streams.find(s => s.id === slug(n) || s.name.toLowerCase() === n.trim().toLowerCase())
  const from = find(fromName)
  const into = find(intoName)
  if (!from) return `No stream named ${fromName}.`
  if (!into) return `No stream named ${intoName}.`
  if (from.id === into.id) return 'A stream cannot merge into itself.'
  if (looping.includes(from.id)) return `${from.id} has a loop running: stop it first.`
  const moving = x.rows.filter(r => r.streamId === from.id)
  const agentIds = Object.entries(x.agentStream).flatMap(([a, sid]) => (sid === from.id ? [a] : []))
  return {
    streams: x.streams
      .filter(s => s.id !== from.id)
      .map(s => (s.id === into.id ? { ...s, rows: s.rows + moving.length, agents: s.agents + from.agents, lastAt: Math.max(s.lastAt, from.lastAt), archived: false } : s)),
    rows: x.rows.map(r => (r.streamId === from.id ? { ...r, streamId: into.id } : r)),
    agentStream: { ...x.agentStream, ...Object.fromEntries(agentIds.map(a => [a, into.id])) },
    agents: Object.fromEntries(Object.entries(x.agents).map(([k, a]) => [k, a.streamId === from.id ? { ...a, streamId: into.id } : a])),
    merges: [...x.merges.slice(-19), { stream: from, into: into.id, rows: moving.map(r => r.id), agents: agentIds }],
    files: moving.flatMap(r => keysOf(r).map(key => ({ key, streamId: into.id }))),
    from: from.id,
    to: into.id,
    text: `Merged ${from.id} into ${into.id} (${plural(moving.length)}). /stream undo puts it back.`,
  }
}

/** The last merge undone: the stream back, with exactly the rows and agents that left it; a string when none. */
export function undone(x: MergeState): MergeResult | string {
  const last = x.merges.at(-1)
  if (!last) return 'Nothing to undo.'
  const back = last.stream.id
  const ids = new Set(last.rows)
  const agents = new Set(last.agents)
  const moving = x.rows.filter(r => ids.has(r.id))
  return {
    streams: [
      ...x.streams.map(s => (s.id === last.into ? { ...s, rows: Math.max(0, s.rows - moving.length), agents: Math.max(0, s.agents - last.stream.agents) } : s)),
      ...(x.streams.some(s => s.id === back) ? [] : [last.stream]),
    ],
    rows: x.rows.map(r => (ids.has(r.id) ? { ...r, streamId: back } : r)),
    agentStream: { ...x.agentStream, ...Object.fromEntries([...agents].map(a => [a, back])) },
    agents: Object.fromEntries(Object.entries(x.agents).map(([k, a]) => [k, agents.has(k) ? { ...a, streamId: back } : a])),
    merges: x.merges.slice(0, -1),
    files: moving.flatMap(r => keysOf(r).map(key => ({ key, streamId: back }))),
    from: last.into,
    to: back,
    text: `Undid the merge: ${back} is back with its ${plural(moving.length)}.`,
  }
}

/** Several streams folded into one (a suggested merge): each its own merge, so /stream undo takes them back one by one. */
export function mergedAll(x: MergeState, from: readonly string[], into: string, looping: readonly string[] = []): MergeResult | string {
  let state: MergeState = x
  let files: MergeResult['files'] = []
  let rows = 0
  for (const f of from) {
    const r = merged(state, f, into, looping)
    if (typeof r === 'string') return r
    rows += r.rows.filter(row => row.streamId === r.to).length - state.rows.filter(row => row.streamId === r.to).length
    files = [...files, ...r.files]
    state = r
  }
  return { ...state, files, from: from[0] ?? '', to: into, text: `Merged ${from.join(', ')} into ${into} (${plural(rows)}). /stream undo puts each back.` }
}
