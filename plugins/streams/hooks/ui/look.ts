import type { AgentRun, StreamRowKind } from '../../types'
import type { BadgeKind } from '../classify'
import type { StatusKind } from '../status'

// The colours, glyphs and sizes the terminal views share.

/** Status words as bold coloured text on the terminal's own background. */
export const STATUS_WORD: Record<BadgeKind, string> = {
  running: '#ffd33d',
  loop: '#ffd33d',
  stalled: '#ff9500',
  done: '#7ee787',
  error: '#ff7b72',
  idle: '#8b949e',
}

/** The status card's state words: the pane's status colours, and a blue that asks for the person. */
export const STATE_COLOR: Record<StatusKind, string> = { ...STATUS_WORD, waiting: '#79c0ff' }

/** A limit's colour by how much of it is used: green, then yellow from half, red from 80%. */
export const limitColor = (percent: number): string => (percent >= 80 ? '#ff7b72' : percent >= 50 ? '#ffd33d' : '#7ee787')

export const STATUS_GLYPH: Record<AgentRun['status'], string> = { running: '●', done: '✓', error: '✗' }

export const GLYPH: Record<StreamRowKind, string> = { prompt: '>', reply: '⏺', tool: '⎿', agent: '↳', loop: '↻', notice: '·' }

/** Rows the status card shows before pointing to the pane. */
export const STATUS_ROWS = 14
/** Tickets the status card shows, on top of its stream rows. */
export const TICKET_ROWS = 8
/** Rows the full chat style draws in a stream's view; older ones stay in compact. */
export const FULL_ROWS = 30

/** Markdown text within the element's bound, control characters but tab and newline removed. */
export const markdownOf = (text: string): string => {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return clean.length <= 9000 ? clean : `${clean.slice(0, 9000)}\n\n…`
}
