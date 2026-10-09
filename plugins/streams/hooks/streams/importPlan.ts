import type { Folded, Stream, StreamRow } from '../../types'
import { REPLIES_SYSTEM, buildRepliesPrompt, fallbackName, isFollowUp, oneLine, parseTag, pickReplyStreams, slug, textKey } from '../classify'
import { BATCH_SYSTEM, MERGE_SYSTEM, buildBatchPrompt, buildMergePrompt, parseBatch, parseMerge, rowOf, turnsOf, type HistoryItem, type HistoryTurn, type Proposal } from '../history'
import { withStream } from './model'

// Filing a past session into streams, as decisions only: which stream each prompt and reply belongs to, the
// streams to make, the rows to keep. It asks the model through `yield` and is handed the replies back, so the
// worker (worker.ts) makes the calls and the writes, and all of this runs in plain tests.

/** Prompts per classifying call: enough for context, few enough to answer reliably. */
export const BATCH = 25

/** One model call the plan needs. */
export type Ask = { system: string; prompt: string; maxTokens: number }
/** Calls the plan needs answered before it goes on, several at once; `label` is what the pane says meanwhile. */
export type Asking = { label: string; asks: Ask[] }
/** Each call's reply text, in order; undefined where the model did not answer. */
export type Replies = (string | undefined)[]

export type ImportPlan = {
  /** Streams to make first, in order (a name that already exists is kept as it is). */
  newStreams: { name: string; summary: string }[]
  /** Which stream each transcript id (a message's uuid, a tool's id, a reply's text key) is filed under. */
  marks: [id: string, sid: string][]
  rows: StreamRow[]
  /** The stream the last prompt went to: the session's current one, for its own transcript. */
  current: string
  prompts: number
  streams: number
  /** Items that could not be made into a row, and why. */
  skipped: string[]
}

/**
 * The import's decisions over a transcript's items: #tags and follow-ups first, then the rest classified in
 * batches, the names those batches proposed merged in one pass, and replies in turns with prompts sent mid-turn
 * routed to the thread they answer. Rows are timed from `startedAt`, one ms apart, or by the item's own time.
 */
export function* importPlan(x: {
  items: readonly HistoryItem[]
  streams: readonly Stream[]
  current: string
  startedAt: number
  isCurrent: boolean
  now: number
}): Generator<Asking, ImportPlan, Replies> {
  const turns = turnsOf(x.items)
  const prompts = turns.flatMap(t => [t.prompt, ...t.items.filter(i => i.kind === 'prompt')]) as (HistoryItem & { kind: 'prompt' })[]
  let streams = [...x.streams]
  const newStreams: ImportPlan['newStreams'] = []
  const ensure = (name: string, summary: string): string => {
    if (!streams.some(s => s.id === slug(name))) newStreams.push({ name, summary })
    streams = withStream(streams, name, summary, x.now)
    return slug(name)
  }

  // 1. Prompts that need no model: #tags, and follow-ups (which take the stream of the prompt before them).
  const sids = new Map<HistoryItem, string>()
  const texts = new Map<HistoryItem, string>()
  for (const p of prompts) {
    const tag = parseTag(p.text)
    texts.set(p, tag ? tag.rest : p.text)
    if (tag) sids.set(p, ensure(tag.name, oneLine(tag.rest, 120)))
  }
  const open = prompts.filter(p => !sids.has(p) && !isFollowUp(p.text))
  const said = (p: HistoryItem) => texts.get(p) ?? (p.kind === 'prompt' ? p.text : '')

  // 2. The rest, classified in batches.
  const known = [...streams]
  const batches = Array.from({ length: Math.ceil(open.length / BATCH) }, (_, i) => open.slice(i * BATCH, (i + 1) * BATCH))
  const sorted: Replies = batches.length
    ? yield { label: 'sorting prompts', asks: batches.map(b => ({ system: BATCH_SYSTEM, prompt: buildBatchPrompt(known, b.map(said)), maxTokens: 60 + b.length * 16 })) }
    : []
  const labels = batches.flatMap((b, i) => (sorted[i] === undefined ? b.map(() => '') : parseBatch(sorted[i] as string, b.length)))

  // 3. One pass merges the names the batches proposed on their own.
  const ids = new Set(known.map(s => s.id))
  const proposals = new Map<string, Proposal>()
  open.forEach((p, i) => {
    const label = labels[i] || fallbackName(said(p))
    labels[i] = label
    if (ids.has(label)) return
    const one = proposals.get(label) ?? { name: label, count: 0, samples: [] }
    one.count += 1
    if (one.samples.length < 2) one.samples.push(said(p))
    proposals.set(label, one)
  })
  let merged: Record<string, string> = {}
  if (proposals.size > 1) {
    const names = [...proposals.keys()]
    const [reply] = yield { label: 'merging streams', asks: [{ system: MERGE_SYSTEM, prompt: buildMergePrompt(known, [...proposals.values()]), maxTokens: 80 + names.length * 24 }] }
    merged = reply === undefined ? {} : parseMerge(reply, names)
  }
  open.forEach((p, i) => {
    const final = merged[labels[i] ?? ''] ?? labels[i] ?? ''
    sids.set(p, ids.has(final) ? final : ensure(final, oneLine(said(p), 120)))
  })
  // Follow-ups, in order: the stream of the prompt before them.
  let previous = x.current
  for (const p of prompts) {
    const sid = sids.get(p) ?? previous
    sids.set(p, sid)
    previous = sid
  }

  // 4. Replies in turns that had prompts sent mid-turn: which thread each answers.
  const mixed = turns.filter(t => t.items.some(i => i.kind === 'prompt') && t.items.some(i => i.kind === 'reply'))
  const routing = mixed.map((turn: HistoryTurn) => {
    const turnSid = sids.get(turn.prompt) ?? previous
    const first = turn.items.findIndex(i => i.kind === 'prompt')
    const folded: Folded[] = turn.items.filter(i => i.kind === 'prompt').map(i => ({ streamId: sids.get(i) ?? turnSid, text: texts.get(i) ?? '' }))
    const replies = turn.items.slice(first).filter(i => i.kind === 'reply') as (HistoryItem & { kind: 'reply' })[]
    return { self: { streamId: turnSid, text: texts.get(turn.prompt) ?? '' }, folded, replies }
  })
  const routed: Replies = routing.length
    ? yield { label: 'routing replies', asks: routing.map(t => ({ system: REPLIES_SYSTEM, prompt: buildRepliesPrompt(t.self, t.folded, t.replies.map(i => i.text)), maxTokens: 40 + t.replies.length * 16 })) }
    : []
  const replyTo = new Map<HistoryItem, string>()
  routing.forEach((t, i) => {
    const picks = routed[i] === undefined ? [] : pickReplyStreams(routed[i] as string, t.self, t.folded, t.replies.length)
    t.replies.forEach((item, j) => replyTo.set(item, picks[j] ?? t.self.streamId))
  })

  // 5. Every row, and where each transcript id is filed.
  const rows: StreamRow[] = []
  const marks: ImportPlan['marks'] = []
  const skipped: string[] = []
  let at = x.startedAt
  for (const turn of turns) {
    const turnSid = sids.get(turn.prompt) ?? previous
    for (const item of [turn.prompt, ...turn.items]) {
      const sid = item.kind === 'prompt' ? (sids.get(item) ?? turnSid) : item.kind === 'reply' ? (replyTo.get(item) ?? turnSid) : turnSid
      marks.push([item.kind === 'tool' ? item.id : item.uuid, sid])
      if (item.kind === 'reply') marks.push([textKey(item.text), sid])
      const when = x.isCurrent ? at++ : (item.at ?? at++)
      try {
        rows.push(rowOf(item, sid, when))
      } catch (err) {
        skipped.push(String(err))
      }
    }
  }
  return { newStreams, marks, rows, current: previous, prompts: prompts.length, streams: new Set(sids.values()).size, skipped }
}
