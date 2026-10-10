import type { Snapshot } from './snapshot'

// When a session asks the relay to wake a phone by Web Push (ARCHITECTURE.md, "Notifications"). Pure: it compares
// each snapshot with what it saw before and names a kind, never any text, so the relay and the push service learn
// only that something happened. It spots news and skips devices that are looking; how often a device may be woken
// is the relay's alone (relay/cloudflare/src/push.ts `mayPush`), since only the relay sees every session.

/** Also in relay/cloudflare/src/push.ts and app/src/push.ts (separate packages): change all three together. */
export type NotifyKind = 'needs-you' | 'done' | 'failed'
/** The plaintext hint in the session's `up` body: which devices to wake, and why in one word. */
export type Hint = { notify: string[]; kind: NotifyKind }

/** A loop's tick is news only after this many quiet ticks in a row: a loop that changes every tick is not. */
export const QUIET_STREAK = 3
/**
 * A question is worth a buzz only once it has waited this long. Most replies that end in "?" are answered at the
 * Mac within a minute, and a phone buzzing for a person typing at the Mac is noise. Held permissions are not
 * delayed: a prompt is held for the phone only while a device is looking, so it buzzes nobody but a second device.
 */
export const QUESTION_GRACE_MS = 2 * 60_000

/** What a snapshot shows, as far as waking someone goes. */
type Seen = {
  permissions: Set<string>
  /** `stream id|question`: a new question in the same stream is new. */
  questions: Set<string>
  /** Workflow status by task id. */
  runs: Map<string, string>
  /** Each failure shown, by what it is, never by how many (`failuresOf`). */
  failures: Set<string>
  /** Each armed loop's quiet streak and when it last changed something. */
  loops: Map<string, { streak: number; changedAt: number }>
}

/**
 * Every failure a snapshot shows, named so the same failure keeps its name: a subagent that errored, a run's
 * errored agents (one name per count), a stream in error since a time. Named, not counted: a count drops when an
 * old failure leaves the cards after ten minutes, and the next failure would then pass for the first one again.
 */
function failuresOf(s: Snapshot): Set<string> {
  const out = new Set<string>()
  for (const st of s.streams) {
    for (const a of st.agents) if (a.status === 'error') out.add(`agent:${a.id}`)
    if (st.kind === 'error') out.add(`stream:${st.id}:${st.since ?? ''}`)
    const wf = st.workflow
    if (wf) for (let i = 1; i <= wf.agents.err; i++) out.add(`run:${wf.taskId}:${i}`)
  }
  return out
}

const seenOf = (s: Snapshot): Seen => ({
  permissions: new Set(s.permissions.map(p => p.id)),
  questions: new Set(s.streams.flatMap(st => (st.kind === 'waiting' ? [`${st.id}|${st.question ?? st.detail}`] : []))),
  runs: new Map(s.streams.flatMap(st => (st.workflow ? [[st.workflow.taskId, st.workflow.status] as const] : []))),
  failures: failuresOf(s),
  loops: new Map(s.streams.flatMap(st => (st.loop ? [[st.id, { streak: st.loop.noopStreak, changedAt: st.loop.lastChange?.at ?? 0 }] as const] : []))),
})

/**
 * The news besides questions, the most pressing kind first: a new held permission needs you; a run that failed or
 * was killed, or a failure never shown before, failed; a run that finished, or a loop's real change after a quiet
 * streak, is done. A loop that stops is no news: it is mostly the person or the model ending it on purpose.
 */
function newsOf(was: Seen, now: Seen, failed: ReadonlySet<string>): NotifyKind | undefined {
  if ([...now.permissions].some(id => !was.permissions.has(id))) return 'needs-you'
  const ended = [...now.runs].filter(([id, st]) => st !== 'running' && was.runs.get(id) === 'running').map(([, st]) => st)
  if (ended.some(st => st !== 'completed') || [...now.failures].some(f => !failed.has(f))) return 'failed'
  if (ended.length) return 'done'
  for (const [id, l] of was.loops) {
    const next = now.loops.get(id)
    if (next && l.streak >= QUIET_STREAK && next.changedAt > l.changedAt) return 'done'
  }
  return undefined
}

/**
 * One session's notifier. `hint` sees every snapshot the session makes: the first is only remembered (a session
 * that starts is no news), each later one is compared with what came before. A question becomes news once it has
 * waited `QUESTION_GRACE_MS` unanswered: decided here on the session's clock, never written into the snapshot, so
 * time passing changes no snapshot. A hint names the paired devices not looking now.
 */
export function createNotifier() {
  let seen: Seen | undefined
  /** Questions waiting now, by key: when each was first seen, and whether it was news already. */
  const asked = new Map<string, { at: number; told: boolean }>()
  /** Every failure shown this session, so each is news once. */
  const failed = new Set<string>()
  return {
    hint(s: Snapshot, devices: readonly string[], isLooking: (id: string) => boolean, now: number): Hint | undefined {
      const was = seen
      const next = seenOf(s)
      seen = next
      for (const key of [...asked.keys()]) if (!next.questions.has(key)) asked.delete(key)
      for (const key of next.questions) if (!asked.has(key)) asked.set(key, { at: now, told: !was })
      const due = [...asked.values()].filter(q => !q.told && now - q.at >= QUESTION_GRACE_MS)
      for (const q of due) q.told = true
      const kind = was && (due.length ? 'needs-you' : newsOf(was, next, failed))
      for (const f of next.failures) failed.add(f)
      if (!kind) return undefined
      const notify = devices.filter(id => !isLooking(id))
      return notify.length ? { notify, kind } : undefined
    },
  }
}
