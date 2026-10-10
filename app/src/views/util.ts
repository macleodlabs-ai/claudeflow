// Small helpers every view shares: escaping (snapshot text is shown, never run), clocks, and the state colours.
import type { Snapshot } from '../state'
export { lineText, resetsIn } from '../../../plugins/streams/hooks/status'

export type Stream = Snapshot['streams'][number]

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** The plugin's stream pastels (classify.ts PASTELS) as the brand's strand colours (BRAND.md). */
const BRAND_STREAM: Record<string, string> = {
  '#a5d8ff': '#7cc8ff', '#b2f2bb': '#6ff0c0', '#ffd8a8': '#ffb88a', '#d0bfff': '#b9a2ff', '#fcc2d7': '#ff94d1',
  '#ffec99': '#d9c6ff', '#99e9f2': '#5fe4f2', '#ffc9c9': '#e08cff', '#c0eb75': '#b6e6a0', '#bac8ff': '#c9d6ff',
}
const STRANDS = [...new Set(Object.values(BRAND_STREAM))]

const rgb = (hex: string): number[] => {
  const h = hex.slice(1)
  const six = h.length <= 4 ? [...h.slice(0, 3)].map(c => c + c).join('') : h.slice(0, 6)
  return [0, 2, 4].map(i => parseInt(six.slice(i, i + 2), 16))
}

/** Any other colour becomes the nearest strand, so a stream never wears a status colour (a yellow stream beside a RUNNING pill). */
const nearestStrand = (hex: string): string => {
  const [r, g, b] = rgb(hex)
  const d = (s: string) => rgb(s).reduce((sum, v, i) => sum + (v - [r, g, b][i]!) ** 2, 0)
  return STRANDS.reduce((best, s) => (d(s) < d(best) ? s : best))
}

/** A colour from a snapshot, kept to a plain hex value since it lands in a style attribute, and always a brand strand. */
export const color = (c: unknown, fallback = '#8a90c8'): string =>
  typeof c === 'string' && /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(c) ? (BRAND_STREAM[c.toLowerCase()] ?? nearestStrand(c)) : fallback

export const GLYPH: Record<string, string> = { running: '●', loop: '↻', waiting: '?', error: '✗', stalled: '◔', done: '✓', idle: '○' }
/** The status tokens in styles.css, so the views and the stylesheet cannot drift apart. */
export const STATE_COLOR: Record<string, string> = {
  running: 'var(--running)', loop: 'var(--loop)', stalled: 'var(--stalled)', done: 'var(--done)', error: 'var(--error)', idle: 'var(--text-faint)', waiting: 'var(--waiting)',
}
/** Kinds used in class names, so an unknown one cannot inject a class. */
export const kindOf = (k: unknown): string => (typeof k === 'string' && k in GLYPH ? k : 'idle')

export const clock = (ms: number): string => {
  const m = Math.floor(ms / 60000)
  const s = Math.floor(ms / 1000) % 60
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${s}s` : `${s}s`
}

export const limitColor = (p: number): string => (p >= 80 ? 'var(--error)' : p >= 50 ? 'var(--running)' : 'var(--done)')
