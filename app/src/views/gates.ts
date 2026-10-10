// The screens before a room's sessions: Pair this device (make a passkey), Locked (Unlock with it), Not paired.
// One per room that needs something, so a device paired with several accounts unlocks each with its own Face ID.
// While a passkey step runs its button says where it is (Face ID, then syncing with the Mac) and takes no second tap.
import type { Gate } from '../links'
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
}

const NOT_PAIRED = 'Run <b>/streams phone</b> in Claude Code on your Mac and scan the code it shows.'
const PENDING = { faceid: 'Waiting for Face ID…', checking: 'Syncing…' } as const

function one(g: GateView, isMany: boolean): string {
  const who = isMany ? `<div class="meta">${esc(g.label)}</div>` : ''
  const why = g.why && g.stage.at === 'idle' ? `<p class="why" role="status">${esc(g.why)}</p>` : ''
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
      ${g.canRepair ? ` ${btn('pair', 'Pair again')}` : ''}${slow}${offline}${forget}</div>`
  return `<div class="gate">${who}<h2>Not paired</h2>${why}<p>${NOT_PAIRED}</p>${forget}</div>`
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
