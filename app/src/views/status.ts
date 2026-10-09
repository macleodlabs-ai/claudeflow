// The Status view, as the terminal's status card: Git, then Tickets, then every stream, what needs you first.
import type { Snapshot } from '../state'
import { detailOf, esc, STATE_COLOR } from './util'

const srow = (area: string, state: string, c: string, detail: string) => `<div class="srow"><span class="area">${esc(area)}</span>
  <span class="state" style="color:${c}">${esc(state)}</span><span class="sdetail">${esc(detail)}</span></div>`

const group = (name: string, rows: string[]) => (rows.length ? `<div class="sgroup">${name}</div><div class="status">${rows.join('')}</div>` : '')

export function statusView(x: Snapshot, now: number): string {
  const lines = x.status ?? []
  const git = lines.filter(l => !l.kind).map(l => srow(l.area, l.state, '#a5d8ff', l.detail))
  const tickets = lines.filter(l => l.kind).map(l => srow(l.area, l.state, STATE_COLOR[l.kind!] ?? '#8b949e', l.detail))
  const streams = (x.streams ?? []).map(s =>
    srow(s.name, s.kind === 'waiting' ? 'WAITING' : s.state, STATE_COLOR[s.kind] ?? '#8b949e', s.question || detailOf(s, now)),
  )
  return group('Git', git) + group('Tickets', tickets) + group('Streams', streams) || '<p class="empty">Nothing to report yet.</p>'
}
