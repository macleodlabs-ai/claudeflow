import { atom, read } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import { noteMatched, noteUnmatched } from '../state'
import { oneLine, pastelOf, rowKey, textKey } from '../classify'

// The session's own transcript rows, each behind a strip of its stream's colour; with a stream focused,
// other streams' rows shrink to a stub.

type $ = EngineInterface

const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const ROW = { plugin: 'streams', key: 'rowStream' } as const
const COLOR = { plugin: 'streams', key: 'streamColor' } as const

export function wireTranscript(on: On) {
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const sid = await streamOf($, e.requestId)
    if (sid) noteMatched('UserMessage', e.requestId)
    else noteUnmatched('UserMessage', e.requestId, e.props.text)
    if (!e.props.isExpanded && (await isHidden($, sid))) return stripe($, e, sid, stub($, e, sid, oneLine(e.props.text, 70)))
    return stripe($, e, sid, await next(e))
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const sid = (await streamOf($, e.requestId)) || (await streamOf($, textKey(e.props.text)))
    if (sid) noteMatched('AssistantMessage', e.requestId)
    else noteUnmatched('AssistantMessage', e.requestId, e.props.text)
    if (await isHidden($, sid)) return stripe($, e, sid, stub($, e, sid, oneLine(e.props.text, 70)))
    return stripe($, e, sid, await next(e))
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const first = e.props.calls.find(c => c.tool_use_id)?.tool_use_id
    const sid = first ? await streamOf($, first) : ''
    if (!e.props.isExpanded && (await isHidden($, sid))) return stripe($, e, sid, stub($, e, sid, `${e.props.calls.length} tool calls`))
    return stripe($, e, sid, await next(e))
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const sid = await streamOf($, e.props.tool_use_id)
    if (await isHidden($, sid)) return stripe($, e, sid, stub($, e, sid, e.props.tool))
    return stripe($, e, sid, await next(e))
  })
}

/** The stream a transcript row was filed in; '' when it was not. */
async function streamOf($: $, id: string): Promise<string> {
  const { value } = await $.state.get({ ...ROW, id: rowKey(id) })
  return value ?? ''
}

/** Whether focus on another stream shrinks this row to a stub. */
async function isHidden($: $, sid: string): Promise<boolean> {
  if (!sid) return false
  const focus = await read($, focusA)
  return focus !== '' && focus !== sid
}

const BAR = Array.from({ length: 400 }, () => '▏').join('\n')

type RowRender = Parameters<$["ui"]["resolve"]>[0]

/** The row as drawn, behind a one-cell strip of its stream's colour. Unfiled rows are left as they are. */
async function stripe($: $, e: RowRender, sid: string, tree: RenderElement): Promise<RenderElement> {
  if (!sid) return tree
  const { value } = await $.state.get({ ...COLOR, id: sid })
  const { Box } = $.ui.resolve(e)
  const { Text } = $.ui.resolve(e)
  // A thin glyph column laid over the row's left edge: absolute, so it takes the row's height and adds none.
  return (
    <Box flexDirection="row">
      <Box position="absolute" top={0} bottom={0} left={0} width={1} overflow="hidden" flexDirection="column">
        <Text color={value ?? pastelOf(sid)}>{BAR}</Text>
      </Box>
      <Box marginLeft={2} flexGrow={1} flexShrink={1} flexDirection="column">
        {tree}
      </Box>
    </Box>
  )
}

function stub($: $, e: RowRender, streamId: string, gist: string): RenderElement {
  const { Text } = $.ui.resolve(e)
  return (
    <Text dimColor wrap="truncate">
      ▸ [{streamId}] {gist}
    </Text>
  )
}
