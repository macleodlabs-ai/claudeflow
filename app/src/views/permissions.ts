// Permission prompts a session holds for the devices: Allow (with Face ID) or Deny, and the seconds left before the
// Mac asks in the terminal instead.
import type { Snapshot } from '../state'
import { esc } from './util'

/** How long a session holds a prompt for the devices (remote/snapshot.ts PHONE_PERMISSION_MS). */
const HOLD_MS = 60_000

export const secondsLeft = (at: number, now: number): number => Math.max(0, Math.round((at + HOLD_MS - now) / 1000))

export function permissions(x: Snapshot, now: number): string {
  return (x.permissions ?? [])
    .map(
      p => `<div class="perm"><div class="perm-head"><b>Claude wants to run ${esc(p.tool)}</b><span class="left">${secondsLeft(p.at, now)}s left</span></div>
      <div class="what">${esc(p.summary)}</div>
      <div class="actions"><button class="btn allow" data-perm="${esc(p.id)}" data-decision="allow">Allow</button>
      <button class="btn deny" data-perm="${esc(p.id)}" data-decision="deny">Deny</button></div></div>`,
    )
    .join('')
}
