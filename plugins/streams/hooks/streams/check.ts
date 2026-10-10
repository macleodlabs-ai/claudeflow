import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { CHECK_RETRY_MS, COMPLETION_SYSTEM, checkPrompt, parseCheck, suspectsOf } from './completion'
import { streamsNow } from './model'

// The completion check, the engine half (the `completionCheck` setting): streams that show WAITING or stalled are
// sent to Haiku in one call, at moments that suit (the session starting, a turn ending while the session is idle,
// the status card opening) and for any that has shown so for CHECK_STALE_MS. What the answer means is completion.ts.
// A model call cannot run in the hook that wants it (the engine cuts a dispatch's calls once its hook returns), so
// the hooks only say it is wanted and this module's own timer makes the call.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const verdictsA = atom({ plugin: 'streams', key: 'verdicts' } as const, {})
const statusOpenA = atom({ plugin: 'streams', key: 'statusOpen' } as const, false)

/** How often the check looks for work: cheap reads, and a model call only when a stream needs one. */
export const CHECK_TICK_MS = 5000

/** A quiet moment asked for a check (session start, a turn ended); the next idle tick makes it. */
let isWanted = false
/** The status card was up at the last tick: its opening is a moment too. */
let wasOpen = false
let isChecking = false
let isStarted = false
/** After a failed call, no other before this time. */
let retryAt = 0

/**
 * One look: the streams that show WAITING or stalled with no verdict for their last row, all of them at a moment, else
 * only those stuck CHECK_STALE_MS; then one call for all of them. Nothing to ask, no call. A failed or unreadable
 * answer changes nothing and waits CHECK_RETRY_MS.
 */
async function checkTick($: $) {
  if (isChecking) return
  const now = await $.clock.now()
  if (now < retryAt) return
  const [streams, busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts, isOpen] = await Promise.all([
    read($, streamsA),
    read($, busyA),
    read($, currentA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, rowsA),
    read($, loopsA),
    read($, workflowsA),
    read($, verdictsA),
    read($, statusOpenA),
  ])
  const isOpened = isOpen && !wasOpen
  wasOpen = isOpen
  const isMoment = isOpened || (isWanted && !busy)
  if (isMoment) isWanted = false
  // As the streams show before any verdict: what would say WAITING or stalled.
  const raw = streamsNow({ busy, current, agents, inflight, outcome, rows, loops, workflows, verdicts: {}, now }, streams)
  const waiting = new Set(raw.lines.filter(l => l.kind === 'waiting').map(l => l.id))
  const suspects = suspectsOf({ streams, rows, waiting, health: raw.health, verdicts, now, isStaleOnly: !isMoment })
  if (!suspects.length) return
  isChecking = true
  try {
    const r = await $.model.complete({ model: 'haiku', system: COMPLETION_SYSTEM, prompt: checkPrompt(suspects), maxTokens: 80 + 60 * suspects.length, timeoutMs: 30_000 })
    const got = r.isAnswered ? parseCheck(r.text, suspects, await $.clock.now()) : {}
    if (Object.keys(got).length) await update($, verdictsA, m => ({ ...m, ...got }))
    if (suspects.some(s => !got[s.id])) retryAt = now + CHECK_RETRY_MS
  } catch {
    retryAt = now + CHECK_RETRY_MS
  } finally {
    isChecking = false
  }
}

export function wireCheck(on: On, opts: { isOn: boolean }) {
  if (!opts.isOn) return

  on('session.start', {}, async ($, e, next) => {
    isWanted = true
    if (!isStarted) {
      isStarted = true
      $.clock.every(CHECK_TICK_MS, () => void checkTick($).catch(() => {}))
    }
    return next(e)
  })

  // A turn that ends is when a reply's closing question appears: check once the session is idle.
  on('turn.complete', {}, async ($, e, next) => {
    isWanted = true
    return next(e)
  })
}
