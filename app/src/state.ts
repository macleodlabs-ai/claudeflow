// What the app shows, as one value changed only by `reduce`: sessions from every paired room, the tab and view
// chosen, open cards, reply drafts. Pure, so the rules (stale sessions, drafts surviving redraws) are testable.
import type { Snapshot } from '../../plugins/streams/hooks/remote/snapshot'

export type { Snapshot }
export type View = 'streams' | 'status'

/** A session's latest snapshot, keyed by room and session id: two accounts never share a tab. */
export type Held = { room: string; snapshot: Snapshot; seen: number }

export type State = {
  sessions: Record<string, Held>
  chosen: string
  view: View
  /** Cards opened, by stream key. */
  open: string[]
  isUsageOpen: boolean
  /** Reply text by stream key, kept until it is sent: a redraw from a new snapshot must not lose it. */
  drafts: Record<string, string>
  /** When an answer to a stream was last sent, to show "sent" for a moment. */
  sentAt: Record<string, number>
  /** When Stop was first tapped; a second tap within STOP_MS stops. */
  stopArmed: number
  /** A Stop workflow or Stop loop tapped once, by its button key, and when: a second tap within STOP_MS sends it. */
  armed: { key: string; at: number }
}

/** A session that has not sent a snapshot in this long has probably ended (it resends every 30 s). */
export const STALE_MS = 75_000
/** A stale session is dropped after this long, so ended sessions do not pile up as tabs. */
export const FORGET_MS = 30 * 60_000
export const STOP_MS = 4_000
export const SENT_MS = 8_000

export const keyOf = (room: string, session: string): string => `${room}|${session}`
export const streamKey = (sessionKey: string, streamId: string): string => `${sessionKey}|${streamId}`

export const initial = (saved: Partial<Pick<State, 'chosen' | 'view' | 'open' | 'isUsageOpen'>> = {}): State => ({
  sessions: {},
  chosen: saved.chosen ?? '',
  view: saved.view === 'status' ? 'status' : 'streams',
  open: saved.open ?? [],
  isUsageOpen: saved.isUsageOpen ?? false,
  drafts: {},
  sentAt: {},
  stopArmed: 0,
  armed: { key: '', at: 0 },
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
  | { type: 'draft'; key: string; text: string }
  | { type: 'sent'; key: string; now: number }
  | { type: 'stop-armed'; now: number }
  /** First tap on a destructive stream button (Stop workflow, Stop loop); `now: 0` disarms. */
  | { type: 'arm'; key: string; now: number }

export function reduce(s: State, a: Action): State {
  switch (a.type) {
    case 'snapshot': {
      const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([, h]) => a.now - h.seen < FORGET_MS))
      sessions[keyOf(a.room, a.snapshot.session.id)] = { room: a.room, snapshot: a.snapshot, seen: a.now }
      return { ...s, sessions }
    }
    case 'choose':
      return { ...s, chosen: a.key, stopArmed: 0 }
    case 'view':
      return { ...s, view: a.view }
    case 'toggle':
      return { ...s, open: s.open.includes(a.key) ? s.open.filter(k => k !== a.key) : [...s.open, a.key] }
    case 'reveal':
      return s.open.includes(a.key) ? s : { ...s, open: [...s.open, a.key] }
    case 'select':
      return { ...s, open: [...s.open.filter(k => k !== a.key), a.key] }
    case 'usage':
      return { ...s, isUsageOpen: !s.isUsageOpen }
    case 'draft':
      return { ...s, drafts: { ...s.drafts, [a.key]: a.text } }
    case 'sent': {
      const { [a.key]: _, ...drafts } = s.drafts
      return { ...s, drafts, sentAt: { ...s.sentAt, [a.key]: a.now } }
    }
    case 'stop-armed':
      return { ...s, stopArmed: a.now }
    case 'arm':
      return { ...s, armed: { key: a.key, at: a.now } }
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
