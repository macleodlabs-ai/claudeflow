import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { ChatStyle, Stream } from '../../types'
import { PANE, PANE_KEY, SAVED_ROWS, mem, storeKey, type PaneSaved, type Saved } from '../state'
import { FOLD_LABEL, HEALTH_GLYPH, HEALTH_TEXT, NEXT_FOLD, ago, oneLine, type Fold } from '../classify'
import { colorOf, streamsNow, type Facts } from '../streams/model'
import { foldQuiet, lapsed } from '../streams/loops'
import { updateControl } from '../updates/control'
import { FULL_ROWS, GLYPH, STATUS_WORD } from './look'
import { badge, fullRow, loopRows, workOf, workflowRows, type PaneView } from './rows'

// The navigator pane: every stream as a card with its live work and latest rows, or one stream in full.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const verdictsA = atom({ plugin: 'streams', key: 'verdicts' } as const, {})
const tickA = atom({ plugin: 'streams', key: 'tick' } as const, 0)
const foldA = atom({ plugin: 'streams', key: 'fold' } as const, {})
const showArchivedA = atom({ plugin: 'streams', key: 'showArchived' } as const, false)
const turnStartedAtA = atom({ plugin: 'streams', key: 'turnStartedAt' } as const, 0)
const chatStyleA = atom({ plugin: 'streams', key: 'chatStyle' } as const, '')
const importProgressA = atom({ plugin: 'streams', key: 'importProgress' } as const, { label: '', done: 0, total: 0 })
const paneCollapsedA = atom({ plugin: 'streams', key: 'paneCollapsed' } as const, false)
const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
const updatingA = atom({ plugin: 'streams', key: 'updating' } as const, false)

type PaneRender = Parameters<$['ui']['resolve']>[0] & {
  props: { bodyColumns: number; placement: string; scroll?: { offset: number; bodyRows: number } }
}

/** Times the pane's draw and keeps what it drew, or what it threw, for the diagnostics file. */
async function timedPane($: $, e: PaneRender, draw: () => Promise<RenderElement>): Promise<RenderElement> {
  const began = Date.now()
  const view = await read($, viewA)
  try {
    const tree = await draw()
    const drawn = JSON.stringify(tree)
    // An upper bound on the rows drawn: every Text and Button is at most a row.
    const rows = (drawn.match(/"type":"(Text|Button)"/g) ?? []).length
    if (e.props.placement === 'dock') mem.dockColumns = e.props.bodyColumns
    mem.lastPane = { at: began, ms: Date.now() - began, view, columns: e.props.bodyColumns, placement: e.props.placement, surface: e.surface, size: drawn.length, rows, scroll: e.props.scroll }
    return tree
  } catch (err) {
    mem.lastPane = { at: began, ms: Date.now() - began, view, columns: e.props.bodyColumns, error: `${String(err)} ${(err as Error)?.stack ?? ''}`.slice(0, 600) }
    throw err
  }
}

/** Folds the docked pane away to a tab at the bar's right end, keeping its width for when it comes back. */
async function collapsePane($: $) {
  await $.store.set(PANE_KEY, { collapsed: true, columns: mem.dockColumns } satisfies PaneSaved)
  await update($, paneCollapsedA, () => true)
  await $.ui.close({ id: PANE })
}

async function focusOn($: $, id: string) {
  await update($, focusA, () => id)
}

/** Opening a stream shows it in the pane and focuses the transcript on it: one act, as the bar's pills do. */
async function openStream($: $, id: string) {
  await update($, viewA, () => id)
  await focusOn($, id)
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
}

async function setArchived($: $, id: string, archived: boolean) {
  // Restored by the person: auto-archive leaves it until it has been active again (streams/archive.ts).
  const now = await $.clock.now()
  await update($, streamsA, list => list.map(s => (s.id === id ? { ...s, archived, ...(archived ? {} : { restoredAt: now }) } : s)))
  if (archived) {
    if ((await read($, focusA)) === id) await focusOn($, '')
    if ((await read($, viewA)) === id) await update($, viewA, () => '')
  }
  const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
  await $.store.set(storeKey(cwd), { streams, rows: rows.slice(-SAVED_ROWS), loopStream } satisfies Saved)
}

/** The facts as of now; the tick is read so the pane redraws while clocks run. */
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

export function wirePane(on: On) {
  // `/streams` alone opens the pane; its subcommands are answered by the modules that own them, wired first.
  on('command.run', { command: 'streams' }, async $ => {
    await update($, paneCollapsedA, () => false)
    const opened = await $.ui.open({ id: PANE, title: 'Streams', focus: true })
    await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
    const surfaces = await $.session.surfaces().catch(() => [] as const)
    const where = `Attached: ${surfaces.join(', ') || 'none reported'}. Pane ${opened.isPlaced ? 'drawn' : `waiting: ${opened.reason}`}.`
    return { text: `Streams navigator opened. ${where} \`/streams import\` files a past session of this project into streams.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    timedPane($, e, async () => {
      const ui = $.ui.resolve(e)
      const { Box, Text, Button } = ui
      const [streams, view, focus, showArchived, fold, turnStartedAt, filing, facts] = await Promise.all([
        read($, streamsA),
        read($, viewA),
        read($, focusA),
        read($, showArchivedA),
        read($, foldA),
        read($, turnStartedAtA),
        read($, importProgressA),
        factsOf($),
      ])
      const { now, rows } = facts
      const { health } = streamsNow(facts, streams)
      const loops = Object.fromEntries(Object.entries(facts.loops).filter(([, l]) => !lapsed(l, now)))
      const width = Math.max(20, e.props.bodyColumns)
      const room = Math.max(3, (e.viewport?.rows ?? 30) - 8)
      const shown = streams.find(s => s.id === view)
      const v: PaneView = { ui, width, now, current: facts.current, busy: facts.busy, turnStartedAt, outcome: facts.outcome, agents: facts.agents, loops, workflows: facts.workflows }
      const updates = updateControl(ui, await read($, updatesA), await read($, updatingA))
      // Docked beside the transcript, the pane folds away to a tab in the bar and comes back at its width.
      const hideButton = e.props.placement === 'dock' ? <Button key="collapse" plain dimColor label="⇥ hide" hotkey="h" onPress={() => collapsePane($)} /> : null
      const style: ChatStyle = (await read($, chatStyleA)) || mem.defaultStyle
      const nextStyle: ChatStyle = style === 'full' ? 'compact' : 'full'
      // Both choices always drawn, the current one lit; `v` switches to the other (one button carries it, so the
      // hotkey is the pane's once, as in a stream's own view). The list and a stream's view share the one style.
      const styleButtons = (keyOf: (st: ChatStyle) => string, hasHotkey: boolean) =>
        (['full', 'compact'] as const).map(st => (
          <Button
            key={keyOf(st)}
            plain
            dimColor={st !== style}
            label={`${st === style ? '◉' : '○'} ${st}`}
            {...(hasHotkey && st === nextStyle ? { hotkey: 'v' } : {})}
            onPress={() => update($, chatStyleA, () => st)}
          />
        ))
      const archiveButton = (s: Stream) =>
        s.archived ? (
          <Button key={`restore:${s.id}`} plain dimColor label="restore" onPress={() => setArchived($, s.id, false)} />
        ) : (
          <Button key={`archive:${s.id}`} plain dimColor label="✕" onPress={() => setArchived($, s.id, true)} />
        )

      if (shown) {
        const verdict = health[shown.id] ?? 'idle'
        const activity = workOf(v, shown, 8)
        // Full rows run several lines each, so fewer of them fit; the pane scrolls for the rest.
        const own = foldQuiet(rows.filter(r => r.streamId === shown.id)).slice(style === 'full' ? -FULL_ROWS : -Math.max(3, room - activity.length * 2))
        return (
          <Box flexDirection="column">
            <Box gap={2}>
              <Button key="back" plain label="← all streams" onPress={() => openStream($, '')} />
              {hideButton}
            </Box>
            <Box gap={1} marginTop={1}>
              <Text color={HEALTH_TEXT[verdict]}>{HEALTH_GLYPH[verdict]}</Text>
              <Text bold color={colorOf(shown)}>
                {shown.name}
              </Text>
              <Text dimColor>│ view</Text>
              {styleButtons(st => `style:${st}`, true)}
              {archiveButton(shown)}
            </Box>
            <Text wrap="truncate">{badge(v, verdict, verdict.toUpperCase())}</Text>
            {loopRows(v, shown)}
            {workflowRows(v, shown)}
            <Text dimColor wrap="truncate">{oneLine(shown.summary, width) || ' '}</Text>
            {activity}
            {own.length === 0 && <Text dimColor>Nothing recorded yet.</Text>}
            {style === 'compact' &&
              own.map(r => (
                <Text key={r.id} dimColor={r.kind === 'tool' || r.kind === 'notice'} wrap="truncate">
                  {GLYPH[r.kind]} {r.agentId ? `[${r.agentId.slice(0, 6)}] ` : ''}
                  {oneLine(r.text, width)}
                </Text>
              ))}
            {style === 'full' && own.map(r => fullRow(v, r, colorOf(shown)))}
          </Box>
        )
      }

      const byRecent = [...streams].sort((a, b) => b.lastAt - a.lastAt)
      const active = byRecent.filter(s => !s.archived)
      const archived = byRecent.filter(s => s.archived)
      // Folded by hand wins; otherwise an idle stream shows its header alone and the rest share the pane.
      const foldOf = (s: Stream): Fold => fold[s.id] ?? ((health[s.id] ?? 'idle') === 'idle' ? 'none' : 'all')
      const open = active.filter(s => foldOf(s) === 'all').length
      const perStream = Math.max(2, Math.floor(room / Math.max(1, open)) - 3)
      const card = (s: Stream, isArchived: boolean) => {
        const verdict = health[s.id] ?? 'idle'
        const f: Fold = isArchived ? 'none' : foldOf(s)
        const count = f === 'all' ? perStream : f === '10' ? 10 : f === '1' ? 1 : 0
        const recent = count ? foldQuiet(rows.filter(row => row.streamId === s.id)).slice(-count) : []
        return (
          <Box key={s.id} flexDirection="column" marginTop={1}>
            <Box gap={1}>
              <Text backgroundColor={isArchived ? undefined : colorOf(s)}> </Text>
              <Text color={isArchived ? undefined : HEALTH_TEXT[verdict]} dimColor={isArchived}>
                {HEALTH_GLYPH[verdict]}
              </Text>
              <Button
                key={`open:${s.id}`}
                plain
                dimColor={isArchived}
                hover={{ color: colorOf(s), bold: true }}
                // The header keeps one line at any width: fold, full/compact and ✕ take 24 columns plus the fold label,
                // and the name gives way first.
                label={isArchived ? `${s.name}${focus === s.id ? ' ◉' : ''}` : oneLine(`${s.name}${focus === s.id ? ' ◉' : ''}`, Math.max(6, width - 24 - FOLD_LABEL[f].length))}
                onPress={() => openStream($, s.id)}
              />
              {isArchived ? null : (
                <Button key={`fold:${s.id}`} plain dimColor label={FOLD_LABEL[f]} onPress={() => update($, foldA, m => ({ ...m, [s.id]: NEXT_FOLD[f] }))} />
              )}
              {isArchived ? null : styleButtons(st => `style:${s.id}:${st}`, s.id === active[0]?.id)}
              {archiveButton(s)}
            </Box>
            <Text wrap="truncate">
              {isArchived ? <Text dimColor>{verdict}</Text> : badge(v, verdict, verdict.toUpperCase())}
              <Text dimColor>
                {' '}
                · {s.rows} rows · {s.agents} agents · {ago(now - s.lastAt)} ago
              </Text>
            </Text>
            {isArchived ? null : loopRows(v, s)}
            {isArchived ? null : workflowRows(v, s)}
            {f === 'none' ? null : (
              <Box flexDirection="column">
                {s.summary ? <Text dimColor wrap="truncate">{oneLine(s.summary, width)}</Text> : null}
                {workOf(v, s, f === '1' ? 2 : 5)}
                {style === 'full'
                  ? recent.map(row => fullRow(v, row, colorOf(s)))
                  : recent.map(row => (
                      <Text key={row.id} color={row.kind === 'prompt' ? colorOf(s) : undefined} dimColor={row.kind !== 'prompt'} wrap="truncate">
                        {'  '}
                        {GLYPH[row.kind]} {oneLine(row.text, width - 4)}
                      </Text>
                    ))}
              </Box>
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          {filing.total > 0 ? (
            <Text color={STATUS_WORD.running} bold wrap="truncate">
              ⟳ filing history: {filing.label}
              {filing.total > 1 ? ` ${filing.done}/${filing.total}` : '…'}
            </Text>
          ) : null}
          {updates}
          <Box gap={1}>
            <Text dimColor>
              {active.length} streams · {focus ? `focused on ${focus}` : 'showing all'}
            </Text>
            {focus ? <Button key="unfocus" plain dimColor label="show all" onPress={() => focusOn($, '')} /> : null}
            {hideButton}
          </Box>
          <Box gap={1}>
            <Button key="fold-all" plain dimColor label="collapse all" onPress={() => update($, foldA, () => Object.fromEntries(active.map(s => [s.id, 'none' as const])))} />
            <Button key="unfold-all" plain dimColor label="expand all" onPress={() => update($, foldA, () => Object.fromEntries(active.map(s => [s.id, 'all' as const])))} />
          </Box>
          {active.length === 0 && <Text dimColor>Streams appear as you prompt. Tag one by hand with #name.</Text>}
          {active.map(s => card(s, false))}
          {archived.length > 0 ? (
            <Box marginTop={1}>
              <Button
                key="archived"
                plain
                dimColor
                label={`${showArchived ? '▾' : '▸'} archived (${archived.length})`}
                onPress={() => update($, showArchivedA, was => !was)}
              />
            </Box>
          ) : null}
          {showArchived ? archived.map(s => card(s, true)) : null}
        </Box>
      )
    }),
  )
}
