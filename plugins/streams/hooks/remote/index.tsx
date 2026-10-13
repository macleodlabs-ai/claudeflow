import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { savedOf, mem, storeKey, type Saved } from '../state'
import { gitStatus } from '../status'
import { afterCall } from '../streams/loops'
import { cardOf, colorOf, streamsNow, type Facts } from '../streams/model'
import { DAY_MS, INVITE_MS, PAIRING_MS, SHARE_DAYS, createLink, devicesOf, identityOf, invitesOf, originOf, pairingOf, roleOf, withPaired, KEPT_MARGIN, RETRY_WHY, type Device, type KeptConn, type Link } from './link'
import { newIdentity, publicKeyOf, randomId } from './seal'
import { decodeArgv, mkdirArgv, openArgv, platformOf, removeArgv, sleepArgv, type Platform } from './platform'
import {
  HEARTBEAT_MS,
  NO_DEVICE_MS,
  SETTLED_MS,
  accountOf,
  permissionSummary,
  questionOf,
  snapshotOf,
  type Ack,
  type AckWhy,
  type PendingPermission,
  type PendingQuestion,
  type PhoneCommand,
  type PhoneFile,
  type Settled,
  type Snapshot,
  PROTO,
} from './snapshot'

// The session's side of the remote (ARCHITECTURE.md, "Protocol (v2)"), the engine half: the account's identity
// and paired devices in $.store, the relay posts on the 2 s clock within the polling budget, pairing, and the
// effects of the devices' commands. What the frames mean is decided in link.ts, which has no engine in it.
//
// The engine follows `$` only within a file, so everything here that calls the engine stays in this file,
// and register.tsx wires it with `wireRemote(on, options)`.

type $ = EngineInterface

const streamsA = atom({ plugin: 'streams', key: 'streams' } as const, [])
const currentA = atom({ plugin: 'streams', key: 'current' } as const, '')
const rowsA = atom({ plugin: 'streams', key: 'rows' } as const, [])
const sourcesA = atom({ plugin: 'streams', key: 'sources' } as const, { since: 0, files: [] as string[] })
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const workflowsA = atom({ plugin: 'streams', key: 'workflows' } as const, {})
const verdictsA = atom({ plugin: 'streams', key: 'verdicts' } as const, {})
const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
/** The status card's git rows, shared with the card (ui/bar.tsx): one read serves both while it is fresh. */
const statusGitA = atom({ plugin: 'streams', key: 'statusGit' } as const, { lines: [], at: 0 })
/** The permissions held now, for the band above the prompt (read while drawn, so it redraws as they change). */
/** What the session answered for an absent person, shown in the band for a while. */
const focusA = atom({ plugin: 'streams', key: 'focus' } as const, '')
const viewA = atom({ plugin: 'streams', key: 'view' } as const, '')
const loopStreamA = atom({ plugin: 'streams', key: 'loopStream' } as const, {})
const remoteNoteA = atom({ plugin: 'streams', key: 'remoteNote' } as const, { text: '', until: 0 })
/** This session's open channels with devices, kept across a reload of the plugin ($.state outlives it; link.ts `kept`). */
const remoteConnsA = atom({ plugin: 'streams', key: 'remoteConns' } as const, { room: '', session: '', conns: [] as KeptConn[] })
/** How long the band says the session chose for the person. */
const NOTE_MS = 2 * 60_000
/** What the band says when the service refuses this account, and for how long after each refusal. */
export const REFUSED_TOKEN = 'Streams did not accept this account: run /streams connect to sign in again.'
export const REFUSED_PLAN = 'Your Streams trial has ended: run /streams billing to subscribe and keep your phone connected.'
export const REFUSED_ROOM = "Streams refused this computer's phone room: another Streams account holds it. Run /streams connect with the account that set it up."
/** The Streams site: the hosted relay builds its sign-in and billing pages here, not on its own origin. */
export const SITE = 'https://streams.macleodlabs.com'
/** The hosted relay, whose pages are on SITE. */
export const HOSTED_RELAY = 'https://relay.claudeflow.workers.dev'
/** Where `/streams billing` may send the browser: Stripe's own pages, or the site's sign-in for billing. */
const BILLING_ORIGINS = ['https://checkout.stripe.com', 'https://billing.stripe.com', SITE]

/**
 * The `token` setting holds `<origin>#<token>`: the relay that issued it. A token is only ever sent there, so setting
 * another relay (or a mistyped one) never hands it to someone else; that relay needs its own `/streams connect`.
 */
export function tokenFor(stored: string, relayUrl: string): string {
  const at = stored.indexOf('#')
  const [origin, token] = at < 0 ? [HOSTED_RELAY, stored] : [stored.slice(0, at), stored.slice(at + 1)]
  return token && origin === originOf(relayUrl) ? token : ''
}
const REFUSED_NOTE_MS = 10 * 60_000

/** Where the account's remote state is kept in $.store (one per config dir, shared by its sessions). */
export const STORE = {
  /** `{ room, token, sk }`: the room id, the relay token, this account's X25519 secret key (all b64u). */
  identity: 'remote:identity',
  /** `[{ id, pk, credentialId, credentialKey, label, pairedAt }]`: every paired phone or tablet. */
  devices: 'remote:devices',
  /** `{ secret, until }`: an open pairing, valid ten minutes for any number of devices. */
  pairing: 'remote:pairing',
  /** `[{ secret, until, project, role, days }]`: shared invites until they expire, one person each. */
  invites: 'remote:invites',
  /**
   * `<relay origin>#<token>`: the Streams token `/streams connect` got (tokenFor), shared by the account's sessions.
   * Not a setting: settings are shown at install and in /config, and the token is nobody's to type.
   */
  token: 'remote:token',
} as const

/** How often the session looks for news to send and commands to take while a device is active. */
export const TICK_MS = 2000

export type RemoteOptions = {
  /** The Claudeflow relay's address (the `relayUrl` setting), e.g. https://relay.<you>.workers.dev; '' when unset. */
  relayUrl: string
  /** This account's Streams token (the `token` setting, kept in secure storage), from `/streams connect`; '' when none. */
  token: string
}

/** This session as the devices see it; set at session start. */
let me: Snapshot['session'] | undefined
/** This session's project, as shared invites name it: its working directory. */
let myCwd = ''
/** The sealed link to the devices, made once the account has an identity. */
let link: Link | undefined
/** What was last kept of the link's channels in $.state (`remoteConnsA`), to write them only when that changes. */
let keptMark = ''
/** A tick is running: the next one waits, so two posts never race on the same link. */
let isTicking = false
/** When the running tick began: one still running after TICK_STUCK_MS is given up on (see remoteTick). */
let tickAt = 0
/**
 * $.http.fetch has no timeout of its own: a request on a connection that died under it (the Mac slept, the network
 * changed) may never settle. Past this it counts as failed, and the link backs off and posts again.
 */
export const FETCH_MS = 20_000
/**
 * A tick that has run this long is stuck on something that will not settle; the next tick goes ahead without it,
 * or this session would never post again and every phone would find the Mac gone until Claude restarts.
 */
export const TICK_STUCK_MS = 60_000

/** A `wait` is held at the relay: one at a time. */
let isWaiting = false
/** The room and its token, as the last tick read them: what a `wait` is asked with. */
let waitAs: { room: string; token: string } | undefined
/** A relay that does not answer `wait` (an older one, or failing) is not asked again until this time. */
let waitOffUntil = 0
/** How long `wait` rests after the relay did not answer it. */
export const WAIT_OFF_MS = 5 * 60_000

/** How long a removed guest's device is remembered as removed. */
const REMOVED_DAYS = 30

/** A phone's Run now is taken at most once in this long per loop. */
const RUN_NOW_GAP_MS = 30_000
/** When each loop's tick was last run from a phone, by stream id. */
const ranNowAt = new Map<string, number>()

/** An answer to a held prompt or question: from a phone (its command id) or the Mac (the band, the terminal dialog). */
type Answer = { by: 'phone' | 'mac'; decision?: 'allow' | 'deny'; label?: string; command?: string }
/**
 * Permission prompts and questions held for an answer, by call id. The first answer wins (`winner`), from either
 * side; a later one is told what won.
 */
const held = new Map<string, { ask?: PendingPermission; question?: PendingQuestion; winner?: Answer; resolve: (a: Answer) => void }>()
/** What became of the ones no longer held, by call id, newest last: for a late tap, and for the snapshot. */
const settled = new Map<string, Settled>()

/** Answers a held one if nothing has yet, and says which answer stands. */
function answerHeld(id: string, a: Answer): Answer | undefined {
  const h = held.get(id)
  if (h && !h.winner) {
    h.winner = a
    h.resolve(a)
  }
  return h?.winner
}

const whyOf = (a: Answer): AckWhy => (a.by === 'mac' ? 'answered on Mac' : a.label !== undefined ? 'chosen' : a.decision === 'allow' ? 'allowed' : 'denied')

function settle(id: string, why: AckWhy, at: number, label?: string) {
  settled.delete(id)
  settled.set(id, { id, why, at, ...(label !== undefined ? { label } : {}) })
  if (settled.size > 50) settled.delete(settled.keys().next().value!)
}

let options: RemoteOptions = { relayUrl: '', token: '' }
/** Which system this session runs on (platform.ts), found at session start. */
let platform: Platform = 'darwin'
/** What the phone side says on a system it does not run on yet. */
export const NOT_ON_WINDOWS = 'Streams on your phone does not run on Windows yet: it works from macOS and Linux.'

/**
 * A pairing write must not lose to history: when the engine refuses it (the shared store is past 4 MiB), drop the
 * largest other project's history and try again, a few times, before giving up.
 */
async function saveRemote($: $, key: string, value: unknown) {
  for (let tries = 0; ; tries++) {
    try {
      return await $.store.set(key, value)
    } catch (err) {
      const others = (await $.store.keys()).filter(k => k.startsWith(storeKey('')) && k !== storeKey(myCwd))
      if (tries >= 5 || !others.length) throw err
      const sizes = await Promise.all(others.map(async k => ({ k, size: JSON.stringify(await $.store.get(k)).length })))
      await $.store.delete(sizes.sort((a, b) => b.size - a.size)[0]!.k)
    }
  }
}

/** At session start: note who this session is, and start the clock that keeps the devices current. */
async function remoteStart($: $, e: { cwd: string }) {
  const [id, configDir] = await Promise.all([$.session.id(), $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)])
  me = { id, account: accountOf(configDir ?? ''), project: e.cwd.split('/').pop() || e.cwd, busy: false }
  myCwd = e.cwd
  const osEnv = await $.env.get('OS').catch(() => undefined)
  const uname = osEnv === 'Windows_NT' ? undefined : await $.process.run(['uname', '-s'], { timeoutMs: 5000 }).catch(() => undefined)
  platform = platformOf(osEnv, uname?.exitCode === 0 ? uname.stdout : undefined)
  $.clock.every(TICK_MS, () => {
    void remoteTick($).catch(() => {})
    void remoteWait($).catch(() => {})
    void connectTick($).catch(() => {})
  })
}

/**
 * While a device is active, one `wait` is held at the relay, answered the moment that device sends anything: a tap,
 * an Allow, a hello. Then the session posts at once, so what the person did reaches the Mac in about a second instead
 * of at the next poll (6 s while looking, 15 s otherwise). The polls still run: a wait only makes the next one early.
 */
async function remoteWait($: $) {
  if (isWaiting || !link || !waitAs || !me || !options.relayUrl || !options.token || !link.isWatched()) return
  const now = await $.clock.now()
  if (now < waitOffUntil) return
  isWaiting = true
  try {
    const r = await Promise.race([
      $.http
        .fetch(`${options.relayUrl.replace(/\/+$/, '')}/v1/room/${waitAs.room}/wait`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
          body: JSON.stringify({ token: waitAs.token, session: me.id, since: link.cursor() }),
        })
        .catch(() => undefined),
      $.clock.sleep(FETCH_MS).then(() => undefined, () => undefined),
    ])
    let isWoken: boolean | undefined
    try {
      isWoken = r?.ok ? (JSON.parse(r.text) as { wake?: unknown }).wake === true : undefined
    } catch {}
    if (isWoken === undefined) waitOffUntil = now + WAIT_OFF_MS
    if (isWoken) {
      link.wake()
      await remoteTick($)
    }
  } finally {
    isWaiting = false
  }
}

/**
 * Every tick: post `up` when the link says one is due (link.ts, `next`), sending welcomes and sealed snapshots and
 * taking back hellos and commands. Only the effects are here: $.store, the post itself, and the commands.
 */
async function remoteTick($: $) {
  // Read each tick: another session of the account may have connected or disconnected since.
  options.token = tokenFor(String((await $.store.get(STORE.token)) ?? ''), options.relayUrl)
  // No Streams token, no traffic: the phone is the Streams service's, and `/streams connect` signs in to it.
  if (!options.relayUrl || !options.token || !me || platform === 'win32') return
  const now = await $.clock.now()
  if (isTicking && now - tickAt < TICK_STUCK_MS) return
  isTicking = true
  tickAt = now
  try {
    const note = await read($, remoteNoteA)
    if (note.text && now >= note.until) await update($, remoteNoteA, () => ({ text: '', until: 0 }))
    const [identity, stored, pairing, invites] = await Promise.all([
      $.store.get(STORE.identity).then(identityOf),
      $.store.get(STORE.devices).then(devicesOf),
      $.store.get(STORE.pairing).then(pairingOf),
      $.store.get(STORE.invites).then(invitesOf),
    ])
    if (!identity) return
    waitAs = { room: identity.room, token: identity.token }
    if (link?.room !== identity.room) {
      // After /reload-plugins the channels this session had are taken up again: the phones still hold theirs.
      const was = await read($, remoteConnsA)
      const kept = was.room === identity.room && was.session === me.id ? was.conns : []
      link = createLink({ identity, session: me.id, origin: originOf(options.relayUrl), project: myCwd, kept })
    }
    let devices = stored
    // No device could answer, or the relay is backing off: no snapshot is made, and the relay is not asked.
    if (link.isQuiet({ devices, pairing, invites, now })) return
    // The owner's devices also see who this project is shared with (the link keeps it from shared ones).
    const people = devices.flatMap(d =>
      d.role && !d.removed && d.project === myCwd
        ? [{ id: d.id, label: d.label, role: roleOf(d)!, until: d.until ?? 0, pairedAt: d.pairedAt, ...(d.browserKey ? { browserKey: true } : {}) }]
        : [],
    )
    const snapshot = { ...(await snapshotNow($, me)), ...(people.length ? { people } : {}) }
    let post = link.next({ devices, pairing, invites, now, snapshot, isHolding: held.size > 0 })
    let hasAcked = false
    while (post) {
      const r = await Promise.race([
        $.http
          .fetch(`${options.relayUrl.replace(/\/+$/, '')}/v1/room/${identity.room}/up`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${options.token}` },
            body: JSON.stringify(post),
          })
          .catch(() => undefined),
        $.clock.sleep(FETCH_MS).then(() => undefined, () => undefined),
      ])
      // The service turned this account away: say why above the prompt, rather than back off without a word.
      const refusal = r?.status === 401 ? REFUSED_TOKEN : r?.status === 402 ? REFUSED_PLAN : r?.status === 403 ? REFUSED_ROOM : undefined
      if (refusal) await update($, remoteNoteA, n => (n.text === refusal && now < n.until ? n : { text: refusal, until: now + REFUSED_NOTE_MS }))
      const got = link.answered(r?.ok ? r.text : undefined, now)
      if (got.paired.length) {
        // Read fresh: another session may have paired a device meanwhile.
        devices = devicesOf(withPaired(devicesOf(await $.store.get(STORE.devices)), got.paired))
        // Not kept, a device is welcomed now and unknown at its next unlock: say so on the Mac rather than fail quietly.
        await saveRemote($, STORE.devices, devices).catch(async err => {
          await update($, remoteNoteA, () => ({ text: `Could not keep ${got.paired.map(d => d.label).join(', ')}: the Streams store is full`, until: now + NOTE_MS }))
          throw err
        })
      }
      for (const c of got.commands) {
        // Every command is acked, so the phone shows what came of it instead of guessing on a slow network.
        const done = await phoneCommand($, c.command).catch((): Omit<Ack, 't' | 'id'> => ({ ok: false }))
        link.ack(c.device, { t: 'ack', id: c.command.id, ...done })
      }
      // The acks go in this tick, once: a phone waiting on Allow should not wait for the next one.
      const isAcking: boolean = got.commands.length > 0 && !hasAcked
      hasAcked ||= isAcking
      post = got.again || isAcking ? link.next({ devices, pairing, invites, now, snapshot, isHolding: held.size > 0 }) : undefined
      // Kept when they change in a way a reload must not lose: a channel opened or gone, a box from a phone opened
      // (exact, so a reload cannot take a replayed command), or the send count past what the reload's margin
      // (KEPT_MARGIN) covers. Not after every post: a working session posts every 2 s.
      const conns = link.kept()
      const mark = conns.map(c => `${c.device.id}:${c.peerEph}:${c.lastOpened}:${Math.floor(c.sent / (KEPT_MARGIN / 2))}`).join('|')
      if (mark !== keptMark) {
        keptMark = mark
        await update($, remoteConnsA, () => ({ room: identity.room, session: me!.id, conns }))
      }
    }
  } finally {
    isTicking = false
  }
}

/** Everything the phone draws for this session now, held permissions included; sealed per device by the link. */
async function snapshotNow($: $, session: Snapshot['session']): Promise<Snapshot> {
  const [streams, busy, agents, inflight, outcome, rows, loops, workflows, verdicts, updates, now] = await Promise.all([
    read($, streamsA),
    read($, busyA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, rowsA),
    read($, loopsA),
    read($, workflowsA),
    read($, verdictsA),
    read($, updatesA),
    $.clock.now(),
  ])
  const facts: Facts = { busy, current: await read($, currentA), agents, inflight, outcome, rows, loops, workflows, verdicts, now }
  let git = await read($, statusGitA)
  if (now - git.at >= HEARTBEAT_MS) {
    const r = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 }).catch(() => undefined)
    git = { lines: r?.exitCode === 0 ? gitStatus(r.stdout) : [], at: now }
    await update($, statusGitA, () => git)
  }
  const card = cardOf(streamsNow(facts, streams), { git: git.lines, rateLimits: (await $.session.usage().catch(() => undefined))?.rateLimits })
  const model = await $.session.model().catch(() => undefined)
  return snapshotOf({
    session: { ...session, busy, proto: PROTO, ...(model ? { model } : {}) },
    lines: card.lines,
    streams,
    colorOf,
    agents: Object.values(agents),
    rows,
    status: [...card.git, ...card.tickets],
    limits: card.limits,
    updates,
    permissions: [...held.values()].flatMap(h => (h.ask ? [h.ask] : [])),
    questions: [...held.values()].flatMap(h => (h.question ? [h.question] : [])),
    settled: [...settled.values()].filter(x => now - x.at < SETTLED_MS).slice(-20),
    loops,
    workflows,
    now,
    archived: streams.filter(s => s.archived).slice(-30).map(s => ({ id: s.id, name: s.name, color: colorOf(s) })),
  })
}

/**
 * Waits for `answered` while a paired device keeps looking: no deadline. Undefined once none has looked for
 * NO_DEVICE_MS straight, or when `stop` aborts.
 *
 * The engine gives a hook 10 s of its own time per dispatch (HookBudget.ms) and counts a `$.clock` wait, or any
 * promise of the plugin's, against it; only a `$` call in flight stops that clock. So each 2 s step keeps a
 * `/bin/sleep 2` running beside the clock's wait: a prompt can wait for minutes while the hook spends only the moments
 * between steps. Past the budget the engine would drop the hook, and the terminal would ask after 10 s.
 */
async function awaitAnswer<T>($: $, answered: Promise<T>, stop: AbortSignal): Promise<T | undefined> {
  const got = answered.then(v => ({ v }))
  let quietSince: number | undefined
  const sleep = sleepArgv(platform, TICK_MS / 1000)
  // With no sleep to wait in, the hook would run past its budget: the terminal asks, as with no phone.
  if (!sleep) return undefined
  while (!stop.aborted) {
    const step = Promise.all([
      $.clock.sleep(TICK_MS, { signal: stop }).catch(() => undefined),
      $.process.run(sleep, { timeoutMs: 10_000 }).catch(() => undefined),
    ])
    const r = await Promise.race([got, step.then(() => undefined)])
    if (r) return r.v
    const now = await $.clock.now()
    if (link?.isLooking()) quietSince = undefined
    else if (now - (quietSince ??= now) >= NO_DEVICE_MS) return undefined
  }
  return undefined
}

/** The calls tool.check put to the mode's decider, by tool and input: PermissionRequest does not name its call. */
const askedIds = new Map<string, string>()
const callKey = (tool: string, input: unknown) => `${tool}\0${JSON.stringify(input ?? null)}`

/** Whether a dialog holds the keys now: the engine refuses to fill the prompt box while one does. */
const isDialogUp = async ($: $): Promise<boolean> =>
  (await $.prompt.fill({ text: '', mode: 'insert' }).catch(() => undefined))?.refusal === 'dialog'

/** How long a permission request looks for the terminal's dialog before leaving the call to it alone. */
const DIALOG_WAIT_MS = 1_500

/** The phone's answer, or undefined once the dialog is gone (answered at the Mac) or the request is withdrawn. */
async function whileDialog<T>($: $, answered: Promise<T>, stop: AbortSignal): Promise<T | undefined> {
  const got = answered.then(v => ({ v }))
  while (!stop.aborted) {
    const r = await Promise.race([got, $.clock.sleep(TICK_MS, { signal: stop }).then(() => undefined, () => undefined)])
    if (r) return r.v
    if (!(await isDialogUp($))) return undefined
  }
  return undefined
}

type PermissionHookResult = { decision?: { behavior: 'allow' } | { behavior: 'deny'; message?: string } }

/**
 * A permission prompt that needs the person (PermissionRequest: rules and auto mode's classifier have passed it on)
 * also goes to the paired devices, with "also on your phone" under the terminal's own dialog. The first answer wins:
 * the phone's is this hook's decision, which closes the dialog; one at the Mac closes the dialog and ends the hold.
 * Where the dialog is not up while this hook runs, it steps aside at once: the terminal never waits on a phone.
 */
async function holdManual<R extends PermissionHookResult>(
  $: $,
  e: { tool_name: string; tool_input: unknown },
  next: (e: never) => Promise<R>,
  signal: AbortSignal,
): Promise<R | PermissionHookResult> {
  const id = askedIds.get(callKey(e.tool_name, e.tool_input))
  const devices = devicesOf(await $.store.get(STORE.devices))
  if (!id || !link || devices.length === 0) return next(e as never)
  // Other PermissionRequest hooks run as ever; a decision of theirs stands.
  const below = next(e as never)
  const decided = below.then(r => (r?.decision ? r : new Promise<never>(() => {})))
  const started = await $.clock.now()
  let isUp = await isDialogUp($)
  while (!isUp && (await $.clock.now()) - started < DIALOG_WAIT_MS) {
    await $.clock.sleep(250).catch(() => undefined)
    isUp = await isDialogUp($)
  }
  if (!isUp) return below
  const ask: PendingPermission = { id, tool: e.tool_name, summary: permissionSummary(e.tool_name, e.tool_input), at: started, since: started }
  let resolve: (a: Answer) => void = () => {}
  const answered = new Promise<Answer>(r => (resolve = r))
  held.set(id, { ask, resolve })
  try {
    $.ui.notice(id, 'also on your phone')
  } catch {}
  try {
    const first = await Promise.race([decided.then(r => ({ hooks: r })), whileDialog($, answered, signal).then(a => ({ a }))])
    const now = await $.clock.now()
    if ('hooks' in first) {
      answerHeld(id, { by: 'mac' })
      settle(id, 'answered on Mac', now)
      return first.hooks
    }
    if (!first.a?.decision) {
      answerHeld(id, { by: 'mac' })
      settle(id, 'answered on Mac', now)
      return {}
    }
    settle(id, whyOf(first.a), now)
    return first.a.decision === 'allow'
      ? { decision: { behavior: 'allow' } }
      : { decision: { behavior: 'deny', message: 'Denied on your phone' } }
  } finally {
    held.delete(id)
    try {
      $.ui.notice(id, undefined)
    } catch {}
  }
}

/**
 * Claude asks a question with options (AskUserQuestion) while a device is looking: the terminal's dialog shows as
 * always (`next`), the phone shows the options, and the first answer wins (returning while `next` is pending closes
 * the dialog). If no device looks for NO_DEVICE_MS, the option marked "(Recommended)" is taken and Claude is told so;
 * with none marked, the terminal's dialog stays the only way to answer.
 */
async function holdQuestion<R>($: $, e: { tool: string; tool_use_id?: string; questions?: unknown }, next: (e: never) => Promise<R>): Promise<R | { result: unknown; context?: string[] }> {
  const id = e.tool_use_id
  const since = await $.clock.now()
  const question = id && link?.isLooking() ? questionOf(e, id, since) : undefined
  if (!id || !question) return next(e as never)
  let resolve: (a: Answer) => void = () => {}
  const answered = new Promise<Answer>(r => (resolve = r))
  held.set(id, { question, resolve })
  const stop = new AbortController()
  const beneath = next(e as never)
  // Answered from the phone, this hook returns while the dialog is up, which ends it: that rejection is expected.
  beneath.catch(() => undefined)
  const resultOf = (label: string) => ({ questions: e.questions, answers: { [question.question]: label } })
  try {
    const first = await Promise.race([beneath.then(r => ({ mac: r })), awaitAnswer($, answered, stop.signal).then(a => ({ phone: a }))])
    const now = await $.clock.now()
    if ('mac' in first) {
      answerHeld(id, { by: 'mac' })
      settle(id, 'answered on Mac', now)
      return first.mac
    }
    if (first.phone?.label !== undefined) {
      settle(id, 'chosen', now, first.phone.label)
      return { result: resultOf(first.phone.label) }
    }
    const rec = question.options.find(o => o.isRecommended)
    if (!rec) {
      // It leaves the phone now; the terminal's dialog is still up.
      held.delete(id)
      settle(id, 'moved to Mac', now)
      return await beneath
    }
    answerHeld(id, { by: 'mac', label: rec.label })
    settle(id, 'chose recommended', now, rec.label)
    await update($, remoteNoteA, () => ({ text: `Chose the recommended answer: ${rec.label} (no answer for 2m)`, until: now + NOTE_MS }))
    return { result: resultOf(rec.label), context: [`No answer from the person after 2 minutes; chose the recommended option: ${rec.label}`] }
  } finally {
    stop.abort()
    held.delete(id)
  }
}

/**
 * One thing a device asked, opened from its sealed box: an answer filed in its stream, a stop, a permission decided
 * or a question answered, a workflow run stopped, or a loop ended or ticked now. An `allow` reaches here only after
 * link.ts checked its passkey assertion. What it returns is acked; `ok: false` with no `why` means it was not done
 * (the run or loop is no longer there, or a tick is not due).
 */
/** Files arriving from a phone, by blob id: their base64 chunks, until a prompt names them. */
const uploads = new Map<string, { parts: string[]; got: number; at: number }>()
/** A blob nobody named within this long is dropped. */
const UPLOAD_MS = 10 * 60_000

/**
 * Writes the files a prompt names to ~/.claudeflow/uploads/<blob>/<name> and gives their paths, or undefined if one
 * has not fully arrived. fs.write takes text only, so the base64 is written and decoded by the system's base64.
 */
async function saveFiles($: $, files: readonly PhoneFile[]): Promise<string[] | undefined> {
  const done = files.map(f => uploads.get(f.blob))
  if (done.some(u => !u || u.got < u.parts.length)) return undefined
  const home = (await $.env.get('HOME').catch(() => undefined)) || '/tmp'
  const paths: string[] = []
  for (const [i, f] of files.entries()) {
    const dir = `${home}/.claudeflow/uploads/${f.blob}`
    const path = `${dir}/${f.name}`
    const mkdir = mkdirArgv(platform, dir)
    const decode = decodeArgv(platform, `${path}.b64`, path)
    const remove = removeArgv(platform, `${path}.b64`)
    if (!mkdir || !decode || !remove) return undefined
    await $.process.run(mkdir, { timeoutMs: 10_000 })
    await $.fs.write(`${path}.b64`, done[i]!.parts.join(''))
    const r = await $.process.run(decode, { timeoutMs: 20_000 })
    await $.process.run(remove, { timeoutMs: 10_000 }).catch(() => undefined)
    if (r.exitCode !== 0) return undefined
    uploads.delete(f.blob)
    paths.push(path)
  }
  return paths
}

async function phoneCommand($: $, c: PhoneCommand): Promise<Omit<Ack, 't' | 'id'>> {
  // Sharing this project (the owner's devices only; the link refuses these from shared ones).
  if (c.kind === 'invite') {
    const now = await $.clock.now()
    // The phone's own secret (PROTO 3): its link is already on screen, so this one must be the one kept.
    const secret = c.secret ?? randomId(32)
    const open = invitesOf(await $.store.get(STORE.invites)).filter(i => now < i.until)
    await saveRemote($, STORE.invites, [...open, { secret, until: now + INVITE_MS, project: myCwd, role: c.role, days: SHARE_DAYS }].slice(-20))
    return { ok: true, secret }
  }
  if (c.kind === 'setRole' || c.kind === 'extend' || c.kind === 'forgetDevice') {
    const now = await $.clock.now()
    const devices = devicesOf(await $.store.get(STORE.devices))
    // Only someone this project was shared with: never the owner's own devices, nor another project's people.
    const d = devices.find(x => x.id === c.deviceId && x.role && !x.removed && x.project === myCwd)
    if (!d) return { ok: false }
    // Removed, it is kept as removed for REMOVED_DAYS, so its next unlock is told that rather than "unknown device".
    const changed: Device =
      c.kind === 'setRole' ? { ...d, role: c.role } : c.kind === 'extend' ? { ...d, until: Math.max(now, d.until ?? 0) + SHARE_DAYS * DAY_MS } : { ...d, removed: true, until: now }
    const kept = devices.filter(x => !(x.removed && (x.until ?? 0) < now - REMOVED_DAYS * DAY_MS))
    await saveRemote($, STORE.devices, kept.map(x => (x.id === d.id ? changed : x)))
    return { ok: true }
  }
  if (c.kind === 'chunk') {
    const now = await $.clock.now()
    for (const [blob, u] of uploads) if (now - u.at > UPLOAD_MS) uploads.delete(blob)
    const u = uploads.get(c.blob) ?? { parts: Array<string>(c.of).fill(''), got: 0, at: now }
    if (u.parts.length !== c.of) return { ok: false }
    if (!u.parts[c.part]) u.got++
    u.parts[c.part] = c.data
    u.at = now
    uploads.set(c.blob, u)
    return { ok: true }
  }
  if (c.kind === 'permission' || c.kind === 'choose') {
    const h = held.get(c.requestId)
    const fits = c.kind === 'permission' ? !!h?.ask : !!h?.question?.options.some(o => o.label === c.label)
    const won = fits ? answerHeld(c.requestId, c.kind === 'permission' ? { by: 'phone', decision: c.decision, command: c.id } : { by: 'phone', label: c.label, command: c.id }) : undefined
    if (won) return won.command === c.id ? { ok: true, why: whyOf(won) } : { ok: false, why: whyOf(won) }
    // Too late or never held: say what became of it (the Mac answered, it moved there), so the card resolves.
    return { ok: false, why: settled.get(c.requestId)?.why ?? 'unknown request' }
  }
  if (c.kind === 'archive' || c.kind === 'restore') {
    // Only a stream this session has. One already so (the phone sent it again, or another device did it first) is
    // what was asked: acked as done, so the phone keeps the card where the swipe put it.
    const st = (await read($, streamsA)).find(x => x.id === c.streamId)
    if (!st) return { ok: false, why: 'no such stream' }
    if (!!st.archived === (c.kind === 'archive')) return { ok: true }
    // As the pane's ✕ and restore do (ui/pane.tsx setArchived): $ calls stay in this file, at the call site.
    const archived = c.kind === 'archive'
    const now = await $.clock.now()
    await update($, streamsA, list => list.map(s => (s.id === c.streamId ? { ...s, archived, ...(archived ? {} : { restoredAt: now }) } : s)))
    if (archived && (await read($, focusA)) === c.streamId) await update($, focusA, () => '')
    if (archived && (await read($, viewA)) === c.streamId) await update($, viewA, () => '')
    const [cwd, streams, rows, loopStream] = await Promise.all([$.session.cwd(), read($, streamsA), read($, rowsA), read($, loopStreamA)])
    // Kept for the next session when the store has room; the archive itself holds either way.
    await $.store.set(storeKey(cwd), savedOf(streams, rows, loopStream, await read($, sourcesA))).catch(() => undefined)
    return { ok: true }
  }
  if (c.kind === 'stop') {
    if (mem.runningTurn) await $.turn.abort({ turnId: mem.runningTurn })
    return { ok: true }
  }
  if (c.kind === 'stopTask') {
    // Only a run this session shows and is still going: the phone cannot stop any task it names.
    if ((await read($, workflowsA))[c.taskId]?.status !== 'running') return { ok: false }
    const r = await $.tool.call({ tool: 'TaskStop', task_id: c.taskId })
    return { ok: r.deny === undefined && r.isError !== true }
  }
  if (c.kind === 'stopLoop' || c.kind === 'runTick') {
    const loop = (await read($, loopsA))[c.streamId]
    if (!loop) return { ok: false }
    if (c.kind === 'runTick') {
      // A tick is its prompt run in its stream: a slash command (a /loop) runs as one, other text is submitted. An
      // autonomous loop's sentinel is no prompt to send.
      const text = loop.prompt?.trim() ?? ''
      if (!text || /^<<[\w-]+>>$/.test(text)) return { ok: false }
      // Each tick is a model turn the person pays for: none while that stream's turn runs, and repeated taps within
      // RUN_NOW_GAP_MS run it once.
      const now = await $.clock.now()
      const [busy, current] = await Promise.all([read($, busyA), read($, currentA)])
      if ((busy && current === c.streamId) || now - (ranNowAt.get(c.streamId) ?? 0) < RUN_NOW_GAP_MS) return { ok: false }
      ranNowAt.set(c.streamId, now)
      await update($, currentA, () => c.streamId)
      const slash = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(text)
      if (slash?.[1]) await $.command.run({ command: slash[1], args: slash[2] ?? '' })
      else {
        // Routing (streams/routing.ts) files it as this loop's tick, not as something the person typed.
        mem.runNow = { streamId: c.streamId, text }
        await $.prompt.submit({ text, asUser: true })
      }
      return { ok: true }
    }
    // Ended as the model would end it. A plugin's own call skips its own hooks, so the loop is cleared here too.
    const input =
      loop.kind === 'wakeup'
        ? { tool: 'ScheduleWakeup' as const, stop: true }
        : loop.kind === 'cron' && loop.id
          ? { tool: 'CronDelete' as const, id: loop.id }
          : loop.kind === 'monitor' && loop.id
            ? { tool: 'TaskStop' as const, task_id: loop.id }
            : undefined
    if (!input) return { ok: false }
    const r = await $.tool.call(input)
    const now = await $.clock.now()
    await update($, loopsA, m => afterCall(m, c.streamId, { tool: input.tool, input, result: r.deny === undefined ? r.result : undefined, isError: r.isError === true, now }))
    return { ok: r.deny === undefined && r.isError !== true }
  }
  // Files go first: a prompt is sent only with all of them on disk, for Claude to read by path.
  const paths = c.files?.length ? await saveFiles($, c.files) : []
  if (!paths) return { ok: false, why: RETRY_WHY }
  const text = paths.length ? `${c.text.trim()}\n\n${paths.map(p => `[Attached from my phone: ${p}]`).join('\n')}`.trim() : c.text
  // The stream is made current first, so the answer is filed where it was asked; '' is a new prompt routing files.
  if ((await read($, streamsA)).some(st => st.id === c.streamId)) await update($, currentA, () => c.streamId)
  await $.prompt.submit({ text, asUser: true })
  return { ok: true }
}

/**
 * `/streams phone`: open a pairing (a secret valid ten minutes, for any number of devices) and show the relay's
 * pairing page with its QR code in the Mac's browser. `devices` lists the paired ones; `forget <id|all>` removes
 * them. Says what it did, or what is missing.
 */
/** A `/streams connect` under way: the secret its polls carry, when it gives up, and when it may poll next. */
let connecting: { relay: string; device: string; until: number; every: number; nextAt: number } | undefined

/** What `/streams phone` says before this account has signed in to Streams. */
export const NOT_CONNECTED = 'Streams on your phone needs a Streams account: run `/streams connect` to sign in with GitHub or email (3-day free trial).'

/**
 * `/streams connect`: asks the service for a sign-in code, opens its sign-in page in the browser, and polls on the
 * session's clock until the person has signed in (connectTick), then keeps the token in the `token` setting, which
 * Claude Code holds in secure storage. Says what it did, or what is missing.
 */
async function connect($: $): Promise<string> {
  if (platform === 'win32') return NOT_ON_WINDOWS
  const relay = options.relayUrl.replace(/\/+$/, '')
  const label = `${me?.account ?? 'Claude Code'} (Claude Code)`
  const r = await $.http
    .fetch(`${relay}/v1/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) })
    .catch(() => undefined)
  let c: { code?: unknown; device?: unknown; url?: unknown; interval?: unknown; expiresIn?: unknown } = {}
  try {
    c = r?.ok ? JSON.parse(r.text) : {}
  } catch {}
  // The page opened must be the service's own (the hosted relay's is on the site): another site gets no browser opened.
  const pages = [originOf(relay), ...(originOf(relay) === HOSTED_RELAY ? [SITE] : [])]
  if (typeof c.code !== 'string' || typeof c.device !== 'string' || typeof c.url !== 'string' || !pages.some(o => c.url!.toString().startsWith(`${o}/`))) {
    return `Could not reach the Streams service at ${relay}. Try \`/streams connect\` again in a minute.`
  }
  const now = await $.clock.now()
  const every = Math.max(2, Math.min(30, Number(c.interval) || 2)) * 1000
  connecting = { relay: originOf(relay), device: c.device, until: now + Math.min(15 * 60, Number(c.expiresIn) || 600) * 1000, every, nextAt: now + every }
  const open = openArgv(platform, c.url)
  const opened = open ? await $.process.run(open, { timeoutMs: 10_000 }).catch(() => undefined) : undefined
  const where = opened?.exitCode === 0 ? 'Opened the sign-in page in your browser' : `Open ${c.url} in a browser`
  return `${where}. Check it shows ${c.code}, then sign in with GitHub or email. This session connects by itself once you have.`
}

/** Polls a `/streams connect` under way; keeps the token once the person has signed in. */
async function connectTick($: $) {
  const c = connecting
  if (!c) return
  const now = await $.clock.now()
  if (now < c.nextAt) return
  c.nextAt = now + c.every
  if (now > c.until) {
    connecting = undefined
    $.ui.toast('Streams sign-in expired. Run /streams connect to try again.')
    return
  }
  const r = await $.http
    .fetch(`${options.relayUrl.replace(/\/+$/, '')}/v1/connect/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: c.device }) })
    .catch(() => undefined)
  // Not signed in yet, or the service is down for a moment: ask again at the next poll.
  if (!r || r.status === 428 || r.status >= 500) return
  connecting = undefined
  let got: { token?: unknown; account?: { email?: unknown; login?: unknown } } = {}
  try {
    got = r.ok ? JSON.parse(r.text) : {}
  } catch {}
  if (typeof got.token !== 'string') {
    $.ui.toast('Streams sign-in expired. Run /streams connect to try again.')
    return
  }
  const who = typeof got.account?.login === 'string' ? got.account.login : typeof got.account?.email === 'string' ? got.account.email : 'your account'
  await $.store.set(STORE.token, `${c.relay}#${got.token}`)
  options.token = got.token
  $.ui.toast(`Connected to Streams as ${who}. /streams phone pairs your phone.`)
}

/**
 * `/streams billing`: subscribe (Stripe Checkout), or, for someone who already pays, the site's sign-in that leads to
 * Stripe's Portal. Opens only Stripe's pages or the site's.
 */
async function billing($: $): Promise<string> {
  if (platform === 'win32') return NOT_ON_WINDOWS
  if (!options.token) return NOT_CONNECTED
  const relay = options.relayUrl.replace(/\/+$/, '')
  const r = await $.http.fetch(`${relay}/v1/billing`, { method: 'POST', headers: { authorization: `Bearer ${options.token}` } }).catch(() => undefined)
  if (r?.status === 401) return REFUSED_TOKEN
  let url: unknown
  try {
    url = r?.ok ? (JSON.parse(r.text) as { url?: unknown }).url : undefined
  } catch {}
  if (typeof url !== 'string' || !BILLING_ORIGINS.some(o => url.toString().startsWith(`${o}/`))) return `Could not reach Streams billing. Try again in a minute, or go to ${SITE}/billing.`
  const open = openArgv(platform, url)
  const opened = open ? await $.process.run(open, { timeoutMs: 10_000 }).catch(() => undefined) : undefined
  return opened?.exitCode === 0 ? 'Opened Streams billing in your browser.' : `Open ${url} in a browser.`
}

/**
 * `/streams delete-account`: opens the site's page for deleting the Streams account. Deleting needs a fresh sign-in
 * there, never just this session's token. Run /streams disconnect afterwards to clear the token here too.
 */
async function deleteAccount($: $): Promise<string> {
  const url = `${SITE}/account/delete`
  const open = platform === 'win32' ? undefined : openArgv(platform, url)
  const opened = open ? await $.process.run(open, { timeoutMs: 10_000 }).catch(() => undefined) : undefined
  return `${opened?.exitCode === 0 ? 'Opened' : 'Open'} ${url} to delete your Streams account: sign in there and confirm. Then run /streams disconnect here.`
}

/** `/streams disconnect`: gives the token back to the service and forgets it here. */
async function disconnect($: $): Promise<string> {
  if (!options.token) return 'This account is not connected to Streams.'
  const relay = options.relayUrl.replace(/\/+$/, '')
  if (originOf(relay)) await $.http.fetch(`${relay}/v1/token/revoke`, { method: 'POST', headers: { authorization: `Bearer ${options.token}` } }).catch(() => undefined)
  await $.store.set(STORE.token, '')
  options.token = ''
  return 'Disconnected from Streams: this account no longer talks to the Streams service.'
}

async function remotePair($: $, args: string[]): Promise<string> {
  if (platform === 'win32') return NOT_ON_WINDOWS
  const relay = options.relayUrl.replace(/\/+$/, '')
  if (!options.token && args[0] !== 'devices' && args[0] !== 'forget') return NOT_CONNECTED
  const devices = devicesOf(await $.store.get(STORE.devices))
  if (args[0] === 'devices') {
    if (!devices.length) return 'No devices paired. `/streams phone` pairs one.'
    // A guest's device says whose project it shares; a removed one is kept only to tell it so.
    const what = (d: Device) => (d.removed ? '  removed' : d.role ? `  ${d.role} of ${d.project}` : '')
    return devices.map(d => `${d.label}  ${d.id}  paired ${new Date(d.pairedAt).toISOString().slice(0, 10)}${what(d)}`).join('\n')
  }
  if (args[0] === 'forget') {
    const which = args[1] ?? ''
    const kept = which === 'all' ? [] : devices.filter(d => d.id !== which)
    if (kept.length === devices.length) return `No device "${which}" to forget. \`/streams phone devices\` lists them; \`/streams phone forget all\` forgets every one.`
    await saveRemote($, STORE.devices, kept)
    return `Forgot ${devices.length - kept.length} of ${devices.length} devices. A forgotten device has to pair again with \`/streams phone\`.`
  }
  let identity = identityOf(await $.store.get(STORE.identity))
  if (!identity) {
    identity = { room: randomId(16), token: randomId(32), sk: newIdentity().sk }
    await saveRemote($, STORE.identity, identity)
  }
  const secret = randomId(32)
  await saveRemote($, STORE.pairing, { secret, until: (await $.clock.now()) + PAIRING_MS })
  // Everything after `#` stays in the browser: the relay never sees the secret.
  const url = `${relay}/pair#r=${identity.room}&k=${publicKeyOf(identity.sk)}&s=${secret}`
  const open = openArgv(platform, url)
  const r = open ? await $.process.run(open, { timeoutMs: 10_000 }).catch(() => undefined) : undefined
  return r?.exitCode === 0
    ? `Opened the pairing page from ${relay} in your browser. Scan its QR code with each phone or tablet within 10 minutes.`
    : 'Could not open your browser for the pairing page. Run `/streams phone` again once a browser can open.'
}

export function wireRemote(on: On, opts: RemoteOptions) {
  options = { ...opts, token: tokenFor(opts.token, opts.relayUrl) }
  // Interactive sessions only: a headless run has no one watching from a phone.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await remoteStart($, e)
    return next(e)
  })

  // tool.check's verdict is never changed: it only notes which call an `ask` was, for PermissionRequest below.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id) {
      askedIds.set(callKey(e.tool, e.input), e.tool_use_id)
      if (askedIds.size > 50) askedIds.delete(askedIds.keys().next().value!)
    }
    return verdict
  })

  on('classic.PermissionRequest', async ($, e, next) => (await holdManual($, e, next as never, next.signal)) as never)

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => (await holdQuestion($, e, next as never)) as never)

  // After the session chose an absent person's question for them, the band says so.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [note, now] = await Promise.all([read($, remoteNoteA), $.clock.now()])
    if (e.props.hasSurvey || !note.text || now >= note.until) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Text key="remote-note" dimColor>{note.text}</Text>
        {below}
      </Box>
    )
  })

  on('command.run', { command: 'streams' }, async ($, e, next) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    options.token = tokenFor(String((await $.store.get(STORE.token)) ?? ''), options.relayUrl)
    if (verb === 'connect') return { text: await connect($) }
    if (verb === 'disconnect') return { text: await disconnect($) }
    if (verb === 'billing') return { text: await billing($) }
    if (verb === 'delete-account') return { text: await deleteAccount($) }
    if (verb !== 'phone') return next(e)
    return { text: await remotePair($, rest) }
  })
}
