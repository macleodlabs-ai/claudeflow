import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Stream } from '../types'
import { NEXT_FOLD, PASTELS, STALL_MS, oneLine, rowKey, healthOf, nextPastel, pickReplyStream, readTranscript, isFollowUp, loopKey, parseTag, parseVerdict, slug } from '../hooks/classify'

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
    { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'what is french for pain medication?' } },
    { type: 'attachment', uuid: 'n1', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'The person enabled mod hot-reloading' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Un antidouleur.' }] } },
    { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
  ]
  const items = readTranscript(lines.map(l => JSON.stringify(l)).join('\n'))

  test('is read from the transcript as a prompt of its own, marked as sent mid-turn', () => {
    expect(items.filter(i => i.kind === 'prompt')).toEqual([
      { kind: 'prompt', uuid: 'u1', text: 'build the streams mod', isFolded: false },
      { kind: 'prompt', uuid: 'q1', text: 'what is french for pain medication?', isFolded: true },
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
    const folded = [{ streamId: 'french-translation', text: 'what is french for pain medication?' }]
    expect(pickReplyStream('french-translation', turn, folded)).toBe('french-translation')
    expect(pickReplyStream('no idea', turn, folded)).toBe('streams-mod')
  })
})

describe('the hooks', () => {
  test('a tagged prompt reaches the model untagged and becomes the current stream', async ($, on) => {
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

  test("an untagged prompt goes where the model routes it", async ($, on) => {
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
  test('keeps its stream when a prompt for another stream is sent into it', async ($, on) => {
    mock.clock(on)
    const status = watchStatus(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    await $.prompt.submit({ text: '#streams-mod build the mod', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '#french how do you say painkiller?', wait: false, origin: { kind: 'composer' }, turnId: 'turn-1' })
    expect(status.at(-1)).toBe('stream streams-mod')
  })
})

describe('drawing', () => {
  // A crash while drawing leaves the bar and the pane empty: these catch that before it ships.
  test('the bar draws a pill for a stream, and the pane draws its activity', async ($, on) => {
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

  test('✕ hides a stream from the bar and the list, and restore brings it back with its history', async ($, on) => {
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

  test('a new prompt for an archived stream brings it back, so new work never lands out of sight', async ($, on) => {
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

  test('clicking a name opens the stream and focuses the transcript on it, in one press', async ($, on) => {
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

  test("the transcript is filed on the first prompt, and each filed row is drawn behind its stream's colour", async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('fs.stat', async () => ({ value: { kind: 'file', size: TRANSCRIPT.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => ({ value: TRANSCRIPT }) as never)
    // The one model call: which thread each reply piece after the mid-turn question answers.
    on('model.complete', async () => ({ value: { isAnswered: true, text: '["french", "billing"]', usage: USAGE } }) as never)
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

    // The mid-turn question, and the reply that answers it, wear the French stream's line; the rest stay with billing.
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
  { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '#french what is french for painkiller?' } },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Un antidouleur.' }] } },
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

  test('an idle stream collapses to its header by itself, and a press opens it again', async ($, on) => {
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

  test('a subagent shows yellow while it runs and green once done, so you can see what is moving', async ($, on) => {
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
  test('a session whose rows predate the current keys files its history again on load', async ($, on) => {
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
    on('model.complete', async () => ({ value: { isAnswered: true, text: '["french", "billing"]', usage: USAGE } }) as never)
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
  test('a scheduled wakeup lights its stream with a LOOP badge and a countdown, and stopping it clears it', async ($, on) => {
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

describe('a long session', () => {
  // Seen live: a 4.76 MiB transcript made every import fail, since a read refuses past 4 MiB.
  test('a transcript over the read limit is streamed whole, not refused', async ($, on) => {
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
    on('model.complete', async () => ({ value: { isAnswered: true, text: '["french", "billing"]', usage: USAGE } }) as never)
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
    const row = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AssistantMessage', requestId: 'a2', props: { text: 'Un antidouleur.', isFirstOfReply: true } as never })
    expect(((await row.find({ type: 'Text', text: /^▏/ }))?.props as { color?: string } | undefined)?.color).toBe(PASTELS[1])
  })
})

describe('painting rows', () => {
  // Seen live: a `!` command's output kept its colour codes, and the stream holding it painted an empty pane.
  test('terminal colour codes and control characters never reach a pane line', () => {
    expect(oneLine('\x1b[32m✔\x1b[0m Added tokensave\u0007 MCP server', 80)).toBe('✔ Added tokensave MCP server')
  })
})

describe('diagnostics', () => {
  // An installed copy must not write into its own folder: diagnostics are opt-in.
  test('by default the heartbeat never writes debug.json', async ($, on) => {
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
