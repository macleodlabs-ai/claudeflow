// The session page: one tab per session across every paired room, then the chosen session's Stop, permission
// prompts, the Streams | Status switch and its view, with plan usage pinned at the bottom.
import { currentOf, isStopConfirmed, tabsOf, type SessionTab, type State } from '../state'
import { permissions } from './permissions'
import { statusView } from './status'
import { chips, streamsView } from './streams'
import { usageBar } from './usage'
import { clock, esc } from './util'

export function tabs(s: State, now: number): string {
  const all = tabsOf(s, now)
  const current = currentOf(s, now)
  return all
    .map(t => {
      const x = t.snapshot
      const live = (x.streams ?? []).filter(st => st.kind === 'running' || st.kind === 'waiting').length
      return `<button class="tab ${t.key === current?.key ? 'on' : ''} ${t.isStale ? 'stale' : ''}" data-session="${esc(t.key)}">
      ${x.session.busy ? '● ' : ''}${esc(x.session.account)} · ${esc(x.session.project)}${live ? `<span class="n">${live}</span>` : ''}</button>`
    })
    .join('')
}

function session(s: State, t: SessionTab, now: number): string {
  const x = t.snapshot
  const streams = x.streams ?? []
  const stop =
    x.session.busy && !t.isStale
      ? `<div class="session-bar"><span class="meta">Claude is working</span><span class="grow"></span>
      <button class="btn stop" data-stop>${isStopConfirmed(s, now) ? 'Tap again to stop' : '■ Stop'}</button></div>`
      : ''
  const stale = t.isStale ? `<p class="stale-note">Not heard from for ${clock(now - t.seen)}: the session may have ended.</p>` : ''
  const views = `<div class="views" role="tablist">
    <button data-view="streams" class="${s.view === 'streams' ? 'on' : ''}">Streams</button>
    <button data-view="status" class="${s.view === 'status' ? 'on' : ''}">Status</button></div>`
  const body = s.view === 'status' ? statusView(x, now) : streamsView(s, t.key, streams, now)
  return `${stop}${permissions(x, now)}${stale}
    <div class="chips">${chips(streams)}</div>${views}${body}${usageBar(x, s.isUsageOpen)}`
}

/** The page below the gates; empty-state text when nothing has arrived yet. */
export function page(s: State, now: number, hasOpenRoom: boolean): string {
  const t = currentOf(s, now)
  if (t) return session(s, t, now)
  return hasOpenRoom ? '<p class="empty">No sessions yet. Open Claude Code with the streams mod on the Mac.</p>' : ''
}
