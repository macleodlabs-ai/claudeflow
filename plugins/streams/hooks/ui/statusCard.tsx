import type { ElementTable, RenderElement } from 'claude-code'

import type { Stream } from '../../types'
import { oneLine } from '../classify'
import { lineText, type LimitView, type StatusLine } from '../status'
import { STATE_COLOR, STATUS_ROWS, limitColor } from './look'

export type Card = {
  streams: readonly Stream[]
  /** Git rows, read as the card opened. */
  git: readonly StatusLine[]
  /** Ticket rows, already cut to the card's share. */
  tickets: readonly StatusLine[]
  streamLines: readonly StatusLine[]
  limits: readonly LimitView[]
  width: number
  now: number
}

/**
 * The status card above the prompt: git, tickets and every stream in the order that needs the person, then
 * the plan limits. Its Area and State columns are fixed, so every row lines up.
 */
export function statusCard(ui: ElementTable, c: Card, act: { close: () => unknown; open: (id: string) => unknown }): RenderElement {
  const { Box, Button, Text } = ui
  const { streams, git, tickets, limits, width, now } = c
  const lines = [...git, ...tickets, ...c.streamLines]
  const shown = lines.slice(0, STATUS_ROWS + tickets.length)
  const areaW = Math.min(24, Math.max(10, ...shown.map(l => l.area.length + 2)))
  // 16: room for a limit's bar and percent (`▰▰▰▰▱▱▱▱▱▱ 38%`).
  const stateW = Math.min(28, Math.max(limits.length ? 16 : 8, ...shown.map(l => l.state.length + 2)))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#8b949e" paddingX={1}>
      <Box key="st-title" gap={1}>
        <Text bold>Status</Text>
        <Text dimColor>
          {streams.filter(s => !s.archived).length} streams · {new Date(now).toTimeString().slice(0, 5)}
        </Text>
        <Text dimColor>· ctrl+x tab, then ↑↓ scroll · q close</Text>
        <Box flexGrow={1} />
        <Button key="status-close" plain dimColor label="✕ close" hotkey="q" onPress={act.close} />
      </Box>
      <Box key="st-head">
        <Box width={areaW} flexShrink={0}>
          <Text dimColor bold>Area</Text>
        </Box>
        <Box width={stateW} flexShrink={0}>
          <Text dimColor bold>State</Text>
        </Box>
        <Text dimColor bold>Detail</Text>
      </Box>
      {shown.flatMap((l, i) => {
        // With tickets on the card, tickets and streams each get a heading; without, the card reads as before.
        const heading =
          tickets.length && (l.id.startsWith('ticket:') ? i === git.length : i === git.length + tickets.length) ? (
            <Box key={`st-h:${l.id}`} marginTop={1}>
              <Text bold color="#d0bfff">{l.id.startsWith('ticket:') ? 'Tickets' : 'Streams'}</Text>
            </Box>
          ) : null
        const isStream = !l.id.startsWith('git:') && !l.id.startsWith('ticket:')
        const s = isStream ? streams.find(x => x.id === l.id) : undefined
        return [
          heading,
          <Box key={`st:${l.id}`}>
            <Box width={areaW} flexShrink={0}>
              {s ? (
                <Button key={`st-open:${l.id}`} plain hover={{ bold: true }} label={oneLine(l.area, areaW - 2)} onPress={() => act.open(l.id)} />
              ) : (
                <Text wrap="truncate">{l.area}</Text>
              )}
            </Box>
            <Box width={stateW} flexShrink={0}>
              <Text wrap="truncate" bold={!!l.kind} color={l.kind ? STATE_COLOR[l.kind] : '#a5d8ff'}>
                {l.state}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="wrap">{oneLine(lineText(l, now), Math.max(20, (width - areaW - stateW) * (l.id.startsWith('ticket:') ? 3 : 2)))}</Text>
            </Box>
          </Box>,
        ]
      })}
      {lines.length > shown.length ? <Text dimColor>+{lines.length - shown.length} more in the streams pane</Text> : null}
      {lines.length === 0 ? <Text dimColor>Nothing yet: streams appear as you prompt.</Text> : null}
      {limits.length ? (
        <Box key="limits" flexDirection="column" marginTop={1}>
          {limits.map(l => (
            <Box key={`limit:${l.label}`}>
              <Box width={areaW} flexShrink={0}>
                <Text dimColor>{`Limit ${l.label}`}</Text>
              </Box>
              <Box width={stateW} flexShrink={0}>
                <Text color={limitColor(l.percent)} bold>
                  {`${l.bar} ${l.percent}%`}
                </Text>
              </Box>
              <Text>{l.resetsIn ? `resets in ${l.resetsIn}` : ''}</Text>
              <Text dimColor>{l.resetsAt ? ` · ${l.resetsAt}` : ''}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
