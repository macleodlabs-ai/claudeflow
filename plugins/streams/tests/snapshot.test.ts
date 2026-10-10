import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

/** Tests that drive the engine: room to finish on a busy machine, where the default 5 s is not. */
const ENGINE = { timeoutMs: 20_000 }

// Draws the pane with a realistic mix of agents and prints it as text, so its layout can be judged by eye
// (the test prints it). It also holds the layout rules the agents' rows must keep at every width.

declare const console: { log: (text: string) => void }

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] } | string

/** A rough text drawing of a tree: columns stack, rows join with their gap, Buttons show their label. */
function draw(node: Node, width: number): string[] {
  if (typeof node === 'string') return [node]
  const props = node.props ?? {}
  const kids = node.children ?? []
  if (node.type === 'Button') return [String(props.label ?? '')]
  // Full rows: the session's markdown as its text, highlighted code as a marked block (its first line).
  if (node.type === 'Markdown') return String(props.text ?? '').split('\n')
  if (node.type === 'Code') return [`[${String(props.format ?? props.language ?? 'code')}] ${String(props.source ?? '').split('\n')[0]}`]
  if (node.type === 'Text') return [kids.map(k => (typeof k === 'string' ? k : draw(k, width).join(''))).join('')]
  const parts = kids.map(k => draw(k, width))
  if (props.flexDirection === 'column') {
    const lines = parts.flat()
    return props.marginTop ? ['', ...lines] : lines
  }
  const gap = ' '.repeat(Number(props.gap ?? 0))
  return [parts.map(p => p.join(' ')).join(gap)]
}

const PANE = (bodyColumns: number) => ({ title: 'Streams', isFocused: false, bodyColumns, placement: 'dock' }) as never
let agentNo = 0

async function scene($: Engine, on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  on('session.cwd', async () => ({ value: '/project' }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('agent.spawn', async () => ({ model: 'haiku', agentId: `agent-${++agentNo}` }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)

  await $.prompt.submit({ text: '#billing why is the invoice total off by a cent?', wait: false, origin: { kind: 'composer' } })
  const spawn = (description: string) =>
    $.agent.spawn({ prompt: description, description, subagentType: 'Explore' } as never)
  await spawn('trace rounding in invoice totals')
  await spawn('check currency conversion tables')
  await spawn('scan tax code for float math')
  await clock.advance(42_000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: `agent-${agentNo - 1}`, reason: 'answer' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: `agent-${agentNo}`, reason: 'error' } as never)
  await $.prompt.submit({ text: '#auth-refactor move sessions to signed JWTs', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'move sessions', turnId: 'main' } as never)
  await spawn('find every session cookie read')
  await clock.advance(7_000)
}

describe('the pane at a glance', () => {
  for (const width of [40, 60, 90]) {
    test(`at ${width} columns every agent shows its status, and no line overflows`, ENGINE, async ($, on) => {
      await scene($, on)
      const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE(width) })
      for (const id of ['billing', 'auth-refactor']) if ((await pane.find({ key: `fold:${id}` }))?.text === '▸') await pane.press({ key: `fold:${id}` })
      const root = (await pane.findAll({}))[0] as unknown as Node
      const lines = draw(root, width)
      console.log(`\n── ${width} cols ──\n${lines.map(l => `|${l}`).join('\n')}`)
      const text = lines.join('\n')
      for (const agent of ['trace rounding', 'currency conversion', 'scan tax code', 'session cookie']) expect(text).toContain(agent)
      // A stream with work running says so in its header, the moment it runs: never idle beside a running agent.
      expect(text).not.toMatch(/IDLE ·/)
      expect(text).toMatch(/RUNNING .*3 agents/)
      // Every agent carries a solid status badge with its clock.
      expect(text).toMatch(/● RUNNING 0:\d\d .*trace rounding/)
      expect(text).toMatch(/✓ DONE 0:42 .*currency conversion/)
      expect(text).toMatch(/✗ ERROR 0:42 .*scan tax code/)
    })
  }
})

describe('full or compact on each card', () => {
  // In the list, a card's recent rows are often all the person reads of a stream: the switch sits on every card header,
  // beside its fold and ✕, and it is the same choice as a stream's own view (one `chatStyle`, one `v`), so the pane
  // never shows two styles at once. Full draws replies as markdown and tool calls with their code, as the session does.
  const WORK = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: '#billing why is the invoice total off?' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Rounding happens here:\n\n```ts\nMath.round(x)\n```' }] } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/total.ts', old_string: 'Math.round(x)', new_string: 'roundHalfEven(x)' } }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '#auth-refactor move sessions to signed JWTs' } },
  ].map(l => JSON.stringify(l)).join('\n')

  async function filed($: Engine, on: On) {
    const clock = mock.clock(on)
    mock.store(on)
    on('session.cwd', async () => ({ value: '/project' }))
    on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
    on('ui.status', async () => ({ value: undefined }))
    on('ui.toast', async () => ({ value: undefined }))
    on('fs.stat', async () => ({ value: { kind: 'file', size: WORK.length, mtimeMs: 0, isLink: false } }) as never)
    on('fs.read', async () => ({ value: WORK }) as never)
    on('classic.UserPromptSubmit', async () => ({}) as never)
    on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
    // The import may ask how to merge the two prompts' streams: unanswered, each keeps its own tag.
    on('model.complete', async () => ({ value: { isAnswered: false, reason: 'offline' } }) as never)
    await $.classic.UserPromptSubmit({ prompt: 'next', transcript_path: '/t.jsonl' } as never)
    await clock.advance(1500)
  }

  for (const width of [40, 60, 90]) {
    test(`at ${width} columns each header carries ◉ full ○ compact on one line, and the rows follow the choice`, ENGINE, async ($, on) => {
      await filed($, on)
      const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE(width) })
      const dump = async () => draw((await pane.findAll({}))[0] as unknown as Node, width)
      const headers = (lines: string[]) => lines.filter(l => /✕$/.test(l))
      const full = await dump()
      console.log(`\n── ${width} cols, full ──\n${full.map(l => `|${l}`).join('\n')}`)
      // Two cards, each header on one line within the pane, the long name giving way first.
      expect(headers(full)).toHaveLength(2)
      for (const h of headers(full)) {
        expect(h).toMatch(/▾ (all|10|1) ◉ full ○ compact ✕$/)
        expect(h.length).toBeLessThanOrEqual(width)
      }
      // Full: the reply as the session's markdown (its code block whole), the Edit as a diff.
      expect((await pane.findAll({ type: 'Markdown' })).length).toBeGreaterThan(0)
      expect(full.some(l => l.includes('[diff]'))).toBe(true)
      // One `v` in the whole pane, on the choice it switches to.
      const vs = (await pane.findAll({})).filter(n => (n.props as { hotkey?: string } | undefined)?.hotkey === 'v')
      expect(vs.map(n => (n.props as { label?: string }).label)).toEqual(['○ compact'])

      await pane.press({ key: 'style:billing:compact' })
      const compact = await dump()
      console.log(`\n── ${width} cols, compact ──\n${compact.map(l => `|${l}`).join('\n')}`)
      // Every card follows, not just the one pressed: it is one choice.
      for (const h of headers(compact)) expect(h).toMatch(/○ full ◉ compact ✕$/)
      expect(await pane.find({ type: 'Markdown' })).toBe(undefined)
      expect(compact.some(l => l.includes('[diff]'))).toBe(false)
      expect(compact.some(l => /^ {2}. Rounding happens here:/.test(l))).toBe(true)
      for (const l of compact.filter(l => l.startsWith('  ') && !l.includes('✕'))) expect(l.length).toBeLessThanOrEqual(width)
      // And a stream's own view opens in the style chosen in the list.
      await pane.press({ key: 'open:billing' })
      const own = await dump()
      expect(own.some(l => l.includes('○ full ◉ compact'))).toBe(true)
      await pane.unmount()
    })
  }
})
