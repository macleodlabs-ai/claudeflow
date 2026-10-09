import type { RowCode, StreamRow } from '../types'
import { oneLine } from './classify'

/** Longest source a row keeps for the full chat style; the pane is a glance, not the file. */
export const CODE_LIMIT = 4000

/** `text` cut to whole lines within `limit` characters, with a marker when anything was left out. */
const clip = (text: string, limit: number): string => {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const kept = cut.slice(0, Math.max(0, cut.lastIndexOf('\n')))
  return `${kept}\n… ${text.split('\n').length - kept.split('\n').length} more lines`
}

/** One unified-diff hunk replacing `before` with `after`, as the session draws an Edit. */
const hunk = (before: string, after: string): string => {
  const old = before.split('\n')
  const now = after.split('\n')
  return [`@@ -1,${old.length} +1,${now.length} @@`, ...old.map(l => `-${l}`), ...now.map(l => `+${l}`)].join('\n')
}

/** Strips control characters a Code element refuses; tab and newline stay. */
const printable = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

/**
 * What the full chat style draws under a tool call: the command for Bash, a diff for Edit and MultiEdit,
 * the file for Write; none for tools whose one line says it all (Read, Grep, Glob, ...).
 */
export const codeOf = (tool: string, input: unknown): RowCode | undefined => {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  const path = str('file_path')
  if (tool === 'Bash' && str('command')) return { source: clip(printable(str('command')!), CODE_LIMIT), language: 'bash' }
  if (tool === 'Write' && str('content') !== undefined) return { source: clip(printable(str('content')!), CODE_LIMIT), ...(path ? { path } : {}) }
  const edits: { old_string?: unknown; new_string?: unknown }[] =
    tool === 'Edit' ? [i] : tool === 'MultiEdit' && Array.isArray(i.edits) ? (i.edits as { old_string?: unknown }[]) : []
  const hunks = edits
    .filter(e => typeof e.old_string === 'string' && typeof e.new_string === 'string')
    .map(e => hunk(printable(e.old_string as string), printable(e.new_string as string)))
  if (hunks.length === 0) return undefined
  const diff = hunks.join('\n')
  // A diff cut mid-hunk no longer parses, so an oversized one is drawn as its first hunks only.
  if (diff.length <= CODE_LIMIT) return { source: diff, format: 'diff', ...(path ? { path } : {}) }
  const fit: string[] = []
  for (const h of hunks) if ([...fit, h].join('\n').length <= CODE_LIMIT) fit.push(h)
  return fit.length ? { source: fit.join('\n'), format: 'diff', ...(path ? { path } : {}) } : { source: clip(hunks[0]!, CODE_LIMIT), ...(path ? { path } : {}) }
}

/** A tool call as the session titles it: `Edit(src/a.ts)`, `Bash(npm test)`; the raw input when no field names it. */
export const toolLine = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  const arg = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'path', 'skill', 'prompt']
    .map(k => i[k])
    .find((v): v is string => typeof v === 'string' && v.trim() !== '')
  return arg !== undefined ? `${tool}(${oneLine(arg, 100)})` : `${tool} ${oneLine(JSON.stringify(input ?? {}), 100)}`
}

/** A tool row's code for the full chat style, as a spread: nothing when the tool has none. */
export const withCode = (tool: string, input: unknown): { code?: StreamRow['code'] } => {
  const code = codeOf(tool, input)
  return code ? { code } : {}
}
