import type { RowCode, Folded, Health, Stream } from '../types'

/** A stream id is its name as a slug, so a collapsed row can show it without a lookup. */
export const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'stream'

/** `#name rest` at the start of a prompt picks the stream by hand; the tag is stripped. */
export const parseTag = (text: string): { name: string; rest: string } | undefined => {
  const m = /^#([A-Za-z0-9][\w-]{0,31})\s+([\s\S]*)$/.exec(text.trim())
  return m?.[1] && m[2] !== undefined ? { name: m[1], rest: m[2] } : undefined
}

/** The `#tag` being typed at the start of a draft, up to the cursor: `#bil` gives `bil`; anything else none. */
export const partialTag = (text: string, cursor: number): string | undefined => /^\s*#([\w-]*)$/.exec(text.slice(0, cursor))?.[1]

/** Streams a partial tag could complete to, live ones first, most recently active first; at most `limit`. */
export const tagMatches = (streams: readonly { id: string; lastAt: number; archived?: boolean }[], partial: string, limit = 6): string[] =>
  streams
    .filter(s => s.id.startsWith(partial.toLowerCase()))
    .sort((a, b) => Number(!!a.archived) - Number(!!b.archived) || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map(s => s.id)

/** The draft with the partial tag before the cursor replaced by `#id `, and the cursor after it. */
export const completeTag = (text: string, cursor: number, id: string): { text: string; cursor: number } => {
  const head = text.slice(0, cursor).replace(/#[\w-]*$/, `#${id} `)
  const tail = text.slice(cursor).replace(/^\s+/, '')
  return { text: head + tail, cursor: head.length }
}

/**
 * The key a transcript row is filed under. The transcript draws a row under its uuid with the last group
 * zeroed (stored 61ec327a-403c-4478-84b7-4b8d64663b0d, drawn 61ec327a-403c-4478-84b7-000000000000), so a
 * uuid keys by its first four groups; anything else (a tool_use_id, a text key) keys as it is.
 */
export const rowKey = (id: string): string =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.slice(0, 23).toLowerCase() : id

/** Prompts too short to carry a topic ("yes", "continue") stay on the current stream. */
export const isFollowUp = (text: string): boolean => {
  const t = text.trim().toLowerCase()
  return (
    t.length < 4 ||
    t.startsWith('/') ||
    /^(y|yes|yep|no|nope|ok|okay|sure|go|go ahead|continue|proceed|do it|ship it|thanks|thank you|lgtm|approved?)[.!]*$/.test(t)
  )
}

/** A loop fires the same text each tick: key it loosely so every tick lands together. */
export const loopKey = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 200)

/**
 * Key for an assistant text block, for when a row's requestId is not its uuid. Letters and digits only, so
 * the text as stored and as the transcript draws it (markdown, spacing, case) key alike.
 */
export const textKey = (text: string): string => {
  const t = text.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 80)
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0
  return `t:${h.toString(36)}`
}

export const SYSTEM = `You sort a developer's messages to a coding agent into workstreams.
A workstream is one coherent goal (a feature, a bug, an investigation, a question).
Reply with JSON only, one of:
{"stream":"<existing id>","summary":"<updated one-line summary>"}
{"new":"<2-4 word name>","summary":"<one-line summary>"}
Prefer an existing stream when the message continues, refines or asks about its goal.
Start a new one only for a clearly different goal.`

export const buildPrompt = (streams: readonly Stream[], current: string, text: string): string => {
  const list = streams.length
    ? streams.map(s => `- id: ${s.id}${s.id === current ? ' (current)' : ''}\n  name: ${s.name}\n  summary: ${s.summary}`).join('\n')
    : '(none yet)'
  return `Workstreams:\n${list}\n\nNew message:\n"""\n${text.slice(0, 2000)}\n"""`
}

export type Verdict = { kind: 'existing'; id: string; summary?: string } | { kind: 'new'; name: string; summary: string }

/** Reads the model's reply; anything unreadable or naming no known stream is undefined. */
export const parseVerdict = (reply: string, streams: readonly Stream[]): Verdict | undefined => {
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return undefined
  let v: { stream?: unknown; new?: unknown; summary?: unknown }
  try {
    v = JSON.parse(m[0])
  } catch {
    return undefined
  }
  const summary = typeof v.summary === 'string' ? v.summary.slice(0, 160) : undefined
  if (typeof v.stream === 'string' && streams.some(s => s.id === v.stream)) {
    return { kind: 'existing', id: v.stream, summary }
  }
  if (typeof v.new === 'string' && v.new.trim()) {
    return { kind: 'new', name: v.new.trim().slice(0, 40), summary: summary ?? '' }
  }
  return undefined
}

/** Names a new stream from the prompt itself, when the model cannot be asked. */
export const fallbackName = (text: string): string => text.trim().split(/\s+/).slice(0, 4).join(' ').slice(0, 40) || 'misc'

export const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** Terminal colour codes and other control characters: a pane line holding one does not paint. */
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g

export const oneLine = (text: string, n: number): string => {
  const t = text.replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export const STALL_MS = 120_000
export const STALL_IN_TOOL_MS = 600_000
export const DONE_MS = 600_000

export type Pulse = {
  now: number
  lastAt: number
  isTurnOn: boolean
  liveAgents: number
  inflight: number
  outcome?: 'answer' | 'aborted' | 'refusal' | 'error'
}

/** One heartbeat's verdict. A running tool (a long build) earns a longer silence before it counts as stalled. */
export const healthOf = (p: Pulse): Health => {
  const quiet = p.now - p.lastAt
  if (p.isTurnOn || p.liveAgents > 0 || p.inflight > 0) {
    return quiet > (p.inflight > 0 ? STALL_IN_TOOL_MS : STALL_MS) ? 'stalled' : 'running'
  }
  if (p.outcome === 'error' || p.outcome === 'refusal') return 'error'
  return quiet < DONE_MS ? 'done' : 'idle'
}

/** Pill backgrounds: dark enough that the default text reads on them. Yellow runs, green is done, red failed. */
export const HEALTH_COLOR: Record<Health, string> = {
  running: '#9a6700',
  stalled: '#bc4c00',
  done: '#1a7f37',
  error: '#cf222e',
  idle: '#57606a',
}

/** The same verdicts as text on the terminal's own background. */
export const HEALTH_TEXT: Record<Health, string> = {
  running: '#f2cc60',
  stalled: '#ffa657',
  done: '#7ee787',
  error: '#ff7b72',
  idle: '#8b949e',
}

export const HEALTH_GLYPH: Record<Health, string> = { running: '●', stalled: '◌', done: '✓', error: '✗', idle: '○' }

export const REPLY_SYSTEM = `A coding agent was working on a task when the developer sent extra messages mid-way.
Given one piece of the agent's reply, say which of the listed threads it addresses.
Reply with the thread id only.`

export const buildReplyPrompt = (turn: Folded, folded: readonly Folded[], text: string): string =>
  `Threads:\n${[turn, ...folded].map(f => `- ${f.streamId}: ${oneLine(f.text, 200)}`).join('\n')}\n\nReply piece:\n"""\n${text.slice(0, 1500)}\n"""`

/** The thread a reply piece answers; the turn's own when the model names none of them. */
export const pickReplyStream = (reply: string, turn: Folded, folded: readonly Folded[]): string => {
  const ids = [turn, ...folded].map(f => f.streamId)
  const said = reply.trim().toLowerCase()
  return ids.find(id => said === id) ?? ids.find(id => said.includes(id)) ?? turn.streamId
}

export const REPLIES_SYSTEM = `A coding agent was working on a task when the developer sent extra messages mid-way.
Given the numbered pieces of the agent's reply, say which listed thread each piece addresses.
Reply with a JSON array of thread ids, one per piece, in order.`

export const buildRepliesPrompt = (turn: Folded, folded: readonly Folded[], texts: readonly string[]): string =>
  `Threads:\n${[turn, ...folded].map(f => `- ${f.streamId}: ${oneLine(f.text, 200)}`).join('\n')}\n\nReply pieces:\n${texts
    .map((t, i) => `${i + 1}. ${oneLine(t, 400)}`)
    .join('\n')}`

/** One thread id per piece; any piece the model got wrong or left out stays with the turn. */
export const pickReplyStreams = (reply: string, turn: Folded, folded: readonly Folded[], n: number): string[] => {
  const ids = new Set([turn, ...folded].map(f => f.streamId))
  let said: unknown
  try {
    said = JSON.parse(/\[[\s\S]*\]/.exec(reply)?.[0] ?? '[]')
  } catch {
    said = []
  }
  const list = Array.isArray(said) ? said : []
  return Array.from({ length: n }, (_, i) => {
    const v = list[i]
    return typeof v === 'string' && ids.has(v) ? v : turn.streamId
  })
}

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

/** Pastels that read on a dark terminal and stay apart from each other. */
export const PASTELS = [
  '#a5d8ff', // sky
  '#b2f2bb', // mint
  '#ffd8a8', // peach
  '#d0bfff', // lavender
  '#fcc2d7', // pink
  '#ffec99', // butter
  '#99e9f2', // aqua
  '#ffc9c9', // rose
  '#c0eb75', // lime
  '#bac8ff', // periwinkle
]

/** A new stream takes the first pastel no live stream wears, so neighbours never share a colour. */
export const nextPastel = (taken: readonly (string | undefined)[]): string =>
  PASTELS.find(c => !taken.includes(c)) ?? PASTELS[taken.length % PASTELS.length] ?? '#a5d8ff'

/** The colour of a stream made before colours were kept: stable, from its id. */
export const pastelOf = (id: string): string => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PASTELS[Math.abs(h) % PASTELS.length] ?? '#a5d8ff'
}

/** How much of a stream's activity the pane shows: its share of the pane, the last 10 rows, the last one, or none. */
export type Fold = 'all' | '10' | '1' | 'none'
export const NEXT_FOLD: Record<Fold, Fold> = { all: '10', '10': '1', '1': 'none', none: 'all' }
export const FOLD_LABEL: Record<Fold, string> = { all: '▾ all', '10': '▾ 10', '1': '▾ 1', none: '▸' }

export const clockOf = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Solid badges: black on bright yellow while anything runs, so movement is impossible to miss. */
export type BadgeKind = Health | 'loop'
export const BADGE_BG: Record<BadgeKind, string> = {
  running: '#ffd33d',
  loop: '#ffd33d',
  stalled: '#ff9500',
  done: '#2ea043',
  error: '#da3633',
  idle: '#30363d',
}
export const BADGE_FG: Record<BadgeKind, string> = {
  running: '#000000',
  loop: '#000000',
  stalled: '#000000',
  done: '#ffffff',
  error: '#ffffff',
  idle: '#c9d1d9',
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

/** Longest source a row keeps for the full chat style; the pane is a glance, not the file. */
export const CODE_LIMIT = 4000

/** `text` cut to whole lines within `limit` characters, with a marker when anything was left out. */
const clip = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const kept = cut.slice(0, Math.max(0, cut.lastIndexOf('\n')))
  return `${kept}\n… ${text.split('\n').length - kept.split('\n').length} more lines`
}

/** One unified-diff hunk replacing `before` with `after`, as the session draws an Edit. */
const hunk = (before: string, after: string): string => {
  const old = before.split('\n')
  const now = after.split('\n')
  return [`@@ -1,${old.length} +1,${now.length} @@`, ...old.map(l => `-${l}`), ...now.map(l => `+${l}`)].join('\n')
}

/** Strips control characters a Code element refuses; tab and newline stay. */
const printable = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

/**
 * What the full chat style draws under a tool call: the command for Bash, a diff for Edit and MultiEdit,
 * the file for Write; none for tools whose one line says it all (Read, Grep, Glob, ...).
 */
export const codeOf = (tool: string, input: unknown): RowCode | undefined => {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  const path = str('file_path')
  if (tool === 'Bash' && str('command')) return { source: clip(printable(str('command')!), CODE_LIMIT), language: 'bash' }
  if (tool === 'Write' && str('content') !== undefined) return { source: clip(printable(str('content')!), CODE_LIMIT), ...(path ? { path } : {}) }
  const edits: { old_string?: unknown; new_string?: unknown }[] =
    tool === 'Edit' ? [i] : tool === 'MultiEdit' && Array.isArray(i.edits) ? (i.edits as { old_string?: unknown }[]) : []
  const hunks = edits
    .filter(e => typeof e.old_string === 'string' && typeof e.new_string === 'string')
    .map(e => hunk(printable(e.old_string as string), printable(e.new_string as string)))
  if (hunks.length === 0) return undefined
  const diff = hunks.join('\n')
  // A diff cut mid-hunk no longer parses, so an oversized one is drawn as its first hunks only.
  if (diff.length <= CODE_LIMIT) return { source: diff, format: 'diff', ...(path ? { path } : {}) }
  const fit: string[] = []
  for (const h of hunks) if ([...fit, h].join('\n').length <= CODE_LIMIT) fit.push(h)
  return fit.length ? { source: fit.join('\n'), format: 'diff', ...(path ? { path } : {}) } : { source: clip(hunks[0]!, CODE_LIMIT), ...(path ? { path } : {}) }
}

/** A tool call as the session titles it: `Edit(src/a.ts)`, `Bash(npm test)`; the raw input when no field names it. */
export const toolLine = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const arg = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'path', 'skill', 'prompt']
    .map(k => i[k])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return arg !== undefined ? `${tool}(${oneLine(arg, 100)})` : `${tool} ${oneLine(JSON.stringify(input ?? {}), 100)}`
}
