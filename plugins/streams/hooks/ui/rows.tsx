import type { ElementTable, RenderElement } from 'claude-code'

import type { AgentRun, Stream, StreamRow } from '../../types'
import { clockOf, oneLine, type BadgeKind } from '../classify'
import { loopLines, type Loops } from '../streams/loops'
import { runOf, workflowLines, workflowView, type Workflows } from '../streams/workflows'
import { GLYPH, STATUS_GLYPH, STATUS_WORD, markdownOf } from './look'

/** What the pane's rows are drawn from, read once per draw. */
export type PaneView = {
  ui: ElementTable
  width: number
  now: number
  current: string
  busy: boolean
  turnStartedAt: number
  outcome: Record<string, string>
  agents: Record<string, AgentRun>
  /** Loops still armed: lapsed ones are left out. */
  loops: Loops
  workflows: Workflows
}

/** Status words as bold coloured text: the pane's rows stay one Text per line, the shape known to paint. */
export function badge(v: PaneView, kind: BadgeKind, text: string): RenderElement {
  const { Text } = v.ui
  return (
    <Text color={STATUS_WORD[kind]} bold>
      {text}
    </Text>
  )
}

/**
 * A stream's loop, on lines of its own: when it fires next and why, then how many ticks found nothing and what the
 * last real change was, so a loop that has been quiet for an hour says so instead of looking busy.
 */
export function loopRows(v: PaneView, s: Stream): RenderElement[] {
  const { Text } = v.ui
  const loop = v.loops[s.id]
  if (!loop) return []
  const [head = '', quiet] = loopLines(loop, v.now, v.width)
  return [
    <Text key={`loop:${s.id}`} color={STATUS_WORD.loop} bold wrap="truncate">
      {head}
    </Text>,
    ...(quiet
      ? [
          <Text key={`loop:${s.id}:quiet`} dimColor wrap="truncate">
            {quiet}
          </Text>,
        ]
      : []),
  ]
}

const RUN_COLOR = { running: STATUS_WORD.running, completed: STATUS_WORD.done, failed: STATUS_WORD.error, killed: STATUS_WORD.stalled } as const

/**
 * A stream's Workflow run, its parent row and its phases: status, clock, a progress bar and the agents finished,
 * then each phase with its counts. Failures are red, so a failed agent is seen without opening anything.
 */
export function workflowRows(v: PaneView, s: Stream): RenderElement[] {
  const { Text } = v.ui
  const run = runOf(v.workflows, s.id)
  if (!run) return []
  const view = workflowView(run)
  const [head = '', ...phases] = workflowLines(view, v.now, v.width)
  return [
    <Text key={`run:${s.id}`} color={view.agents.err && view.status === 'running' ? STATUS_WORD.error : RUN_COLOR[view.status]} bold wrap="truncate">
      {head}
    </Text>,
    ...phases.map((line, i) => (
      <Text key={`run:${s.id}:${i}`} {...(line.includes('✗') ? { color: STATUS_WORD.error } : { dimColor: true })} wrap="truncate">
        {line}
      </Text>
    )),
  ]
}

/** The work in a stream, live: its main turn and its subagents, yellow running, green done, red failed. */
export function workOf(v: PaneView, s: Stream, limit: number): (RenderElement | null)[] {
  const { Text } = v.ui
  const { now } = v
  const lines: { key: string; status: AgentRun['status']; label: string; clock: string; last: string }[] = []
  if (s.id === v.current && (v.busy || v.outcome[s.id])) {
    const status = v.busy ? 'running' : v.outcome[s.id] === 'answer' ? 'done' : 'error'
    lines.push({ key: `main:${s.id}`, status, label: 'main turn', clock: v.busy ? clockOf(now - v.turnStartedAt) : '', last: '' })
  }
  const runs = Object.values(v.agents)
    .filter(a => a.streamId === s.id && (a.status === 'running' || now - (a.endedAt ?? a.lastAt) < 600_000))
    .sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.lastAt - a.lastAt)
  for (const a of runs) {
    lines.push({
      key: `agent:${a.id}`,
      status: a.status,
      label: a.description,
      clock: clockOf((a.endedAt ?? now) - a.startedAt),
      last: a.status === 'running' ? (a.tools || a.last !== 'starting' ? `${a.tools} tools · ${a.last}` : 'starting up…') : '',
    })
  }
  return lines.slice(0, limit).flatMap(l => [
    <Text key={l.key} wrap="truncate">
      {'  '}
      {badge(v, l.status, `${STATUS_GLYPH[l.status]} ${l.status.toUpperCase()}${l.clock ? ` ${l.clock}` : ''}`)}
      <Text bold={l.status === 'running'} dimColor={l.status !== 'running'}>
        {'  '}
        {oneLine(l.label, 120)}
      </Text>
    </Text>,
    l.last ? (
      <Text key={`${l.key}:last`} color={STATUS_WORD.running} wrap="truncate">
        {'    ↳ '}
        {oneLine(l.last, v.width - 7)}
      </Text>
    ) : null,
  ])
}

/** One row in the full chat style: prompts and replies as markdown, a tool call with its code beneath. */
export function fullRow(v: PaneView, r: StreamRow, color: string): RenderElement {
  const { Box, Text, Markdown, Code } = v.ui
  const who = r.agentId ? `[${r.agentId.slice(0, 6)}] ` : ''
  // Prompts and replies through the session's own markdown renderer; a tool call as its name
  // and one line, with the command, file or edit beneath in the engine's highlighter.
  if (r.kind === 'prompt' || r.kind === 'reply')
    return (
      <Box key={r.id} flexDirection="row" marginTop={1}>
        <Text bold color={r.kind === 'prompt' ? color : undefined}>
          {r.kind === 'prompt' ? '❯ ' : '⏺ '}
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          {who ? <Text dimColor>{who}</Text> : null}
          <Markdown key={`md:${r.id}`} text={markdownOf(r.text)} />
        </Box>
      </Box>
    )
  if (r.kind === 'tool') {
    const cut = r.text.search(/[( ]/)
    const name = cut < 0 ? r.text : r.text.slice(0, cut)
    const rest = [cut < 0 ? '' : r.text.slice(cut).trim()]
    return (
      <Box key={r.id} flexDirection="column" marginTop={1}>
        <Text wrap="truncate">
          <Text color={STATUS_WORD.done}>⏺ </Text>
          <Text bold>{name}</Text>
          <Text dimColor>
            {rest[0]?.startsWith('(') && !who ? '' : ' '}
            {who}
            {oneLine(rest.join(' '), v.width - name.length - 4)}
          </Text>
        </Text>
        {r.code ? (
          <Box marginLeft={2}>
            <Code
              source={r.code.source}
              {...(r.code.language ? { language: r.code.language } : {})}
              {...(r.code.path ? { path: r.code.path } : {})}
              {...(r.code.format ? { format: r.code.format } : {})}
            />
          </Box>
        ) : null}
      </Box>
    )
  }
  return (
    <Text key={r.id} dimColor wrap="truncate">
      {GLYPH[r.kind]} {who}
      {oneLine(r.text, v.width)}
    </Text>
  )
}
