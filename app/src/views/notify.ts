// The "Notify me" row under a session: a switch while this browser can take pushes, or what to do when it cannot.
import type { NotifyState } from '../push'
import { esc } from './util'

export type NotifyView = { state: NotifyState; why: string; isBusy: boolean }

export function notifyRow(v: NotifyView | undefined): string {
  if (!v || v.state === 'unsupported') return ''
  if (v.state === 'home-screen')
    return '<p class="notify-note">To get notifications on this iPhone or iPad, add claudeflow to your Home Screen: Share, then Add to Home Screen.</p>'
  if (v.state === 'blocked') return '<p class="notify-note">Notifications are blocked for claudeflow. Allow them in Settings to be told when Claude needs you.</p>'
  const isOn = v.state === 'on'
  const note = v.why || (isOn ? 'On: you hear when Claude needs you or something finishes.' : 'When Claude needs you or something finishes.')
  return `<div class="notify">
    <button class="switch" role="switch" aria-checked="${isOn}" data-notify ${v.isBusy ? 'disabled' : ''}><span class="knob" aria-hidden="true"></span>Notify me</button>
    <span class="notify-why">${esc(note)}</span></div>`
}
