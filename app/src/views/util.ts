// Small helpers every view shares: escaping (snapshot text is shown, never run), clocks, and the state colours.
import type { Snapshot } from '../state'

export type Stream = Snapshot['streams'][number]

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A colour from a snapshot, kept to a plain hex value since it lands in a style attribute. */
export const color = (c: unknown, fallback = '#8b949e'): string => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback)

export const GLYPH: Record<string, string> = { running: '●', loop: '↻', waiting: '?', error: '✗', stalled: '◌', done: '✓', idle: '○' }
export const STATE_COLOR: Record<string, string> = {
  running: '#ffd33d', loop: '#ffd33d', stalled: '#ff9500', done: '#2ea043', error: '#ff7b72', idle: '#8b949e', waiting: '#79c0ff',
}
/** Kinds used in class names, so an unknown one cannot inject a class. */
export const kindOf = (k: unknown): string => (typeof k === 'string' && k in GLYPH ? k : 'idle')

export const clock = (ms: number): string => {
  const m = Math.floor(ms / 60000)
  const s = Math.floor(ms / 1000) % 60
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${s}s` : `${s}s`
}

export const short = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}

/** The detail with its clock, counted here so it moves between snapshots (sessions send it without one). */
export function detailOf(s: Stream, now: number): string {
  if (s.nextAt) return `next tick in ${short(s.nextAt - now)}${s.detail ? ` · ${s.detail}` : ''}`
  if (s.kind === 'running') return s.detail
  return `${s.detail || '—'} · ${short(now - s.lastAt)} ago`
}

export const limitColor = (p: number): string => (p >= 80 ? '#ff7b72' : p >= 50 ? '#ffd33d' : '#7ee787')
