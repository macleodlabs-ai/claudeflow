import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Stream, StreamRow } from '../types'
import { PANE_KEY, SAVED_BUDGET, hiddenTicketsKey, storeKey, type Saved } from '../hooks/state'
import { REFUSED_PLAN, REFUSED_ROOM, REFUSED_TOKEN, ROSTER_MS, STORE, TICK_MS } from '../hooks/remote/index'
import { HEARTBEAT_MS, type Snapshot } from '../hooks/remote/snapshot'
import { ACTIVE_POLL_MS } from '../hooks/remote/link'
import { BEARER, RELAY, T0, TOKEN, account, phone, room } from './room'

// The mod's install lifecycle, as a person lives it: the first session after installing, the first session after an
// update (with what older versions left in the shared $.store), what an uninstall leaves behind and a reinstall finds,
// and a Streams Remote account that stops working (a revoked token, an ended plan, a relay that is down). Through all
// of it the free mod (streams, the pane, the bar, the status card) must keep working, and the network must hear from
// this computer only while the person is signed in.

/** Tests that drive the engine: room to finish on a busy machine, where the default 5 s is not. */
const ENGINE = { timeoutMs: 20_000 }
const PROJECT = '/work/claudeflow'
const PANE_PROPS = { title: 'Streams', isFocused: false, bodyColumns: 80, placement: 'dock' } as never
const BAR_PROPS = { bodyColumns: 120, hasSurvey: false } as never

/**
 * The plugin's $.store in memory, readable by the test (mock.store keeps its own out of reach), as in remote.test.ts.
 * `writes` lists every key the session set or deleted, in order.
 */
function store(on: On, entries: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(entries))
  const writes: string[] = []
  on('store.get', async (_$, e) => ({ value: m.get(e.key) }) as never)
  on('store.set', async (_$, e) => {
    writes.push(e.key)
    m.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    writes.push(e.key)
    m.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...m.keys()] }) as never)
  return { m, writes }
}

/**
 * The engine around an interactive session, answered quietly, with what the test needs to watch: the commands it
 * declared, the panes it opened, what it wrote to the status line, its toasts, files and settings it wrote, and every
 * process it ran. `manifest`: what the installed plugin.json says.
 */
function session(on: On, o: { manifest?: string } = {}) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/Users/me/.claude-clients/macleod', HOME: '/Users/me' })
  const seen = { commands: [] as string[], opened: [] as string[], status: [] as (string | undefined)[], toasts: [] as string[], files: [] as string[], settings: [] as string[], runs: [] as string[][], prompts: [] as string[] }
  on('session.cwd', async () => ({ value: PROJECT }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('command.register', async (_$, e) => {
    seen.commands.push(e.name)
    return { value: undefined } as never
  })
  on('ui.open', async (_$, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.status', async (_$, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.close', async () => ({ value: undefined }) as never)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('fs.read', async (_$, e) => ({ value: o.manifest !== undefined && e.path.endsWith('/.claude-plugin/plugin.json') ? o.manifest : '{}' }) as never)
  on('fs.write', async (_$, e) => {
    seen.files.push(e.path)
    return { value: undefined } as never
  })
  on('config.set', async (_$, e) => {
    seen.settings.push(e.key)
    return { value: e.value } as never
  })
  on('process.run', async (_$, e) => {
    seen.runs.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: '' } } as never
  })
  on('prompt.submit', async (_$, e) => {
    seen.prompts.push(e.text)
    return { text: e.text }
  })
  return { clock, seen }
}

const start = ($: Engine) => $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })
const run = ($: Engine, command: 'streams' | 'stream', args: string) =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never) as Promise<{ text: string }>
const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

/** Every Text drawn above the prompt, joined: the welcome, the refusal notes, the status card. */
async function bandText($: Engine): Promise<string[]> {
  const band = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAR_PROPS })
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
  await band.unmount()
  return texts
}

/** The free mod, end to end: a tagged prompt files a stream, the pane and the bar draw it, `/streams` and the card answer. */
async function freeModWorks($: Engine, id: string) {
  await submit($, `#${id} why is the invoice total off?`)
  const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
  expect(await pane.find({ key: `open:${id}` })).toBeDefined()
  await pane.unmount()
  const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: BAR_PROPS })
  expect(await bar.find({ key: `chip:${id}` })).toBeDefined()
  expect((await run($, 'streams', '')).text).toContain('Streams navigator opened.')
  expect((await submit($, 'status')).drop).toBeDefined()
  await bar.redraw(BAR_PROPS)
  expect(await bar.find({ key: `st-open:${id}` })).toBeDefined()
  await bar.unmount()
}

const stream = (id: string, extra: Partial<Stream> & Record<string, unknown> = {}): Stream =>
  ({ id, name: id, summary: `${id} work`, createdAt: T0 - 3 * 3600_000, lastAt: T0 - 2 * 3600_000, rows: 2, agents: 0, loops: 0, ...extra }) as Stream
const row = (id: string, streamId: string, kind: StreamRow['kind'], text: string, extra: Record<string, unknown> = {}): StreamRow =>
  ({ id, streamId, kind, text, at: T0 - 2 * 3600_000, ...extra }) as StreamRow

describe('a new install: the first session on an empty store', () => {
  // The first impression decides whether the mod stays installed: it must come up whole with nothing kept, and a
  // person who never signed up for Streams Remote must not have this computer talk to the service at all.
  test('starts clean: commands declared, pane opened, an older footer cleared, the welcome shown, and no request to the network', ENGINE, async ($, on) => {
    const { clock, seen } = session(on)
    const kept = store(on)
    let fetches = 0
    on('http.fetch', async () => {
      fetches++
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } } as never
    })
    await start($)
    expect(seen.commands).toEqual(expect.arrayContaining(['streams', 'stream']))
    expect(seen.opened).toEqual(['streams'])
    // A footer an older version wrote is cleared, not left showing a stream name nobody updates.
    expect(seen.status).toContain(undefined)
    const band = (await bandText($)).join('\n')
    expect(band).toContain('/streams connect')
    // The empty pane and bar draw; a throw here would leave both blank.
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    expect((await pane.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('open:'))).toEqual([])
    await pane.unmount()
    await clock.advance(2 * HEARTBEAT_MS + ROSTER_MS)
    expect(fetches).toBe(0)
    expect(seen.toasts).toEqual([])
    expect(kept.m.get(STORE.welcomed)).toBe(T0)
  })

  test('the first prompt files a stream that the pane, the bar and the card show, and it is kept for the next session', ENGINE, async ($, on) => {
    session(on)
    const kept = store(on)
    let fetches = 0
    on('http.fetch', async () => {
      fetches++
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } } as never
    })
    on('turn.complete', async () => ({ text: '' }))
    await start($)
    await freeModWorks($, 'billing')
    // Saved when the turn ends, so the next session (or a reinstall over this store) finds it.
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    expect((kept.m.get(storeKey(PROJECT)) as Saved).streams.map(s => s.id)).toEqual(['billing'])
    // The welcome goes with the first prompt.
    expect((await bandText($)).join('\n')).not.toContain('Macleod Labs')
    expect(fetches).toBe(0)
  })
})

describe('an update: what older versions left in the store loads under this one', () => {
  // Shaped as 2.0.x kept a project (state.ts Saved): streams before `startedAt` (2.0.7) and before colours were always
  // set, rows with no tool id or code, no `sources` (before 1.3.0), and keys this version does not know.
  const OLD: Saved & Record<string, unknown> = {
    streams: [
      stream('billing', { color: '#ffb3ba', legacy: 'kept by a fork' }),
      stream('relay'),
      stream('docs', { archived: true }),
    ],
    rows: [
      row('p1', 'billing', 'prompt', 'why is the invoice total off?'),
      row('r1', 'billing', 'reply', 'Rounding: toFixed.', { mood: 'unknown key' }),
      row('t1', 'relay', 'tool', 'Bash(wrangler deploy)'),
      row('r2', 'relay', 'reply', 'Deployed.'),
      row('p2', 'docs', 'prompt', 'tidy the README'),
    ],
    loopStream: {},
  }

  test('2.0.x history restores whole: every stream drawn, archived ones restorable, and the next save keeps every row', ENGINE, async ($, on) => {
    const { seen } = session(on)
    const kept = store(on, { [storeKey(PROJECT)]: OLD, [STORE.welcomed]: T0 - 86_400_000 })
    await start($)
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    expect(await pane.find({ key: 'open:billing' })).toBeDefined()
    // A stream saved before colours were kept still draws (colorOf picks one), rather than crashing the pane.
    expect(await pane.find({ key: 'open:relay' })).toBeDefined()
    expect(await pane.find({ key: 'open:docs' })).toBe(undefined)
    // Merges and suggestions came after 2.0: absent, they read as none.
    expect(await pane.find({ key: 'undo-merge' })).toBe(undefined)
    expect(await pane.find({ key: 'suggest-merge' })).toBe(undefined)
    expect((await run($, 'stream', 'undo')).text).toBe('Nothing to undo.')
    await pane.press({ key: 'archived' })
    await pane.press({ key: 'restore:docs' })
    expect(await pane.find({ key: 'open:docs' })).toBeDefined()
    await pane.unmount()
    const saved = kept.m.get(storeKey(PROJECT)) as Saved
    expect(saved.rows.map(r => r.id)).toEqual(OLD.rows.map(r => r.id))
    expect(saved.rows.map(r => r.text)).toEqual(OLD.rows.map(r => r.text))
    expect(saved.streams.map(s => [s.id, !!s.archived])).toEqual([['billing', false], ['relay', false], ['docs', false]])
    // Keys this version does not know, on a stream or a row, are carried, not stripped.
    expect((saved.streams[0] as unknown as Record<string, unknown>).legacy).toBe('kept by a fork')
    expect((saved.rows[1] as unknown as Record<string, unknown>).mood).toBe('unknown key')
    // Someone welcomed by an older version is not welcomed again.
    expect((await bandText($)).join('\n')).not.toContain('Macleod Labs')
    expect(seen.toasts).toEqual([])
  })

  test('restored 2.0.x streams merge and undo exactly, though they predate merging', ENGINE, async ($, on) => {
    session(on)
    const kept = store(on, { [storeKey(PROJECT)]: OLD, [STORE.welcomed]: T0 })
    await start($)
    expect((await run($, 'stream', 'merge relay billing')).text).toBe('Merged relay into billing (2 rows). /stream undo puts it back.')
    expect((await run($, 'stream', 'undo')).text).toBe('Undid the merge: relay is back with its 2 rows.')
    const saved = kept.m.get(storeKey(PROJECT)) as Saved
    expect(saved.rows.filter(r => r.streamId === 'relay').map(r => r.id)).toEqual(['t1', 'r2'])
  })

  // 2.0.9 keeps the tickets hidden on the card per project. An entry it did not write (another version's, a hand edit)
  // must not bring the card down, nor hide a ticket it does not name.
  test('tickets hidden under 2.0.9 stay hidden after the update; a malformed entry is ignored', ENGINE, async ($, on) => {
    session(on)
    store(on, { [hiddenTicketsKey(PROJECT)]: { 'APP-261': T0 - 60_000, 'APP-262': 'yesterday' }, [STORE.welcomed]: T0 })
    let agents = 0
    on('agent.spawn', async () => ({ model: 'haiku', agentId: `ag${++agents}` }))
    await start($)
    await submit($, '#billing fix the totals')
    await $.agent.spawn({ prompt: 'fix it', description: 'APP-261 totals fix', subagentType: 'Explore' } as never)
    await $.agent.spawn({ prompt: 'fix it', description: 'APP-262 tax fix', subagentType: 'Explore' } as never)
    await submit($, 'status')
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: BAR_PROPS })
    expect(await bar.find({ key: 'ticket-hide:APP-261' })).toBe(undefined)
    expect(await bar.find({ key: 'ticket-hide:APP-262' })).toBeDefined()
    await bar.unmount()
  })

  test('a pane an older version folded to the side tab stays folded: the update does not reopen it', ENGINE, async ($, on) => {
    const { seen } = session(on)
    store(on, { [PANE_KEY]: { collapsed: true, columns: 72 }, [STORE.welcomed]: T0 })
    await start($)
    expect(seen.opened).toEqual([])
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: BAR_PROPS })
    await submit($, '#billing one question')
    await bar.redraw(BAR_PROPS)
    expect(await bar.find({ key: 'tab' })).toBeDefined()
    await bar.unmount()
  })

  // The store is shared with other mods' versions and other projects: what this version does not own, it leaves be.
  test('store keys this version does not own are left exactly as they were', ENGINE, async ($, on) => {
    session(on)
    const theirs = { 'remote:future-thing': { a: 1 }, 'notes:v3': ['x'], 'streams:v0:/old': 'from 0.1' }
    const kept = store(on, { ...theirs, [STORE.welcomed]: T0 })
    await start($)
    await freeModWorks($, 'billing')
    for (const [k, v] of Object.entries(theirs)) expect(kept.m.get(k)).toEqual(v)
    expect(kept.writes.filter(k => k in theirs)).toEqual([])
  })
})

describe('uninstalling: what the mod leaves behind, and a reinstall', () => {
  // The engine has no uninstall or disable event to drive, so these hold the contract that makes either safe: the mod
  // keeps nothing outside its own $.store (no file, no setting, nothing installed that runs without it), the store it
  // leaves is small, and a reinstall over that store, or over none, comes up whole.
  test('a full session keeps everything in its own store, small, and writes no file or setting and installs nothing', ENGINE, async ($, on) => {
    const { clock, seen } = session(on)
    const kept = store(on)
    on('http.fetch', async () => ({ value: { status: 200, ok: true, headers: {}, text: '{}' } }) as never)
    on('agent.spawn', async () => ({ model: 'haiku', agentId: 'ag1' }))
    on('turn.complete', async () => ({ text: '' }))
    await start($)
    await freeModWorks($, 'billing')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
    await $.agent.spawn({ prompt: 'fix it', description: 'APP-300 totals fix', subagentType: 'Explore' } as never)
    await submit($, 'status')
    const bar = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', props: BAR_PROPS })
    await bar.press({ key: 'ticket-hide:APP-300' })
    await bar.unmount()
    const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
    await pane.press({ key: 'collapse' })
    await pane.unmount()
    await clock.advance(10 * 60_000)

    expect(seen.files).toEqual([])
    expect(seen.settings).toEqual([])
    // What it runs only reads (the OS, git) or is Claude Code's own plugin listing: nothing that would outlive it.
    for (const argv of seen.runs) expect(argv[0] === 'uname' || argv[0] === 'git' || (argv[0] === 'claude' && argv[1] === 'plugin')).toBe(true)
    expect([...kept.m.keys()].sort()).toEqual([PANE_KEY, STORE.welcomed, hiddenTicketsKey(PROJECT), storeKey(PROJECT), 'streams:updates:checkedAt'].sort())
    expect(JSON.stringify(kept.m.get(storeKey(PROJECT))).length).toBeLessThanOrEqual(SAVED_BUDGET)
  })

  for (const left of ['the store it left', 'a wiped store'] as const)
    test(`reinstalling over ${left} comes up whole`, ENGINE, async ($, on) => {
      const { seen } = session(on)
      const kept = left === 'a wiped store' ? {} : { [storeKey(PROJECT)]: { streams: [stream('billing')], rows: [row('p1', 'billing', 'prompt', 'why?')], loopStream: {} }, [STORE.welcomed]: T0 - 86_400_000, [PANE_KEY]: { collapsed: false, columns: 72 } }
      store(on, kept)
      await start($)
      const pane = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'Pane', requestId: 'streams', props: PANE_PROPS })
      expect(!!(await pane.find({ key: 'open:billing' }))).toBe(left === 'the store it left')
      await pane.unmount()
      // Welcomed once per account, ever: a reinstall that kept the store does not say hello again.
      expect((await bandText($)).join('\n').includes('Macleod Labs')).toBe(left === 'a wiped store')
      await freeModWorks($, 'docs')
      expect(seen.toasts).toEqual([])
    })
})

/**
 * The relay as the service answers it, switchable mid-test: a status, `down` (the request fails), or `hang` (it never
 * comes back). Every request is kept with the bearer it carried and when. `route` answers a path itself.
 */
function service(on: On, clock: { now: () => number }) {
  const st = {
    answer: 200 as number | 'down' | 'hang',
    route: undefined as undefined | ((path: string, auth: string) => { status: number; body?: unknown } | undefined),
    asked: [] as { path: string; auth: string; body: string; at: number }[],
  }
  on('http.fetch', async (_$, e) => {
    const path = new URL(e.url).pathname
    const auth = ((e.init?.headers ?? {}) as Record<string, string>).authorization ?? ''
    st.asked.push({ path, auth, body: String(e.init?.body ?? ''), at: clock.now() })
    const routed = st.route?.(path, auth)
    if (routed) return { value: { status: routed.status, ok: routed.status < 300, headers: {}, text: JSON.stringify(routed.body ?? {}) } } as never
    if (st.answer === 'down') throw new Error('connect ECONNREFUSED')
    if (st.answer === 'hang') return new Promise<never>(() => {})
    const ok = st.answer < 300
    return { value: { status: st.answer, ok, headers: {}, text: ok ? '{"frames":[],"devices":[]}' : '' } } as never
  })
  return st
}

/** A connected account with one paired phone, its session started and posting. */
async function connected($: Engine, on: On) {
  const me = account()
  const a = phone(me, 'iPhone')
  const s = session(on)
  const kept = store(on, { [STORE.token]: TOKEN, [STORE.identity]: me, [STORE.devices]: [a.stored()], [STORE.welcomed]: T0 })
  const relay = service(on, s.clock)
  await start($)
  await s.clock.advance(TICK_MS)
  expect(relay.asked.some(x => x.path.endsWith('/up') && x.auth === `Bearer ${BEARER}`)).toBe(true)
  return { ...s, kept, relay }
}

/** The shortest gap between two requests to the same path among these. */
const tightest = (asked: { path: string; at: number }[]) => {
  let gap = Infinity
  for (const path of new Set(asked.map(x => x.path))) {
    const at = asked.filter(x => x.path === path).map(x => x.at)
    for (let i = 1; i < at.length; i++) gap = Math.min(gap, at[i]! - at[i - 1]!)
  }
  return gap
}

describe('degrading from Streams Remote to the free mod', () => {
  // A revoked token, an ended plan, another account's room, or a relay that is down or hangs: the phone stops, never
  // the streams on this computer. The session must not hammer the service, must say a refusal once (in the band, not
  // toast after toast), and must not show the token anywhere.
  for (const [failure, says] of [
    [401, REFUSED_TOKEN],
    [402, REFUSED_PLAN],
    [403, REFUSED_ROOM],
    [500, undefined],
    [503, undefined],
    ['down', undefined],
    ['hang', undefined],
  ] as const)
    test(`after the relay answers ${failure}, the free mod works, the session backs off, and the band says so ${says ? 'once' : 'not at all'}`, ENGINE, async ($, on) => {
      const { clock, seen, relay } = await connected($, on)
      const from = relay.asked.length
      relay.answer = failure
      await clock.advance(10 * 60_000)
      const during = relay.asked.slice(from)
      // Not a hot loop: never two requests to one path within 4 s (the link's first backoff), and about one a
      // heartbeat at most (a hot loop on the 2 s tick would be 300).
      expect(tightest(during)).toBeGreaterThanOrEqual(4000)
      expect(during.length).toBeLessThanOrEqual((10 * 60_000) / HEARTBEAT_MS + (10 * 60_000) / ROSTER_MS + 4)
      // Every request still went to the relay that issued the token, and nowhere else.
      expect(during.every(x => x.auth === '' || x.auth === `Bearer ${BEARER}`)).toBe(true)
      const band = await bandText($)
      const refusals = band.filter(t => t === REFUSED_TOKEN || t === REFUSED_PLAN || t === REFUSED_ROOM)
      expect(refusals).toEqual(says ? [says] : [])
      expect(band.join('\n')).not.toContain(BEARER)
      expect(seen.toasts.filter(t => /Streams|connect/i.test(t))).toEqual([])
      expect(seen.toasts.some(t => t.includes(BEARER))).toBe(false)
      await freeModWorks($, 'billing')
    })

  test('a relay that comes back is used again without a restart, at the quiet pace, not the backoff', ENGINE, async ($, on) => {
    const { clock, relay } = await connected($, on)
    relay.answer = 503
    await clock.advance(5 * 60_000)
    relay.answer = 200
    await clock.advance(HEARTBEAT_MS + TICK_MS)
    const back = relay.asked.length
    await clock.advance(5 * 60_000)
    const ups = relay.asked.slice(back).filter(x => x.path.endsWith('/up'))
    expect(ups.length).toBeGreaterThan(0)
    expect(tightest(ups)).toBeGreaterThanOrEqual(4000)
  })

  // Signing in again is the way back from a revoked token: /streams connect asks for a fresh one without sending the
  // stale one, and from then on only the fresh one is sent.
  test('after a 401, /streams connect signs in again and only the new token is sent from then on', ENGINE, async ($, on) => {
    const { clock, relay, kept } = await connected($, on)
    const NEW = 'sr1.newaccount0000000.newtoken0000000000.sig'
    relay.answer = 401
    await clock.advance(2 * 60_000)
    relay.route = (path, auth) =>
      path === '/v1/connect'
        ? { status: 200, body: { code: 'WXYZ-1234', device: 'dev-2', url: `${RELAY}/connect?code=WXYZ-1234`, interval: 2, expiresIn: 600 } }
        : path === '/v1/connect/token'
          ? { status: 200, body: { token: NEW, account: { login: 'octo' } } }
          : auth === `Bearer ${NEW}`
            ? { status: 200, body: { frames: [], devices: [] } }
            : undefined
    const at = relay.asked.length
    expect((await run($, 'streams', 'connect')).text).toContain('WXYZ-1234')
    await clock.advance(HEARTBEAT_MS + 2 * TICK_MS)
    expect(kept.m.get(STORE.token)).toBe(`${RELAY}#${NEW}`)
    const after = relay.asked.slice(at)
    // The sign-in itself carries no bearer: the stale token is not handed to the sign-in endpoints.
    expect(after.filter(x => x.path.startsWith('/v1/connect')).every(x => x.auth === '')).toBe(true)
    const authed = after.filter(x => x.auth)
    const firstNew = authed.findIndex(x => x.auth === `Bearer ${NEW}`)
    expect(firstNew).toBeGreaterThanOrEqual(0)
    expect(authed.slice(firstNew).every(x => x.auth === `Bearer ${NEW}`)).toBe(true)
    await clock.advance(5 * 60_000)
    expect(relay.asked.slice(at).filter(x => x.auth === `Bearer ${BEARER}` && x.at > authed[firstNew]!.at)).toEqual([])
    await freeModWorks($, 'billing')
  })

  test('/streams disconnect after a refusal stops every request, and the free mod keeps working', ENGINE, async ($, on) => {
    const { clock, relay } = await connected($, on)
    relay.answer = 402
    await clock.advance(60_000)
    expect((await run($, 'streams', 'disconnect')).text).toContain('Disconnected')
    const at = relay.asked.length
    await clock.advance(10 * 60_000)
    expect(relay.asked.slice(at)).toEqual([])
    expect((await run($, 'streams', 'phone')).text).toContain('/streams connect')
    await freeModWorks($, 'billing')
  })
})

describe('the version a computer reports', () => {
  // "Which version is this?" is the first question of every report: the phone, the account page and the status card
  // must all say the one in the plugin.json installed, read from the plugin's own folder.
  test('the snapshot, the account roster and the status card all name the installed manifest\'s version', ENGINE, async ($, on) => {
    const me = account()
    const a = phone(me, 'iPhone')
    const { clock } = session(on, { manifest: '{"name":"streams","version":"2.2.0"}' })
    store(on, { [STORE.token]: TOKEN, [STORE.identity]: me, [STORE.devices]: [a.stored()], [STORE.welcomed]: T0 })
    const relay = room([a])
    const seen: Snapshot[] = []
    const rosters: unknown[] = []
    relay.from(a, a.hello({ now: T0 }))
    on('http.fetch', async (_$, e) => {
      if (e.url.endsWith('/wait')) return { value: { status: 404, ok: false, headers: {}, text: '' } } as never
      const body = JSON.parse(String(e.init?.body))
      if (e.url.endsWith('/roster')) {
        rosters.push(body.version)
        return { value: { status: 200, ok: true, headers: {}, text: '{}' } } as never
      }
      for (const got of relay.deliver(body.frames).values()) for (const m of got as { t?: string; snapshot: Snapshot }[]) if (m?.t === 'snapshot') seen.push(m.snapshot)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(relay.answer([a])) } } as never
    })
    await start($)
    await clock.advance(TICK_MS)
    await clock.advance(ACTIVE_POLL_MS)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(s => s.session.version === '2.2.0')).toBe(true)
    expect(rosters).toEqual(['2.2.0'])
    await run($, 'streams', 'status')
    const band = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAR_PROPS })
    expect((await band.find({ key: 'st-title' }))?.text).toContain('v2.2.0')
    await band.unmount()
  })
})
