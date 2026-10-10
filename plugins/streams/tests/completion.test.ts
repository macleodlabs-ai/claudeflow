import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Stream, StreamRow, Verdict } from '../types'
import { storeKey } from '../hooks/state'
import { CHECK_RETRY_MS, CHECK_STALE_MS, parseCheck, suspectsOf } from '../hooks/streams/completion'
import { CHECK_TICK_MS } from '../hooks/streams/check'
import { cardOf, streamsNow, type Facts } from '../hooks/streams/model'
import { snapshotOf } from '../hooks/remote/snapshot'

// Streams often show WAITING (the last reply ended on "Anything else?") or stalled when the work is in fact finished,
// and a status card full of false alarms teaches the person to ignore it. Haiku reads the stuck ones and says which
// are done. It must cost nothing when nothing is stuck, ask once per new thing that happens in a stream (not once per
// look), and a failed call must never make a stream look finished.

const ENGINE = { timeoutMs: 20_000 }
const T0 = Date.UTC(2026, 9, 10, 12)
const MIN = 60_000

const stream = (id: string, lastAt: number): Stream => ({ id, name: id, summary: `${id} work`, createdAt: 0, lastAt, rows: 1, agents: 0, loops: 0 }) as Stream
const reply = (id: string, streamId: string, text: string, at: number): StreamRow => ({ id, streamId, kind: 'reply', text, at }) as StreamRow
const ASKED = reply('r1', 'docs', 'README updated and committed. Anything else?', T0 - 10 * MIN)

const facts = (rows: StreamRow[], verdicts: Record<string, Verdict>, now = T0): Facts => ({
  busy: false, current: '', agents: {}, inflight: {}, outcome: {}, rows, loops: {}, workflows: {}, verdicts, now,
})

describe('which streams are asked about', () => {
  const streams = [stream('docs', T0 - 10 * MIN), stream('auth', T0 - 10 * MIN)]
  const rows = [ASKED, reply('r2', 'auth', 'Moved sessions to JWT.', T0 - 10 * MIN)]
  const raw = streamsNow(facts(rows, {}), streams)
  const waiting = new Set(raw.lines.filter(l => l.kind === 'waiting').map(l => l.id))
  const ask = (o: { verdicts?: Record<string, Verdict>; rows?: StreamRow[]; now?: number; isStaleOnly?: boolean }) =>
    suspectsOf({ streams, rows: o.rows ?? rows, waiting, health: raw.health, verdicts: o.verdicts ?? {}, now: o.now ?? T0, isStaleOnly: o.isStaleOnly ?? false }).map(s => s.id)

  test('only streams shown WAITING or stalled, never one that is plainly done or idle', () => {
    expect(ask({})).toEqual(['docs'])
  })

  test('a verdict holds until a new row lands in that stream, then it is asked again', () => {
    const v: Verdict = { rowId: 'r1', state: 'waiting', reason: 'asks for a decision', at: T0 }
    expect(ask({ verdicts: { docs: v } })).toEqual([])
    // Something new there: the old verdict read rows that are no longer the latest.
    expect(ask({ verdicts: { docs: v }, rows: [...rows, reply('r3', 'docs', 'Also fixed the badge. Want the changelog too?', T0)] })).toEqual(['docs'])
  })

  test('the periodic look takes only streams stuck for 5 minutes; a moment takes them all', () => {
    const fresh = [reply('r9', 'docs', 'Shall I push it?', T0 - 2 * MIN)]
    expect(ask({ rows: fresh, isStaleOnly: true })).toEqual([])
    expect(ask({ rows: fresh, isStaleOnly: true, now: T0 - 2 * MIN + CHECK_STALE_MS })).toEqual(['docs'])
    expect(ask({ rows: fresh, isStaleOnly: false })).toEqual(['docs'])
  })

  test("the model's reply is read only for the streams asked about, keyed to the row it read", () => {
    const suspects = [{ id: 'docs', name: 'docs', rowId: 'r1', rows: [ASKED] }]
    expect(parseCheck('Here: [{"id":"docs","state":"done","reason":"README done"},{"id":"auth","state":"done","reason":"x"}]', suspects, T0)).toEqual({
      docs: { rowId: 'r1', state: 'done', reason: 'README done', at: T0 },
    })
    expect(parseCheck('[{"id":"docs","state":"finished"}]', suspects, T0)).toEqual({})
    expect(parseCheck('no idea', suspects, T0)).toEqual({})
  })
})

describe('a done verdict on every screen', () => {
  test('clears WAITING on the terminal card and the phone, and stalled in the pane, with "checked ✓" and the reason', () => {
    const streams = [stream('docs', T0 - 10 * MIN), stream('build', T0 - 10 * MIN)]
    const rows = [ASKED, reply('b1', 'build', 'Running the release build now.', T0 - 10 * MIN)]
    // build's turn is on and has gone quiet: stalled.
    const f = (verdicts: Record<string, Verdict>) => ({ ...facts(rows, verdicts), busy: true, current: 'build' })
    const seen = (verdicts: Record<string, Verdict>) => {
      const now = streamsNow(f(verdicts), streams)
      const card = cardOf(now, { git: [] })
      const phone = snapshotOf({ session: { id: 's', account: 'a', project: 'p', busy: true }, lines: card.lines, streams, colorOf: () => '#a5d8ff', agents: [], rows: [], status: [], limits: [], updates: [], now: T0 })
      const line = (id: string) => card.lines.find(l => l.id === id)
      return { pane: now.health.build, docs: [line('docs')?.kind, line('docs')?.detail], phone: phone.streams.find(x => x.id === 'docs')?.question }
    }
    expect(seen({})).toEqual({ pane: 'stalled', docs: ['waiting', 'Anything else?'], phone: 'Anything else?' })
    const done = { docs: { rowId: 'r1', state: 'done', reason: 'README committed', at: T0 }, build: { rowId: 'b1', state: 'done', reason: 'build finished', at: T0 } } as const
    expect(seen(done)).toEqual({ pane: 'done', docs: ['done', 'checked ✓ README committed'], phone: undefined })
    // A verdict for an older row says nothing about what is there now.
    expect(seen({ docs: { ...done.docs, rowId: 'r0' } }).docs[0]).toBe('waiting')
  })
})

/** A session restored with `rows`, its model calls answered by `answer` and counted. */
function session(on: On, streams: Stream[], rows: StreamRow[], answer: (prompt: string) => { isAnswered: boolean; text?: string }) {
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
  const prompts: string[] = []
  on('model.complete', async (_$, e) => {
    prompts.push(String(e.prompt))
    const a = answer(String(e.prompt))
    return { value: a.isAnswered ? { isAnswered: true, text: a.text ?? '', usage: { inputTokens: 0, outputTokens: 0 } } : { isAnswered: false, reason: 'api error 529' } } as never
  })
  return { clock, prompts }
}

/** The status card's stream rows as drawn above the prompt. */
async function card($: Engine): Promise<string[]> {
  await $.prompt.submit({ text: 'status', wait: false, origin: { kind: 'composer' } })
  const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120, hasSurvey: false } as never })
  const texts = (await bar.findAll({ type: 'Text' })).map(t => t.text)
  await bar.unmount()
  return texts.filter(t => /WAITING|DONE|checked|Anything else/.test(t))
}

describe('the check in a session', () => {
  test('a stream left waiting is checked once, shows DONE "checked ✓", and is not asked again while nothing new happens', ENGINE, async ($, on) => {
    const { clock, prompts } = session(on, [stream('docs', T0 - 10 * MIN), stream('auth', T0 - 10 * MIN)], [ASKED, reply('r2', 'auth', 'Moved sessions to JWT.', T0 - 10 * MIN)], () => ({
      isAnswered: true,
      text: '[{"id":"docs","state":"done","reason":"README committed"}]',
    }))
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(CHECK_TICK_MS)
    // One call, for the stuck stream only: auth is plainly done and costs nothing.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Stream id: docs')
    expect(prompts[0]).not.toContain('auth')
    expect((await card($)).join('\n')).toContain('checked ✓ README committed')
    expect((await card($)).join('\n')).not.toContain('WAITING')
    // Opening the card again and time passing ask nothing more: the verdict holds for that row.
    await clock.advance(20 * MIN)
    expect(prompts).toHaveLength(1)
  })

  test('nothing waiting or stalled: no model call at all, at start, on the card, or with time', ENGINE, async ($, on) => {
    const { clock, prompts } = session(on, [stream('auth', T0 - 10 * MIN)], [reply('r2', 'auth', 'Moved sessions to JWT.', T0 - 10 * MIN)], () => ({ isAnswered: true, text: '[]' }))
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(CHECK_TICK_MS)
    await card($)
    await clock.advance(CHECK_STALE_MS + CHECK_TICK_MS)
    expect(prompts).toEqual([])
  })

  test('a model error leaves the stream WAITING, and is tried again only after a pause', ENGINE, async ($, on) => {
    const { clock, prompts } = session(on, [stream('docs', T0 - 10 * MIN)], [ASKED], () => ({ isAnswered: false }))
    await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: false } as never)
    await clock.advance(CHECK_TICK_MS)
    expect(prompts).toHaveLength(1)
    const shown = (await card($)).join('\n')
    expect(shown).toContain('WAITING')
    expect(shown).not.toContain('checked')
    // Not every tick: a down API is not hammered.
    await clock.advance(CHECK_RETRY_MS - 2 * CHECK_TICK_MS)
    expect(prompts).toHaveLength(1)
    await clock.advance(3 * CHECK_TICK_MS)
    expect(prompts).toHaveLength(2)
  })
})
