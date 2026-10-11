// The screens before a room's sessions: Pair this device (make a passkey), Locked (Unlock with it), Not paired.
// One per room that needs something, so a device paired with several accounts unlocks each with its own Face ID.
// While a passkey step runs its button says where it is (Face ID, then syncing with the Mac) and takes no second tap.
// A guest (invited to someone else's project) gets its own words: the project and who shared it, never the Mac.
import type { Gate, Guest } from '../links'
import type { SignIn } from '../signin'
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
  /** How this device signs in, for a guest's words and ways in. */
  signIn?: SignIn
  /** The room's key is this browser's own (no passkey): it opens with no prompt. */
  isBrowserKey?: boolean
}

const NOT_PAIRED = 'Open the invite link you were sent. Or, to see your own Claude Code: run <b>/streams phone</b> on your Mac and scan the code it shows.'
/** The Mac's refusals, said so the way out is clear. */
const WHY_TEXT: Record<string, string> = {
  'not paired': 'Your Mac no longer knows this device. Run /streams phone on your Mac and scan its code to pair again.',
  'passkey not verified': 'Your Mac could not check that Face ID. Tap Unlock to try again; if it keeps failing, scan a new code.',
}
const PENDING = { faceid: 'Waiting for Face ID…', checking: 'Syncing…' } as const

/** A refusal or a line from the connection, as a guest reads it: what happened to their access, and who to ask. */
function guestWhy(why: string, { project, owner }: Guest, term: string): string {
  if (why === 'access removed') return `${owner} removed your access to ${project}. Ask them if you need it back.`
  if (why === 'access expired') return `Your access to ${project} has ended. Ask ${owner} to extend it.`
  if (why === 'not paired') return `You no longer have access to ${project}. Ask ${owner} for a new invite.`
  if (why === 'pairing expired' || why === 'bad pairing proof') return `This invite has expired or was already used. Ask ${owner} for a new link.`
  if (why === 'passkey not verified') return `${cap(term)} couldn't be checked. Try Unlock again.`
  if (why === 'bad registration') return `Setting up ${term} went wrong. Try again.`
  // passkey.ts's words, said for this device.
  if (/already has that passkey/.test(why)) return 'This device is already set up for it. Try again.'
  if (/can't use passkeys/.test(why)) return `This browser can't do that. Choose "Join on this browser" instead.`
  if (/https address/.test(why)) return 'Open the link exactly as it was sent to you.'
  if (/\bMac\b|pair|passkey/i.test(why)) return `Couldn't reach ${project}. Try again in a moment.`
  return why.replaceAll('Face ID', term).replace(/^your /, 'Your ').replace(/^this /, 'This ')
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The gates of a project someone shared: join with a name and the device's sign-in (Face ID, Windows Hello, the
 * screen lock, a phone or security key), unlock, or why it cannot open. With nothing built in, a guest may keep a key
 * in this browser instead, and is told it then only watches.
 */
function guestOne(g: GateView, guest: Guest): string {
  const { project, owner } = guest
  const signIn = g.signIn ?? { term: 'Face ID', canPasskey: true, hasPlatform: true }
  const term = g.isBrowserKey ? 'this browser' : signIn.term
  const why = g.why && g.stage.at === 'idle' ? `<p class="why" role="status">${esc(guestWhy(g.why, guest, term))}</p>` : ''
  const isBusy = g.stage.at !== 'idle'
  const btn = (kind: 'pair' | 'pair-browser' | 'unlock', text: string, look = 'yes') => {
    const isMine = g.stage.at !== 'idle' && g.stage.kind === (kind === 'pair-browser' ? 'pair' : kind)
    const label = isMine && g.stage.at !== 'idle' ? `${spinner}${g.stage.at === 'faceid' ? `Waiting for ${esc(term)}…` : `Opening ${esc(project)}…`}` : text
    return `<button class="btn ${look}" data-gate="${kind}" data-room="${esc(g.room)}" ${isBusy || g.isCeremony || !g.isOnline ? 'disabled' : ''} ${isMine ? 'aria-busy="true"' : ''}>${label}</button>`
  }
  // Not open now: the project is there while its owner works in it, and the hello waits for it.
  const slow = g.isSlow
    ? `<p class="slow" role="status">${esc(project)} isn't online right now. It opens while ${esc(owner)} is working on it.</p><button class="btn ghost" data-gate="retry" data-room="${esc(g.room)}">Try again</button>`
    : ''
  const offline = g.isOnline ? '' : '<p class="meta">Connecting…</p>'
  if (g.gate === 'pair') {
    // The way in this browser has, then the browser key where nothing is built in (said plainly what it costs).
    const browserNote = '<p class="browser-note">On this browser you can watch, not act. Anyone who uses this browser can open it.</p>'
    const ways = !signIn.canPasskey
      ? `${btn('pair-browser', 'Join on this browser')}${browserNote}`
      : `${btn('pair', `Join with ${esc(signIn.term)}`)}${signIn.hasPlatform ? '' : `${btn('pair-browser', 'Join on this browser instead', 'ghost')}${browserNote}`}`
    const how = signIn.canPasskey ? `then use ${esc(signIn.term)} to keep it yours` : 'and this browser will keep it yours'
    return `<div class="gate guest"><h2>Join ${esc(project)}</h2>
      <p>${esc(owner)} shared <b>${esc(project)}</b> with you. Add your name so they know it's you, ${how}.</p>
      <input class="guest-name" data-guest-name maxlength="40" autocomplete="name" placeholder="Your name" aria-label="Your name" value="${esc(g.name ?? '')}">
      ${why}${ways}${slow}${offline}</div>`
  }
  if (g.gate === 'locked') {
    const how = g.isBrowserKey ? 'Open it to see it.' : `Unlock with ${esc(term)} to see it.`
    return `<div class="gate guest"><h2>${esc(project)}</h2><p>Shared with you by ${esc(owner)}. ${how}</p>${why}${btn('unlock', g.isBrowserKey ? 'Open' : 'Unlock')}${slow}${offline}</div>`
  }
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
