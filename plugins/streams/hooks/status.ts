import type { Health, Stream } from '../types'
import { ago, clockOf, oneLine, type BadgeKind } from './classify'

/** What the status card says of one stream: a state word, its colour kind, and one line of detail. */
export type StatusKind = BadgeKind | 'waiting'
export type StatusLine = { id: string; area: string; kind?: StatusKind; state: string; detail: string }
export type StatusInput = {
  stream: Pick<Stream, 'id' | 'name' | 'summary' | 'lastAt'>
  health: Health
  loop?: { kind: 'wakeup' | 'cron'; nextAt: number; label: string }
  running: { description: string; last: string; tools: number }[]
  /** The stream's last prompt or reply: a reply ending in a question is waiting on the person. */
  lastSaid?: { kind: string; text: string }
  now: number
}

const STATE_WORD: Record<StatusKind, string> = {
  running: 'RUNNING',
  loop: 'LOOP',
  waiting: 'WAITING FOR YOU',
  error: 'ERROR',
  stalled: 'STALLED',
  done: 'DONE',
  idle: 'IDLE',
}
const STATE_RANK: Record<StatusKind, number> = { running: 0, loop: 1, waiting: 2, error: 3, stalled: 4, done: 5, idle: 6 }

/** The question a reply ends on, as its last sentence; undefined when it does not end on one. */
export const questionOf = (text: string): string | undefined => {
  const t = text.trim().replace(/[*_`\s]+$/, '')
  if (!t.endsWith('?')) return undefined
  const last = t.split(/(?<=[.!?:])\s+|\n+/).filter(Boolean).at(-1) ?? t
  return oneLine(last, 300)
}

/** One stream's row on the status card: what it is doing, or what it last left the person with. */
export function statusOf(x: StatusInput): StatusLine {
  const { stream: s, now } = x
  const line = (kind: StatusKind, detail: string, state = STATE_WORD[kind]): StatusLine => ({ id: s.id, area: s.name, kind, state, detail })
  if (x.health === 'running') {
    const top = x.running[0]
    if (!top) return line('running', `main turn · ${s.summary}`)
    const more = x.running.length > 1 ? `${x.running.length} agents · ` : ''
    return line('running', `${more}${top.description}: ${top.tools ? `${top.last} (${top.tools} tools)` : 'starting up'}`)
  }
  if (x.loop) {
    const when = x.loop.kind === 'cron' ? x.loop.label : `next tick in ${clockOf(Math.max(0, x.loop.nextAt - now))}`
    return line('loop', `${when} · ${s.summary}`)
  }
  const question = x.lastSaid?.kind === 'reply' ? questionOf(x.lastSaid.text) : undefined
  if (question && x.health !== 'error') return line('waiting', question)
  return line(x.health, `${s.summary || '—'} · ${ago(now - s.lastAt)} ago`)
}

/** Status rows in the order that needs the person: running, looping, waiting, failed, then the finished. */
export const sortStatus = (lines: StatusLine[], lastAt: Record<string, number>): StatusLine[] =>
  [...lines].sort((a, b) => STATE_RANK[a.kind ?? 'idle'] - STATE_RANK[b.kind ?? 'idle'] || (lastAt[b.id] ?? 0) - (lastAt[a.id] ?? 0))

/** The card's git rows from `git status --porcelain=v1 --branch`: branch against upstream, and what is uncommitted. */
export function gitStatus(porcelain: string): StatusLine[] {
  const [head = '', ...files] = porcelain.split('\n').filter(Boolean)
  const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head)
  if (!m) return []
  const [, branch = '', upstream, track = ''] = m
  const ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
  const sync = !upstream
    ? 'no upstream; nothing pushed'
    : ahead || behind
      ? [ahead ? `${ahead} unpushed` : '', behind ? `${behind} behind ${upstream}` : ''].filter(Boolean).join(', ')
      : `up to date with ${upstream}`
  const rows: StatusLine[] = [{ id: 'git:branch', area: 'Git branch', state: branch, detail: sync }]
  const paths = files.map(f => f.slice(3))
  rows.push({
    id: 'git:changes',
    area: 'Uncommitted',
    state: paths.length ? `${paths.length} file${paths.length === 1 ? '' : 's'}` : 'none',
    detail: paths.length ? oneLine(paths.slice(0, 4).join(', ') + (paths.length > 4 ? ` +${paths.length - 4} more` : ''), 300) : 'clean',
  })
  return rows
}

/** A ticket id as trackers write them (TL-260, ENG-1042); the standards and encodings that look alike are not tickets. */
const TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g
const NOT_TICKETS = new Set(['UTF', 'SHA', 'ISO', 'GPT', 'RFC', 'HTTP', 'IPV', 'ES', 'MD', 'ECMA', 'WCAG', 'COVID', 'AES', 'RSA', 'P', 'H', 'X', 'TLS', 'SSL'])

/** The ticket ids a text names, in order, each once. */
export const ticketsIn = (text: string): string[] =>
  [...new Set([...text.matchAll(TICKET)].map(m => m[1] ?? '').filter(id => id && !NOT_TICKETS.has(id.split('-')[0] ?? '')))]

export type TicketInput = {
  rows: readonly { kind: string; text: string; at: number; streamId: string }[]
  agents: readonly { description: string; status: 'running' | 'done' | 'error'; last: string; tools: number; lastAt: number; endedAt?: number; streamId: string }[]
  /** Each stream's own state on the card, so a ticket worked in a waiting stream is waiting too. */
  streamKind: Record<string, StatusKind>
  now: number
}

/** The sentence of a text that names the ticket, or its first sentence. */
const sentenceAbout = (text: string, id: string): string => {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
  return sentences.find(s => s.includes(id)) ?? sentences[0] ?? ''
}

/**
 * One status row per ticket the person or an agent was set to work on: named in a prompt or an agent's task.
 * Running agents on it say what they are doing and how long they have been quiet; otherwise its latest news.
 */
export function ticketLines(x: TicketInput): StatusLine[] {
  const { now } = x
  const named = [...new Set([...x.rows.filter(r => r.kind === 'prompt' || r.kind === 'loop').map(r => r.text), ...x.agents.map(a => a.description)].flatMap(ticketsIn))]
  const lines = named.map(id => {
    const mine = x.agents.filter(a => ticketsIn(a.description).includes(id))
    const said = x.rows.filter(r => ticketsIn(r.text).includes(id)).sort((a, b) => a.at - b.at)
    const lastAt = Math.max(0, ...mine.map(a => a.endedAt ?? a.lastAt), ...said.map(r => r.at))
    const line = (kind: StatusKind, detail: string): StatusLine & { lastAt: number } => ({ id: `ticket:${id}`, area: id, kind, state: STATE_WORD[kind], detail, lastAt })
    const running = mine.filter(a => a.status === 'running').sort((a, b) => b.lastAt - a.lastAt)
    const top = running[0]
    if (top) {
      const quiet = now - top.lastAt > 60_000 ? `, ${ago(now - top.lastAt)} with no output` : ''
      const more = running.length > 1 ? `${running.length} agents · ` : ''
      return line('running', `${more}${top.description}: ${top.tools ? `${top.last} (${top.tools} tools${quiet})` : 'starting up'}`)
    }
    const ended = mine.filter(a => a.endedAt !== undefined).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
    const reply = said.filter(r => r.kind === 'reply').at(-1)
    if (ended?.status === 'error' && (ended.endedAt ?? 0) >= (reply?.at ?? 0)) return line('error', `${ended.description} failed`)
    const streams = [...new Set([...said.map(r => r.streamId), ...mine.map(a => a.streamId)])]
    const kinds = streams.map(s => x.streamKind[s] ?? 'idle')
    const kind = (['running', 'waiting', 'loop', 'error', 'stalled', 'done'] as const).find(k => kinds.includes(k)) ?? 'idle'
    const latest = said.filter(r => r.kind !== 'tool').at(-1)
    const news = latest ? oneLine(sentenceAbout(latest.text, id), 300) : ended ? `${ended.description} finished` : ''
    return line(kind, news || '—')
  })
  return sortStatus(lines, Object.fromEntries(lines.map(l => [l.id, l.lastAt]))).map(({ id, area, kind, state, detail }) => ({ id, area, ...(kind ? { kind } : {}), state, detail }))
}

/** One plan limit as the status card's footer shows it. */
export type LimitView = { label: string; percent: number; bar: string; resetsIn: string; resetsAt: string }

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'week', seven_day_opus: 'week opus', seven_day_sonnet: 'week sonnet', spend_limit: 'spend' }
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** How long until a time, in the two largest units: `3d 4h`, `2h 14m`, `9m`. */
export const untilOf = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`
}

/** A plan limit for the card: its window, a ten-cell bar, the percent used, and when it resets with the weekday. */
export function limitView(limit: { kind: string; percentUsed: number; resetsAt?: string }, now: number): LimitView {
  const percent = Math.round(limit.percentUsed)
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)))
  const at = limit.resetsAt ? new Date(limit.resetsAt) : undefined
  const ok = at !== undefined && !Number.isNaN(at.getTime())
  return {
    label: LIMIT_LABEL[limit.kind] ?? limit.kind.replace(/_/g, ' '),
    percent,
    bar: '▰'.repeat(filled) + '▱'.repeat(10 - filled),
    resetsIn: ok ? untilOf(at.getTime() - now) : '',
    resetsAt: ok ? `${WEEKDAY[at.getDay()]} ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` : '',
  }
}
