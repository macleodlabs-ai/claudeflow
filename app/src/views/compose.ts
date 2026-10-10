// The dock: a carousel pinned to the bottom. The composer comes first and is always there, for the stream being
// viewed (or a new prompt); plan usage and the runs-and-loops line sit beside it, a swipe away. While the composer
// has focus it takes the whole width, with plan usage as thin lines under it.
import { isInFlight, streamKey, type State } from '../state'
import type { Snapshot } from '../state'
import { esc, limitColor, type Stream } from './util'

/** A file waiting to go with the next prompt: its name, and a preview for an image. */
export type Attached = { name: string; preview?: string }

/** What the composer shows besides the state: files attached, whether dictation is on and offered. */
export type ComposeView = { files: Attached[]; isListening: boolean; hasMic: boolean; why: string }

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

function composer(s: State, sessionKey: string, streams: readonly Stream[], view: ComposeView): string {
  const target = targetOf(s, sessionKey, streams)
  const key = composeKey(sessionKey, target)
  const name = streams.find(x => x.id === target)?.name
  const busy = isInFlight(s.taps[key])
  const files = view.files.length
    ? `<div class="attached">${view.files
        .map((f, i) => `<span class="file">${f.preview ? `<img src="${esc(f.preview)}" alt="">` : '📄'}<span class="fname">${esc(f.name)}</span><button type="button" class="x" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">✕</button></span>`)
        .join('')}</div>`
    : ''
  const mic = view.hasMic
    ? `<button type="button" class="icon-btn ${view.isListening ? 'on' : ''}" data-mic aria-pressed="${view.isListening}" aria-label="${view.isListening ? 'Stop dictation' : 'Dictate'}">🎤</button>`
    : ''
  return `<div class="slide compose">
    <div class="to">→ ${name ? `<b>${esc(name)}</b>` : 'new prompt'}${view.why ? ` · <span class="why">${esc(view.why)}</span>` : ''}</div>${files}
    <div class="compose-row">
      <label class="icon-btn" aria-label="Attach a photo or file"><input type="file" data-attach multiple hidden>📎</label>
      <textarea rows="1" placeholder="${name ? `Message ${esc(name)}…` : 'New prompt…'}" data-draft="${esc(key)}" data-compose>${esc(s.drafts[key] ?? '')}</textarea>${mic}
      <button class="btn send" data-send="${esc(key)}" ${busy ? 'disabled' : ''} aria-label="Send">${busy ? '…' : '↑'}</button>
    </div></div>`
}

/** Plan usage as thin full-width lines, one per limit: what is left while typing. */
export function limitLines(x: Snapshot): string {
  const limits = x.limits ?? []
  if (!limits.length) return ''
  const pct = (p: number) => Math.max(0, Math.min(100, Number(p) || 0))
  return `<div class="limit-lines" aria-hidden="true">${limits.map(l => `<span title="${esc(l.label)} ${pct(l.percent)}% used"><i style="width:${pct(l.percent)}%;background:${limitColor(l.percent)}"></i></span>`).join('')}</div>`
}

/** The dock's slides: the composer, then each of `others` (plan usage, the runs-and-loops line) that has something. */
export function dock(s: State, sessionKey: string, x: Snapshot, view: ComposeView, others: string[]): string {
  const slides = [composer(s, sessionKey, x.streams ?? [], view), ...others.filter(Boolean).map(o => `<div class="slide info">${o}</div>`)]
  const dots = slides.length > 1 ? `<div class="slide-dots" aria-hidden="true">${slides.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''
  return `<div class="dock"><div class="slides" data-slides>${slides.join('')}</div>${dots}${limitLines(x)}</div>`
}
