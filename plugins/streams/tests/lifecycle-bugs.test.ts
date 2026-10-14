import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { storeKey, type Saved } from '../hooks/state'
import { REFUSED_TOKEN, STORE, TICK_MS } from '../hooks/remote/index'
import { HEARTBEAT_MS } from '../hooks/remote/snapshot'
import { BEARER, RELAY, T0, TOKEN, account, phone } from './room'

// A token the service refused, and the history other projects keep: bugs found in 2.2.0's install lifecycle, each
// held here so it stays fixed.

const ENGINE = { timeoutMs: 20_000 }
const PROJECT = '/work/claudeflow'
const BAR_PROPS = { bodyColumns: 120, hasSurvey: false } as never

function store(on: On, entries: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(entries))
  on('store.get', async (_$, e) => ({ value: m.get(e.key) }) as never)
  on('store.set', async (_$, e) => {
    m.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    m.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...m.keys()] }) as never)
  return m
}

function session(on: On) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/Users/me/.claude-clients/macleod', HOME: '/Users/me' })
  on('session.cwd', async () => ({ value: PROJECT }))
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.start', async (_$, e) => e as never)
  on('session.usage', async () => ({ value: { startedAt: 0 } }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('fs.read', async () => ({ value: '{}' }) as never)
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  return clock
}

const start = ($: Engine) => $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true })

async function connected($: Engine, on: On, answer: (path: string, auth: string) => number | { status: number; body: unknown }) {
  const me = account()
  const a = phone(me, 'iPhone')
  const clock = session(on)
  const kept = store(on, { [STORE.token]: TOKEN, [STORE.identity]: me, [STORE.devices]: [a.stored()], [STORE.welcomed]: T0 })
  const asked: { path: string; auth: string; at: number }[] = []
  on('http.fetch', async (_$, e) => {
    const path = new URL(e.url).pathname
    const auth = ((e.init?.headers ?? {}) as Record<string, string>).authorization ?? ''
    asked.push({ path, auth, at: clock.now() })
    const r = answer(path, auth)
    const status = typeof r === 'number' ? r : r.status
    const body = typeof r === 'number' ? { frames: [], devices: [] } : r.body
    return { value: { status, ok: status < 300, headers: {}, text: status < 300 ? JSON.stringify(body) : '' } } as never
  })
  await start($)
  await clock.advance(TICK_MS)
  return { clock, asked, kept }
}

describe('a token the service refused is not sent again', () => {
  // A 401 means the token is revoked or expired: no later request with it can succeed. The session nonetheless posts
  // it to /up every 30 s (the backoff's cap) and to /roster every minute until the session ends: ~90 requests an hour
  // per open session, each one a revoked credential on the wire, for nothing.
  test('after a 401, the rejected token is not sent again until the stored token changes', ENGINE, async ($, on) => {
    let revoked = false
    const { clock, asked } = await connected($, on, () => (revoked ? 401 : 200))
    revoked = true
    await clock.advance(HEARTBEAT_MS + TICK_MS)
    const firstRefused = asked.length
    await clock.advance(10 * 60_000)
    expect(asked.slice(firstRefused).filter(x => x.auth === `Bearer ${BEARER}`)).toEqual([])
  })
})

describe('the refusal note goes with the reconnect that fixes it', () => {
  // After a 401 the band says "Streams did not accept this account: run /streams connect". The person does, the new
  // token is accepted, and the band keeps telling them to sign in again for up to 10 minutes (REFUSED_NOTE_MS): an
  // accepted post never clears the note, and neither does a successful sign-in.
  test('once a post with the new token is accepted, the band no longer says to sign in again', ENGINE, async ($, on) => {
    const NEW = 'sr1.newaccount0000000.newtoken0000000000.sig'
    const { clock, kept, asked } = await connected($, on, (path, auth) =>
      path === '/v1/connect'
        ? { status: 200, body: { code: 'WXYZ-1234', device: 'dev-2', url: `${RELAY}/connect?code=WXYZ-1234`, interval: 2, expiresIn: 600 } }
        : path === '/v1/connect/token'
          ? { status: 200, body: { token: NEW, account: { login: 'octo' } } }
          : auth === `Bearer ${NEW}`
            ? 200
            : 401,
    )
    await clock.advance(HEARTBEAT_MS)
    await $.command.run({ command: 'streams', args: 'connect', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
    await clock.advance(HEARTBEAT_MS + 2 * TICK_MS)
    expect(kept.get(STORE.token)).toBe(`${RELAY}#${NEW}`)
    expect(asked.some(x => x.path.endsWith('/up') && x.auth === `Bearer ${NEW}`)).toBe(true)
    const band = await $.ui.mount({ plugin: 'streams', surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: BAR_PROPS })
    const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
    await band.unmount()
    expect(texts).not.toContain(REFUSED_TOKEN)
  })
})

describe('the store trim keeps keys it does not know in every project\'s history', () => {
  // trimStore (streams/session.ts) rewrites every `streams:v1:` entry through savedOf, which keeps only streams, rows,
  // loopStream and sources. Any other top-level key, such as one a newer Streams adds, is dropped from every project
  // (not only this one) at start and every 2 minutes, by any session still on 2.2.0, even when the entry is far under
  // budget. Stream and row objects keep unknown keys; only the Saved envelope loses them.
  test('another project\'s history within budget keeps its unknown keys through this session\'s trim', ENGINE, async ($, on) => {
    session(on)
    const other: Saved & { pinned: string[] } = { streams: [], rows: [{ id: 'r1', streamId: 's', kind: 'reply', text: 'hi', at: 1 }], loopStream: {}, pinned: ['s'] }
    const kept = store(on, { [storeKey('/work/other')]: other, [STORE.welcomed]: T0 })
    await start($)
    expect((kept.get(storeKey('/work/other')) as typeof other).pinned).toEqual(['s'])
  })
})
