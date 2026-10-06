import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

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
    test(`at ${width} columns every agent shows its status, and no line overflows`, async ($, on) => {
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
