import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Health, Stream } from '../../types'
import { PANE, PANE_KEY, type PaneSaved } from '../state'
import { BADGE_BG, BADGE_FG, HEALTH_GLYPH, completeTag, partialTag, tagMatches, type BadgeKind } from '../classify'
import { gitStatus } from '../status'
import { cardOf, colorOf, streamsNow, type Facts } from '../streams/model'
import { lapsed } from '../streams/loops'
import { updateControl } from '../updates/control'
import { TICKET_ROWS } from './look'
import { statusCard } from './statusCard'

// The band above the prompt: every stream a colour-coded pill, its colour the heartbeat's verdict; the #tag
// being typed and what it completes to; and the status card.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const verdictsA = atom({ plugin: 'streams', key: 'verdicts' } as const, {})
const tickA = atom({ plugin: 'streams', key: 'tick' } as const, 0)
const tagHintA = atom({ plugin: 'streams', key: 'tagHint' } as const, null)
const statusOpenA = atom({ plugin: 'streams', key: 'statusOpen' } as const, false)
/** Only the word `status` on its own asks for the card. `status?` or any other words are a question for Claude. */
export const STATUS_ASK = /^\s*status\s*$/i

const statusGitA = atom({ plugin: 'streams', key: 'statusGit' } as const, { lines: [], at: 0 })
const paneCollapsedA = atom({ plugin: 'streams', key: 'paneCollapsed' } as const, false)
const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
const updatingA = atom({ plugin: 'streams', key: 'updating' } as const, false)

/** The facts as of now; the tick is read so a drawing redraws while clocks run. */
async function factsOf($: $): Promise<Facts> {
  const [busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts] = await Promise.all([
    read($, busyA),
    read($, currentA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, rowsA),
    read($, loopsA),
    read($, workflowsA),
    read($, verdictsA),
  ])
  await read($, tickA)
  return { busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts, now: await $.clock.now() }
}

async function focusOn($: $, id: string) {
  await update($, focusA, () => id)
  const current = await read($, currentA)
  $.ui.status(id ? `◉ stream ${id}` : current ? `stream ${current}` : undefined)
}

/** Opening a stream shows it in the pane and focuses the transcript on it: one act, as the pane's names do. */
async function openStream($: $, id: string) {
  await update($, viewA, () => id)
  await focusOn($, id)
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
  await $.ui.open({ id: PANE, title: 'Streams' })
}

/** Shows the status card above the prompt, its git rows read now; the stream rows stay live as it shows. */
async function openStatus($: $, band = '') {
  await update($, statusOpenA, () => true)
  // Opened from the bar, the band holds the keys: its ring goes to the card, so ↑↓ scroll it and Esc closes it.
  if (band) void $.ui.focus({ requestId: band, key: 'status-close' }).catch(() => {})
  const lines = await $.process
    .run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 })
    .then(r => (r.exitCode === 0 ? gitStatus(r.stdout) : []))
    .catch(() => [])
  const at = await $.clock.now()
  await update($, statusGitA, () => ({ lines, at }))
}

/** Brings the pane back from the side tab at the width it had (a width the person dragged to wins anyway). */
async function expandPane($: $) {
  const saved = (await $.store.get(PANE_KEY)) as PaneSaved | undefined
  await update($, paneCollapsedA, () => false)
  await $.store.set(PANE_KEY, { collapsed: false, columns: saved?.columns ?? 0 } satisfies PaneSaved)
  await $.ui.open({ id: PANE, title: 'Streams', ...(saved?.columns ? { columns: saved.columns } : {}), focus: true })
}

export function wireBar(on: On) {
  on('command.run', { command: 'streams' }, async ($, e, next) => {
    if (e.args.trim().split(/\s+/)[0] !== 'status') return next(e)
    await openStatus($)
    return { text: 'Status card shown above the prompt.' }
  })

  // Before the prompt is filed: the tag hint goes, and a typed `status` (that word alone) shows the card instead of
  // asking Claude. Every other prompt reaches Claude and puts the card away.
  on('prompt.submit', {}, async ($, e, next) => {
    await update($, tagHintA, () => null)
    if (STATUS_ASK.test(e.text) && e.origin.kind === 'composer') {
      await openStatus($)
      return { drop: 'status shown above the prompt' }
    }
    await update($, statusOpenA, () => false)
    return next(e)
  }).catch(($, e, next) => next(e))

  // `#` at the start of the prompt completes stream names: the bar lists the matches, Tab takes the first,
  // and a tag naming a known stream is painted in that stream's colour.
  on('prompt.edit', async ($, e, next) => {
    const streams = await read($, streamsA)
    const typing = partialTag(e.text, e.cursor)
    if (e.key?.key === 'tab' && !e.key.shift && typing !== undefined) {
      const [first] = tagMatches(streams, typing)
      if (first) {
        await update($, tagHintA, () => null)
        return completeTag(e.text, e.cursor, first)
      }
    }
    const box = await next(e)
    const partial = partialTag(box.text, box.cursor)
    const matches = partial === undefined ? [] : tagMatches(streams, partial)
    await update($, tagHintA, () => (partial === undefined ? null : { partial, matches }))
    const named = /^\s*#([\w-]+)/.exec(box.text)
    const known = named?.[1] && streams.find(s => s.id === named[1])
    if (!named || !known) return box
    const start = box.text.indexOf('#')
    return { ...box, decorations: [...(box.decorations ?? []), { start, end: start + named[0].trim().length, color: colorOf(known), bold: true }] }
  })

  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.element && (await read($, statusOpenA))) await update($, statusOpenA, () => false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [streams, focus, facts] = await Promise.all([read($, streamsA), read($, focusA), factsOf($)])
    const now = streamsNow(facts, streams)
    const { health } = now
    const hint = await read($, tagHintA)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    if (hint && !e.props.hasSurvey) {
      if (hint.matches.length === 0) return <Text dimColor>{`#${hint.partial}  new stream`}</Text>
      return (
        <Box gap={1}>
          <Text dimColor>{`#${hint.partial} →`}</Text>
          {hint.matches.map((id, i) => {
            const s = streams.find(x => x.id === id)
            return (
              <Text key={`tag:${id}`} color={s ? colorOf(s) : undefined} bold={i === 0}>
                {id}
              </Text>
            )
          })}
          <Text dimColor>tab to complete</Text>
        </Box>
      )
    }
    if (!e.props.hasSurvey && (await read($, statusOpenA))) {
      const rows = cardOf(now, { git: (await read($, statusGitA)).lines, rateLimits: (await $.session.usage().catch(() => undefined))?.rateLimits })
      const card = { streams, git: rows.git, tickets: rows.tickets.slice(0, TICKET_ROWS), streamLines: rows.lines, limits: rows.limits, width: e.props.bodyColumns, now: facts.now }
      return statusCard(ui, card, { close: () => update($, statusOpenA, () => false), open: id => openStream($, id) })
    }
    if (e.props.hasSurvey) return next(e)
    const updateButton = updateControl(ui, await read($, updatesA), await read($, updatingA))
    if (!streams.some(s => !s.archived)) return updateButton ?? next(e)
    const width = e.props.bodyColumns
    const pills: { s: Stream; label: string; health: Health }[] = []
    let used = 16
    for (const s of streams.filter(s => !s.archived).sort((a, b) => b.lastAt - a.lastAt).slice(0, 9)) {
      const n = Object.values(facts.agents).filter(a => a.streamId === s.id && a.status === 'running').length
      const label = `${s.id}${n ? ` ⟳${n}` : ''}${focus === s.id ? ' ◉' : ''}`
      if (used + label.length + 8 > width) break
      used += label.length + 8
      pills.push({ s, label, health: health[s.id] ?? 'idle' })
    }
    const pick = (id: string) => openStream($, focus === id ? '' : id)
    const loops = Object.fromEntries(Object.entries(facts.loops).filter(([, l]) => !lapsed(l, facts.now)))
    return (
      <Box gap={1}>
        <Button key="all" plain label={focus ? 'all' : 'all ◉'} hotkey="0" onPress={() => focusOn($, '')} />
        {pills.map((pill, i) => {
          // A pending loop lights its pill like running work: something is going to move there.
          const kind: BadgeKind = loops[pill.s.id] && pill.health !== 'running' && pill.health !== 'error' ? 'loop' : pill.health
          return (
            <Box key={`pill:${pill.s.id}`} gap={0}>
              <Button key={`chip:${pill.s.id}`} plain label={String(i + 1)} hotkey={String(i + 1)} onPress={() => pick(pill.s.id)} />
              <Text backgroundColor={BADGE_BG[kind]} color={BADGE_FG[kind]} bold={kind === 'running' || kind === 'loop'}>
                {' '}
                {kind === 'loop' ? '↻' : HEALTH_GLYPH[pill.health]} {pill.label}{' '}
              </Text>
            </Box>
          )
        })}
        <Button key="status" plain label="status" hotkey="t" onPress={() => openStatus($, e.requestId)} />
        {updateButton}
        {(await read($, paneCollapsedA)) ? (
          <Box key="tab-box" flexGrow={1} justifyContent="flex-end">
            <Button key="tab" label="◂ streams" hotkey="s" onPress={() => expandPane($)} />
          </Box>
        ) : (
          <Button key="pane" plain label="≡" hotkey="s" onPress={() => expandPane($)} />
        )}
        {pills.length === 0 ? <Text dimColor>widen the terminal to see streams</Text> : null}
      </Box>
    )
  })
}
