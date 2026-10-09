import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { mem } from '../state'
import { gitStatus } from '../status'
import { cardOf, colorOf, streamsNow, type Facts } from '../streams/model'
import { PAIRING_MS, createLink, devicesOf, identityOf, originOf, pairingOf, type Link } from './link'
import { newIdentity, publicKeyOf, randomId } from './seal'
import { HEARTBEAT_MS, PHONE_PERMISSION_MS, accountOf, permissionSummary, snapshotOf, type PendingPermission, type PhoneCommand, type Snapshot } from './snapshot'

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
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
/** The status card's git rows, shared with the card (ui/bar.tsx): one read serves both while it is fresh. */
const statusGitA = atom({ plugin: 'streams', key: 'statusGit' } as const, { lines: [], at: 0 })

/** Where the account's remote state is kept in $.store (one per config dir, shared by its sessions). */
export const STORE = {
  /** `{ room, token, sk }`: the room id, the relay token, this account's X25519 secret key (all b64u). */
  identity: 'remote:identity',
  /** `[{ id, pk, credentialId, credentialKey, label, pairedAt }]`: every paired phone or tablet. */
  devices: 'remote:devices',
  /** `{ secret, until }`: an open pairing, valid ten minutes for any number of devices. */
  pairing: 'remote:pairing',
} as const

/** How often the session looks for news to send and commands to take while a device is active. */
export const TICK_MS = 2000

export type RemoteOptions = {
  /** The Claudeflow relay's address (the `relayUrl` setting), e.g. https://claudeflow-relay.<you>.workers.dev; '' when unset. */
  relayUrl: string
}

/** This session as the devices see it; set at session start. */
let me: Snapshot['session'] | undefined
/** The sealed link to the devices, made once the account has an identity. */
let link: Link | undefined
/** A tick is running: the next one waits, so two posts never race on the same link. */
let isTicking = false

/** Permission prompts held for the devices, by call id, each with the answer that releases it. */
const held = new Map<string, { ask: PendingPermission; answer: (d: 'allow' | 'deny') => void }>()

let options: RemoteOptions = { relayUrl: '' }

/** At session start: note who this session is, and start the clock that keeps the devices current. */
async function remoteStart($: $, e: { cwd: string }) {
  const [id, configDir] = await Promise.all([$.session.id(), $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)])
  me = { id, account: accountOf(configDir ?? ''), project: e.cwd.split('/').pop() || e.cwd, busy: false }
  $.clock.every(TICK_MS, () => void remoteTick($).catch(() => {}))
}

/**
 * Every tick: post `up` when the link says one is due (link.ts, `next`), sending welcomes and sealed snapshots and
 * taking back hellos and commands. Only the effects are here: $.store, the post itself, and the commands.
 */
async function remoteTick($: $) {
  if (!options.relayUrl || !me || isTicking) return
  isTicking = true
  try {
    const now = await $.clock.now()
    const [identity, stored, pairing] = await Promise.all([
      $.store.get(STORE.identity).then(identityOf),
      $.store.get(STORE.devices).then(devicesOf),
      $.store.get(STORE.pairing).then(pairingOf),
    ])
    if (!identity) return
    if (link?.room !== identity.room) link = createLink({ identity, session: me.id, origin: originOf(options.relayUrl) })
    let devices = stored
    // No device could answer, or the relay is backing off: no snapshot is made, and the relay is not asked.
    if (link.isQuiet({ devices, pairing, now })) return
    const snapshot = await snapshotNow($, me)
    let post = link.next({ devices, pairing, now, snapshot, isHolding: held.size > 0 })
    while (post) {
      const r = await $.http
        .fetch(`${options.relayUrl.replace(/\/+$/, '')}/v1/room/${identity.room}/up`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(post),
        })
        .catch(() => undefined)
      const got = link.answered(r?.ok ? r.text : undefined, now)
      if (got.paired.length) {
        // Read fresh: another session may have paired a device meanwhile.
        const fresh = devicesOf(await $.store.get(STORE.devices))
        devices = [...fresh.filter(d => !got.paired.some(p => p.id === d.id)), ...got.paired]
        await $.store.set(STORE.devices, devices)
      }
      for (const c of got.commands) await phoneCommand($, c.command).catch(() => {})
      post = got.again ? link.next({ devices, pairing, now, snapshot, isHolding: held.size > 0 }) : undefined
    }
  } finally {
    isTicking = false
  }
}

/** Everything the phone draws for this session now, held permissions included; sealed per device by the link. */
async function snapshotNow($: $, session: Snapshot['session']): Promise<Snapshot> {
  const [streams, busy, agents, inflight, outcome, rows, loops, updates, now] = await Promise.all([
    read($, streamsA),
    read($, busyA),
    read($, agentsA),
    read($, inflightA),
    read($, outcomeA),
    read($, rowsA),
    read($, loopsA),
    read($, updatesA),
    $.clock.now(),
  ])
  const facts: Facts = { busy, current: await read($, currentA), agents, inflight, outcome, rows, loops, now }
  let git = await read($, statusGitA)
  if (now - git.at >= HEARTBEAT_MS) {
    const r = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5000 }).catch(() => undefined)
    git = { lines: r?.exitCode === 0 ? gitStatus(r.stdout) : [], at: now }
    await update($, statusGitA, () => git)
  }
  const card = cardOf(streamsNow(facts, streams), { git: git.lines, rateLimits: (await $.session.usage().catch(() => undefined))?.rateLimits })
  return snapshotOf({
    session: { ...session, busy },
    lines: card.lines,
    streams,
    colorOf,
    agents: Object.values(agents),
    rows,
    status: [...card.git, ...card.tickets],
    limits: card.limits,
    updates,
    permissions: [...held.values()].map(h => h.ask),
    now,
  })
}

/** While an unlocked device is looking, a permission prompt waits for its answer first; unanswered, the Mac asks as usual. */
async function holdPermission<V extends { decision: string; reason?: string }>($: $, e: { tool: string; input: unknown; tool_use_id?: string }, verdict: V): Promise<V> {
  const id = e.tool_use_id
  if (verdict.decision !== 'ask' || !link?.isLooking() || !id) return verdict
  const ask: PendingPermission = { id, tool: e.tool, summary: permissionSummary(e.tool, e.input), at: await $.clock.now() }
  let answer: (d: 'allow' | 'deny') => void = () => {}
  const answered = new Promise<'allow' | 'deny'>(resolve => (answer = resolve))
  held.set(id, { ask, answer })
  try {
    const decision = await Promise.race([answered, $.clock.sleep(PHONE_PERMISSION_MS).then(() => undefined)])
    return decision ? { ...verdict, decision, reason: `${decision === 'allow' ? 'Allowed' : 'Denied'} on your phone` } : verdict
  } finally {
    held.delete(id)
  }
}

/**
 * One thing a device asked, opened from its sealed box: an answer filed in its stream, a stop, or a permission
 * decided. An `allow` reaches here only after link.ts checked its passkey assertion.
 */
async function phoneCommand($: $, c: PhoneCommand) {
  if (c.kind === 'permission') {
    held.get(c.requestId)?.answer(c.decision)
    return
  }
  if (c.kind === 'stop') {
    if (mem.runningTurn) await $.turn.abort({ turnId: mem.runningTurn })
    return
  }
  // The stream is made current first, so the answer is filed where it was asked.
  if ((await read($, streamsA)).some(st => st.id === c.streamId)) await update($, currentA, () => c.streamId)
  await $.prompt.submit({ text: c.text, asUser: true })
}

const NO_RELAY = 'Set the relay address first: /config, streams, relayUrl (e.g. https://claudeflow-relay.<you>.workers.dev).'

/**
 * `/streams phone`: open a pairing (a secret valid ten minutes, for any number of devices) and show the relay's
 * pairing page with its QR code in the Mac's browser. `devices` lists the paired ones; `forget <id|all>` removes
 * them. Says what it did, or what is missing.
 */
async function remotePair($: $, args: string[]): Promise<string> {
  const relay = options.relayUrl.replace(/\/+$/, '')
  if (!originOf(relay)) return NO_RELAY
  const devices = devicesOf(await $.store.get(STORE.devices))
  if (args[0] === 'devices') {
    if (!devices.length) return 'No devices paired. `/streams phone` pairs one.'
    return devices.map(d => `${d.label}  ${d.id}  paired ${new Date(d.pairedAt).toISOString().slice(0, 10)}`).join('\n')
  }
  if (args[0] === 'forget') {
    const which = args[1] ?? ''
    const kept = which === 'all' ? [] : devices.filter(d => d.id !== which)
    if (kept.length === devices.length) return `No device "${which}" to forget. \`/streams phone devices\` lists them; \`/streams phone forget all\` forgets every one.`
    await $.store.set(STORE.devices, kept)
    return `Forgot ${devices.length - kept.length} of ${devices.length} devices. A forgotten device has to pair again with \`/streams phone\`.`
  }
  let identity = identityOf(await $.store.get(STORE.identity))
  if (!identity) {
    identity = { room: randomId(16), token: randomId(32), sk: newIdentity().sk }
    await $.store.set(STORE.identity, identity)
  }
  const secret = randomId(32)
  await $.store.set(STORE.pairing, { secret, until: (await $.clock.now()) + PAIRING_MS })
  // Everything after `#` stays in the browser: the relay never sees the secret.
  const url = `${relay}/pair#r=${identity.room}&k=${publicKeyOf(identity.sk)}&s=${secret}`
  const r = await $.process.run(['/usr/bin/open', url], { timeoutMs: 10_000 }).catch(() => undefined)
  return r?.exitCode === 0
    ? `Opened the pairing page from ${relay} in your browser. Scan its QR code with each phone or tablet within 10 minutes.`
    : 'Could not open your browser for the pairing page. Run `/streams phone` again once a browser can open.'
}

export function wireRemote(on: On, opts: RemoteOptions) {
  options = opts
  // Interactive sessions only: a headless run has no one watching from a phone.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await remoteStart($, e)
    return next(e)
  })

  on('tool.check', async ($, e, next) => holdPermission($, e, await next(e)))

  on('command.run', { command: 'streams' }, async ($, e, next) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb !== 'phone') return next(e)
    return { text: await remotePair($, rest) }
  })
}
