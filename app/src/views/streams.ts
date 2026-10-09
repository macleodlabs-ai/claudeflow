// The Streams view: a card per stream, a waiting one with its question and Yes / Reply, and a reply box whose
// draft comes from the state, so a redraw from a new snapshot keeps what was typed.
import { SENT_MS, streamKey, type State } from '../state'
import { clock, color, detailOf, esc, GLYPH, kindOf, STATE_COLOR, type Stream } from './util'

const ROW_CLASS: Record<string, string> = { prompt: 'prompt', reply: 'reply', tool: 'tool', agent: 'agent-row', loop: 'loop', notice: 'notice' }

const sentNote = (s: State, key: string, now: number) => (now - (s.sentAt[key] ?? 0) < SENT_MS ? '<span class="sent">✓ sent</span>' : '')

export function replyBox(s: State, key: string): string {
  return `<div class="replybox"><textarea rows="2" placeholder="Reply in this stream…" data-draft="${esc(key)}">${esc(s.drafts[key] ?? '')}</textarea>
    <button class="btn" data-send="${esc(key)}">Send</button></div>`
}

export function card(s: State, sessionKey: string, x: Stream, now: number): string {
  const key = streamKey(sessionKey, x.id)
  const isOpen = s.open.includes(key)
  const kind = kindOf(x.kind)
  const icon = kind === 'running' ? '<span class="icon spin"></span>' : `<span class="icon">${GLYPH[kind]}</span>`
  const agents = (x.agents ?? [])
    .map(
      a => `<div class="agent"><span class="dot" style="background:${STATE_COLOR[a.status] ?? '#8b949e'}"></span>
      <div class="what"><div>${esc(a.description)}</div><div class="last">${esc(a.last)}</div></div>
      <span class="meta">${Number(a.tools) || 0} tools · ${clock((Number(a.endedAt) || now) - (Number(a.startedAt) || now))}</span></div>`,
    )
    .join('')
  const rows = (x.rows ?? []).map(r => `<div class="row ${ROW_CLASS[r.kind] ?? ''}">${esc(r.text)}</div>`).join('')
  const question = x.question
    ? `<div class="question">${esc(x.question)}
      <div class="actions"><button class="btn yes" data-answer="${esc(key)}">Yes</button>
      <button class="btn ghost" data-reply-open="${esc(key)}">Reply…</button>${sentNote(s, key, now)}</div></div>`
    : ''
  return `<section class="card ${isOpen ? 'open' : ''}" style="--c:${color(x.color)}">
    <div class="head" data-toggle="${esc(key)}">${icon}
      <div class="title"><div class="name">${esc(x.name)}</div>${x.question ? '' : `<div class="detail">${esc(detailOf(x, now))}</div>`}</div>
      <span class="badge bg-${kind} k-${kind}">${kind === 'waiting' ? 'waiting' : esc(x.state)}</span>
      <span class="chev">${isOpen ? '▾' : '▸'}</span></div>
    ${question}
    <div class="body">${agents}${rows || '<div class="row reply">Nothing filed yet.</div>'}${replyBox(s, key)}${x.question ? '' : sentNote(s, key, now)}</div>
  </section>`
}

/** Counts by state, what needs you first. */
export function chips(streams: Stream[]): string {
  return ['waiting', 'running', 'loop', 'error', 'stalled', 'done']
    .map(k => [k, streams.filter(x => x.kind === k).length] as const)
    .filter(([, n]) => n)
    .map(([k, n]) => `<span class="chip bg-${k} k-${k}">${GLYPH[k]} ${n} ${k}</span>`)
    .join('')
}

export function streamsView(s: State, sessionKey: string, streams: Stream[], now: number): string {
  return streams.length ? streams.map(x => card(s, sessionKey, x, now)).join('') : '<p class="empty">Streams appear as you prompt.</p>'
}
