// The app: keeps this device's identity and paired rooms, runs a link per room, and draws the state on each change.
// Taps go through one delegated click handler; everything a session receives is sealed by the room's link.
import { newIdentity, randomId } from '../../plugins/streams/hooks/remote/seal'
import type { PhoneCommand } from '../../plugins/streams/hooks/remote/snapshot'
import { gateOf, parseLink, withLink, type Pairing } from './links'
import { currentOf, initial, isStopConfirmed, reduce, type Action, type State } from './state'
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
  if (a.type === 'choose' || a.type === 'view' || a.type === 'toggle' || a.type === 'reveal' || a.type === 'usage')
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
  }),
)
const linkOf = (room: string) => links.find(l => l.room() === room)

const el = (id: string) => document.getElementById(id)!

function render() {
  // Redrawing would drop the keyboard mid-word: wait until the box loses focus.
  if (document.activeElement?.matches('textarea')) {
    pendingRender = true
    return
  }
  pendingRender = false
  const now = Date.now()
  el('conn').classList.toggle('on', links.some(l => l.isOpen()))
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
  el('main').innerHTML = page(state, now, views.some(v => v.gate === 'open'))
  const hasUsage = !!currentOf(state, now)?.snapshot.limits?.length
  document.body.classList.toggle('has-usage', hasUsage)
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
  const v = at('[data-view]')
  if (v) return dispatch({ type: 'view', view: v.dataset.view === 'status' ? 'status' : 'streams' }), render()
  if (at('[data-usage]')) return dispatch({ type: 'usage' }), render()
  const tab = at('[data-session]')
  if (tab) return dispatch({ type: 'choose', key: tab.dataset.session! }), render()
  const head = at('[data-toggle]')
  if (head) return dispatch({ type: 'toggle', key: head.dataset.toggle! }), render()
})

// Clocks and permission countdowns move between snapshots: every second while a prompt counts down, else every 10 s.
let ticks = 0
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  const hasPrompt = !!currentOf(state, Date.now())?.snapshot.permissions?.length
  if (hasPrompt || ++ticks % 10 === 0) render()
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
