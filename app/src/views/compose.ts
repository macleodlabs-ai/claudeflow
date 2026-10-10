// The dock: a carousel pinned to the bottom. The composer comes first and is always there, for the stream being
// viewed (or a new prompt), with plan usage as small marks beside its target; plan usage in full and the runs-and-loops
// line sit beside it, a swipe away. The dock is as tall as the slide in view; focused, the composer takes it whole.
import { isInFlight, streamKey, type State } from '../state'
import type { Snapshot } from '../state'
import { esc, limitColor, type Stream } from './util'
import { WAVE_BARS } from '../voice'

/** A file waiting to go with the next prompt: its name, and a preview for an image. */
export type Attached = { name: string; preview?: string }

/** What the composer shows besides the state: files attached, whether dictation is on and offered. */
export type ComposeView = { files: Attached[]; isListening: boolean; hasMic: boolean; why: string }

/** The files waiting to go: a thumbnail (or 📄) each, with ✕. Drawn on its own too, the moment a file is added. */
export const attachedStrip = (files: readonly Attached[]): string =>
  `<div class="attached" data-attached>${files
    .map((f, i) => `<span class="file">${f.preview ? `<img src="${esc(f.preview)}" alt="">` : '📄'}<span class="fname">${esc(f.name)}</span><button type="button" class="x" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`)
    .join('')}</div>`

/** 📎, green with a count while files wait to go. */
export const clip = (n: number): string =>
  `<label class="icon-btn clip ${n ? 'has' : ''}" data-clip aria-label="${n ? `${n} attached; attach more` : 'Attach a photo or file'}"><input type="file" data-attach multiple hidden>📎${n ? `<span class="count">${n}</span>` : ''}</label>`

/** The stream a prompt from the composer goes to: the last opened card of this session that still exists, else ''. */
export function targetOf(s: State, sessionKey: string, streams: readonly Stream[]): string {
  for (let i = s.open.length - 1; i >= 0; i--) {
    const key = s.open[i]!
    const st = streams.find(x => streamKey(sessionKey, x.id) === key)
    if (st) return st.id
  }
  return ''
}

/** The composer's draft key: the session key, then the target stream id ('' for a new prompt). */
export const composeKey = (sessionKey: string, target: string): string => streamKey(sessionKey, target)

function composer(s: State, sessionKey: string, x: Snapshot, view: ComposeView): string {
  const streams = x.streams ?? []
  const target = targetOf(s, sessionKey, streams)
  const key = composeKey(sessionKey, target)
  const name = streams.find(x => x.id === target)?.name
  const busy = isInFlight(s.taps[key])
  const mic = view.hasMic
    ? `<button type="button" class="icon-btn ${view.isListening ? 'on' : ''}" data-mic aria-pressed="${view.isListening}" aria-label="${view.isListening ? 'Stop dictation' : 'Dictate: hold to talk, or tap to start and stop'}">🎤</button>`
    : ''
  return `<div class="slide compose">
    <div class="to"><span class="target">→ ${name ? `<b>${esc(name)}</b>` : 'new prompt'}<span class="why" data-why>${view.why ? ` · ${esc(view.why)}` : ''}</span></span>${limitMarks(x)}</div>${attachedStrip(view.files)}
    <div class="compose-row ${view.isListening ? 'listening' : ''}">
      ${clip(view.files.length)}
      <div class="field"><span class="wave" aria-hidden="true">${'<i></i>'.repeat(WAVE_BARS)}</span><textarea rows="1" placeholder="${name ? `Message ${esc(name)}…` : 'New prompt…'}" data-draft="${esc(key)}" data-compose>${esc(s.drafts[key] ?? '')}</textarea></div>${mic}
      <button class="btn send" data-send="${esc(key)}" ${busy ? 'disabled' : ''} aria-label="Send">${busy ? '…' : '↑'}</button>
    </div></div>`
}

/** Plan usage as small marks beside the target, one per limit: how much is used, in its colour, and when it resets. */
export function limitMarks(x: Snapshot): string {
  const limits = x.limits ?? []
  if (!limits.length) return ''
  const pct = (p: number) => Math.max(0, Math.min(100, Math.round(Number(p) || 0)))
  return `<span class="limits">${limits
    .map(l => `<span class="lim" style="color:${limitColor(l.percent)}" title="${esc(l.label)}: ${pct(l.percent)}% used, resets ${esc(l.resetsAt)}">${pct(l.percent)}%${l.resetsAt ? `<small>${esc(l.resetsAt)}</small>` : ''}</span>`)
    .join('')}</span>`
}

/** The dock's slides: the composer, then each of `others` (plan usage, the runs-and-loops line) that has something. */
export function dock(s: State, sessionKey: string, x: Snapshot, view: ComposeView, others: string[]): string {
  const slides = [composer(s, sessionKey, x, view), ...others.filter(Boolean).map(o => `<div class="slide info">${o}</div>`)]
  const dots = slides.length > 1 ? `<div class="slide-dots" aria-hidden="true">${slides.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''
  return `<div class="dock"><div class="slides" data-slides>${slides.join('')}</div>${dots}</div>`
}
