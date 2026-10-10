// The app: keeps this device's identity and paired rooms, runs a link per room, and draws the state on each change.
// Taps go through one delegated click handler; everything a session receives is sealed by the room's link.
import { newIdentity, randomId } from '../../plugins/streams/hooks/remote/seal'
import type { PhoneCommand } from '../../plugins/streams/hooks/remote/snapshot'
import { gateOf, parseLink, withLink, type Pairing } from './links'
import { notifyState, subOf, turnOff, turnOn, type PushDeps, type PushSub } from './push'
import { currentOf, initial, isArmed, isStopConfirmed, reduce, type Action, type State } from './state'
import { PING_MS, roomLink, type Device, type RoomLink } from './transport'
import { gates, unpaired, type GateView } from './views/gates'
import { page, tabs } from './views/page'

/** localStorage can throw (private mode, blocked storage): the app then works for this visit only. */
const keep = {
  get<T>(k: string, d: T): T {
    try {
      return (JSON.parse(localStorage.getItem(k) ?? 'null') as T) ?? d
    } catch {
      return d
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
}

const device: Device = keep.get<Device | null>('cf:device', null) ?? { id: randomId(), ...newIdentity() }
keep.set('cf:device', device)

// The fragment stays in the address: Add to Home Screen keeps it, so the Home Screen app can pair once too.
let rooms = keep.get<Record<string, Pairing>>('cf:rooms', {})
const scanned = parseLink(location.hash)
if (scanned) rooms = withLink(rooms, scanned)
keep.set('cf:rooms', rooms)
const labels = keep.get<Record<string, string>>('cf:labels', {})

let state: State = initial(keep.get('cf:ui', {}))
let pendingRender = false

function dispatch(a: Action) {
  state = reduce(state, a)
  if (a.type === 'choose' || a.type === 'view' || a.type === 'toggle' || a.type === 'reveal' || a.type === 'select' || a.type === 'usage')
    keep.set('cf:ui', { chosen: state.chosen, view: state.view, open: state.open, isUsageOpen: state.isUsageOpen })
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
    changed: () => render(),
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
  el('conn').classList.toggle('on', isOnline)
  const connText = isOnline ? 'Connected' : 'Reconnecting…'
  if (el('conn').textContent !== connText) el('conn').textContent = connText
  const views: GateView[] = links.map(l => ({
    room: l.room(),
    gate: gateOf(l.pairing(), l.isUnlocked()),
    label: labels[l.room()] ?? `Account ${l.room().slice(0, 6)}`,
    why: l.why(),
    isBusy: l.isBusy(),
    isOnline: l.isOpen(),
    canRepair: !!l.pairing().secret,
  }))
  el('gate').innerHTML = links.length ? gates(views) : unpaired()
  el('tabs').innerHTML = tabs(state, now)
  el('main').innerHTML = page(state, now, views.some(v => v.gate === 'open'), wide.matches, notifyView())
  // On a Mac the sidebar holds the dock (runs-and-loops line, plan usage) right under the session tabs.
  const dock = el('main').querySelector('.dock')
  if (dock && side.matches) el('tabs').append(dock)
  const hasUsage = !!dock?.querySelector('.usage')
  document.body.classList.toggle('has-usage', hasUsage)
  document.body.classList.toggle('has-summary', !!dock?.querySelector('.flowsum'))
  document.body.classList.toggle('usage-open', hasUsage && state.isUsageOpen)
}

/** Sends the shown session one command; the page shows it was sent, the stream shows what came of it. */
async function send(command: PhoneCommand): Promise<boolean> {
  const t = currentOf(state, Date.now())
  const link = t && linkOf(t.room)
  return !!link && (await link.send(t.snapshot.session.id, command))
}

/** A stream key is the session key, then the stream id; the session key is the shown tab's. */
const streamIdOf = (key: string) => key.slice((currentOf(state, Date.now())?.key.length ?? 0) + 1)

document.addEventListener('input', e => {
  const d = (e.target as Element).closest?.<HTMLTextAreaElement>('[data-draft]')
  if (d) state = reduce(state, { type: 'draft', key: d.dataset.draft!, text: d.value })
})
document.addEventListener('focusout', () => setTimeout(() => pendingRender && render(), 0))

document.addEventListener('click', async e => {
  const at = (sel: string) => (e.target as Element).closest<HTMLElement>(sel)
  const answer = at('[data-answer]')
  if (answer) {
    const key = answer.dataset.answer!
    answer.setAttribute('disabled', '')
    if (await send({ id: randomId(), kind: 'answer', streamId: streamIdOf(key), text: 'yes' })) dispatch({ type: 'sent', key, now: Date.now() })
    return render()
  }
  const sendBtn = at('[data-send]')
  if (sendBtn) {
    const key = sendBtn.dataset.send!
    const text = (state.drafts[key] ?? '').trim()
    if (!text) return
    sendBtn.setAttribute('disabled', '')
    if (await send({ id: randomId(), kind: 'answer', streamId: streamIdOf(key), text })) dispatch({ type: 'sent', key, now: Date.now() })
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    return render()
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
    const buttons = [...(perm.parentElement?.querySelectorAll('button') ?? [])]
    buttons.forEach(b => (b.disabled = true))
    const decision = perm.dataset.decision === 'allow' ? 'allow' : 'deny'
    const ok = await send({ id: randomId(), kind: 'permission', requestId: perm.dataset.perm!, decision })
    if (!ok) buttons.forEach(b => (b.disabled = false))
    return
  }
  if (at('[data-notify]')) {
    // turnOn asks for permission before its first await: iOS allows the prompt only inside the tap.
    const turning = pushSub ? turnOff(pushDeps).then(() => ({ sub: null })) : turnOn(pushDeps)
    notifying = { why: '', isBusy: true }
    render()
    const r = await turning
    if ('sub' in r) {
      pushSub = r.sub
      links.forEach(l => l.push(r.sub))
    }
    notifying = { why: 'why' in r ? r.why : '', isBusy: false }
    return render()
  }
  const gateBtn = at('[data-gate]')
  if (gateBtn) {
    const link = linkOf(gateBtn.dataset.room!)
    return gateBtn.dataset.gate === 'pair' ? link?.pair() : link?.unlock()
  }
  if (at('[data-stop]')) {
    const now = Date.now()
    if (isStopConfirmed(state, now)) {
      dispatch({ type: 'stop-armed', now: 0 })
      await send({ id: randomId(), kind: 'stop' })
    } else dispatch({ type: 'stop-armed', now })
    return render()
  }
  // Stop workflow and Stop loop: the first tap arms that button, the second within STOP_MS sends.
  const armed = at('[data-arm]')
  if (armed) {
    const now = Date.now()
    const arm = armed.dataset.arm!
    if (!isArmed(state, arm, now)) return dispatch({ type: 'arm', key: arm, now }), render()
    dispatch({ type: 'arm', key: '', now: 0 })
    armed.setAttribute('disabled', '')
    if (armed.dataset.stopTask) await send({ id: randomId(), kind: 'stopTask', taskId: armed.dataset.stopTask })
    else if (armed.dataset.stopLoop) await send({ id: randomId(), kind: 'stopLoop', streamId: streamIdOf(armed.dataset.stopLoop) })
    return render()
  }
  const tick = at('[data-run-tick]')
  if (tick) {
    tick.setAttribute('disabled', '')
    await send({ id: randomId(), kind: 'runTick', streamId: streamIdOf(tick.dataset.runTick!) })
    return render()
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

// Clocks and countdowns move between snapshots (which carry only times): every second while a prompt, a loop's next
// tick or a running workflow counts, else every 10 s. Drawing only: no request is made.
let ticks = 0
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  const x = currentOf(state, Date.now())?.snapshot
  const isCounting = !!x?.permissions?.length || x?.summary?.nextTickAt !== undefined || !!x?.streams?.some(st => st.workflow?.status === 'running')
  if (isCounting || ++ticks % 10 === 0) render()
}, 1_000)
setInterval(() => links.forEach(l => l.ping()), PING_MS)
// A phone wakes the page without a reconnect: check the line when it comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  links.forEach(l => l.wake())
  render()
})

links.forEach(l => l.start())
render()
