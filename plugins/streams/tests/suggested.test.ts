import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Stream, StreamRow } from '../types'
import { storeKey } from '../hooks/state'
import { SUGGEST_MS, SUGGEST_SYSTEM } from '../hooks/streams/suggest'

// In a session: with enough active streams, every SUGGEST_MS the session asks once whether some are one goal, and the
// pane offers that group with merge and dismiss. Merge folds them all (each undoable); dismiss puts the offer away and
// the same group is never offered again. With mergeSuggestions off, no model is asked at all.

const ENGINE = { timeoutMs: 20_000 }
const T0 = Date.UTC(2026, 9, 14, 12)
const stream = (id: string): Stream => ({ id, name: id, summary: `${id} work`, createdAt: 0, lastAt: T0 - 60_000, rows: 1, agents: 0, loops: 0 }) as Stream
const IDS = ['launch', 'badges', 'relay-fix', 'site', 'billing', 'docs']
const STREAMS = IDS.map(stream)
const ROWS = IDS.map((id, i) => ({ id: `r${i}`, streamId: id, kind: 'reply', text: 'Done.', at: T0 - 60_000 }) as StreamRow)
const PROPS = { title: 'Streams', isFocused: false, bodyColumns: 100, placement: 'dock' } as never

function session(on: On, asked: string[]) {
  mock.store(on, { [storeKey('/project')]: { streams: STREAMS, rows: ROWS, loopStream: {} } })
  const clock = mock.clock(on, { now: T0 })
  on('session.cwd', async () => ({ value: '/project' }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('fs.read', async () => ({ value: '{}' }) as never)
  on('model.complete', async (_$, e) => {
    if (e.system === SUGGEST_SYSTEM) asked.push(e.prompt)
    const text = e.system === SUGGEST_SYSTEM ? '{"into":"launch","from":["badges","relay-fix"]}' : '[]'
    return { value: { isAnswered: true, text, usage: { inputTokens: 0, outputTokens: 0 } } } as never
  })
  return clock
}

describe('suggested merges in a session', () => {
  test('the pane offers the group, and merge folds every stream in it', ENGINE, async ($, on) => {
    const asked: string[] = []
    const clock = session(on, asked)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(SUGGEST_MS)
    expect(asked).toHaveLength(1)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PROPS })
    expect((await pane.find({ key: 'suggest-merge' }))?.props).toMatchObject({ label: 'merge badges, relay-fix → launch' })
    await pane.press({ key: 'suggest-merge' })
    await pane.redraw(PROPS)
    expect(await pane.find({ key: 'open:badges' })).toBe(undefined)
    expect(await pane.find({ key: 'open:relay-fix' })).toBe(undefined)
    expect(await pane.find({ key: 'suggest-merge' })).toBe(undefined)
    expect(await pane.find({ key: 'undo-merge' })).toBeDefined()
    await pane.unmount()
  })

  test('dismiss puts the offer away, and the same group is not offered again', ENGINE, async ($, on) => {
    const asked: string[] = []
    const clock = session(on, asked)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(SUGGEST_MS)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PROPS })
    await pane.press({ key: 'suggest-dismiss' })
    await pane.redraw(PROPS)
    expect(await pane.find({ key: 'suggest-merge' })).toBe(undefined)
    await clock.advance(SUGGEST_MS)
    await pane.redraw(PROPS)
    expect(asked).toHaveLength(2)
    expect(await pane.find({ key: 'suggest-merge' })).toBe(undefined)
    expect(await pane.find({ key: 'open:badges' })).toBeDefined()
    await pane.unmount()
  })

  test('with mergeSuggestions off no model is asked', { ...ENGINE, options: { mergeSuggestions: false } }, async ($, on) => {
    const asked: string[] = []
    const clock = session(on, asked)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(SUGGEST_MS * 2)
    expect(asked).toEqual([])
  })
})
