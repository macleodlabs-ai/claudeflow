import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Stream, StreamRow, Verdict } from '../types'
import { storeKey } from '../hooks/state'
import { ARCHIVE_LOOK_MS, HOUR_MS, archiveHoursOf, archivableOf } from '../hooks/streams/archive'
import { CHECK_TICK_MS } from '../hooks/streams/check'
import { streamsNow, type Facts } from '../hooks/streams/model'

// A long session piles up streams whose work ended days ago, and the bar and the list get too long to scan for what
// needs the person. Finished, long-quiet streams archive themselves. What must never vanish: anything still running,
// waiting on the person, looping on a schedule, or failed, since those are what the person is there to see. And an
// archived stream is only out of sight, never gone: "archived" lists it and restore brings it back.

const ENGINE = { timeoutMs: 20_000 }
const T0 = Date.UTC(2026, 9, 10, 12)
const OLD = T0 - 25 * HOUR_MS

const stream = (id: string, lastAt = OLD, extra: Partial<Stream> = {}): Stream => ({ id, name: id, summary: `${id} work`, createdAt: 0, lastAt, rows: 1, agents: 0, loops: 0, ...extra }) as Stream
const reply = (streamId: string, text: string, at = OLD): StreamRow => ({ id: `r-${streamId}`, streamId, kind: 'reply', text, at }) as StreamRow

describe('which streams archive themselves', () => {
  const facts = (o: Partial<Facts>): Facts => ({ busy: false, current: '', agents: {}, inflight: {}, outcome: {}, rows: [], loops: {}, workflows: {}, verdicts: {}, now: T0, ...o })
  const archivable = (streams: Stream[], o: Partial<Facts> = {}, hours = 24) => {
    const f = facts(o)
    return archivableOf({ now: streamsNow(f, streams), streams, loops: f.loops, hours, at: T0 })
  }

  test('a finished stream quiet for the setting\'s hours goes; one quiet for less stays', () => {
    expect(archivable([stream('docs'), stream('recent', T0 - 23 * HOUR_MS)], { rows: [reply('docs', 'Committed.'), reply('recent', 'Committed.', T0 - 23 * HOUR_MS)] })).toEqual(['docs'])
  })

  test('never one waiting on the person, looping, failed or running, however old', () => {
    const streams = [stream('asks'), stream('ci'), stream('broke'), stream('build')]
    const o: Partial<Facts> = {
      rows: [reply('asks', 'Shall I push it?')],
      loops: { ci: { kind: 'cron', id: 'c1', every: 'daily', nextAt: T0 + HOUR_MS, noopStreak: 9 } as never },
      outcome: { broke: 'error' },
      busy: true,
      current: 'build',
      inflight: { build: 1 },
    }
    expect(archivable(streams, o)).toEqual([])
  })

  test('a question the completion check found finished counts as done, but only for the row it read', () => {
    const rows = [reply('asks', 'All merged. Anything else?')]
    const done: Verdict = { rowId: 'r-asks', state: 'done', reason: 'merged', at: T0 }
    expect(archivable([stream('asks')], { rows, verdicts: { asks: done } })).toEqual(['asks'])
    expect(archivable([stream('asks')], { rows, verdicts: { asks: { ...done, state: 'waiting' } } })).toEqual([])
    expect(archivable([stream('asks')], { rows, verdicts: { asks: { ...done, rowId: 'older' } } })).toEqual([])
  })

  test('one the person restored stays until it has been active again; 0 hours turns it off', () => {
    const rows = [reply('docs', 'Committed.')]
    expect(archivable([stream('docs', OLD, { restoredAt: OLD + HOUR_MS })], { rows })).toEqual([])
    expect(archivable([stream('docs', OLD, { restoredAt: OLD - HOUR_MS })], { rows })).toEqual(['docs'])
    expect(archivable([stream('docs')], { rows }, 0)).toEqual([])
    expect([archiveHoursOf(undefined), archiveHoursOf(0), archiveHoursOf(-3), archiveHoursOf(6)]).toEqual([24, 0, 0, 6])
  })
})

/** A session restored with these streams and rows; the completion check's answers come from `verdicts`. */
function session(on: On, streams: Stream[], rows: StreamRow[], verdicts: string) {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, { [storeKey('/project')]: { streams, rows, loopStream: {} } })
  on('session.cwd', async () => ({ value: '/project' }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('fs.read', async () => ({ value: '{}' }) as never)
  on('model.complete', async () => ({ value: { isAnswered: true, text: verdicts, usage: { inputTokens: 0, outputTokens: 0 } } }) as never)
  return { clock }
}

const PANE_PROPS = { title: 'Streams', isFocused: false, bodyColumns: 60, placement: 'dock' } as never
const STREAMS = [stream('docs'), stream('asks'), stream('merged')]
const ROWS = [reply('docs', 'Committed.'), reply('asks', 'Which region should it deploy to?'), reply('merged', 'Merged the PR. Anything else?')]
const VERDICTS = '[{"id":"asks","state":"waiting","reason":"needs a region"},{"id":"merged","state":"done","reason":"PR merged"}]'

describe('auto-archive in a session', () => {
  test('finished streams archive themselves (by status or by the check), stay listed under "archived", and restore for good', ENGINE, async ($, on) => {
    const { clock } = session(on, STREAMS, ROWS, VERDICTS)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(CHECK_TICK_MS)
    await clock.advance(ARCHIVE_LOOK_MS)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    // The question that really needs an answer stays in sight; the finished ones left the list.
    expect(await pane.find({ key: 'open:asks' })).toBeDefined()
    expect(await pane.find({ key: 'open:docs' })).toBe(undefined)
    expect(await pane.find({ key: 'open:merged' })).toBe(undefined)
    expect((await pane.find({ key: 'archived' }))?.props).toMatchObject({ label: '▸ archived (2)' })
    // Kept, and restorable: the person's restore holds although the stream is as old and finished as before.
    await pane.press({ key: 'archived' })
    await pane.press({ key: 'restore:docs' })
    await clock.advance(2 * ARCHIVE_LOOK_MS)
    await pane.redraw(PANE_PROPS)
    expect(await pane.find({ key: 'open:docs' })).toBeDefined()
    await pane.unmount()
  })

  test('with autoArchiveHours 0 nothing archives itself', { ...ENGINE, options: { autoArchiveHours: 0 } }, async ($, on) => {
    const { clock } = session(on, STREAMS, ROWS, VERDICTS)
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(CHECK_TICK_MS)
    await clock.advance(2 * ARCHIVE_LOOK_MS)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    for (const id of ['docs', 'asks', 'merged']) expect(await pane.find({ key: `open:${id}` })).toBeDefined()
    await pane.unmount()
  })
})
