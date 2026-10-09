// The screens before a room's sessions: Pair this device (make a passkey), Locked (Unlock with it), Not paired.
// One per room that needs something, so a device paired with several accounts unlocks each with its own Face ID.
import type { Gate } from '../links'
import { esc } from './util'

export type GateView = { room: string; gate: Gate; label: string; why: string; isBusy: boolean; isOnline: boolean; canRepair: boolean }

const NOT_PAIRED = 'Run <b>/streams phone</b> in Claude Code on your Mac and scan the code it shows.'

function one(g: GateView, isMany: boolean): string {
  const who = isMany ? `<div class="meta">${esc(g.label)}</div>` : ''
  const why = g.why ? `<p class="why">${esc(g.why)}</p>` : ''
  const btn = (kind: string, text: string) =>
    `<button class="btn yes" data-gate="${kind}" data-room="${esc(g.room)}" ${g.isBusy || !g.isOnline ? 'disabled' : ''}>${text}</button>`
  const offline = g.isOnline ? '' : '<p class="meta">Connecting…</p>'
  if (g.gate === 'pair')
    return `<div class="gate">${who}<h2>Pair this device</h2>
      <p>Create a passkey for Claudeflow. You'll use Face ID or your passcode to open it and to allow Claude's actions.</p>${why}${btn('pair', 'Create passkey')}${offline}</div>`
  if (g.gate === 'locked')
    return `<div class="gate">${who}<h2>Locked</h2><p>Unlock with your passkey to see your sessions.</p>${why}${btn('unlock', 'Unlock')}
      ${g.canRepair ? ` ${btn('pair', 'Pair again')}` : ''}${offline}</div>`
  return `<div class="gate">${who}<h2>Not paired</h2>${why}<p>${NOT_PAIRED}</p></div>`
}

export function gates(views: GateView[]): string {
  const shown = views.filter(g => g.gate !== 'open')
  return shown.map(g => one(g, views.length > 1)).join('')
}

/** No rooms at all: the app was opened without a pairing link. */
export const unpaired = (): string => `<div class="gate"><h2>Not paired</h2><p>${NOT_PAIRED}</p></div>`
