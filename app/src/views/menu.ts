// The ☰ menu: one place for what is set up rather than watched. Sharing the shown project (the owner's devices
// only): invite someone to watch or to contribute, and manage who it is shared with; pairing another device; Lock now.
import { isArmed, type SessionTab, type State } from '../state'
import { esc } from './util'

/** An invite being made, or made: its link to share, or why it could not be made. */
export type InviteView = { role: 'viewer' | 'contributor'; isBusy: boolean; link?: string; why?: string }

const ROLE_WORD = { viewer: 'Watching', contributor: 'Contributing' } as const

/** Days (or hours, under a day) until `until`, for "6d left". */
export const leftOf = (until: number, now: number): string => {
  const ms = Math.max(0, until - now)
  return ms >= 86_400_000 ? `${Math.floor(ms / 86_400_000)}d left` : `${Math.max(1, Math.ceil(ms / 3_600_000))}h left`
}

/** On a shared device: what it may do here, and for how long. */
export function roleNote(t: SessionTab, now: number): string {
  const you = t.snapshot.you
  if (!you) return ''
  return `<div class="role-note role-${you.role}">${ROLE_WORD[you.role]} · ${esc(t.snapshot.session.project)} · ${leftOf(you.until, now)}</div>`
}

function people(s: State, t: SessionTab, now: number, invite: InviteView | undefined): string {
  const list = (t.snapshot.people ?? [])
    .map(p => {
      const removeKey = `remove:${p.id}`
      return `<div class="person"><div class="who"><b>${esc(p.label)}</b><span class="meta">${ROLE_WORD[p.role]} · ${leftOf(p.until, now)}</span></div>
        <div class="seg" role="group" aria-label="Role">
          <button type="button" class="${p.role === 'viewer' ? 'on' : ''}" data-people-role="${esc(p.id)}" data-role="viewer">Watch</button>
          <button type="button" class="${p.role === 'contributor' ? 'on' : ''}" data-people-role="${esc(p.id)}" data-role="contributor">Contribute</button></div>
        <button type="button" class="btn ghost small" data-people-extend="${esc(p.id)}">+7d</button>
        <button type="button" class="btn ghost small danger" data-arm-remove="${esc(p.id)}">${isArmed(s, removeKey, now) ? 'Tap again' : 'Remove'}</button></div>`
    })
    .join('')
  const made = invite?.link
    ? `<div class="invite-made"><p>Anyone with this link can join <b>${esc(t.snapshot.session.project)}</b> as ${invite.role === 'viewer' ? 'a watcher' : 'a contributor'} once, within 24 hours, for 7 days:</p>
      <input class="invite-link" readonly value="${esc(invite.link)}" aria-label="Invite link">
      <div class="actions"><button type="button" class="btn" data-share-link>Share…</button><button type="button" class="btn ghost" data-copy-link>Copy</button></div></div>`
    : invite?.isBusy
      ? '<p class="meta">Making the link…</p>'
      : invite?.why
        ? `<p class="why">${esc(invite.why)}</p>`
        : ''
  return `<section class="menu-section"><h3>Share ${esc(t.snapshot.session.project)}</h3>
    <div class="actions"><button type="button" class="btn" data-invite="viewer">Invite to watch</button><button type="button" class="btn ghost" data-invite="contributor">Invite to contribute</button></div>
    ${made}${list ? `<div class="people">${list}</div>` : '<p class="meta">Not shared with anyone yet.</p>'}</section>`
}

/** The menu sheet, or nothing while it is closed. */
export function menuView(s: State, t: SessionTab | undefined, isOpen: boolean, now: number, invite: InviteView | undefined): string {
  if (!isOpen) return ''
  // Sharing is the owner's: a device the project was shared with sees no Share section.
  const share = t && !t.snapshot.you ? people(s, t, now, invite) : ''
  return `<div class="sheet-backdrop" data-menu-close></div><div class="sheet" role="dialog" aria-label="Menu">
    <div class="sheet-head"><b>Menu</b><button type="button" class="icon-btn" data-menu-close aria-label="Close">✕</button></div>
    ${share}
    <section class="menu-section"><h3>Devices</h3><div class="actions"><button type="button" class="btn ghost" data-scan>📷 Pair this device by code</button>
      <button type="button" class="btn ghost" data-lock>🔒 Lock now</button></div></section></div>`
}
