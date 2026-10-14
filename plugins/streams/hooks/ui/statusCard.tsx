import type { ElementTable, RenderElement } from 'claude-code'

import type { Stream } from '../../types'
import { oneLine } from '../classify'
import { lineText, resetsIn, type LimitView, type StatusLine } from '../status'
import { STATE_COLOR, STATUS_ROWS, limitColor } from './look'

export type Card = {
  streams: readonly Stream[]
  /** Git rows, read as the card opened. */
  git: readonly StatusLine[]
  /** Ticket rows, already cut to the card's share. */
  tickets: readonly StatusLine[]
  streamLines: readonly StatusLine[]
  limits: readonly LimitView[]
  /** Streams Remote's plan, once the service has said it (a connected account only; the free mod has none). */
  account?: { trialEndsAt: number; paidUntil: number; status: string; at: number }
  /** This mod's version, shown small for debugging. */
  version?: string
  width: number
  now: number
}

/** The status card's Streams Remote row: the plan in a few words, and where to go about it; none without an account. */
export function accountRow(a: Card['account'], now: number): { state: string; detail: string; hint: string; isLive: boolean } | undefined {
  if (!a || !a.at) return undefined
  const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  if (a.paidUntil > now) return a.status === 'payment_failed' ? { state: 'payment failed', detail: `paid until ${day(a.paidUntil)}`, hint: '/streams billing', isLive: true } : { state: 'paid', detail: `until ${day(a.paidUntil)}`, hint: '/streams account', isLive: true }
  if (a.trialEndsAt > now) return { state: 'trial', detail: `ends ${day(a.trialEndsAt)}`, hint: '/streams account', isLive: true }
  return { state: 'ended', detail: 'phone off, the free mod keeps working', hint: '/streams billing', isLive: false }
}

/**
 * The status card above the prompt: git, tickets and every stream in the order that needs the person, then
 * the plan limits. Its Area and State columns are fixed, so every row lines up.
 */
export function statusCard(ui: ElementTable, c: Card, act: { close: () => unknown; open: (id: string) => unknown; ticket: (id: string, what: 'continue' | 'close' | 'hide') => unknown }): RenderElement {
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
        {c.version ? <Text dimColor>{`v${c.version}`}</Text> : null}
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
            {/* A ticket is one press from being picked up again or closed in its tracker. */}
            {l.id.startsWith('ticket:') ? (
              <Box key={`st-acts:${l.area}`} flexShrink={0} gap={1} marginLeft={1}>
                <Button key={`ticket-continue:${l.area}`} plain hover={{ bold: true }} label="▶ continue" onPress={() => act.ticket(l.area, 'continue')} />
                <Button key={`ticket-close:${l.area}`} plain hover={{ bold: true }} label="✓ close" onPress={() => act.ticket(l.area, 'close')} />
                <Button key={`ticket-hide:${l.area}`} plain dimColor hover={{ bold: true }} label="✕ hide" onPress={() => act.ticket(l.area, 'hide')} />
              </Box>
            ) : null}
          </Box>,
        ]
      })}
      {lines.length > shown.length ? <Text dimColor>+{lines.length - shown.length} more in the streams pane</Text> : null}
      {lines.length === 0 ? <Text dimColor>Nothing yet: streams appear as you prompt.</Text> : null}
      {(() => {
        const row = accountRow(c.account, now)
        return row ? (
          <Box key="account" marginTop={1}>
            <Box width={areaW} flexShrink={0}>
              <Text dimColor>Streams Remote</Text>
            </Box>
            <Box width={stateW} flexShrink={0}>
              <Text color={row.isLive ? undefined : 'yellow'} bold>
                {row.state}
              </Text>
            </Box>
            <Text>{row.detail}</Text>
            <Text dimColor>{` · ${row.hint}`}</Text>
          </Box>
        ) : null
      })()}
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
              <Text>{l.until !== undefined ? `resets in ${resetsIn(l, now)}` : ''}</Text>
              <Text dimColor>{l.resetsAt ? ` · ${l.resetsAt}` : ''}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {c.version ? (
        <Box key="version" justifyContent="flex-end">
          <Text dimColor>{`streams ${c.version}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
