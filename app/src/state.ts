// What the app shows, as one value changed only by `reduce`: sessions from every paired room, the tab and view
// chosen, open cards, reply drafts, and the taps in flight. Pure, so the rules (stale sessions, drafts surviving
// redraws, a tap sent once and settled by an ack or a snapshot) are testable.
import {
  MAX_ALLOW_TRIES,
  type Ack,
  type AckWhy,
  type PendingPermission,
  type PendingQuestion,
  type PhoneCommand,
  type Snapshot,
} from '../../plugins/streams/hooks/remote/snapshot'

export type { Snapshot }
export type View = 'streams' | 'status'

/** A session's latest snapshot, keyed by room and session id: two accounts never share a tab. */
export type Held = { room: string; snapshot: Snapshot; seen: number }

/**
 * How far a tap got: Face ID up, waiting for the line to come back, posted, settled (by an ack or the snapshot), or
 * refused before it was done (the person can tap again).
 */
export type TapStage = 'faceid' | 'queued' | 'sent' | 'done' | 'failed'
/**
 * How a prompt or a tap ended: `ok` (an answer or Stop done), `allowed`, `denied`, `chosen` (an option), `mac`
 * (answered in the terminal), `moved` (nobody answered, so the terminal asks), `auto` (nobody answered, so the
 * session took the recommended option), `gone` (answered elsewhere: another device, or an older session).
 */
export type Outcome = 'ok' | 'allowed' | 'denied' | 'chosen' | 'mac' | 'moved' | 'auto' | 'gone'

/**
 * One tap's command and where it is. The command keeps its id through retries and reconnects, so the session runs it
 * once and its ack finds it here.
 */
export type Tap = {
  command: PhoneCommand
  room: string
  sessionId: string
  stage: TapStage
  /** When this stage began. */
  at: number
  result?: Outcome
  /** The option an outcome names (`chosen`, `auto`). */
  label?: string
  /** Why it failed, in plain words. */
  why?: string
  /** Allows this request's passkey checks refused so far (MAX_ALLOW_TRIES at most). */
  tries?: number
}

/**
 * A permission prompt or a question seen in a snapshot, kept after it leaves so its card can say what became of it.
 * `ended`: how and when it left, for one this app did not answer itself.
 */
export type SeenAsk = {
  session: string
  since: number
  perm?: PendingPermission
  question?: PendingQuestion
  ended?: { result: Outcome; label?: string; at: number }
}

export type State = {
  sessions: Record<string, Held>
  chosen: string
  view: View
  /** Cards opened, by stream key. */
  open: string[]
  isUsageOpen: boolean
  /** The header's list of sessions, opened by holding or tapping the project name. */
  isSwitchOpen: boolean
  /** What each stream was when last viewed (`markOf`), by stream key: a stream that differs has news. */
  seen: Record<string, string>
  /** The bell: muted, the header says nothing of other projects' news. */
  isMuted: boolean
  /** Reply text by stream key, kept until it is sent: a redraw from a new snapshot must not lose it. */
  drafts: Record<string, string>
  /** When Stop was first tapped; a second tap within STOP_MS stops. */
  stopArmed: number
  /** A Stop workflow or Stop loop tapped once, by its button key, and when: a second tap within STOP_MS sends it. */
  armed: { key: string; at: number }
  /** Taps by what they act on: `permKey(requestId)`, a stream key (Yes, Reply), `stopKey(session)`. */
  taps: Record<string, Tap>
  /** Permission prompts and questions by request id. */
  perms: Record<string, SeenAsk>
  /** Cards hidden with ✕, by request id: hiding does not answer anything. */
  hidden: string[]
}

/** A session that has not sent a snapshot in this long has probably ended (it resends every 30 s). */
export const STALE_MS = 75_000
/** A stale session is dropped after this long, so ended sessions do not pile up as tabs. */
export const FORGET_MS = 30 * 60_000
export const STOP_MS = 4_000
/** How long "Sent ✓" shows once the Mac has the answer. */
export const SENT_MS = 8_000
/** How long a settled card shows its outcome before it collapses: a moment for the person's own answer, longer for news. */
export const SHOWN_MS: Record<Outcome, number> = { ok: 2_000, allowed: 2_000, denied: 2_000, chosen: 2_000, mac: 4_000, moved: 4_000, gone: 4_000, auto: 8_000 }
/** No word from the Mac in this long: say so, offer Retry, and keep waiting. */
export const SLOW_MS = 45_000

export const keyOf = (room: string, session: string): string => `${room}|${session}`
export const streamKey = (sessionKey: string, streamId: string): string => `${sessionKey}|${streamId}`
export const permKey = (requestId: string): string => `perm|${requestId}`
export const stopKey = (sessionKey: string): string => `stop|${sessionKey}`

/** What a session's word for an ending means here. */
export const outcomeOf = (why: AckWhy | undefined): Outcome | undefined =>
  why === 'allowed' || why === 'denied' || why === 'chosen'
    ? why
    : why === 'answered on Mac'
      ? 'mac'
      : why === 'moved to Mac'
        ? 'moved'
        : why === 'chose recommended'
          ? 'auto'
          : why === 'unknown request'
            ? 'gone'
            : undefined

/** A tap still on its way: another tap on the same thing does nothing, so nothing is sent twice. */
export const isInFlight = (t: Tap | undefined): boolean => !!t && (t.stage === 'faceid' || t.stage === 'queued' || t.stage === 'sent')

export const initial = (saved: Partial<Pick<State, 'chosen' | 'view' | 'open' | 'isUsageOpen' | 'hidden' | 'seen' | 'isMuted'>> = {}): State => ({
  sessions: {},
  chosen: saved.chosen ?? '',
  view: saved.view === 'status' ? 'status' : 'streams',
  open: saved.open ?? [],
  isUsageOpen: saved.isUsageOpen ?? false,
  isSwitchOpen: false,
  seen: saved.seen ?? {},
  isMuted: saved.isMuted ?? false,
  drafts: {},
  stopArmed: 0,
  armed: { key: '', at: 0 },
  taps: {},
  perms: {},
  hidden: saved.hidden ?? [],
})

export type Action =
  | { type: 'snapshot'; room: string; snapshot: Snapshot; now: number }
  | { type: 'choose'; key: string }
  | { type: 'view'; view: View }
  | { type: 'toggle'; key: string }
  | { type: 'reveal'; key: string }
  /** Show a stream in the wide layout's detail pane: the last opened card is the selected one. */
  | { type: 'select'; key: string }
  | { type: 'usage' }
  | { type: 'switch'; open: boolean }
  | { type: 'mute' }
  | { type: 'draft'; key: string; text: string }
  /** A reply went: its draft is cleared (the tap keeps the text for a retry). */
  | { type: 'sent'; key: string }
  | { type: 'stop-armed'; now: number }
  /** First tap on a destructive stream button (Stop workflow, Stop loop); `now: 0` disarms. */
  | { type: 'arm'; key: string; now: number }
  | { type: 'tap'; key: string; tap: Tap }
  | { type: 'ack'; ack: Ack; now: number }
  | { type: 'hide'; requestId: string }

/** The outcome a tap of ours meant, when the session drops it without saying more. */
const meantBy = (c: PhoneCommand): Outcome => (c.kind === 'permission' ? (c.decision === 'allow' ? 'allowed' : 'denied') : c.kind === 'choose' ? 'chosen' : 'ok')

/** What an ack makes of a tap: settled with its outcome, or refused (an Allow whose Face ID was not accepted). */
function acked(t: Tap, a: Ack, now: number): Tap {
  if (a.why === 'passkey not verified') {
    const tries = (t.tries ?? 0) + 1
    const why = tries >= MAX_ALLOW_TRIES ? 'Face ID was not accepted. Answer on your Mac.' : 'Face ID was not accepted. Tap Allow to try again.'
    return { ...t, stage: 'failed', at: now, tries, why }
  }
  const result = outcomeOf(a.why) ?? (a.ok ? 'ok' : undefined)
  if (!result) return { ...t, stage: 'failed', at: now, why: "Your Mac couldn't do that. Try again." }
  return { ...t, stage: 'done', at: now, result, ...(result === 'chosen' && t.command.kind === 'choose' ? { label: t.command.label } : {}) }
}

/** The session's prompts and questions now: new ones kept, and the ones it dropped settled with what became of them. */
function seenAsks(s: State, sessionKey: string, x: Snapshot, now: number): Pick<State, 'perms' | 'taps'> {
  const perms = { ...s.perms }
  const taps = { ...s.taps }
  const perm = x.permissions ?? []
  const questions = x.questions ?? []
  for (const p of perm) perms[p.id] = { session: sessionKey, since: p.since ?? p.at, perm: p }
  for (const q of questions) perms[q.id] = { session: sessionKey, since: q.since, question: q }
  for (const [id, seen] of Object.entries(s.perms)) {
    if (seen.session !== sessionKey || seen.ended || perm.some(p => p.id === id) || questions.some(q => q.id === id)) continue
    const t = taps[permKey(id)]
    const told = x.settled?.find(e => e.id === id)
    const result = outcomeOf(told?.why) ?? (t?.stage === 'sent' ? meantBy(t.command) : 'gone')
    const label = told?.label ?? (t?.command.kind === 'choose' ? t.command.label : undefined)
    if (t?.stage === 'done') continue
    if (t && isInFlight(t)) taps[permKey(id)] = { ...t, stage: 'done', at: now, result, ...(label !== undefined ? { label } : {}) }
    else perms[id] = { ...seen, ended: { result, at: now, ...(label !== undefined ? { label } : {}) } }
  }
  // Settled ones are kept a while (long enough to show), then dropped with their card.
  for (const [k, t] of Object.entries(taps))
    if (t.stage === 'done' && now - t.at > 60_000) {
      delete taps[k]
      if (k.startsWith('perm|')) delete perms[k.slice(5)]
    }
  for (const [id, seen] of Object.entries(perms)) if (seen.ended && now - seen.ended.at > 60_000) delete perms[id]
  return { perms, taps }
}

/**
 * What a stream is, for news: its state, its last row and its question. Clocks are left out, so a stream that only
 * ages is no news; running streams with new rows are.
 */
export const markOf = (x: Snapshot['streams'][number]): string => `${x.kind}|${x.state}|${x.rows?.at(-1)?.at ?? 0}|${x.question ?? ''}`

/** The session key of a stream key: everything before the stream id. */
const sessionOfKey = (key: string): string => key.slice(0, key.lastIndexOf('|'))

/** The seen marks with these streams of a session marked as they are now. */
function marked(s: State, sessionKey: string, only?: string): Record<string, string> {
  const streams = s.sessions[sessionKey]?.snapshot.streams ?? []
  const seen = { ...s.seen }
  for (const x of streams) if (!only || x.id === only) seen[streamKey(sessionKey, x.id)] = markOf(x)
  return seen
}

/**
 * The seen marks after a snapshot: a session met for the first time is taken as seen (nothing it did before this
 * device knew it is news), and an open card is watched as it changes. Marks of forgotten sessions go.
 */
function seenAfter(s: State, sessions: Record<string, Held>, key: string, snapshot: Snapshot): Record<string, string> {
  const isNew = !Object.keys(s.seen).some(k => sessionOfKey(k) === key)
  const seen = Object.fromEntries(Object.entries(s.seen).filter(([k]) => sessions[sessionOfKey(k)]))
  for (const x of snapshot.streams ?? []) {
    const k = streamKey(key, x.id)
    if (isNew || (key === s.chosen && s.open.includes(k))) seen[k] = markOf(x)
  }
  return seen
}

/** A stream with news: something changed since it was last viewed. */
export const isUnseen = (s: State, sessionKey: string, x: Snapshot['streams'][number]): boolean => {
  const was = s.seen[streamKey(sessionKey, x.id)]
  return was !== markOf(x)
}

/** How many of a session's streams have news. */
export const newsOf = (s: State, sessionKey: string): number =>
  (s.sessions[sessionKey]?.snapshot.streams ?? []).filter(x => isUnseen(s, sessionKey, x)).length

export function reduce(s: State, a: Action): State {
  switch (a.type) {
    case 'snapshot': {
      const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([, h]) => a.now - h.seen < FORGET_MS))
      const key = keyOf(a.room, a.snapshot.session.id)
      sessions[key] = { room: a.room, snapshot: a.snapshot, seen: a.now }
      return { ...s, sessions, seen: seenAfter(s, sessions, key, a.snapshot), ...seenAsks(s, key, a.snapshot, a.now) }
    }
    case 'choose':
      // Leaving a session counts as having viewed it.
      return { ...s, chosen: a.key, stopArmed: 0, isSwitchOpen: false, seen: s.chosen ? marked(s, s.chosen) : s.seen }
    case 'view':
      return { ...s, view: a.view }
    case 'toggle':
      return {
        ...s,
        open: s.open.includes(a.key) ? s.open.filter(k => k !== a.key) : [...s.open, a.key],
        seen: marked(s, sessionOfKey(a.key), a.key.slice(a.key.lastIndexOf('|') + 1)),
      }
    case 'reveal':
      return s.open.includes(a.key) ? s : { ...s, open: [...s.open, a.key] }
    case 'select':
      return { ...s, open: [...s.open.filter(k => k !== a.key), a.key], seen: marked(s, sessionOfKey(a.key), a.key.slice(a.key.lastIndexOf('|') + 1)) }
    case 'usage':
      return { ...s, isUsageOpen: !s.isUsageOpen }
    case 'switch':
      return { ...s, isSwitchOpen: a.open }
    case 'mute':
      return { ...s, isMuted: !s.isMuted }
    case 'draft':
      return { ...s, drafts: { ...s.drafts, [a.key]: a.text } }
    case 'sent': {
      const { [a.key]: _, ...drafts } = s.drafts
      return { ...s, drafts }
    }
    case 'stop-armed':
      return { ...s, stopArmed: a.now }
    case 'arm':
      return { ...s, armed: { key: a.key, at: a.now } }
    case 'tap':
      return { ...s, taps: { ...s.taps, [a.key]: a.tap } }
    case 'ack': {
      const hit = Object.entries(s.taps).find(([, t]) => t.command.id === a.ack.id)
      if (!hit) return s
      const next = acked(hit[1], a.ack, a.now)
      // An ack for a tap already settled the same way changes nothing (its moment on screen is not restarted).
      if (hit[1].stage === 'done' && next.result === hit[1].result) return s
      return { ...s, taps: { ...s.taps, [hit[0]]: next } }
    }
    case 'hide':
      return s.hidden.includes(a.requestId) ? s : { ...s, hidden: [...s.hidden, a.requestId] }
  }
}

/** Two taps, no dialog: a stray touch does not stop a turn. True when this tap is the second one. */
export const isStopConfirmed = (s: State, now: number): boolean => now - s.stopArmed < STOP_MS

/** The same two taps for a stream's Stop workflow or Stop loop, each button armed on its own. */
export const isArmed = (s: State, key: string, now: number): boolean => s.armed.key === key && now - s.armed.at < STOP_MS

export type SessionTab = Held & { key: string; isStale: boolean }

/** Every session across rooms, in the order first seen, each marked stale when it has gone quiet. */
export const tabsOf = (s: State, now: number): SessionTab[] =>
  Object.entries(s.sessions).map(([key, h]) => ({ ...h, key, isStale: now - h.seen > STALE_MS }))

/** The tab shown: the chosen one while it exists, otherwise the first. */
export const currentOf = (s: State, now: number): SessionTab | undefined => {
  const tabs = tabsOf(s, now)
  return tabs.find(t => t.key === s.chosen) ?? tabs[0]
}

/** The tab `step` places from the shown one, wrapping round: a sideways swipe on the header moves through them. */
export const stepOf = (s: State, now: number, step: 1 | -1): string | undefined => {
  const tabs = tabsOf(s, now)
  const i = tabs.findIndex(t => t.key === currentOf(s, now)?.key)
  return tabs.length < 2 ? undefined : tabs[(i + step + tabs.length) % tabs.length]!.key
}

/** Whether a request can still be answered from here: the session holds it and nothing settled it. */
export const isOpenAsk = (s: State, requestId: string): boolean => {
  const seen = s.perms[requestId]
  return !!seen && !seen.ended && s.taps[permKey(requestId)]?.stage !== 'done'
}

/**
 * What a card shows: `open` (its buttons), a tap on its way (`faceid`, `queued`, `sent`, and `slow` once the Mac has
 * been quiet for SLOW_MS), or how it ended, for a moment (SHOWN_MS) before it collapses. No deadline: a prompt waits
 * until someone answers it.
 */
export type CardPhase = 'open' | 'faceid' | 'queued' | 'sent' | 'slow' | Exclude<Outcome, 'ok'>
export type AskCard = { id: string; seen: SeenAsk; phase: CardPhase; tap?: Tap; label?: string; canAllow: boolean }

/** The session's permission and question cards now, hidden ones left out and settled ones collapsed. */
export function askCards(s: State, sessionKey: string, now: number): AskCard[] {
  return Object.entries(s.perms).flatMap(([id, seen]): AskCard[] => {
    if (seen.session !== sessionKey || s.hidden.includes(id)) return []
    const tap = s.taps[permKey(id)]
    const card = { id, seen, tap, canAllow: (tap?.tries ?? 0) < MAX_ALLOW_TRIES }
    const ended = tap?.stage === 'done' ? { result: tap.result ?? 'gone', label: tap.label, at: tap.at } : seen.ended
    if (ended) {
      if (now - ended.at > SHOWN_MS[ended.result]) return []
      return [{ ...card, phase: ended.result === 'ok' ? 'gone' : ended.result, label: ended.label }]
    }
    if (tap?.stage === 'sent') return [{ ...card, phase: now - tap.at >= SLOW_MS ? 'slow' : 'sent' }]
    if (tap?.stage === 'faceid' || tap?.stage === 'queued') return [{ ...card, phase: tap.stage }]
    return [{ ...card, phase: 'open' }]
  })
}
