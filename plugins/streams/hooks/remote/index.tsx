import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { mem } from '../state'
import { gitStatus } from '../status'
import { cardOf, colorOf, streamsNow, type Facts } from '../streams/model'
import { PAIRING_MS, createLink, devicesOf, identityOf, originOf, pairingOf, type Link } from './link'
import { newIdentity, publicKeyOf, randomId } from './seal'
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
  type Settled,
  type Snapshot,
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
const busyA = atom({ plugin: 'streams', key: 'busy' } as const, false)
const agentsA = atom({ plugin: 'streams', key: 'agents' } as const, {})
const inflightA = atom({ plugin: 'streams', key: 'inflight' } as const, {})
const outcomeA = atom({ plugin: 'streams', key: 'outcome' } as const, {})
const loopsA = atom({ plugin: 'streams', key: 'loops' } as const, {})
const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
/** The status card's git rows, shared with the card (ui/bar.tsx): one read serves both while it is fresh. */
const statusGitA = atom({ plugin: 'streams', key: 'statusGit' } as const, { lines: [], at: 0 })
/** The permissions held now, for the band above the prompt (read while drawn, so it redraws as they change). */
const askingA = atom({ plugin: 'streams', key: 'asking' } as const, [])
/** What the session answered for an absent person, shown in the band for a while. */
const remoteNoteA = atom({ plugin: 'streams', key: 'remoteNote' } as const, { text: '', until: 0 })
/** How long the band says the session chose for the person. */
const NOTE_MS = 2 * 60_000

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
  /** The Claudeflow relay's address (the `relayUrl` setting), e.g. https://relay.<you>.workers.dev; '' when unset. */
  relayUrl: string
}

/** This session as the devices see it; set at session start. */
let me: Snapshot['session'] | undefined
/** The sealed link to the devices, made once the account has an identity. */
let link: Link | undefined
/** A tick is running: the next one waits, so two posts never race on the same link. */
let isTicking = false

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

/** The band's rows: what each held permission would run. */
const askingNow = () => [...held.values()].flatMap(h => (h.ask ? [{ id: h.ask.id, tool: h.ask.tool, summary: h.ask.summary }] : []))

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
    const note = await read($, remoteNoteA)
    if (note.text && now >= note.until) await update($, remoteNoteA, () => ({ text: '', until: 0 }))
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
    let hasAcked = false
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
        devices = devicesOf([...fresh.filter(d => !got.paired.some(p => p.id === d.id)), ...got.paired])
        await $.store.set(STORE.devices, devices)
      }
      for (const c of got.commands) {
        // Every command is acked, so the phone shows what came of it instead of guessing on a slow network.
        const done = await phoneCommand($, c.command).catch((): Omit<Ack, 't' | 'id'> => ({ ok: false }))
        link.ack(c.device, { t: 'ack', id: c.command.id, ...done })
      }
      // The acks go in this tick, once: a phone waiting on Allow should not wait for the next one.
      const isAcking = got.commands.length > 0 && !hasAcked
      hasAcked ||= isAcking
      post = got.again || isAcking ? link.next({ devices, pairing, now, snapshot, isHolding: held.size > 0 }) : undefined
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
    permissions: [...held.values()].flatMap(h => (h.ask ? [h.ask] : [])),
    questions: [...held.values()].flatMap(h => (h.question ? [h.question] : [])),
    settled: [...settled.values()].filter(x => now - x.at < SETTLED_MS).slice(-20),
    now,
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
  while (!stop.aborted) {
    const step = Promise.all([
      $.clock.sleep(TICK_MS, { signal: stop }).catch(() => undefined),
      $.process.run(['/bin/sleep', String(TICK_MS / 1000)], { timeoutMs: 10_000 }).catch(() => undefined),
    ])
    const r = await Promise.race([got, step.then(() => undefined)])
    if (r) return r.v
    const now = await $.clock.now()
    if (link?.isLooking()) quietSince = undefined
    else if (now - (quietSince ??= now) >= NO_DEVICE_MS) return undefined
  }
  return undefined
}

/**
 * While an unlocked device is looking, a permission prompt waits for an answer from the phone or from the band above
 * the prompt, the first one winning, with no deadline. If no device looks for NO_DEVICE_MS it goes to the terminal's
 * own prompt: a tool is never allowed for a person who is not there, and there is no recommended answer to take.
 */
async function holdPermission<V extends { decision: string; reason?: string }>(
  $: $,
  e: { tool: string; input: unknown; tool_use_id?: string },
  verdict: V,
  signal: AbortSignal,
): Promise<V> {
  const id = e.tool_use_id
  if (verdict.decision !== 'ask' || !link?.isLooking() || !id) return verdict
  const since = await $.clock.now()
  const ask: PendingPermission = { id, tool: e.tool, summary: permissionSummary(e.tool, e.input), at: since, since }
  let resolve: (a: Answer) => void = () => {}
  const answered = new Promise<Answer>(r => (resolve = r))
  held.set(id, { ask, resolve })
  await update($, askingA, askingNow)
  try {
    const a = await awaitAnswer($, answered, signal)
    const now = await $.clock.now()
    if (!a?.decision) {
      settle(id, 'moved to Mac', now)
      return verdict
    }
    settle(id, whyOf(a), now)
    const word = a.decision === 'allow' ? 'Allowed' : 'Denied'
    return { ...verdict, decision: a.decision, reason: `${word} ${a.by === 'mac' ? 'in the terminal' : 'on your phone'}` }
  } finally {
    held.delete(id)
    await update($, askingA, askingNow)
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
 * One thing a device asked, opened from its sealed box: an answer filed in its stream, a stop, or a permission
 * decided. An `allow` reaches here only after link.ts checked its passkey assertion.
 */
async function phoneCommand($: $, c: PhoneCommand): Promise<Omit<Ack, 't' | 'id'>> {
  if (c.kind === 'permission' || c.kind === 'choose') {
    const h = held.get(c.requestId)
    const fits = c.kind === 'permission' ? !!h?.ask : !!h?.question?.options.some(o => o.label === c.label)
    const won = fits ? answerHeld(c.requestId, c.kind === 'permission' ? { by: 'phone', decision: c.decision, command: c.id } : { by: 'phone', label: c.label, command: c.id }) : undefined
    if (won) return won.command === c.id ? { ok: true, why: whyOf(won) } : { ok: false, why: whyOf(won) }
    // Too late or never held: say what became of it (the Mac answered, it moved there), so the card resolves.
    return { ok: false, why: settled.get(c.requestId)?.why ?? 'unknown request' }
  }
  if (c.kind === 'stop') {
    if (mem.runningTurn) await $.turn.abort({ turnId: mem.runningTurn })
    return { ok: true }
  }
  // The stream is made current first, so the answer is filed where it was asked.
  if ((await read($, streamsA)).some(st => st.id === c.streamId)) await update($, currentA, () => c.streamId)
  await $.prompt.submit({ text: c.text, asUser: true })
  return { ok: true }
}

const NO_RELAY = 'Set the relay address first: /config, streams, relayUrl (e.g. https://relay.<you>.workers.dev).'

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

  on('tool.check', async ($, e, next) => holdPermission($, e, await next(e), next.signal))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => (await holdQuestion($, e, next as never)) as never)

  // While a permission is held, the band above the prompt answers it too ("also on your phone"); the first answer,
  // here or on a phone, wins and the other side clears. After the session chose for an absent person, it says so.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [asking, note, now] = await Promise.all([read($, askingA), read($, remoteNoteA), $.clock.now()])
    const hasNote = !!note.text && now < note.until
    if (e.props.hasSurvey || (!asking.length && !hasNote)) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const first = asking[0]
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {first ? (
          <Box key="asking" flexDirection="column">
            <Box key="ask-head" gap={1}>
              <Text bold color="#4d8dff">{`? Claude wants to run ${first.tool}`}</Text>
              <Text dimColor>{asking.length > 1 ? `also on your phone · ${asking.length - 1} more` : 'also on your phone'}</Text>
            </Box>
            <Text key="ask-what">{first.summary}</Text>
            <Box key="ask-buttons" gap={1}>
              <Button key={`allow:${first.id}`} label="Allow" hotkey="a" onPress={() => void answerHeld(first.id, { by: 'mac', decision: 'allow' })} />
              <Button key={`deny:${first.id}`} label="Deny" hotkey="d" onPress={() => void answerHeld(first.id, { by: 'mac', decision: 'deny' })} />
            </Box>
          </Box>
        ) : null}
        {hasNote ? <Text key="remote-note" dimColor>{note.text}</Text> : null}
        {below}
      </Box>
    )
  })

  on('command.run', { command: 'streams' }, async ($, e, next) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    if (verb !== 'phone') return next(e)
    return { text: await remotePair($, rest) }
  })
}
