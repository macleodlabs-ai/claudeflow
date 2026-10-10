// The app: keeps this device's identity and paired rooms, runs a link per room, and draws the state on each change.
// Taps go through one delegated click handler; everything a session receives is sealed by the room's link. A tap
// becomes one command with one id: it is sent once (again only as the same command, on Retry or after a reconnect),
// and settles when the session acks it or its snapshot shows the outcome.
import { newIdentity, randomId } from '../../plugins/streams/hooks/remote/seal'
import type { PhoneCommand } from '../../plugins/streams/hooks/remote/snapshot'
import { gateOf, parseLink, withLink, type Pairing } from './links'
import { isCeremonyBusy } from './passkey'
import { notifyState, subOf, turnOff, turnOn, type PushDeps, type PushSub } from './push'
import {
  currentOf,
  initial,
  isArmed,
  isInFlight,
  isStopConfirmed,
  askCards,
  isOpenAsk,
  permKey,
  reduce,
  SENT_MS,
  SLOW_MS,
  stepOf,
  stopKey,
  tabsOf,
  type Action,
  type SessionTab,
  type State,
  type Tap,
} from './state'
import { startTheme } from './theme'
import { PING_MS, roomLink, type Device, type RoomLink } from './transport'
import { gates, unpaired, type GateView } from './views/gates'
import { page, switcher, tabs } from './views/page'

/** Web storage can throw (private mode, blocked storage): the app then works for this visit only. */
const storeOf = (which: () => Storage) => ({
  get<T>(k: string, d: T): T {
    try {
      return (JSON.parse(which().getItem(k) ?? 'null') as T) ?? d
    } catch {
      return d
    }
  },
  set(k: string, v: unknown) {
    try {
      which().setItem(k, JSON.stringify(v))
    } catch {}
  },
})
const keep = storeOf(() => localStorage)
/** Kept for this visit only: cards hidden with ✕. */
const visit = storeOf(() => sessionStorage)

const device: Device = keep.get<Device | null>('cf:device', null) ?? { id: randomId(), ...newIdentity() }
keep.set('cf:device', device)

// The fragment stays in the address: Add to Home Screen keeps it, so the Home Screen app can pair once too.
let rooms = keep.get<Record<string, Pairing>>('cf:rooms', {})
const scanned = parseLink(location.hash)
if (scanned) rooms = withLink(rooms, scanned)
keep.set('cf:rooms', rooms)
const labels = keep.get<Record<string, string>>('cf:labels', {})

let state: State = initial({ ...keep.get('cf:ui', {}), hidden: visit.get<string[]>('cf:hidden', []) })
let pendingRender = false
/** The line was up once: from then on a drop shows the Reconnecting banner. */
let wasOnline = false

function dispatch(a: Action) {
  state = reduce(state, a)
  if (a.type === 'choose' || a.type === 'view' || a.type === 'toggle' || a.type === 'reveal' || a.type === 'select' || a.type === 'usage')
    keep.set('cf:ui', { chosen: state.chosen, view: state.view, open: state.open, isUsageOpen: state.isUsageOpen })
  if (a.type === 'hide') visit.set('cf:hidden', state.hidden)
}

const links: RoomLink[] = Object.values(rooms).map(p =>
  roomLink(p, device, {
    save(next) {
      rooms = { ...rooms, [next.room]: next }
      keep.set('cf:rooms', rooms)
    },
    snapshot(room, snapshot) {
      dispatch({ type: 'snapshot', room, snapshot, now: Date.now() })
      if (labels[room] !== snapshot.session.account) {
        labels[room] = snapshot.session.account
        keep.set('cf:labels', labels)
      }
      render()
    },
    ack(_room, _session, ack) {
      dispatch({ type: 'ack', ack, now: Date.now() })
      render()
    },
    changed() {
      flush()
      render()
    },
    // Each unlock tells the room again where to push: cheap, and it heals a room that forgot (a 410, a new room).
    welcomed() {
      if (pushSub) linkOf(p.room)?.push(pushSub)
    },
  }),
)
const linkOf = (room: string) => links.find(l => l.room() === room)

// "Notify me" (push.ts): the browser parts, and what this browser has. iOS offers Push only to Home Screen apps.
const hasPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const isStandalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
const pushDeps: PushDeps = {
  permission: () => Notification.requestPermission(),
  key: () => fetch('/v1/push/key').then(r => (r.ok ? (r.json() as Promise<{ key?: string }>) : undefined)).then(j => j?.key),
  manager: async () => {
    await navigator.serviceWorker.register('/sw.js')
    return (await navigator.serviceWorker.ready).pushManager
  },
}
let pushSub: PushSub | null = null
let notifying = { why: '', isBusy: false }
const notifyView = () => ({
  state: notifyState({ hasPush, isIOS, isStandalone, permission: hasPush ? Notification.permission : 'unsupported', isSubscribed: !!pushSub }),
  ...notifying,
})
// A subscription made on an earlier visit is still this browser's: the toggle shows on, and unlocks resend it.
if (hasPush)
  navigator.serviceWorker
    .getRegistration()
    .then(r => r?.pushManager.getSubscription())
    .then(s => {
      pushSub = subOf(s?.toJSON()) ?? null
      render()
    })
    .catch(() => {})

startTheme()
const el = (id: string) => document.getElementById(id)!
/** From 820 px the Streams view is a list and a detail pane (styles.css uses the same breakpoint). */
const wide = matchMedia('(min-width: 820px)')
wide.addEventListener?.('change', () => render())
const side = matchMedia('(min-width: 1280px)')
side.addEventListener?.('change', () => render())

function render() {
  // Redrawing would drop the keyboard mid-word: wait until the box loses focus.
  if (document.activeElement?.matches('textarea')) {
    pendingRender = true
    return
  }
  pendingRender = false
  const now = Date.now()
  const isOnline = links.some(l => l.isOpen())
  wasOnline ||= isOnline
  el('conn').classList.toggle('on', isOnline)
  const connText = isOnline ? 'Connected' : 'Reconnecting…'
  if (el('conn').textContent !== connText) el('conn').textContent = connText
  const queued = Object.values(state.taps).filter(t => t.stage === 'queued').length
  const banner = el('banner')
  banner.hidden = !(wasOnline && links.some(l => !l.isOpen()))
  banner.textContent = `Reconnecting…${queued ? ` ${queued === 1 ? 'Your tap sends' : `${queued} taps send`} once you're back.` : ''}`
  const views: GateView[] = links.map(l => {
    const stage = l.stage()
    return {
      room: l.room(),
      gate: gateOf(l.pairing(), l.isUnlocked()),
      label: labels[l.room()] ?? `Account ${l.room().slice(0, 6)}`,
      why: l.why(),
      stage,
      isSlow: stage.at === 'checking' && now - stage.since >= SLOW_MS,
      isCeremony: isCeremonyBusy(),
      isOnline: l.isOpen(),
      canRepair: !!l.pairing().secret,
    }
  })
  el('gate').innerHTML = links.length ? gates(views) : unpaired()
  el('tabs').innerHTML = tabs(state, now)
  el('page-name').innerHTML = switcher(state, now)
  el('main').innerHTML = page(state, now, views.some(v => v.gate === 'open'), wide.matches, notifyView())
  // On a Mac the sidebar holds the dock (runs-and-loops line, plan usage) right under the session tabs.
  const dock = el('main').querySelector('.dock')
  if (dock && side.matches) el('tabs').append(dock)
  const hasUsage = !!dock?.querySelector('.usage')
  document.body.classList.toggle('has-usage', hasUsage)
  document.body.classList.toggle('has-summary', !!dock?.querySelector('.flowsum'))
  document.body.classList.toggle('usage-open', hasUsage && state.isUsageOpen)
}

/** A new tap on `key` for session `t`, carrying the Allow tries this request has already spent. */
const tapOf = (key: string, room: string, sessionId: string, command: PhoneCommand): Tap => ({
  command,
  room,
  sessionId,
  stage: 'queued',
  at: Date.now(),
  tries: state.taps[key]?.tries,
})
const tapFor = (t: SessionTab, key: string, command: PhoneCommand): Tap => tapOf(key, t.room, t.snapshot.session.id, command)

/**
 * Sends a tap's command and moves its stage on: Face ID (an Allow), then sent; queued while there is no line to its
 * session; failed with plain words. Sending the same tap again sends the same command id.
 */
async function go(key: string, tap: Tap) {
  const link = linkOf(tap.room)
  const c = tap.command
  if (!link?.canSend(tap.sessionId)) {
    dispatch({ type: 'tap', key, tap: { ...tap, stage: 'queued', at: Date.now(), why: undefined } })
    return render()
  }
  dispatch({ type: 'tap', key, tap: { ...tap, stage: 'sent', at: Date.now(), why: undefined } })
  render()
  const r = await link.send(tap.sessionId, c)
  const cur = state.taps[key]
  // Settled while Face ID was up (an ack, or the request left the snapshot): that outcome stands.
  if (cur?.command.id !== c.id || cur.stage === 'done') return render()
  const at = Date.now()
  dispatch({ type: 'tap', key, tap: r.ok ? { ...cur, stage: 'sent', at } : r.isOffline ? { ...cur, stage: 'queued', at } : { ...cur, stage: 'failed', at, why: r.why } })
  render()
}

/** The line is back: send what was tapped offline, if it still means something (the request is still held). */
function flush() {
  const now = Date.now()
  for (const [key, tap] of Object.entries(state.taps)) {
    if (tap.stage !== 'queued' || !linkOf(tap.room)?.canSend(tap.sessionId)) continue
    const c = tap.command
    if ((c.kind === 'permission' || c.kind === 'choose') && !state.perms[c.requestId]) {
      dispatch({ type: 'tap', key, tap: { ...tap, stage: 'done', at: now, result: 'gone' } })
      continue
    }
    void go(key, tap)
  }
}

/** Sends an answer to a held prompt or question, once, while it can still be answered. */
function answerAsk(requestId: string, command: PhoneCommand) {
  const key = permKey(requestId)
  const seen = state.perms[requestId]
  const held = seen && state.sessions[seen.session]
  if (!held || !isOpenAsk(state, requestId) || isInFlight(state.taps[key])) return
  void go(key, tapOf(key, held.room, held.snapshot.session.id, command))
}

/** A stream key is the session key, then the stream id; the session key is the shown tab's. */
const streamIdOf = (key: string) => key.slice((currentOf(state, Date.now())?.key.length ?? 0) + 1)

document.addEventListener('input', e => {
  const d = (e.target as Element).closest?.<HTMLTextAreaElement>('[data-draft]')
  if (d) state = reduce(state, { type: 'draft', key: d.dataset.draft!, text: d.value })
})
document.addEventListener('focusout', () => setTimeout(() => pendingRender && render(), 0))

document.addEventListener('click', e => {
  const at = (sel: string) => (e.target as Element).closest<HTMLElement>(sel)
  // The click that ends a swipe or a hold on the header is not a tap on it.
  if (isGesture) return void (isGesture = false)
  if (at('[data-switch]')) return dispatch({ type: 'switch', open: !state.isSwitchOpen }), render()
  // A tap anywhere off the open list closes it (a session in it is chosen below, which closes it too).
  if (state.isSwitchOpen && !at('.switch-menu')) return dispatch({ type: 'switch', open: false }), render()
  const shown = currentOf(state, Date.now())
  const answer = at('[data-answer]')
  if (answer) {
    const key = answer.dataset.answer!
    if (!shown || isInFlight(state.taps[key])) return
    return void go(key, tapFor(shown, key, { id: randomId(), kind: 'answer', streamId: streamIdOf(key), text: 'yes' }))
  }
  const sendBtn = at('[data-send]')
  if (sendBtn) {
    const key = sendBtn.dataset.send!
    const text = (state.drafts[key] ?? '').trim()
    if (!text || !shown || isInFlight(state.taps[key])) return
    dispatch({ type: 'sent', key })
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    return void go(key, tapFor(shown, key, { id: randomId(), kind: 'answer', streamId: streamIdOf(key), text }))
  }
  const replyOpen = at('[data-reply-open]')
  if (replyOpen) {
    const key = replyOpen.dataset.replyOpen!
    dispatch({ type: 'reveal', key })
    render()
    document.querySelector<HTMLElement>(`[data-draft="${CSS.escape(key)}"]`)?.focus()
    return
  }
  const perm = at('[data-perm]')
  if (perm) {
    const requestId = perm.dataset.perm!
    const decision = perm.dataset.decision === 'allow' ? 'allow' : 'deny'
    // One tap per request until it settles, and one Face ID at a time.
    if (decision === 'allow' && isCeremonyBusy()) return
    return answerAsk(requestId, { id: randomId(), kind: 'permission', requestId, decision })
  }
  const choose = at('[data-choose]')
  if (choose) {
    const requestId = choose.dataset.choose!
    return answerAsk(requestId, { id: randomId(), kind: 'choose', requestId, label: choose.dataset.label ?? '' })
  }
  const hide = at('[data-hide]')
  if (hide) return dispatch({ type: 'hide', requestId: hide.dataset.hide! }), render()
  const retry = at('[data-retry]')
  if (retry) {
    // The same command again: the session runs it once, and acks it again if it already had it.
    const key = retry.dataset.retry!
    const tap = state.taps[key]
    return tap?.stage === 'sent' ? void go(key, tap) : undefined
  }
  if (at('[data-notify]')) {
    // turnOn asks for permission before its first await: iOS allows the prompt only inside the tap.
    const turning = pushSub ? turnOff(pushDeps).then(() => ({ sub: null })) : turnOn(pushDeps)
    notifying = { why: '', isBusy: true }
    render()
    return void turning.then(r => {
      if ('sub' in r) {
        pushSub = r.sub
        links.forEach(l => l.push(r.sub))
      }
      notifying = { why: 'why' in r ? r.why : '', isBusy: false }
      render()
    })
  }
  const gateBtn = at('[data-gate]')
  if (gateBtn) {
    const link = linkOf(gateBtn.dataset.room!)
    const kind = gateBtn.dataset.gate
    return void (kind === 'pair' ? link?.pair() : kind === 'unlock' ? link?.unlock() : link?.retry())
  }
  if (at('[data-stop]') && shown) {
    const now = Date.now()
    const key = stopKey(shown.key)
    if (isInFlight(state.taps[key])) return
    if (isStopConfirmed(state, now)) {
      dispatch({ type: 'stop-armed', now: 0 })
      return void go(key, tapFor(shown, key, { id: randomId(), kind: 'stop' }))
    }
    dispatch({ type: 'stop-armed', now })
    return render()
  }
  // Stop workflow and Stop loop: the first tap arms that button, the second within STOP_MS sends. Each is a tap like
  // Yes or Allow (keyed by its button), so it goes pending → sent → acked, with Retry when the Mac is slow.
  const armed = at('[data-arm]')
  if (armed && shown) {
    const now = Date.now()
    const arm = armed.dataset.arm!
    if (isInFlight(state.taps[arm])) return
    if (!isArmed(state, arm, now)) return dispatch({ type: 'arm', key: arm, now }), render()
    dispatch({ type: 'arm', key: '', now: 0 })
    const command: PhoneCommand | undefined = armed.dataset.stopTask
      ? { id: randomId(), kind: 'stopTask', taskId: armed.dataset.stopTask }
      : armed.dataset.stopLoop
        ? { id: randomId(), kind: 'stopLoop', streamId: streamIdOf(armed.dataset.stopLoop) }
        : undefined
    return command ? void go(arm, tapFor(shown, arm, command)) : render()
  }
  const tick = at('[data-run-tick]')
  if (tick && shown) {
    const key = `${tick.dataset.runTick!}|runTick`
    if (isInFlight(state.taps[key])) return
    return void go(key, tapFor(shown, key, { id: randomId(), kind: 'runTick', streamId: streamIdOf(tick.dataset.runTick!) }))
  }
  const phase = at('[data-phase]')
  if (phase) return dispatch({ type: 'toggle', key: phase.dataset.phase! }), render()
  const v = at('[data-view]')
  if (v) return dispatch({ type: 'view', view: v.dataset.view === 'status' ? 'status' : 'streams' }), render()
  if (at('[data-usage]')) return dispatch({ type: 'usage' }), render()
  const tab = at('[data-session]')
  if (tab) return dispatch({ type: 'choose', key: tab.dataset.session! }), render()
  const head = at('[data-toggle]')
  if (head) return dispatch({ type: 'toggle', key: head.dataset.toggle! }), render()
  const pick = at('[data-select]')
  if (pick) return dispatch({ type: 'select', key: pick.dataset.select! }), render()
})

// The header switches session: swipe it sideways for the next or previous one, or hold it for the list.
const SWIPE_PX = 40
const HOLD_MS = 450
let isGesture = false
let press: { x: number; y: number; hold: ReturnType<typeof setTimeout> } | undefined
const header = document.querySelector('header')!
header.addEventListener('pointerdown', e => {
  if (tabsOf(state, Date.now()).length < 2 || (e.target as Element).closest('#theme, .switch-menu')) return
  const hold = setTimeout(() => {
    press = undefined
    isGesture = true
    navigator.vibrate?.(10)
    dispatch({ type: 'switch', open: true })
    render()
  }, HOLD_MS)
  press = { x: e.clientX, y: e.clientY, hold }
})
header.addEventListener('pointermove', e => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) clearTimeout(press.hold)
})
// A gesture's own click comes right after its pointerup; past that, clicks are taps again.
const endGesture = () => setTimeout(() => (isGesture = false), 400)
header.addEventListener('pointerup', e => {
  if (isGesture) endGesture()
  if (!press) return
  clearTimeout(press.hold)
  const dx = e.clientX - press.x
  const dy = e.clientY - press.y
  press = undefined
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 2 * Math.abs(dy)) return
  // Swiping left brings the next session in, as a page turns.
  const key = stepOf(state, Date.now(), dx < 0 ? 1 : -1)
  if (!key) return
  isGesture = true
  endGesture()
  dispatch({ type: 'choose', key })
  render()
})
header.addEventListener('pointercancel', () => {
  if (press) clearTimeout(press.hold)
  press = undefined
})

// Card heads and the usage bar are role="button": Enter and Space work them from a keyboard, as on a button.
document.addEventListener('keydown', e => {
  const t = e.target as HTMLElement
  if ((e.key === 'Enter' || e.key === ' ') && t.matches?.('[role="button"]:not(button)')) {
    e.preventDefault()
    // The redraw replaces the element: put focus back on its replacement so the keyboard keeps its place.
    const attr = ['data-toggle', 'data-select', 'data-usage', 'data-phase'].find(a => t.hasAttribute(a))
    const sel = attr && `[${attr}="${CSS.escape(t.getAttribute(attr) ?? '')}"]`
    t.click()
    if (sel) document.querySelector<HTMLElement>(sel)?.focus()
  }
})

// Clocks, countdowns and pending taps move between snapshots (which carry only times): every second while a tap
// waits, a settled card is about to collapse, a loop's next tick or a running workflow counts, else every 10 s (a
// waiting card counts whole minutes). Drawing only: no request is made.
let ticks = 0
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  const shown = currentOf(state, now)
  const isMoving =
    (!!shown && askCards(state, shown.key, now).some(c => c.phase !== 'open')) ||
    Object.values(state.taps).some(t => t.stage !== 'done' || now - t.at < SENT_MS) ||
    links.some(l => l.stage().at !== 'idle') ||
    shown?.snapshot.summary?.nextTickAt !== undefined ||
    !!shown?.snapshot.streams?.some(st => st.workflow?.status === 'running')
  if (isMoving || ++ticks % 10 === 0) render()
}, 1_000)
setInterval(() => links.forEach(l => l.ping()), PING_MS)
// A phone wakes the page, or gets its network back, without a reconnect: check the line when it does.
// Put away or out of focus, it says so at once, so sessions stop sending every change to it.
const wake = () => {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return void links.forEach(l => l.ping())
  links.forEach(l => l.wake())
  render()
}
document.addEventListener('visibilitychange', wake)
addEventListener('focus', wake)
addEventListener('blur', wake)
addEventListener('online', wake)

links.forEach(l => l.start())
render()
