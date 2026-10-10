// The session page: one tab per session across every paired room, then the chosen session's Stop, permission
// prompts, the Streams | Status switch and its view, "Notify me", with plan usage pinned at the bottom.
import { currentOf, newsOf, isInFlight, isStopConfirmed, askCards, stopKey, tabsOf, type SessionTab, type State } from '../state'
import { summaryLine } from './flows'
import { notifyRow, type NotifyView } from './notify'
import { permissions } from './permissions'
import { statusView } from './status'
import { chips, streamsView } from './streams'
import { usageBar } from './usage'
import { clock, esc, spinner } from './util'

/** One session's button: working dot, account · project, and how many of its streams are live. */
function tab(s: State, t: SessionTab, current: SessionTab | undefined, cls: string, role = ''): string {
  const x = t.snapshot
  const live = (x.streams ?? []).filter(st => st.kind === 'running' || st.kind === 'waiting').length
  const news = hasNews(s, t, current) ? '<span class="news" role="img" aria-label="news"></span>' : ''
  return `<button class="${cls} ${t.key === current?.key ? 'on' : ''} ${t.isStale ? 'stale' : ''}" data-session="${esc(t.key)}" aria-current="${t.key === current?.key}"${role}>
      ${x.session.busy ? '<span class="busy" aria-label="working">●</span> ' : ''}<span class="who">${esc(x.session.account)}</span> · ${esc(x.session.project)}${news}${live ? `<span class="n">${live}</span>` : ''}</button>`
}

/** Another project with streams changed since they were viewed, unless the bell is muted. */
const hasNews = (s: State, t: SessionTab, current: SessionTab | undefined): boolean => !s.isMuted && t.key !== current?.key && newsOf(s, t.key) > 0

/** The header's bell, with more than one session: mutes and unmutes the news of other projects. */
export function bell(s: State, now: number): string {
  if (tabsOf(s, now).length < 2) return ''
  return `<button class="bell ${s.isMuted ? 'muted' : ''}" type="button" data-mute aria-pressed="${s.isMuted}" aria-label="${s.isMuted ? 'Unmute other projects' : 'Mute other projects'}">${s.isMuted ? '🔕' : '🔔'}</button>`
}

export function tabs(s: State, now: number): string {
  const current = currentOf(s, now)
  return tabsOf(s, now)
    .map(t => tab(s, t, current, 'tab'))
    .join('')
}

/**
 * The header's page name: the shown session's project. With more than one session it is a button: swipe it sideways
 * for the next or previous session (main.ts), hold or tap it for the list; dots say where in the list this one is.
 */
export function switcher(s: State, now: number): string {
  const all = tabsOf(s, now)
  const current = currentOf(s, now)
  if (!current) return 'Streams'
  const name = esc(current.snapshot.session.project)
  if (all.length < 2) return name
  const dots = all.map(t => `<i class="${t.key === current.key ? 'on' : hasNews(s, t, current) ? 'new' : ''}"></i>`).join('')
  const news = all.filter(t => hasNews(s, t, current)).length
  const badge = news ? `<span class="switch-news" aria-label="${news} other ${news === 1 ? 'project has' : 'projects have'} news">${news}</span>` : ''
  const menu = s.isSwitchOpen
    ? `<div class="switch-menu" role="menu">${all.map(t => tab(s, t, current, 'switch-item', ' role="menuitem"')).join('')}</div>`
    : ''
  return `<button class="switch" type="button" data-switch aria-haspopup="menu" aria-expanded="${s.isSwitchOpen}">
    <span class="switch-name">${name}</span><span class="switch-dots" aria-hidden="true">${dots}</span>${badge}<span class="caret" aria-hidden="true">▾</span></button>${menu}`
}

function session(s: State, t: SessionTab, now: number, isWide: boolean, notify?: NotifyView): string {
  const x = t.snapshot
  const streams = x.streams ?? []
  const isStopping = isInFlight(s.taps[stopKey(t.key)])
  const stop =
    x.session.busy && !t.isStale
      ? `<div class="session-bar"><span class="meta">Claude is working</span><span class="grow"></span>
      <button class="btn stop" data-stop ${isStopping ? 'disabled' : ''}>${isStopping ? `${spinner}Stopping…` : isStopConfirmed(s, now) ? 'Tap again to stop' : '■ Stop'}</button></div>`
      : ''
  const stale = t.isStale ? `<p class="stale-note">Not heard from for ${clock(now - t.seen)}: the session may have ended.</p>` : ''
  const views = `<div class="views" role="tablist">
    <button data-view="streams" role="tab" aria-selected="${s.view === 'streams'}" class="${s.view === 'streams' ? 'on' : ''}">Streams</button>
    <button data-view="status" role="tab" aria-selected="${s.view === 'status'}" class="${s.view === 'status' ? 'on' : ''}">Status</button></div>`
  const body = s.view === 'status' ? statusView(x, now) : streamsView(s, t.key, streams, now, isWide)
  // The dock: the runs-and-loops line sits on plan usage, pinned to the bottom (on a Mac, main.ts puts it in the sidebar).
  const dock = summaryLine(x, now) + usageBar(x, s.isUsageOpen, now)
  // From 820 px the working line and Stop sit at the right of the toolbar, by the streams they stop.
  return `${isWide ? '' : stop}${permissions(askCards(s, t.key, now), now)}${stale}
    <div class="toolbar"><div class="chips">${chips(streams)}</div>${views}${isWide ? stop : ''}</div>${body}${notifyRow(notify)}${dock ? `<div class="dock">${dock}</div>` : ''}`
}

/**
 * The page below the gates; empty-state text when nothing has arrived yet. `isWide` is the 820 px two-pane layout;
 * `notify` the "Notify me" row, drawn with a session, so only once a room is unlocked.
 */
export function page(s: State, now: number, hasOpenRoom: boolean, isWide = false, notify?: NotifyView): string {
  const t = currentOf(s, now)
  if (t) return session(s, t, now, isWide, notify)
  return hasOpenRoom ? '<div class="empty"><span class="motif" aria-hidden="true"></span>Nothing flowing yet. Start Claude Code on your Mac.</div>' : ''
}
