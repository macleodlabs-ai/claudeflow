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
      return `<button class="tab ${t.key === current?.key ? 'on' : ''} ${t.isStale ? 'stale' : ''}" data-session="${esc(t.key)}" aria-current="${t.key === current?.key}">
      ${x.session.busy ? '<span class="busy" aria-label="working">●</span> ' : ''}<span class="who">${esc(x.session.account)}</span> · ${esc(x.session.project)}${live ? `<span class="n">${live}</span>` : ''}</button>`
    })
    .join('')
}

function session(s: State, t: SessionTab, now: number, isWide: boolean): string {
  const x = t.snapshot
  const streams = x.streams ?? []
  const stop =
    x.session.busy && !t.isStale
      ? `<div class="session-bar"><span class="meta">Claude is working</span><span class="grow"></span>
      <button class="btn stop" data-stop>${isStopConfirmed(s, now) ? 'Tap again to stop' : '■ Stop'}</button></div>`
      : ''
  const stale = t.isStale ? `<p class="stale-note">Not heard from for ${clock(now - t.seen)}: the session may have ended.</p>` : ''
  const views = `<div class="views" role="tablist">
    <button data-view="streams" role="tab" aria-selected="${s.view === 'streams'}" class="${s.view === 'streams' ? 'on' : ''}">Streams</button>
    <button data-view="status" role="tab" aria-selected="${s.view === 'status'}" class="${s.view === 'status' ? 'on' : ''}">Status</button></div>`
  const body = s.view === 'status' ? statusView(x, now) : streamsView(s, t.key, streams, now, isWide)
  // From 820 px the working line and Stop sit at the right of the toolbar, by the streams they stop.
  return `${isWide ? '' : stop}${permissions(x, now)}${stale}
    <div class="toolbar"><div class="chips">${chips(streams)}</div>${views}${isWide ? stop : ''}</div>${body}${usageBar(x, s.isUsageOpen, now)}`
}

/** The page below the gates; empty-state text when nothing has arrived yet. `isWide` is the 820 px two-pane layout. */
export function page(s: State, now: number, hasOpenRoom: boolean, isWide = false): string {
  const t = currentOf(s, now)
  if (t) return session(s, t, now, isWide)
  return hasOpenRoom ? '<div class="empty"><span class="motif" aria-hidden="true"></span>Nothing flowing yet. Start Claude Code on your Mac.</div>' : ''
}
