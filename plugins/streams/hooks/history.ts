import type { Stream } from '../types'
import { oneLine } from './classify'

// Reading a session's transcript, and the prompts that file a long history into streams in batches.

/** A turn of the transcript: the prompt that began it, prompts sent into it, and what the agent did. */
export type HistoryTurn = { prompt: HistoryItem & { kind: 'prompt' }; items: HistoryItem[] }

/** Splits the transcript at each typed prompt; anything before the first one is dropped. */
export const turnsOf = (items: readonly HistoryItem[]): HistoryTurn[] => {
  const turns: HistoryTurn[] = []
  for (const item of items) {
    if (item.kind === 'prompt' && !item.isFolded) turns.push({ prompt: item, items: [] })
    else turns.at(-1)?.items.push(item)
  }
  return turns
}

/** One line of a transcript file, as far as filing it into streams needs. */
export type TranscriptLine = {
  type?: string
  uuid?: string
  isMeta?: boolean
  isSidechain?: boolean
  message?: { role?: string; content?: unknown }
  attachment?: { type?: string; prompt?: unknown; commandMode?: string }
}

export type HistoryItem =
  | { kind: 'prompt'; uuid: string; text: string; isFolded: boolean; at?: number }
  | { kind: 'reply'; uuid: string; text: string; at?: number }
  | { kind: 'tool'; uuid: string; id: string; name: string; input: unknown; at?: number }

/** A message's text: a string as it is, a list of blocks by its text blocks (a prompt with an image is one). */
export const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(b => b?.type === 'text' && typeof b.text === 'string')
          .map(b => b.text as string)
          .join('\n')
      : ''

/** The main conversation's prompts (typed or sent mid-turn), replies and tool calls, in order. */
export const readTranscript = (jsonl: string): HistoryItem[] => {
  const items: HistoryItem[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let d: TranscriptLine
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.isSidechain || d.isMeta || !d.uuid) continue
    // A queued task notification is the engine's, not the person's: only queued prompts count.
    const queued = d.type === 'attachment' && d.attachment?.type === 'queued_command' && d.attachment.commandMode === 'prompt'
    if (queued) {
      const text = textOf(d.attachment?.prompt).trim()
      if (text) items.push({ kind: 'prompt', uuid: d.uuid, text, isFolded: true })
      continue
    }
    const content = d.message?.content
    if (d.type === 'user') {
      const text = textOf(content)
      if (text.trim() && !text.trim().startsWith('<')) items.push({ kind: 'prompt', uuid: d.uuid, text: text.trim(), isFolded: false })
    } else if (d.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) items.push({ kind: 'reply', uuid: d.uuid, text: b.text })
        if (b?.type === 'tool_use' && typeof b.id === 'string') items.push({ kind: 'tool', uuid: d.uuid, id: b.id, name: String(b.name), input: b.input })
      }
    }
  }
  return items
}

/** Runs `fn` over `items` with at most `limit` at once, results in input order. Model calls wait on the network, so a few in flight file a long history several times faster. */
export async function inParallel<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i] as T, i)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

export const BATCH_SYSTEM = `You sort a developer's messages to a coding agent into workstreams.
A workstream is one coherent goal (a feature, a bug, an investigation, a question).
You get the existing workstreams and a numbered run of messages, oldest first.
Reply with a JSON array, one string per message, in order: the id of an existing workstream,
or a 2-4 word name for a new one. Use the same new name for every message about the same goal,
and give a message that continues the one before it ("yes", "now also do X") that message's entry.`

export const buildBatchPrompt = (streams: readonly Stream[], texts: readonly string[]): string => {
  const list = streams.length ? streams.map(s => `- ${s.id}: ${oneLine(s.summary || s.name, 120)}`).join('\n') : '(none yet)'
  return `Workstreams:\n${list}\n\nMessages:\n${texts.map((t, i) => `${i + 1}. ${oneLine(t, 300)}`).join('\n')}`
}

/** One label per message: an existing id or a proposed name; '' where the model gave nothing usable. */
export const parseBatch = (reply: string, n: number): string[] => {
  let said: unknown = []
  try {
    said = JSON.parse(/\[[\s\S]*\]/.exec(reply)?.[0] ?? '[]')
  } catch {
    said = []
  }
  const list = Array.isArray(said) ? said : []
  return Array.from({ length: n }, (_, i) => (typeof list[i] === 'string' ? (list[i] as string).trim().slice(0, 40) : ''))
}

export const MERGE_SYSTEM = `Workstream names were proposed separately for different parts of one long session.
Merge names that mean the same goal. Map a name to an existing workstream id when it is that workstream.
Reply with a JSON object mapping every proposed name to its final name or existing id.`

export type Proposal = { name: string; count: number; samples: string[] }

export const buildMergePrompt = (streams: readonly Stream[], proposals: readonly Proposal[]): string =>
  `Existing workstreams:\n${streams.length ? streams.map(s => `- ${s.id}: ${oneLine(s.summary || s.name, 100)}`).join('\n') : '(none)'}\n\nProposed names:\n${proposals
    .map(p => `- "${p.name}" (${p.count} messages), e.g. ${p.samples.map(s => `"${oneLine(s, 80)}"`).join('; ')}`)
    .join('\n')}`

/** Every proposed name to its final one; a name the model left out keeps itself. */
export const parseMerge = (reply: string, names: readonly string[]): Record<string, string> => {
  let said: unknown = {}
  try {
    said = JSON.parse(/\{[\s\S]*\}/.exec(reply)?.[0] ?? '{}')
  } catch {
    said = {}
  }
  const map = (said && typeof said === 'object' ? said : {}) as Record<string, unknown>
  return Object.fromEntries(names.map(n => [n, typeof map[n] === 'string' && (map[n] as string).trim() ? (map[n] as string).trim().slice(0, 40) : n]))
}
