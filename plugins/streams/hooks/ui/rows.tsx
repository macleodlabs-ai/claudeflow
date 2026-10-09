import type { ElementTable, RenderElement } from 'claude-code'

import type { AgentRun, Stream, StreamRow } from '../../types'
import { clockOf, oneLine, type BadgeKind } from '../classify'
import type { Loops } from '../streams/model'
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

export function loopBadge(v: PaneView, s: Stream): RenderElement | null {
  const loop = v.loops[s.id]
  if (!loop) return null
  return badge(v, 'loop', loop.kind === 'cron' ? `↻ LOOP ${loop.label}` : `↻ LOOP next ${clockOf(Math.max(0, loop.nextAt - v.now))}`)
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
