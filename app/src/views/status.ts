// The Status view, as the terminal's status card: Git, then Tickets, then every stream, what needs you first.
import type { Snapshot } from '../state'
import { color, esc, lineText, STATE_COLOR } from './util'

/** One status line; a stream's line carries its strand colour as a dot, so it matches its card. */
const srow = (area: string, state: string, c: string, detail: string, strand = '') => `<div class="srow"${strand ? ` style="--c:${strand}"` : ''}><span class="area">${strand ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(area)}</span>
  <span class="state" style="color:${c}">${esc(state)}</span><span class="sdetail">${esc(detail)}</span></div>`

const group = (name: string, rows: string[]) => (rows.length ? `<div class="sgroup">${name}</div><div class="status">${rows.join('')}</div>` : '')

export function statusView(x: Snapshot, now: number): string {
  const lines = x.status ?? []
  const git = lines.filter(l => !l.kind).map(l => srow(l.area, l.state, 'var(--brand)', l.detail))
  const tickets = lines.filter(l => l.kind).map(l => srow(l.area, l.state, STATE_COLOR[l.kind!] ?? 'var(--text-faint)', lineText(l, now)))
  const streams = (x.streams ?? []).map(s =>
    srow(s.name, s.kind === 'waiting' ? 'WAITING' : s.state, STATE_COLOR[s.kind] ?? 'var(--text-faint)', s.question || lineText(s, now), color(s.color)),
  )
  const all = group('Git', git) + group('Tickets', tickets) + group('Streams', streams)
  return all ? `<div class="statusview">${all}</div>` : '<div class="empty"><span class="motif" aria-hidden="true"></span>Nothing to report yet.</div>'
}
