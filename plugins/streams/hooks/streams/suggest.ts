import type { Stream } from '../../types'

// Suggested merges, pure: now and then the heartbeat (session.ts) asks a cheap model whether some of the active
// streams are one goal, and the pane and the phone offer the group it names to merge. What it says is checked here:
// only streams that exist, never the kept one among those folded, never one with a loop running.

/** How often a session asks, and how many active streams make it worth asking. */
export const SUGGEST_MS = 30 * 60_000
export const SUGGEST_MIN = 5

/** One proposed merge: `from` folded into `into`. */
export type Suggestion = { into: string; from: string[] }

export const SUGGEST_SYSTEM = `You tidy a developer's list of workstreams with a coding agent.
Some streams may be parts of one larger goal (the same project, release or feature) and belong together.
Reply with JSON only, one of:
{"into":"<id of the stream to keep>","from":["<id>", ...]}
{"none":true}
Name at most one group: the streams most clearly one goal, kept under the stream that best names that goal.
Reply {"none":true} unless they plainly belong together: different projects or unrelated tasks stay apart.`

export const suggestPrompt = (streams: readonly Stream[]): string =>
  `Workstreams:\n${streams.map(s => `- id: ${s.id}\n  name: ${s.name}\n  goal: ${s.summary}`).join('\n')}`

/** The model's group, if it names one worth offering; `looping`: streams with a loop armed, never folded. */
export function parseSuggestion(reply: string, streams: readonly Stream[], looping: readonly string[]): Suggestion | undefined {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0]
  let v: { into?: unknown; from?: unknown } = {}
  try {
    v = json ? JSON.parse(json) : {}
  } catch {
    return undefined
  }
  const ids = new Set(streams.map(s => s.id))
  if (typeof v.into !== 'string' || !ids.has(v.into) || !Array.isArray(v.from)) return undefined
  const from = [...new Set(v.from.filter((x): x is string => typeof x === 'string' && ids.has(x)))]
  if (!from.length || from.includes(v.into) || from.some(x => looping.includes(x))) return undefined
  return { into: v.into, from }
}

/** The same group in any order, for remembering one the person dismissed. */
export const suggestionKey = (s: Suggestion): string => `${s.into}<${[...s.from].sort().join(',')}`
