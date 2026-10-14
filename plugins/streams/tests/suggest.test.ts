import { describe, expect, test } from 'claude-code/testing'

import type { Stream } from '../types'
import { parseSuggestion, suggestPrompt, suggestionKey } from '../hooks/streams/suggest'

// A long session ends up with small streams that are one goal. Now and then a cheap model looks at their names and
// goals and may propose one group to merge. What it says is checked hard: only streams that exist, at least one to
// fold, never the kept one among them, never one with a loop running; anything else is no suggestion at all.

const s = (id: string, summary = `${id} work`) => ({ id, name: id, summary, createdAt: 0, lastAt: 0, rows: 1, agents: 0, loops: 0 }) as Stream
const STREAMS = [s('launch', 'launch Streams Remote'), s('badges', 'fix README badges'), s('relay-fix', 'fix the relay deploy'), s('lunch', 'order lunch')]

describe('suggested merges', () => {
  test('the prompt lists every stream by id, name and goal', () => {
    const p = suggestPrompt(STREAMS)
    for (const x of STREAMS) expect(p).toContain(`id: ${x.id}`)
    expect(p).toContain('goal: launch Streams Remote')
  })

  test('a group of existing streams into another existing one is a suggestion', () => {
    expect(parseSuggestion('{"into":"launch","from":["badges","relay-fix"]}', STREAMS, [])).toEqual({ into: 'launch', from: ['badges', 'relay-fix'] })
    expect(parseSuggestion('Sure: {"into":"launch","from":["badges"]}', STREAMS, [])).toEqual({ into: 'launch', from: ['badges'] })
  })

  test('nothing to merge, unknown streams, the kept one among them, or a looping one is no suggestion', () => {
    expect(parseSuggestion('{"none":true}', STREAMS, [])).toBe(undefined)
    expect(parseSuggestion('{"into":"launch","from":[]}', STREAMS, [])).toBe(undefined)
    expect(parseSuggestion('{"into":"nope","from":["badges"]}', STREAMS, [])).toBe(undefined)
    expect(parseSuggestion('{"into":"launch","from":["badges","nope"]}', STREAMS, [])).toEqual({ into: 'launch', from: ['badges'] })
    expect(parseSuggestion('{"into":"launch","from":["launch"]}', STREAMS, [])).toBe(undefined)
    expect(parseSuggestion('{"into":"launch","from":["badges"]}', STREAMS, ['badges'])).toBe(undefined)
    expect(parseSuggestion('not json', STREAMS, [])).toBe(undefined)
  })

  test('the same group in any order is the same suggestion, so a dismissed one is not offered again', () => {
    expect(suggestionKey({ into: 'launch', from: ['relay-fix', 'badges'] })).toBe(suggestionKey({ into: 'launch', from: ['badges', 'relay-fix'] }))
  })
})
