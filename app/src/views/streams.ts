// The Streams view: a card per stream, a waiting one with its question and Yes / Reply, and a reply box whose
// draft comes from the state, so a redraw from a new snapshot keeps what was typed.
import { isInFlight, SENT_MS, SLOW_MS, streamKey, type State, isUnseen } from '../state'
import { flowDetail, flowSub, progress } from './flows'
import { clock, color, esc, GLYPH, kindOf, lineText, SLOW_TEXT, STATE_COLOR, stageLine, type Stream } from './util'

const ROW_CLASS: Record<string, string> = { prompt: 'prompt', reply: 'reply', tool: 'tool', agent: 'agent-row', loop: 'loop', notice: 'notice' }

/** Where this stream's last Yes or reply is: on its way, slow (with Retry), refused, or "Sent ✓" once the Mac has it. */
const sentNote = (s: State, key: string, now: number): string => {
  const t = s.taps[key]
  if (!t) return ''
  if (t.stage === 'done') return now - t.at < SENT_MS ? '<span class="sent" role="status">Sent ✓</span>' : ''
  if (t.stage === 'failed') return stageLine(t.why ?? 'Not sent. Try again.', false)
  if (t.stage === 'queued') return stageLine('Offline: sends when you reconnect…')
  if (now - t.at < SLOW_MS) return stageLine('Sent: waiting for your Mac…')
  return `${stageLine(SLOW_TEXT, false)}<button class="btn ghost" data-retry="${esc(key)}">Retry</button>`
}

export function replyBox(s: State, key: string): string {
  return `<div class="replybox"><textarea rows="2" placeholder="Reply in this stream…" data-draft="${esc(key)}">${esc(s.drafts[key] ?? '')}</textarea>
    <button class="btn" data-send="${esc(key)}" ${isInFlight(s.taps[key]) ? 'disabled' : ''}>Send</button></div>`
}

/** How a card is drawn: inline on a phone (tap to open), as a list row or as the detail pane in the wide layout. */
export type CardMode = 'inline' | 'list' | 'detail'

export function card(s: State, sessionKey: string, x: Stream, now: number, mode: CardMode = 'inline', isSelected = false): string {
  const key = streamKey(sessionKey, x.id)
  const isOpen = mode === 'detail' || (mode === 'inline' && s.open.includes(key))
  const kind = kindOf(x.kind)
  const icon = kind === 'running' ? '<span class="icon spin" aria-hidden="true"></span>' : `<span class="icon" aria-hidden="true">${GLYPH[kind]}</span>`
  const agents = (x.agents ?? [])
    .map(
      a => `<div class="agent"><span class="dot" style="background:${STATE_COLOR[a.status] ?? 'var(--text-faint)'}"></span>
      <div class="what"><div>${esc(a.description)}</div><div class="last">${esc(a.last)}</div></div>
      <span class="meta">${Number(a.tools) || 0} tools · ${clock((Number(a.endedAt) || now) - (Number(a.startedAt) || now))}</span></div>`,
    )
    .join('')
  const rows = (x.rows ?? []).map(r => `<div class="row ${ROW_CLASS[r.kind] ?? ''}">${esc(r.text)}</div>`).join('')
  const question =
    x.question && mode !== 'list'
      ? `<div class="question">${esc(x.question)}
      <div class="actions"><button class="btn yes" data-answer="${esc(key)}" ${isInFlight(s.taps[key]) ? 'disabled' : ''}>Yes</button>
      <button class="btn ghost" data-reply-open="${esc(key)}">Reply…</button>${sentNote(s, key, now)}</div></div>`
      : ''
  // A list row shows the question as its line, so what needs you reads without opening it. A run or a loop says
  // where it is instead of the status detail: phase and count, or next tick, quiet streak and last change.
  const line = x.question ? (mode === 'list' ? `<div class="sub">${esc(x.question)}</div>` : '') : `<div class="sub">${esc(flowSub(x, now) ?? lineText(x, now))}</div>`
  const act =
    mode === 'inline'
      ? `data-toggle="${esc(key)}" role="button" tabindex="0" aria-expanded="${isOpen}"`
      : mode === 'list'
        ? `data-select="${esc(key)}" role="button" tabindex="0" aria-current="${isSelected}"`
        : ''
  const chev = mode === 'inline' ? `<span class="chev" aria-hidden="true">▸</span>` : ''
  const flow = mode === 'list' ? '' : flowDetail(s, key, x, now)
  const body =
    mode === 'list'
      ? ''
      : `<div class="body">${flow}${agents}${rows || (flow ? '' : '<div class="row reply">Quiet so far.</div>')}${x.question ? '' : sentNote(s, key, now)}</div>`
  return `<section class="card st-${kind} ${isOpen ? 'open' : ''} ${mode !== 'inline' ? mode : ''} ${isSelected ? 'sel' : ''}" style="--c:${color(x.color)}">
    <div class="head" ${act}>${icon}
      <div class="title"><div class="name">${esc(x.name)}${mode !== 'detail' && isUnseen(s, sessionKey, x) ? '<span class="new-dot" role="img" aria-label="changed since you looked"></span>' : ''}</div>${line}</div>
      <span class="badge bg-${kind} k-${kind}">${kind === 'waiting' ? 'waiting' : esc(x.state)}</span>${chev}</div>
    ${x.workflow ? progress(x.workflow) : ''}${question}${body}
  </section>`
}

/** Counts by state, what needs you first. */
export function chips(streams: Stream[]): string {
  return ['waiting', 'running', 'loop', 'error', 'stalled', 'done']
    .map(k => [k, streams.filter(x => x.kind === k).length] as const)
    .filter(([, n]) => n)
    .map(([k, n]) => `<span class="chip bg-${k} k-${k}" title="${n} ${k}">${GLYPH[k]} ${n}<span class="chip-word"> ${k}</span></span>`)
    .join('')
}

/** The stream the wide layout's detail pane shows: the last one opened, else the first that needs you, else the first. */
export function selectedOf(s: State, sessionKey: string, streams: Stream[]): string | undefined {
  const keys = streams.map(x => streamKey(sessionKey, x.id))
  const waiting = streams.findIndex(x => x.kind === 'waiting')
  return [...s.open].reverse().find(k => keys.includes(k)) ?? keys[waiting] ?? keys[0]
}

/** Phones get a column of cards that open in place; from 820 px a list on the left and the chosen stream on the right. */
export function streamsView(s: State, sessionKey: string, streams: Stream[], now: number, isWide = false): string {
  if (!streams.length) return '<div class="empty"><span class="motif" aria-hidden="true"></span>Streams appear as you prompt.</div>'
  if (!isWide) return streams.map(x => card(s, sessionKey, x, now)).join('')
  const sel = selectedOf(s, sessionKey, streams)
  const chosen = streams.find(x => streamKey(sessionKey, x.id) === sel)!
  const list = streams.map(x => card(s, sessionKey, x, now, 'list', streamKey(sessionKey, x.id) === sel)).join('')
  return `<div class="split"><div class="list" aria-label="Streams">${list}</div>
    <div class="pane">${card(s, sessionKey, chosen, now, 'detail')}</div></div>`
}
