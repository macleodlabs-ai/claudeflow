// The screens before a room's sessions: Pair this device (make a passkey), Locked (Unlock with it), Not paired.
// One per room that needs something, so a device paired with several accounts unlocks each with its own Face ID.
// While a passkey step runs its button says where it is (Face ID, then syncing with the Mac) and takes no second tap.
// A guest (invited to someone else's project) gets its own words: the project and who shared it, never the Mac.
import type { Gate, Guest } from '../links'
import type { GateStage } from '../transport'
import { esc, SLOW_TEXT, spinner } from './util'

export type GateView = {
  room: string
  gate: Gate
  label: string
  why: string
  stage: GateStage
  /** The Mac has not answered the hello for state.ts SLOW_MS: say so, offer Retry, keep waiting. */
  isSlow: boolean
  /** A passkey ceremony is up somewhere in the app: only one at a time. */
  isCeremony: boolean
  isOnline: boolean
  canRepair: boolean
  /** Joined by an invite: spoken to about the project and its owner. */
  guest?: Guest
  /** The name the guest has typed so far, kept across redraws. */
  name?: string
}

const NOT_PAIRED = 'Open the invite link you were sent. Or, to see your own Claude Code: run <b>/streams phone</b> on your Mac and scan the code it shows.'
/** The Mac's refusals, said so the way out is clear. */
const WHY_TEXT: Record<string, string> = {
  'not paired': 'Your Mac no longer knows this device. Run /streams phone on your Mac and scan its code to pair again.',
  'passkey not verified': 'Your Mac could not check that Face ID. Tap Unlock to try again; if it keeps failing, scan a new code.',
}
const PENDING = { faceid: 'Waiting for Face ID…', checking: 'Syncing…' } as const

/** A refusal or a line from the connection, as a guest reads it: what happened to their access, and who to ask. */
function guestWhy(why: string, { project, owner }: Guest): string {
  if (why === 'access removed') return `${owner} removed your access to ${project}. Ask them if you need it back.`
  if (why === 'access expired') return `Your access to ${project} has ended. Ask ${owner} to extend it.`
  if (why === 'not paired') return `You no longer have access to ${project}. Ask ${owner} for a new invite.`
  if (why === 'pairing expired' || why === 'bad pairing proof') return `This invite has expired or was already used. Ask ${owner} for a new link.`
  if (why === 'passkey not verified') return "Face ID couldn't be checked. Tap Unlock to try again."
  if (why === 'bad registration') return 'Setting up Face ID went wrong. Try again.'
  return /\bMac\b|pair|passkey/i.test(why) ? `Couldn't reach ${project}. Try again in a moment.` : why
}

/** The gates of a project someone shared: join with a name and Face ID, unlock, or why it cannot open. */
function guestOne(g: GateView, guest: Guest): string {
  const { project, owner } = guest
  const why = g.why && g.stage.at === 'idle' ? `<p class="why" role="status">${esc(guestWhy(g.why, guest))}</p>` : ''
  const isBusy = g.stage.at !== 'idle'
  const btn = (kind: 'pair' | 'unlock', text: string) => {
    const isMine = g.stage.at !== 'idle' && g.stage.kind === kind
    const label = isMine && g.stage.at !== 'idle' ? `${spinner}${g.stage.at === 'faceid' ? 'Waiting for Face ID…' : `Opening ${esc(project)}…`}` : text
    return `<button class="btn yes" data-gate="${kind}" data-room="${esc(g.room)}" ${isBusy || g.isCeremony || !g.isOnline ? 'disabled' : ''} ${isMine ? 'aria-busy="true"' : ''}>${label}</button>`
  }
  // Not open now: the project is there while its owner works in it, and the hello waits for it.
  const slow = g.isSlow
    ? `<p class="slow" role="status">${esc(project)} isn't online right now. It opens while ${esc(owner)} is working on it.</p><button class="btn ghost" data-gate="retry" data-room="${esc(g.room)}">Try again</button>`
    : ''
  const offline = g.isOnline ? '' : '<p class="meta">Connecting…</p>'
  if (g.gate === 'pair')
    return `<div class="gate guest"><h2>Join ${esc(project)}</h2>
      <p>${esc(owner)} shared <b>${esc(project)}</b> with you. Add your name so they know it's you, then use Face ID to keep it yours.</p>
      <input class="guest-name" data-guest-name maxlength="40" autocomplete="name" placeholder="Your name" aria-label="Your name" value="${esc(g.name ?? '')}">
      ${why}${btn('pair', 'Join with Face ID')}${slow}${offline}</div>`
  if (g.gate === 'locked')
    return `<div class="gate guest"><h2>${esc(project)}</h2><p>Shared with you by ${esc(owner)}. Unlock with Face ID to see it.</p>${why}${btn('unlock', 'Unlock')}${slow}${offline}</div>`
  return `<div class="gate guest"><h2>${esc(project)}</h2>${why || `<p class="why">This invite has expired or was already used. Ask ${esc(owner)} for a new link.</p>`}</div>`
}

function one(g: GateView, isMany: boolean): string {
  if (g.guest) return guestOne(g, g.guest)
  const who = isMany ? `<div class="meta">${esc(g.label)}</div>` : ''
  const why = g.why && g.stage.at === 'idle' ? `<p class="why" role="status">${esc(WHY_TEXT[g.why] ?? g.why)}</p>` : ''
  // Unlock refused, or no pairing at all: scanning a new code from here is the way back, without leaving the app.
  const scan = g.stage.at === 'idle' && (g.gate === 'not-paired' || (g.gate === 'locked' && WHY_TEXT[g.why])) ? scanButton() : ''
  const isBusy = g.stage.at !== 'idle'
  const btn = (kind: 'pair' | 'unlock', text: string) => {
    const isMine = g.stage.at !== 'idle' && g.stage.kind === kind
    const label = isMine && g.stage.at !== 'idle' ? `${spinner}${PENDING[g.stage.at]}` : text
    return `<button class="btn yes" data-gate="${kind}" data-room="${esc(g.room)}" ${isBusy || g.isCeremony || !g.isOnline ? 'disabled' : ''} ${isMine ? 'aria-busy="true"' : ''}>${label}</button>`
  }
  const slow = g.isSlow
    ? `<p class="slow" role="status">${SLOW_TEXT}</p><button class="btn ghost" data-gate="retry" data-room="${esc(g.room)}">Retry</button>`
    : ''
  const offline = g.isOnline ? '' : '<p class="meta">Connecting…</p>'
  // An account this device no longer uses (an old pairing, a Mac set up again) can be forgotten here.
  const forget = isMany ? `<button type="button" class="btn ghost small" data-forget-room="${esc(g.room)}">Forget this account</button>` : ''
  if (g.gate === 'pair')
    return `<div class="gate">${who}<h2>Pair this device</h2>
      <p>Create a passkey for Claudeflow. You'll use Face ID or your passcode to open it and to allow Claude's actions.</p>${why}${btn('pair', 'Create passkey')}${slow}${offline}</div>`
  if (g.gate === 'locked')
    return `<div class="gate">${who}<h2>Locked</h2><p>Unlock to see your streams.</p>${why}${btn('unlock', 'Unlock')}
      ${g.canRepair ? ` ${btn('pair', 'Pair again')}` : ''}${slow}${offline}${scan}${forget}</div>`
  return `<div class="gate">${who}<h2>Not paired</h2>${why}<p>${NOT_PAIRED}</p>${scan}${forget}</div>`
}

export function gates(views: GateView[]): string {
  // With an account open, one that cannot pair (no code, never paired) is a leftover: it is not shown over the streams.
  const hasOpen = views.some(g => g.gate === 'open')
  const shown = views.filter(g => g.gate !== 'open' && !(hasOpen && g.gate === 'not-paired'))
  return shown.map(g => one(g, views.length > 1)).join('')
}

/** No rooms at all: the app was opened without a pairing link. */
/** Scans the Mac's pairing code from inside the app, so a Home Screen app pairs without opening Safari. */
export const scanButton = (why = ''): string =>
  `<button type="button" class="btn scan-btn" data-scan>📷 Scan pairing code</button>${why ? `<p class="why">${why}</p>` : ''}`

export const unpaired = (why = ''): string => `<div class="gate"><h2>Not paired</h2><p>${NOT_PAIRED}</p>${scanButton(why)}</div>`
