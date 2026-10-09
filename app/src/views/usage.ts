// Plan usage, pinned to the bottom: one row of mini bars; a tap shows each limit with when it resets.
import type { Snapshot } from '../state'
import { esc, limitColor, resetsIn } from './util'

export function usageBar(x: Snapshot, isOpen: boolean, now: number): string {
  const limits = x.limits ?? []
  if (!limits.length) return ''
  const pct = (p: number) => Math.max(0, Math.min(100, Number(p) || 0))
  const row = limits
    .map(
      l => `<span class="u"><span class="meta">${esc(l.label)}</span>
      <span class="mini"><i style="width:${pct(l.percent)}%;background:${limitColor(l.percent)}"></i></span>
      <b style="color:${limitColor(l.percent)}">${pct(l.percent)}%</b></span>`,
    )
    .join('')
  const more = limits
    .map(
      l => `<div class="limit"><span class="meta">${esc(l.label)}</span>
      <span class="bar"><i style="width:${pct(l.percent)}%;background:${limitColor(l.percent)}"></i></span>
      <span class="pct" style="color:${limitColor(l.percent)}">${pct(l.percent)}%</span>
      ${l.until !== undefined ? `<span class="meta reset">resets in ${esc(resetsIn(l, now))} · ${esc(l.resetsAt)}</span>` : ''}</div>`,
    )
    .join('')
  return `<div class="usage" data-usage role="button" aria-expanded="${isOpen}" tabindex="0">
    <div class="usage-row"><span class="meta">Plan usage</span>${row}<span class="grow"></span><span class="chev" aria-hidden="true">▸</span></div>
    ${isOpen ? `<div class="more">${more}</div>` : ''}</div>`
}
