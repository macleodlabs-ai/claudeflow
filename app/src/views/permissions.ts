// What a session holds for an answer: permission prompts (Allow with Face ID, or Deny) and Claude's questions with
// options (the recommended one first and primary). No deadline: each card says how long it has waited, where a tap is
// on a slow network, and how it ended (answered here, on the Mac, moved to the Mac, or chosen for you). Every card has
// an ✕ that hides it here without answering it.
import { permKey, type AskCard, type CardPhase } from '../state'
import { esc, SLOW_TEXT, spinner, stageLine } from './util'

/** How long a card has waited, in whole minutes: it changes rarely, so nothing on it ticks. */
export const waitingText = (since: number, now: number): string => {
  const m = Math.floor(Math.max(0, now - since) / 60_000)
  return m < 1 ? 'just now' : m < 60 ? `waiting ${m}m` : `waiting ${Math.floor(m / 60)}h ${m % 60}m`
}

/** The line under a card's buttons while a tap is on its way. */
const STAGE: Partial<Record<CardPhase, string>> = {
  faceid: 'Waiting for Face ID…',
  queued: 'Offline: sends when you reconnect…',
  sent: 'Sent: waiting for your Mac…',
  slow: SLOW_TEXT,
}

/** How a card ended, in words. */
const ended = (c: AskCard): string | undefined => {
  const label = c.label?.replace(/\s*\(recommended\)\s*$/i, '') ?? ''
  if (c.phase === 'allowed') return 'Allowed ✓'
  if (c.phase === 'denied') return 'Denied'
  if (c.phase === 'chosen') return `Chose ${label} ✓`
  if (c.phase === 'mac') return 'Answered on your Mac'
  if (c.phase === 'moved') return 'Moved to your Mac'
  if (c.phase === 'auto') return `Chose the recommended answer: ${label} (no answer for 2m)`
  if (c.phase === 'gone') return 'Answered elsewhere'
  return undefined
}

function one(c: AskCard, now: number): string {
  const id = esc(c.id)
  const q = c.seen.question
  const title = q ? `Claude asks${q.header ? ` · ${esc(q.header)}` : ''}` : `Claude wants to run ${esc(c.seen.perm?.tool)}`
  const done = ended(c)
  const left = done ? '' : `<span class="left">${waitingText(c.seen.since, now)}</span>`
  const hide = `<button class="x" data-hide="${id}" aria-label="Hide this here (it stays open on your Mac)">✕</button>`
  const what = q ? `<div class="ask">${esc(q.question)}</div>` : `<div class="what">${esc(c.seen.perm?.summary)}</div>`
  const head = `<div class="perm-head"><b>${title}</b>${left}${hide}</div>${what}`
  if (done) return `<div class="perm settled ${c.phase}">${head}<p class="stage done" role="status">${esc(done)}</p></div>`
  // From the first tap until it settles every button stays disabled: a double tap never sends twice.
  const isBusy = c.phase !== 'open'
  const tapped = c.tap?.command
  const buttons = q
    ? [...q.options]
        .sort((a, b) => Number(b.isRecommended) - Number(a.isRecommended))
        .map(o => {
          const isMine = isBusy && tapped?.kind === 'choose' && tapped.label === o.label
          const name = o.label.replace(/\s*\(recommended\)\s*$/i, '')
          return `<button class="btn ${o.isRecommended ? 'primary' : 'ghost'}" data-choose="${id}" data-label="${esc(o.label)}" ${isBusy ? 'disabled' : ''}>${isMine ? spinner : ''}${esc(name)}${o.isRecommended ? '<span class="rec">Recommended</span>' : ''}</button>`
        })
        .join('')
    : (['allow', 'deny'] as const)
        .map(d => {
          const isMine = isBusy && tapped?.kind === 'permission' && tapped.decision === d
          return `<button class="btn ${d}" data-perm="${id}" data-decision="${d}" ${isBusy || (d === 'allow' && !c.canAllow) ? 'disabled' : ''}>${isMine ? spinner : ''}${d === 'allow' ? 'Allow' : 'Deny'}</button>`
        })
        .join('')
  const stage = STAGE[c.phase]
  const retry = c.phase === 'slow' ? `<button class="btn ghost" data-retry="${esc(permKey(c.id))}">Retry</button>` : ''
  const why = c.phase === 'open' && c.tap?.why ? `<p class="stage why" role="status">${esc(c.tap.why)}</p>` : ''
  return `<div class="perm${q ? ' choice' : ''}">${head}<div class="actions${q ? ' options' : ''}">${buttons}</div>
    ${stage ? stageLine(stage, c.phase !== 'slow') : ''}${retry}${why}</div>`
}

export const permissions = (cards: AskCard[], now: number): string => cards.map(c => one(c, now)).join('')
