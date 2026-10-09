import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Stream } from '../types'
import { isNewer, manifestPathOf, pluginsDirOf, updatesOf } from '../hooks/updates'
import { limitView, untilOf, ticketLines, ticketsIn, gitStatus, questionOf, sortStatus, statusOf, buildPrompt, FINISHED_MS, toolLine, codeOf, CODE_LIMIT, completeTag, partialTag, tagMatches, BATCH_SYSTEM, MERGE_SYSTEM, NEXT_FOLD, PASTELS, STALL_MS, inParallel, oneLine, parseBatch, parseMerge, rowKey, healthOf, nextPastel, pickReplyStream, readTranscript, isFollowUp, loopKey, parseTag, parseVerdict, slug } from '../hooks/classify'

/** Tests that drive the engine: room to finish on a busy machine, where the default 5 s is not. */
const ENGINE = { timeoutMs: 20_000 }

const STREAMS: Stream[] = [
  { id: 'auth-refactor', name: 'Auth refactor', summary: 'Move sessions to JWT', createdAt: 0, lastAt: 0, rows: 0, agents: 0, loops: 0 },
]

describe('routing by hand', () => {
  test('a #tag picks the stream and is stripped, so the model never reads it', () => {
    expect(parseTag('#billing why is the invoice total off?')).toEqual({ name: 'billing', rest: 'why is the invoice total off?' })
  })
  test('a hashtag mid-prompt is ordinary text, not a routing order', () => {
    expect(parseTag('fix the #1 bug')).toBe(undefined)
  })
  test('a stream id is its name as a slug, so collapsed rows can show it with no lookup', () => {
    expect(slug('Auth Refactor (v2)')).toBe('auth-refactor-v2')
  })
})

describe('what spends a model call', () => {
  test('bare follow-ups stay on the current stream instead of being reclassified', () => {
    for (const t of ['yes', 'continue', 'do it', 'ok!', '/compact']) expect(isFollowUp(t)).toBe(true)
  })
  test('a real request is classified', () => {
    expect(isFollowUp('now look at why the billing webhook retries')).toBe(false)
  })
  test('every tick of a loop keys the same, so a loop is one stream not one per tick', () => {
    expect(loopKey('  Check   CI status ')).toBe(loopKey('check ci status'))
  })
})

describe("reading the model's verdict", () => {
  test('an existing stream is kept, with its refreshed summary', () => {
    expect(parseVerdict('{"stream":"auth-refactor","summary":"JWT + refresh"}', STREAMS)).toEqual({
      kind: 'existing',
      id: 'auth-refactor',
      summary: 'JWT + refresh',
    })
  })
  test('a stream the model invented an id for is not trusted', () => {
    expect(parseVerdict('{"stream":"made-up"}', STREAMS)).toBe(undefined)
  })
  test('a new stream is read from prose-wrapped JSON', () => {
    expect(parseVerdict('Sure: {"new":"Billing bug","summary":"Invoice totals off"}', STREAMS)).toEqual({
      kind: 'new',
      name: 'Billing bug',
      summary: 'Invoice totals off',
    })
  })
  test('garbage is undefined, so the caller falls back rather than misfiling', () => {
    expect(parseVerdict('no idea', STREAMS)).toBe(undefined)
  })
})

describe('the heartbeat', () => {
  const quiet = (ms: number) => ({ now: ms, lastAt: 0, isTurnOn: true, liveAgents: 0, inflight: 0 })
  test('a working stream that has gone silent past the limit is stalled, not running', () => {
    expect(healthOf(quiet(STALL_MS - 1))).toBe('running')
    expect(healthOf(quiet(STALL_MS + 1))).toBe('stalled')
  })
  test('a long tool call (a build) is not mistaken for a stall', () => {
    expect(healthOf({ ...quiet(STALL_MS * 2), inflight: 1 })).toBe('running')
  })
  test('a background subagent keeps its stream running after the main turn ends', () => {
    expect(healthOf({ ...quiet(1000), isTurnOn: false, liveAgents: 1 })).toBe('running')
  })
  test('a finished stream reads done, then idle once it is old news', () => {
    const ended = { lastAt: 0, isTurnOn: false, liveAgents: 0, inflight: 0, outcome: 'answer' as const }
    expect(healthOf({ ...ended, now: 60_000 })).toBe('done')
    expect(healthOf({ ...ended, now: 3_600_000 })).toBe('idle')
  })
  test('a turn that died on an error stays red until the stream works again', () => {
    expect(healthOf({ now: 3_600_000, lastAt: 0, isTurnOn: false, liveAgents: 0, inflight: 0, outcome: 'error' })).toBe('error')
  })
})

describe('a prompt sent while a turn runs', () => {
  // The transcript keeps it as an attachment (queued_command), not a user message: missing it lost the question.
  const lines = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'build the streams mod' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'how do I convert UTC to local time?' } },
    { type: 'attachment', uuid: 'n1', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'The person enabled mod hot-reloading' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Use Intl.DateTimeFormat with the local zone.' }] } },
    { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
  ]
  const items = readTranscript(lines.map(l => JSON.stringify(l)).join('\n'))

  test('is read from the transcript as a prompt of its own, marked as sent mid-turn', () => {
    expect(items.filter(i => i.kind === 'prompt')).toEqual([
      { kind: 'prompt', uuid: 'u1', text: 'build the streams mod', isFolded: false },
      { kind: 'prompt', uuid: 'q1', text: 'how do I convert UTC to local time?', isFolded: true },
    ])
  })
  // Seen live: a mid-turn prompt with a screenshot is stored as blocks, and reading it as a string crashed the import.
  test('a mid-turn prompt stored as text and image blocks is read by its text', () => {
    const line = { type: 'attachment', uuid: 'q9', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: '[Image #4] nothing is happening' }, { type: 'image', source: {} }] } }
    expect(readTranscript(JSON.stringify(line))).toEqual([{ kind: 'prompt', uuid: 'q9', text: '[Image #4] nothing is happening', isFolded: true }])
  })
  test('tool results and engine notifications are not prompts, and a subagent line is not main conversation', () => {
    expect(items.map(i => i.uuid)).toEqual(['u1', 'a1', 'q1', 'a2'])
  })
  test('the reply that answers it goes to its stream, not the running turn', () => {
    const turn = { streamId: 'streams-mod', text: 'build the streams mod' }
    const folded = [{ streamId: 'timezones', text: 'how do I convert UTC to local time?' }]
    expect(pickReplyStream('timezones', turn, folded)).toBe('timezones')
    expect(pickReplyStream('no idea', turn, folded)).toBe('streams-mod')
  })
})

describe('the hooks', () => {
  test('a tagged prompt reaches the model untagged and becomes the current stream', ENGINE, async ($, on) => {
    mock.clock(on)
    const status = watchStatus(on)
    const seen: string[] = []
    on('prompt.submit', async (_$, e) => {
      seen.push(e.text)
      return { text: e.text }
    })
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    expect(seen).toEqual(['why is the invoice total off?'])
    expect(status.at(-1)).toBe('stream billing')
  })

  test("an untagged prompt goes where the model routes it", ENGINE, async ($, on) => {
    on('model.complete', async () => ({ value: { isAnswered: true, text: '{"new":"Flaky tests","summary":"CI flakes"}', usage: USAGE } }))
    mock.clock(on)
    const status = watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'why does the e2e suite fail one run in five?', wait: false, origin: { kind: 'composer' } })
    expect(status.at(-1)).toBe('stream flaky-tests')
  })
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** The status line names the stream the main loop is on: what the person sees of a routing. */
function watchStatus(on: On): (string | undefined)[] {
  const seen: (string | undefined)[] = []
  on('ui.status', async (_$, e) => {
    seen.push(e.text)
    return { value: undefined }
  })
  return seen
}

describe('the running turn', () => {
  test('keeps its stream when a prompt for another stream is sent into it', ENGINE, async ($, on) => {
    mock.clock(on)
    const status = watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    await $.prompt.submit({ text: '#streams-mod build the mod', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '#timezones how do I convert UTC to local time?', wait: false, origin: { kind: 'composer' }, turnId: 'turn-1' })
    expect(status.at(-1)).toBe('stream streams-mod')
  })
})

describe('drawing', () => {
  // A crash while drawing leaves the bar and the pane empty: these catch that before it ships.
  test('the bar draws a pill for a stream, and the pane draws its activity', ENGINE, async ($, on) => {
    mock.clock(on)
    watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    // Stands for the engine's own drawing beneath the plugin, as a session has it.
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    for (const surface of ['terminal', 'desktop'] as const) {
      const bar = await $.ui.mount({ plugin: 'streams', surface, component: 'AbovePrompt', props: { bodyColumns: 120, hasSurvey: false } as never })
      expect(await bar.find({ key: 'chip:billing' })).toBeDefined()
      await bar.unmount()
      const pane = await $.ui.mount({ plugin: 'streams', surface, component: 'Pane', requestId: 'streams', props: { title: 'Streams', isFocused: false, bodyColumns: 60, placement: 'dock' } as never })
      expect(await pane.find({ key: 'open:billing' })).toBeDefined()
      await pane.unmount()
    }
  })
})

describe('archiving', () => {
  const PANE_PROPS = { title: 'Streams', isFocused: false, bodyColumns: 60, placement: 'dock' } as never
  const BAR_PROPS = { bodyColumns: 120, hasSurvey: false } as never

  test('✕ hides a stream from the bar and the list, and restore brings it back with its history', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })

    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    await pane.press({ key: 'archive:billing' })
    expect(await pane.find({ key: 'open:billing' })).toBe(undefined)
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: BAR_PROPS })
    expect(await bar.find({ key: 'chip:billing' })).toBe(undefined)

    await pane.press({ key: 'archived' })
    await pane.press({ key: 'restore:billing' })
    expect(await pane.find({ key: 'open:billing' })).toBeDefined()
    await bar.redraw(BAR_PROPS)
    expect(await bar.find({ key: 'chip:billing' })).toBeDefined()
  })

  test('a new prompt for an archived stream brings it back, so new work never lands out of sight', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#billing first question', wait: false, origin: { kind: 'composer' } })
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    await pane.press({ key: 'archive:billing' })
    await $.prompt.submit({ text: '#billing one more thing', wait: false, origin: { kind: 'composer' } })
    expect(await pane.find({ key: 'open:billing' })).toBeDefined()
  })

  test('clicking a name opens the stream and focuses the transcript on it, in one press', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    const status = watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    await pane.press({ key: 'open:billing' })
    expect(status.at(-1)).toBe('◉ stream billing')
    expect(await pane.find({ key: 'back' })).toBeDefined()
    await pane.press({ key: 'back' })
    expect(status.at(-1)).toBe('stream billing')
  })
})

describe('stream colours', () => {
  test('a new stream takes a pastel no live stream wears, so two streams never look alike', () => {
    expect(nextPastel([PASTELS[0], PASTELS[1]])).toBe(PASTELS[2])
    expect(nextPastel([])).toBe(PASTELS[0])
  })

  test("the transcript is filed on the first prompt, and each filed row is drawn behind its stream's colour", ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: TRANSCRIPT.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => ({ value: TRANSCRIPT }) as never)
    // The one model call: which thread each reply piece after the mid-turn question answers.
    on('model.complete', async () => ({ value: { isAnswered: true, text: '["timezones", "billing"]', usage: USAGE } }) as never)
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('ui.toast', async () => ({ value: undefined }))
    watchStatus(on)
    on('ui.render', async () => ({ type: 'Text', props: {}, children: ['engine row'] }) as never)
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    // The import runs on the background worker's tick, never inside the prompt's own hook.
    await clock.advance(1500)

    const row = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'UserMessage', requestId: 'u1', props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false } as never })
    const line = await row.find({ type: 'Text', text: /^▏/ })
    expect((line?.props as { color?: string } | undefined)?.color).toBe(PASTELS[0])
    expect(await row.find({ type: 'Text', text: /engine row/ })).toBeDefined()

    // The mid-turn question, and the reply that answers it, wear the timezones stream's line; the rest stay with billing.
    const lineOf = async (component: 'UserMessage' | 'AssistantMessage', requestId: string) => {
      const drawn = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component, requestId, props: { text: 'x', origin: { kind: 'composer' }, isExpanded: false, isFirstOfReply: true } as never })
      return ((await drawn.find({ type: 'Text', text: /^▏/ }))?.props as { color?: string } | undefined)?.color
    }
    expect(await lineOf('UserMessage', 'q1')).toBe(PASTELS[1])
    expect(await lineOf('AssistantMessage', 'a2')).toBe(PASTELS[1])
    expect(await lineOf('AssistantMessage', 'a3')).toBe(PASTELS[0])
    const group = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'ToolGroup', props: { calls: [{ tool_use_id: 't1', tool: 'Bash', input: {}, isRunning: false, isErrored: false }], isActive: false, isExpanded: false } as never })
    expect(((await group.find({ type: 'Text', text: /^▏/ }))?.props as { color?: string } | undefined)?.color).toBe(PASTELS[0])

    const unfiled = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'UserMessage', requestId: 'nope', props: { text: 'hi', origin: { kind: 'composer' }, isExpanded: false } as never })
    expect(await unfiled.findAll({ type: 'Box' })).toEqual([])
  })

})

const TRANSCRIPT = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: '#billing why is the invoice total off?' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep total' } }] } },
  { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '#timezones how do I convert UTC to local time?' } },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Use Intl.DateTimeFormat with the local zone.' }] } },
  { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'Back to the invoice: it was rounding.' }] } },
]
  .map(l => JSON.stringify(l))
  .join('\n')

describe('matching transcript rows', () => {
  // Seen live: every prompt and reply was drawn under its uuid with the last group zeroed, so none matched.
  test('a row drawn under its uuid with the last group zeroed finds the row stored under the full uuid', () => {
    expect(rowKey('61ec327a-403c-4478-84b7-000000000000')).toBe(rowKey('61ec327a-403c-4478-84b7-4b8d64663b0d'))
  })
  test('tool ids and text keys are keyed as they are', () => {
    expect(rowKey('toolu_01abc')).toBe('toolu_01abc')
  })
})

describe('folding the pane', () => {
  test('the fold cycles all → last 10 → last 1 → header only → all', () => {
    expect([NEXT_FOLD.all, NEXT_FOLD['10'], NEXT_FOLD['1'], NEXT_FOLD.none]).toEqual(['10', '1', 'none', 'all'])
  })

  const PANE_PROPS = { title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' } as never
  const setup = async ($: Engine, on: On) => {
    const clock = mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    return clock
  }

  test('an idle stream collapses to its header by itself, and a press opens it again', ENGINE, async ($, on) => {
    const clock = await setup($, on)
    const pane0 = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    // Just finished, it stays open.
    expect((await pane0.find({ key: 'fold:billing' }))?.text).toBe('▾ all')
    await pane0.unmount()
    await clock.advance(11 * 60_000)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    // Quiet past ten minutes: idle, folded to the header.
    expect((await pane.find({ key: 'fold:billing' }))?.text).toBe('▸')
    expect(await pane.find({ type: 'Text', text: /why is the invoice/ })).toBe(undefined)
    await pane.press({ key: 'fold:billing' })
    expect((await pane.find({ key: 'fold:billing' }))?.text).toBe('▾ all')
    expect(await pane.find({ type: 'Text', text: /why is the invoice/ })).toBeDefined()
  })

  test('a subagent shows yellow while it runs and green once done, so you can see what is moving', ENGINE, async ($, on) => {
    on('agent.spawn', async () => ({ model: 'haiku', agentId: 'ag1' }))
    on('turn.complete', async () => ({ text: '' }))
    await setup($, on)
    await $.agent.spawn({ prompt: 'look into it', description: 'check rounding', subagentType: 'Explore' } as never)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    await pane.press({ key: 'fold:billing' })
    const badge = async (word: RegExp) => (await pane.find({ type: 'Text', text: word }))?.props as { color?: string } | undefined
    expect(await pane.find({ type: 'Text', text: /check rounding/ })).toBeDefined()
    expect((await badge(/^● RUNNING/))?.color).toBe('#ffd33d')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', agentId: 'ag1', reason: 'answer' } as never)
    expect((await badge(/^✓ DONE/))?.color).toBe('#7ee787')
  })
})

describe('rows filed under an older key scheme', () => {
  // Seen live: rows filed before the key fix stayed unfound, because the import had already been marked done.
  test('a session whose rows predate the current keys files its history again on load', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    let reads = 0
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: TRANSCRIPT.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => {
      reads += 1
      return { value: TRANSCRIPT } as never
    })
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('ui.toast', async () => ({ value: undefined }))
    on('ui.status', async () => ({ value: undefined }))
    on('model.complete', async () => ({ value: { isAnswered: true, text: '["timezones", "billing"]', usage: USAGE } }) as never)
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
    expect(reads).toBe(1)
    // Filed once under the current scheme: another prompt does not file it again.
    await $.classic.UserPromptSubmit({ prompt: 'again', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
    expect(reads).toBe(1)
  })
})

describe('active loops', () => {
  test('a scheduled wakeup lights its stream with a LOOP badge and a countdown, and stopping it clears it', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#ux-loop polish the agent rows', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w1', delaySeconds: 90, reason: 'next pass', prompt: '/loop x' } as never)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: { title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' } as never })
    const loop = await pane.find({ type: 'Text', text: /^↻ LOOP next 1:30/ })
    expect((loop?.props as { color?: string } | undefined)?.color).toBe('#ffd33d')
    await clock.advance(30_000)
    await pane.redraw({ title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' } as never)
    expect(await pane.find({ type: 'Text', text: /↻ LOOP next 1:00/ })).toBeDefined()
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w2', stop: true } as never)
    expect(await pane.find({ type: 'Text', text: /↻ LOOP/ })).toBe(undefined)
  })
})

describe('finished streams do not swallow new work', () => {
  const PANE_PROPS = { title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' } as never
  // Seen live: a short "repo setup" stream kept taking every later README, badge and git request, because the
  // classifier saw no sign it was done and each match widened its summary.
  const HOUR = 60 * 60_000
  const streams: Stream[] = [
    { id: 'repo-setup', name: 'Repo setup', summary: 'Create the GitHub repo', createdAt: 0, lastAt: 0, rows: 9, agents: 0, loops: 0 },
    { id: 'billing', name: 'Billing', summary: 'Invoice totals off', createdAt: 0, lastAt: 3 * HOUR - 60_000, rows: 4, agents: 0, loops: 0 },
  ]

  test('the classifier is told which streams are finished and how long ago they were last active', () => {
    const prompt = buildPrompt(streams, 'billing', 'add badges to the README', 3 * HOUR, { billing: 'running' })
    expect(prompt).toContain('id: repo-setup\n  name: Repo setup\n  goal: Create the GitHub repo\n  state: finished, last active 3h ago')
    expect(prompt).toContain('id: billing (current)\n  name: Billing\n  goal: Invoice totals off\n  state: working now')
    expect(FINISHED_MS).toBeLessThan(HOUR)
  })

  test("matching a stream leaves its goal as it was created, and archived streams are never offered", ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    const status = watchStatus(on)
    const asked: string[] = []
    on('model.complete', async (_$, e) => {
      asked.push(String((e as { prompt?: unknown }).prompt))
      return { value: { isAnswered: true, text: '{"stream":"billing","summary":"billing, badges, README and everything else"}', usage: USAGE } } as never
    })
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '#old-chore tidy the changelog', wait: false, origin: { kind: 'composer' } })
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    await pane.press({ key: 'archive:old-chore' })
    await $.prompt.submit({ text: 'and check the rounding in refunds as well', wait: false, origin: { kind: 'composer' } })
    expect(status.at(-1)).toBe('stream billing')
    expect(asked.at(-1)).not.toContain('old-chore')
    await pane.press({ key: 'open:billing' })
    expect(await pane.find({ type: 'Text', text: 'why is the invoice total off?' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /badges/ })).toBe(undefined)
  })

  // Two prompts filed by tag, then the second moved by hand: its rows and transcript lines follow.
  const TWO = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '#auth-jwt move sessions to signed JWTs' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Starting with the session store.' }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '#auth-jwt why is the invoice total off by a cent?' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'grep -rn round src/billing' } }] } },
    { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'Totals are rounded per line.' }] } },
  ].map(l => JSON.stringify(l)).join('\n')

  test('/stream move refiles the last prompt and everything after it, transcript lines included', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: TWO.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => ({ value: TWO }) as never)
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.toast', async () => ({ value: undefined }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
    await $.prompt.submit({ text: '#auth-jwt', wait: false, origin: { kind: 'composer' } })
    const run = ($.command as unknown as { run: (e: unknown) => Promise<{ text: string }> }).run
    const done = await run({ command: 'stream', args: 'move billing', origin: { kind: 'composer' } })
    expect(done.text).toBe('Moved the last prompt and 2 rows after it from auth-jwt to billing.')
    const lineOf = async (component: 'UserMessage' | 'AssistantMessage' | 'ToolUse', requestId: string) => {
      const drawn = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component, requestId, props: { text: 'x', origin: { kind: 'composer' }, isExpanded: false, isFirstOfReply: true } as never })
      return ((await drawn.find({ type: 'Text', text: /^▏/ }))?.props as { color?: string } | undefined)?.color
    }
    const auth = await lineOf('UserMessage', 'u1')
    const billing = await lineOf('UserMessage', 'u2')
    expect(billing).toBeDefined()
    expect(billing).not.toBe(auth)
    expect(await lineOf('AssistantMessage', 'a3')).toBe(billing)
  })
})

describe('full chat style', () => {
  const PANE_PROPS = { title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' } as never
  // Compact rows are one line each; the full style is for reading a stream's work as the session shows it,
  // so the command, the edit and the reply's code must keep their structure and highlighting.
  test('a Bash call keeps its command as bash, an Edit becomes a diff, and a Read needs nothing beneath', () => {
    expect(codeOf('Bash', { command: 'npm test -- --watch' })).toEqual({ source: 'npm test -- --watch', language: 'bash' })
    expect(codeOf('Edit', { file_path: 'src/a.ts', old_string: 'let x = 1', new_string: 'const x = 1' })).toEqual({
      source: '@@ -1,1 +1,1 @@\n-let x = 1\n+const x = 1',
      format: 'diff',
      path: 'src/a.ts',
    })
    expect(codeOf('Write', { file_path: 'a.py', content: 'print(1)\n' })).toEqual({ source: 'print(1)\n', path: 'a.py' })
    expect(codeOf('Read', { file_path: 'src/a.ts' })).toBe(undefined)
  })

  test('a tool row is titled as the session titles it, by the file or command it acts on', () => {
    expect(toolLine('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' })).toBe('Edit(src/a.ts)')
    expect(toolLine('Bash', { command: 'npm test', description: 'run tests' })).toBe('Bash(npm test)')
    expect(toolLine('TodoWrite', { todos: [] })).toBe('TodoWrite {"todos":[]}')
  })

  test('an oversized diff is drawn as whole hunks, never cut mid-hunk where it would stop parsing as a diff', () => {
    const big = 'x\n'.repeat(CODE_LIMIT)
    const code = codeOf('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: big, new_string: big }] })
    expect(code?.format).toBe('diff')
    expect(code?.source).toBe('@@ -1,1 +1,1 @@\n-a\n+b')
  })

  // One tagged prompt, a reply with a fenced block, an Edit and a Bash call: filed by the history import.
  const WORK = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '#billing why is the invoice total off?' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Rounding happens here:\n\n```ts\nMath.round(x)\n```' }] } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/total.ts', old_string: 'Math.round(x)', new_string: 'roundHalfEven(x)' } }] } },
    { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
  ].map(l => JSON.stringify(l)).join('\n')

  const openBilling = async ($: Engine, on: On) => {
    const clock = mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: WORK.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => ({ value: WORK }) as never)
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('ui.toast', async () => ({ value: undefined }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    await pane.press({ key: 'open:billing' })
    return pane
  }

  test('a stream view draws replies as markdown and tool calls with highlighted code by default, and the toggle switches to compact', ENGINE, async ($, on) => {
    const pane = await openBilling($, on)
    const codes = await pane.findAll({ type: 'Code' })
    expect(codes.map(c => (c.props as { format?: string; language?: string }).format ?? (c.props as { language?: string }).language)).toEqual(['diff', 'bash'])
    const texts = (await pane.findAll({ type: 'Markdown' })).map(m => (m.props as { text: string }).text)
    expect(texts).toEqual(['why is the invoice total off?', 'Rounding happens here:\n\n```ts\nMath.round(x)\n```'])
    await pane.press({ key: 'style:compact' })
    expect(await pane.find({ type: 'Code' })).toBe(undefined)
    await pane.press({ key: 'style:full' })
    expect(await pane.find({ type: 'Code' })).toBeDefined()
  })

  test('the chatStyle setting picks the style a stream view opens in', { ...ENGINE, options: { chatStyle: 'compact' } }, async ($, on) => {
    const pane = await openBilling($, on)
    expect(await pane.find({ type: 'Code' })).toBe(undefined)
  })
})

describe('#tag autocomplete', () => {
  // Filing a prompt by hand only works if the person can recall the exact stream id; completion makes it cheap.
  const known = [
    { id: 'billing-rounding', lastAt: 5 },
    { id: 'billing-tax', lastAt: 9 },
    { id: 'auth-jwt', lastAt: 7 },
    { id: 'billing-old', lastAt: 99, archived: true },
  ]

  test('a tag is only completed while it is the first thing in the box and the cursor is on it', () => {
    expect(partialTag('#bil', 4)).toBe('bil')
    expect(partialTag('#', 1)).toBe('')
    expect(partialTag('#bil why', 8)).toBe(undefined)
    expect(partialTag('fix #bil', 8)).toBe(undefined)
  })

  test('live streams come before archived ones, most recent first', () => {
    expect(tagMatches(known, 'bil')).toEqual(['billing-tax', 'billing-rounding', 'billing-old'])
    expect(tagMatches(known, 'zzz')).toEqual([])
  })

  test('completing replaces just the partial tag and leaves the cursor ready to type the prompt', () => {
    expect(completeTag('#bil', 4, 'billing-tax')).toEqual({ text: '#billing-tax ', cursor: 13 })
    expect(completeTag('#bil  why is it off', 4, 'billing-tax')).toEqual({ text: '#billing-tax why is it off', cursor: 13 })
  })

  test('Tab in the prompt box completes a partial tag to the best matching stream', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('prompt.edit', async (_$, e) => {
      const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
      return { text, cursor: e.start + e.inputText.length }
    })
    await $.prompt.submit({ text: '#billing-rounding why is the total off?', wait: false, origin: { kind: 'composer' } })
    // The kit raises prompt.edit like any event, though its types leave it off the prompt noun.
    const edit = ($.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string; cursor: number; decorations?: unknown[] }> }).edit
    const box = await edit({ origin: { kind: 'composer' }, key: { key: 'tab' }, text: '#bill', cursor: 5, start: 5, end: 5, inputText: '' } as never)
    expect(box).toMatchObject({ text: '#billing-rounding ', cursor: 18 })
    const typed = await edit({ origin: { kind: 'composer' }, key: { key: 'g' }, text: '#billing-roundin', cursor: 16, start: 16, end: 16, inputText: 'g' } as never)
    expect(typed.decorations?.length).toBe(1)
  })
})

describe('finished loops', () => {
  // A /loop ends by not scheduling another tick, or by a stop filed while another stream is current.
  // Either way it must stop shining yellow, or every past loop looks like it is still running.
  const mountPane = ($: never) => ($ as { ui: { mount: (o: unknown) => Promise<{ find: (q: unknown) => Promise<unknown>; redraw: (p: unknown) => Promise<void> }> } }).ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: { title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' } })
  const props = { title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' }

  test('a wakeup that lapses without re-arming no longer shows as a running loop', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#ux-loop polish the agent rows', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w1', delaySeconds: 60, reason: 'next pass', prompt: '/loop x' } as never)
    const pane = await mountPane($ as never)
    expect(await pane.find({ type: 'Text', text: /↻ LOOP/ })).toBeDefined()
    await clock.advance(15 * 60_000)
    await pane.redraw(props)
    expect(await pane.find({ type: 'Text', text: /↻ LOOP/ })).toBe(undefined)
  })

  test('stopping the loop clears it even when another stream is current', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('tool.call', async () => ({ result: 'ok', text: 'ok' }) as never)
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#ux-loop polish the agent rows', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w1', delaySeconds: 60, reason: 'next pass', prompt: '/loop x' } as never)
    await $.prompt.submit({ text: '#docs tidy the install guide', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'ScheduleWakeup', tool_use_id: 'w2', stop: true } as never)
    const pane = await mountPane($ as never)
    expect(await pane.find({ type: 'Text', text: /↻ LOOP/ })).toBe(undefined)
  })
})

describe('a long session', () => {
  // Seen live: a 4.76 MiB transcript made every import fail, since a read refuses past 4 MiB.
  test('a transcript over the read limit is streamed whole, not refused', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    let streamed = false
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: 5_000_000, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => {
      throw new Error('over 4 MiB')
    })
    on('process.spawn', async function* () {
      streamed = true
      const half = Math.floor(TRANSCRIPT.length / 2)
      yield { stream: 'stdout', text: TRANSCRIPT.slice(0, half) }
      yield { stream: 'stdout', text: TRANSCRIPT.slice(half) }
      return { value: { code: 0, signal: null } }
    } as never)
    on('model.complete', async () => ({ value: { isAnswered: true, text: '["timezones", "billing"]', usage: USAGE } }) as never)
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('ui.toast', async () => ({ value: undefined }))
    on('ui.status', async () => ({ value: undefined }))
    on('ui.render', async () => ({ type: 'Text', props: {}, children: ['engine row'] }) as never)
    const logs: string[] = []
    on('ui.log', async (_$, e) => {
      logs.push(String((e as { text?: string }).text))
      return { value: undefined } as never
    })
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
    expect(logs).toEqual([])
    expect(streamed).toBe(true)
    const row = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AssistantMessage', requestId: 'a2', props: { text: 'Use Intl.DateTimeFormat with the local zone.', isFirstOfReply: true } as never })
    expect(((await row.find({ type: 'Text', text: /^▏/ }))?.props as { color?: string } | undefined)?.color).toBe(PASTELS[1])
  })
})

describe('painting rows', () => {
  // Seen live: a `!` command's output kept its colour codes, and the stream holding it painted an empty pane.
  test('terminal colour codes and control characters never reach a pane line', () => {
    expect(oneLine('\x1b[32m✔\x1b[0m Added example\u0007 MCP server', 80)).toBe('✔ Added example MCP server')
  })
})

describe('diagnostics', () => {
  // An installed copy must not write into its own folder: diagnostics are opt-in.
  test('by default the heartbeat never writes debug.json', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    let writes = 0
    on('fs.write', async () => {
      writes += 1
      return { value: undefined } as never
    })
    on('session.cwd', async () => ({ value: '/project' }))
    on('ui.status', async () => ({ value: undefined }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    await $.prompt.submit({ text: '#billing one', wait: false, origin: { kind: 'composer' } })
    await clock.advance(12_000)
    expect(writes).toBe(0)
  })
})

describe('filing a long history in parallel', () => {
  test('work runs several at once, never more than the limit, and results keep their order', async () => {
    let live = 0
    let most = 0
    const out = await inParallel([5, 1, 4, 2, 3], 2, async n => {
      live += 1
      most = Math.max(most, live)
      await Promise.resolve()
      live -= 1
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30])
    expect(most).toBe(2)
  })

  test('a batch reply gives one label per message, blank where the model gave nothing usable', () => {
    expect(parseBatch('Here: ["auth-jwt", "Billing bug", 7]', 4)).toEqual(['auth-jwt', 'Billing bug', '', ''])
    expect(parseBatch('no idea', 2)).toEqual(['', ''])
  })

  test('the merge pass maps every proposed name, keeping any the model left out', () => {
    expect(parseMerge('{"Billing bug": "billing", "Invoice rounding": "billing"}', ['Billing bug', 'Invoice rounding', 'Docs'])).toEqual({
      'Billing bug': 'billing',
      'Invoice rounding': 'billing',
      Docs: 'Docs',
    })
  })

  // Untagged prompts: batches propose names, the merge pass unifies them, a follow-up takes the stream before it.
  const UNTAGGED = [
    { type: 'user', uuid: 'p1', message: { role: 'user', content: 'why is the invoice total off by a cent?' } },
    { type: 'user', uuid: 'p2', message: { role: 'user', content: 'yes' } },
    { type: 'user', uuid: 'p3', message: { role: 'user', content: 'check the rounding in the tax step too' } },
    { type: 'user', uuid: 'p4', message: { role: 'user', content: 'move sessions to signed JWTs' } },
  ]
    .map(l => JSON.stringify(l))
    .join('\n')

  test('untagged prompts are sorted by batch and merge, and a follow-up stays with the prompt before it', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const systems: string[] = []
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: UNTAGGED.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => ({ value: UNTAGGED }) as never)
    on('model.complete', async (_$, e) => {
      const ask = e as { system?: string }
      systems.push(ask.system === BATCH_SYSTEM ? 'batch' : ask.system === MERGE_SYSTEM ? 'merge' : 'other')
      const text = ask.system === BATCH_SYSTEM ? '["Billing bug", "Invoice rounding", "Auth JWT"]' : '{"Billing bug": "Billing", "Invoice rounding": "Billing", "Auth JWT": "Auth JWT"}'
      return { value: { isAnswered: true, text, usage: USAGE } } as never
    })
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('ui.toast', async () => ({ value: undefined }))
    on('ui.status', async () => ({ value: undefined }))
    on('ui.render', async () => ({ type: 'Text', props: {}, children: ['engine row'] }) as never)
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
    // One batch for the three open prompts ("yes" needs no model), then one merge.
    expect(systems).toEqual(['batch', 'merge'])
    const colourOf = async (requestId: string) => {
      const row = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'UserMessage', requestId, props: { text: 'x', origin: { kind: 'composer' }, isExpanded: false } as never })
      return ((await row.find({ type: 'Text', text: /^▏/ }))?.props as { color?: string } | undefined)?.color
    }
    const billing = await colourOf('p1')
    expect(await colourOf('p2')).toBe(billing)
    expect(await colourOf('p3')).toBe(billing)
    expect(await colourOf('p4')).not.toBe(billing)
  })
})

describe('the status card', () => {
  const BAR_PROPS = { bodyColumns: 120, hasSurvey: false } as never
  const s = (id: string, lastAt = 0) => ({ id, name: id, summary: `${id} work`, lastAt })

  // The card exists to answer "what needs me?": a reply that ends on a question is the person's move,
  // so it must read as waiting, never as done.
  test('a stream whose last reply asks a question is waiting for the person, with the question as its detail', () => {
    const line = statusOf({ stream: s('auth'), health: 'done', running: [], lastSaid: { kind: 'reply', text: 'Tests pass. Shall I commit it?' }, now: 0 })
    expect(line.kind).toBe('waiting')
    expect(line.detail).toBe('Shall I commit it?')
    expect(questionOf('All done.')).toBe(undefined)
  })

  test('running work says what it is doing now, and running and waiting rows sort above finished ones', () => {
    const run = statusOf({ stream: s('billing'), health: 'running', running: [{ description: 'trace rounding', last: 'Grep toFixed', tools: 6 }], now: 0 })
    expect(run.detail).toBe('trace rounding: Grep toFixed (6 tools)')
    const done = statusOf({ stream: s('docs', 9), health: 'done', running: [], now: 10_000 })
    const wait = statusOf({ stream: s('auth'), health: 'done', running: [], lastSaid: { kind: 'reply', text: 'Merge it?' }, now: 0 })
    expect(sortStatus([done, wait, run], { docs: 9 }).map(l => l.id)).toEqual(['billing', 'auth', 'docs'])
  })

  test('git rows say whether anything is unpushed or uncommitted', () => {
    const rows = gitStatus('## main...origin/main [ahead 2]\n M src/a.ts\n?? notes.md\n')
    expect(rows.map(r => [r.area, r.state, r.detail])).toEqual([
      ['Git branch', 'main', '2 unpushed'],
      ['Uncommitted', '2 files', 'src/a.ts, notes.md'],
    ])
    expect(gitStatus('## main...origin/main\n')[0]?.detail).toBe('up to date with origin/main')
  })

  // Asking for status is the most common question: answered locally it costs no model call and works mid-turn.
  test('typing status shows the card without sending a prompt, and the bar button shows it too', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    watchStatus(on)
    const sent: string[] = []
    on('prompt.submit', async (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: BAR_PROPS })
    expect(await bar.find({ key: 'st-open:billing' })).toBe(undefined)

    const r = await $.prompt.submit({ text: 'status?', wait: false, origin: { kind: 'composer' } })
    expect(r.drop).toBeDefined()
    expect(sent).toEqual(['why is the invoice total off?'])
    expect(await bar.find({ key: 'st-open:billing' })).toBeDefined()

    await bar.press({ key: 'status-close' })
    expect(await bar.find({ key: 'st-open:billing' })).toBe(undefined)
    await bar.press({ key: 'status' })
    expect(await bar.find({ key: 'st-open:billing' })).toBeDefined()
    await $.prompt.submit({ text: '#billing one more thing', wait: false, origin: { kind: 'composer' } })
    expect(await bar.find({ key: 'st-open:billing' })).toBe(undefined)
  })
})

describe('plugin updates', () => {
  // A release is only worth a button when it is really later: a git-sha install has no order to compare.
  test('only a later version counts as an update, and a sha install never does', () => {
    expect(isNewer('0.3.4', '0.3.3')).toBe(true)
    expect(isNewer('0.10.0', '0.9.9')).toBe(true)
    expect(isNewer('0.3.3', '0.3.3')).toBe(false)
    expect(isNewer('1.0.0', '1.0.0-beta')).toBe(true)
    expect(isNewer('e18ff5086423', 'e18ff5086422')).toBe(false)
    expect(updatesOf([{ id: 'a@m', version: '1.0.0', installPath: '' }, { id: 'b@m', version: '2.0.0', installPath: '' }], { 'a@m': '1.1.0', 'b@m': '2.0.0' })).toEqual([
      { id: 'a@m', from: '1.0.0', to: '1.1.0' },
    ])
  })

  test('the latest version is read from the marketplace copy the plugin was installed from', () => {
    expect(pluginsDirOf('/cfg/plugins/cache/claudeflow/streams/0.3.3')).toBe('/cfg/plugins')
    expect(manifestPathOf('/cfg/plugins/marketplaces/claudeflow', { name: 'streams', source: './plugins/streams' })).toBe(
      '/cfg/plugins/marketplaces/claudeflow/plugins/streams/.claude-plugin/plugin.json',
    )
    expect(manifestPathOf('/m', { name: 'x', source: './' })).toBe('/m/.claude-plugin/plugin.json')
    expect(manifestPathOf('/m', { name: 'x', source: { source: 'url', url: 'https://x' } })).toBe(undefined)
  })

  // The point is updating without a restart, from the phone as well as the terminal: one press installs and reloads.
  test('/streams update installs every newer plugin and reloads plugins into the session', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    watchStatus(on)
    on('ui.toast', async () => ({ value: undefined }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    const ran: string[] = []
    on('process.run', async (_$, e) => {
      ran.push(e.argv.join(' '))
      const stdout =
        e.argv[2] === 'list'
          ? JSON.stringify({
              installed: [
                { id: 'streams@claudeflow', version: '0.3.3', installPath: '/cfg/plugins/cache/claudeflow/streams/0.3.3' },
                { id: 'linear@official', version: 'e18ff5086423', installPath: '/cfg/plugins/cache/official/linear/e18ff5086423' },
              ],
            })
          : ''
      return { value: { exitCode: 0, stdout, stderr: '' } } as never
    })
    on('fs.read', async (_$, e) => {
      if (e.path === '/cfg/plugins/marketplaces/claudeflow/.claude-plugin/marketplace.json')
        return { value: JSON.stringify({ plugins: [{ name: 'streams', source: './plugins/streams' }] }) }
      if (e.path === '/cfg/plugins/marketplaces/claudeflow/plugins/streams/.claude-plugin/plugin.json') return { value: JSON.stringify({ version: '0.3.5' }) }
      if (e.path === '/cfg/plugins/marketplaces/official/.claude-plugin/marketplace.json')
        return { value: JSON.stringify({ plugins: [{ name: 'linear', source: './plugins/linear' }] }) }
      return { value: JSON.stringify({ version: 'f00' }) }
    })
    let reloads = 0
    on('command.run', { command: 'reload-plugins' }, async () => {
      reloads++
      return { text: '' }
    })
    const r = await $.command.run({ command: 'streams', args: 'update', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
    expect(r.text).toBe('Updated streams@claudeflow 0.3.3 → 0.3.5.')
    expect(ran).toContain('claude plugin update streams@claudeflow')
    expect(ran.some(c => c.includes('linear'))).toBe(false)
    await clock.advance(500)
    expect(reloads).toBe(1)
  })
})

describe('the phone', () => {
  const PANE_PROPS = { title: 'Streams', isFocused: false, bodyColumns: 44, placement: 'inline' } as never
  const WORK = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '#docs rewrite the install guide' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. Shall I open a PR for it?' }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '#billing why is the total off?' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Rounding is **per line**.' }] } },
  ].map(l => JSON.stringify(l)).join('\n')

  // On a phone the person reads and answers; the accordion puts what is waiting on them first and lets them answer it in one tap.
  test('the phone draws an accordion: a waiting stream shows its question with a yes, and a tapped card opens its chat', ENGINE, async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: WORK.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => ({ value: WORK }) as never)
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('ui.toast', async () => ({ value: undefined }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    const sent: string[] = []
    on('prompt.submit', async (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'mobile', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    expect(await pane.find({ key: 'm:docs' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown' })).toBe(undefined)

    await pane.press({ key: 'm-yes:docs' })
    expect(sent.at(-1)).toBe('yes')

    await pane.press({ key: 'm-open:billing' })
    const texts = (await pane.findAll({ type: 'Markdown' })).map(m => (m.props as { text: string }).text)
    expect(texts).toEqual(['why is the total off?', 'Rounding is **per line**.'])
    await pane.press({ key: 'm-open:billing' })
    expect(await pane.find({ type: 'Markdown' })).toBe(undefined)
  })
})

describe('tickets on the status card', () => {
  // Working tickets, the person asks "where is TL-260?": the card answers per ticket, not per topic.
  test('ticket ids are found as trackers write them, and look-alike standards are not tickets', () => {
    expect(ticketsIn('build TL-260 then TL-262, and re-review TL-260')).toEqual(['TL-260', 'TL-262'])
    expect(ticketsIn('encode as UTF-8 and hash with SHA-256 per ISO-8601')).toEqual([])
  })

  test('a ticket with a running agent says what it is doing and how long it has been quiet; a finished one gives its latest news', () => {
    const lines = ticketLines({
      rows: [
        { kind: 'prompt', text: 'build TL-262 and fix TL-260', at: 0, streamId: 'tickets' },
        { kind: 'reply', text: 'Started both. The TL-262 build is committed (6cbe94f6). Reviews come next.', at: 5_000, streamId: 'tickets' },
      ],
      agents: [{ description: 'TL-260 lottie fix', status: 'running', last: 'Bash gh run watch', tools: 12, lastAt: 10_000, streamId: 'tickets' }],
      streamKind: { tickets: 'done' },
      now: 10_000 + 7 * 60_000,
    })
    expect(lines.map(l => [l.area, l.state, l.detail])).toEqual([
      ['TL-260', 'RUNNING', 'TL-260 lottie fix: Bash gh run watch (12 tools, 7m with no output)'],
      ['TL-262', 'DONE', 'The TL-262 build is committed (6cbe94f6).'],
    ])
  })

  test('a ticket whose agent failed after the last word on it shows as an error', () => {
    const [line] = ticketLines({
      rows: [{ kind: 'prompt', text: 'ship ENG-7', at: 0, streamId: 's' }],
      agents: [{ description: 'ENG-7 deploy', status: 'error', last: '', tools: 3, lastAt: 9, endedAt: 10, streamId: 's' }],
      streamKind: { s: 'done' },
      now: 20,
    })
    expect([line?.state, line?.detail]).toEqual(['ERROR', 'ENG-7 deploy failed'])
  })
})

describe('folding the pane to a side tab', () => {
  const DOCK = { title: 'Streams', isFocused: false, bodyColumns: 72, placement: 'dock' } as never
  // The pane takes room from the transcript; folding it must be one press away and give the same pane back.
  test('hide closes the docked pane to a tab in the bar, and the tab reopens it at the width it had', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    const opened: unknown[] = []
    const closed: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e)
      return { value: { isPlaced: true } } as never
    })
    on('ui.close', async (_$, e) => {
      closed.push(e.id)
      return { value: undefined } as never
    })
    await $.prompt.submit({ text: '#billing why is the invoice total off?', wait: false, origin: { kind: 'composer' } })
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: DOCK })
    await pane.press({ key: 'collapse' })
    expect(closed).toEqual(['streams'])
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 120, hasSurvey: false } as never })
    expect(await bar.find({ key: 'pane' })).toBe(undefined)
    await bar.press({ key: 'tab' })
    expect(opened.at(-1)).toMatchObject({ id: 'streams', columns: 72 })
    expect(await bar.find({ key: 'tab' })).toBe(undefined)
  })
})

describe('plan limits on the status card', () => {
  // Read at a glance: how much is used, how long until it resets, and on which day, since a date alone needs a calendar.
  test('a limit shows its percent as a bar, the time to reset in two units, and the weekday it resets', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    const v = limitView({ kind: 'seven_day', percentUsed: 71.4, resetsAt: '2026-10-11T12:00:00Z' }, now)
    expect([v.label, v.percent, v.bar, v.resetsIn]).toEqual(['week', 71, '▰▰▰▰▰▰▰▱▱▱', '3d 0h'])
    expect(v.resetsAt.startsWith('Sun')).toBe(true)
    expect(untilOf(2 * 3600_000 + 14 * 60_000)).toBe('2h 14m')
    expect(untilOf(9 * 60_000)).toBe('9m')
  })

  test('the card ends with each limit, and its fixed columns never shrink, so every row lines up', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    on('session.usage', async () => ({ value: { startedAt: 0, rateLimits: [{ kind: 'five_hour', percentUsed: 38, resetsAt: '2030-01-01T00:00:00Z' }, { kind: 'seven_day', percentUsed: 85 }] } }) as never)
    await $.prompt.submit({ text: '#billing a very long question that runs on and on so that its detail would squeeze the columns beside it', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'status', wait: false, origin: { kind: 'composer' } })
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 80, hasSurvey: false } as never })
    expect(await bar.find({ key: 'limit:5h' })).toBeDefined()
    expect(await bar.find({ key: 'limit:week' })).toBeDefined()
    const fixed = (await bar.findAll({ type: 'Box' })).filter(b => typeof (b.props as { width?: number }).width === 'number')
    expect(fixed.length).toBeGreaterThan(4)
    expect(fixed.every(b => (b.props as { flexShrink?: number }).flexShrink === 0)).toBe(true)
  })
})

describe('scrolling and closing the status card', () => {
  // The card can outgrow the band; it must be readable to the end and closed without reaching for the mouse.
  test('with the card up and nothing typed, arrows scroll it instead of recalling history, and Esc closes it', ENGINE, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    watchStatus(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    let history = 0
    on('prompt.edit', async (_$, e) => {
      history++
      return { text: e.text, cursor: e.cursor }
    })
    await $.prompt.submit({ text: '#billing why is the total off?', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'status', wait: false, origin: { kind: 'composer' } })
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: { bodyColumns: 100, hasSurvey: false } as never })
    const edit = ($.prompt as unknown as { edit: (e: unknown) => Promise<{ text: string }> }).edit
    await edit({ origin: { kind: 'composer' }, key: { key: 'down' }, text: '', cursor: 0, start: 0, end: 0, inputText: '' } as never)
    // The kit has no band to scroll, so what is held here is that the arrow was the card's, not the history's.
    expect(history).toBe(0)
    expect(await bar.find({ key: 'status-close' })).toBeDefined()
    await edit({ origin: { kind: 'composer' }, key: { key: 'escape' }, text: '', cursor: 0, start: 0, end: 0, inputText: '' } as never)
    expect(await bar.find({ key: 'status-close' })).toBe(undefined)
    // With text in the box the arrows are the person's again.
    await edit({ origin: { kind: 'composer' }, key: { key: 'up' }, text: 'draft', cursor: 5, start: 5, end: 5, inputText: '' } as never)
    expect(history).toBe(1)
  })
})
