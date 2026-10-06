import type { Folded, Health, Stream } from '../types'

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
  | { kind: 'prompt'; uuid: string; text: string; isFolded: boolean }
  | { kind: 'reply'; uuid: string; text: string }
  | { kind: 'tool'; uuid: string; id: string; name: string; input: unknown }

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
