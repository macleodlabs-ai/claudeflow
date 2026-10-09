import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { AgentRun, Folded, Stream, StreamRow } from '../../types'
import { MAX_ROWS, SAVED_ROWS, jobs, mem, storeKey, type Saved } from '../state'
import { oneLine, rowKey, textKey } from '../classify'
import { itemsOf, rowOf } from '../history'
import { touched, type LoopArgs, type Loops } from './model'

// Files what the session does, as it happens, in the stream it belongs to: each transcript row, each
// subagent and its end, each turn and its outcome, each loop armed or stopped.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const foldedA = atom({ plugin: 'streams', key: 'folded' } as const, [])
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const agentStreamA = atom({ plugin: 'streams', key: 'agentStream' } as const, {})
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const turnStartedAtA = atom({ plugin: 'streams', key: 'turnStartedAt' } as const, 0)
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const ROW = { plugin: 'streams', key: 'rowStream' } as const

/** Files a transcript row (by uuid, tool_use_id or text key) under a stream. */
const fileAs = ($: $, id: string, sid: string) => $.state.set({ ...ROW, id: rowKey(id) }, sid)

async function touch($: $, id: string, patch?: (s: Stream) => Partial<Stream>) {
  const now = await $.clock.now()
  await update($, streamsA, touched(id, now, patch))
}

async function save($: $) {
  const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
  await $.store.set(storeKey(cwd), { streams, rows: rows.slice(-SAVED_ROWS), loopStream } satisfies Saved)
}

async function inStream($: $, agentId: string | undefined): Promise<string> {
  if (agentId) {
    const map = await read($, agentStreamA)
    if (map[agentId]) return map[agentId]
  }
  return read($, currentA)
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown }

type AppendedRow = {
  message: { type: string; role?: string; isMeta?: true; content: readonly unknown[] }
  agentId?: string
}

async function record($: $, e: AppendedRow, uuid: string) {
  const msg = e.message
  if (msg.type === 'attachment') {
    // A prompt sent mid-turn is stored as this row: link it to the stream prompt.submit filed it in.
    const prompt = (msg.content as readonly Block[]).find(b => b.type === 'text')?.text ?? ''
    const hit = (await read($, foldedA)).findLast(f => prompt.includes(f.text) || f.text.includes(prompt.trim()))
    // Matched to the prompt it carries; any other attachment wears the current stream's line.
    await fileAs($, uuid, hit && prompt.trim() ? hit.streamId : await inStream($, e.agentId))
    return
  }
  if (msg.isMeta) {
    // Notices, reminders and deliveries are not activity, but they sit in the stream's part of the transcript.
    const sid = await inStream($, e.agentId)
    if (sid) await fileAs($, uuid, sid)
    return
  }
  let sid: string
  let folded: readonly Folded[] = []
  if (e.agentId) {
    const map = await read($, agentStreamA)
    sid = map[e.agentId] ?? (mem.pendingSpawn || (await read($, currentA)))
    if (!map[e.agentId] && sid) await update($, agentStreamA, m => ({ ...m, [e.agentId as string]: sid }))
  } else {
    sid = await read($, currentA)
    if (msg.role === 'assistant') folded = await read($, foldedA)
  }
  if (!sid) return
  const marks: Promise<unknown>[] = [fileAs($, uuid, sid)]
  const now = await $.clock.now()
  // The same rows the history import makes of this message (history.ts, `itemsOf` and `rowOf`).
  const rows: StreamRow[] = itemsOf(uuid, msg).map(item => {
    const row: StreamRow = { ...rowOf(item, sid, now), agentId: e.agentId }
    if (item.kind === 'tool') marks.push(fileAs($, item.id, sid))
    if (item.kind === 'reply') {
      marks.push(fileAs($, textKey(item.text), sid))
      // Filed under the turn now; the worker moves it if it answers a prompt sent mid-turn.
      if (folded.length > 0) jobs.push({ kind: 'route', uuid, rowId: row.id, text: item.text, turnSid: sid, folded })
    }
    // A main-loop prompt is filed as what routing took it for: a prompt, a loop's tick or a notice.
    return item.kind === 'prompt' && !e.agentId ? { ...row, kind: mem.pendingKind } : row
  })
  await Promise.all(marks)
  if (rows.length === 0) return
  const agentId = e.agentId
  const latest = rows.at(-1)
  if (agentId && latest) {
    const tools = rows.filter(r => r.kind === 'tool').length
    await update($, agentsA, m =>
      m[agentId] ? { ...m, [agentId]: { ...m[agentId], lastAt: now, last: oneLine(latest.text, 120), tools: m[agentId].tools + tools } } : m,
    )
  }
  await update($, rowsA, list => [...list, ...rows].slice(-MAX_ROWS))
  await touch($, sid, s => ({ rows: s.rows + rows.length }))
}

/** A self-paced wakeup or a cron job arms a loop in its stream; stopping or deleting it disarms it. */
async function noteLoop($: $, sid: string, tool: string, args: LoopArgs) {
  if (tool === 'ScheduleWakeup') {
    // A session has one self-paced loop: stopping it clears it whichever stream it was filed under, and
    // re-arming it from another stream moves it there.
    const others = (m: Loops): Loops => Object.fromEntries(Object.entries(m).filter(([, l]) => l.kind !== 'wakeup'))
    if (args.stop) return update($, loopsA, others)
    const nextAt = (await $.clock.now()) + (args.delaySeconds ?? 60) * 1000
    return update($, loopsA, m => ({ ...others(m), [sid]: { kind: 'wakeup' as const, nextAt, label: args.reason ?? '' } }))
  }
  if (tool === 'CronCreate') return update($, loopsA, m => ({ ...m, [sid]: { kind: 'cron' as const, nextAt: 0, label: args.cron ?? '' } }))
  if (tool === 'CronDelete') return update($, loopsA, ({ [sid]: _, ...rest }) => rest)
}

export function wireFiling(on: On) {
  on('agent.spawn', async ($, e, next) => {
    const map = await read($, agentStreamA)
    const sid = (e.parentAgentId && map[e.parentAgentId]) || (await read($, currentA))
    mem.pendingSpawn = sid
    const r = await next(e)
    // The agent has started: a failure here must not fail the hook (a .catch would spawn it twice).
    if (r.agentId && sid) {
      const agentId = r.agentId
      const now = await $.clock.now()
      const run: AgentRun = { id: agentId, streamId: sid, description: e.description || e.subagentType, status: 'running', startedAt: now, lastAt: now, last: 'starting', tools: 0 }
      await update($, agentStreamA, m => ({ ...m, [agentId]: sid }))
        .then(() => update($, agentsA, m => ({ ...m, [agentId]: run })))
        .then(() => touch($, sid, s => ({ agents: s.agents + 1 })))
        .catch(err => $.ui.log(`streams: could not file an agent: ${String(err)}`))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const sid = await inStream($, e.agentId)
    if (sid) await noteLoop($, sid, String(e.tool), e as unknown as LoopArgs).catch(() => {})
    const bump = (d: number) => (sid ? update($, inflightA, m => ({ ...m, [sid]: Math.max(0, (m[sid] ?? 0) + d) })) : Promise.resolve())
    await bump(1)
    try {
      return await next(e)
    } finally {
      await bump(-1).catch(() => {})
    }
  })

  on('session.append', async ($, e, next) => {
    const r = await next(e)
    // The row is stored by now: a failure here must not fail the hook (a .catch would append it twice).
    await record($, e, e.uuid).catch(err => $.ui.log(`streams: could not file a row: ${String(err)}`))
    return r
  })

  on('turn.start', async ($, e, next) => {
    mem.runningTurn = e.turnId
    await update($, busyA, () => true)
    const startedAt = await $.clock.now()
    await update($, turnStartedAtA, () => startedAt)
    const sid = await read($, currentA)
    if (sid) await update($, outcomeA, ({ [sid]: _, ...rest }) => rest)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.turnId === mem.runningTurn) mem.runningTurn = ''
    // A subagent's run is one turn of its loop: its end is the agent's end.
    const agentId = e.agentId
    if (agentId) {
      const endedAt = await $.clock.now()
      const status: AgentRun['status'] = e.reason === 'answer' ? 'done' : 'error'
      await update($, agentsA, m => (m[agentId] ? { ...m, [agentId]: { ...m[agentId], status, endedAt } } : m))
    }
    if (!e.agentId) {
      await update($, foldedA, () => [])
      const sid = await read($, currentA)
      if (sid) await update($, outcomeA, m => ({ ...m, [sid]: e.reason }))
      await update($, busyA, () => false)
      await save($)
    }
    return r
  })
}
