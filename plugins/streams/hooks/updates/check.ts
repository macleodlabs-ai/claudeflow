import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import { oneLine } from '../classify'
import type { Installed, MarketEntry, Update } from './versions'
import { CHECK_EVERY_MS, manifestPathOf, pluginsDirOf, updatesOf } from './versions'

// Plugin updates: which installed plugins have a newer release, and installing them without a restart.

type $ = EngineInterface

const updatesA = atom({ plugin: 'streams', key: 'updates' } as const, [])
const updatingA = atom({ plugin: 'streams', key: 'updating' } as const, false)

const UPDATE_CHECK_KEY = 'streams:updates:checkedAt'

/**
 * Which installed plugins have a newer release: each marketplace refreshed at most every six hours,
 * then every installed plugin's version held against the one its marketplace now lists.
 */
async function checkUpdates($: $, force = false): Promise<Update[]> {
  const run = (argv: string[], timeoutMs = 30_000) => $.process.run(argv, { timeoutMs })
  const now = await $.clock.now()
  const last = Number((await $.store.get(UPDATE_CHECK_KEY)) ?? 0)
  if (force || now - last > CHECK_EVERY_MS) {
    await run(['claude', 'plugin', 'marketplace', 'update'], 180_000).catch(() => undefined)
    await $.store.set(UPDATE_CHECK_KEY, now)
  }
  const listed = await run(['claude', 'plugin', 'list', '--json'])
  // `plugin list --json` is a bare list; with `--available` it is `{ installed, available }`.
  const parsed = JSON.parse(listed.stdout || '[]') as Installed[] | { installed?: Installed[] }
  const installed = (Array.isArray(parsed) ? parsed : (parsed.installed ?? [])).filter(p => p.id.includes('@'))
  const readJson = async (path: string): Promise<unknown> => JSON.parse(String(await $.fs.read(path)))
  const markets = new Map<string, MarketEntry[]>()
  const latest: Record<string, string | undefined> = {}
  for (const p of installed) {
    const [name = '', market = ''] = p.id.split('@')
    const dir = pluginsDirOf(p.installPath)
    if (!dir) continue
    const marketDir = `${dir}/marketplaces/${market}`
    if (!markets.has(market)) {
      const manifest = (await readJson(`${marketDir}/.claude-plugin/marketplace.json`).catch(() => ({}))) as { plugins?: MarketEntry[] }
      markets.set(market, manifest.plugins ?? [])
    }
    const entry = markets.get(market)?.find(e => e.name === name)
    if (!entry) continue
    const path = manifestPathOf(marketDir, entry)
    latest[p.id] = entry.version ?? (path ? ((await readJson(path).catch(() => ({}))) as { version?: string }).version : undefined)
  }
  const found = updatesOf(installed, latest)
  const before = (await read($, updatesA)).map(u => u.id).join()
  await update($, updatesA, () => found)
  if (found.length && found.map(u => u.id).join() !== before)
    $.ui.toast(`${found.length} plugin update${found.length === 1 ? '' : 's'} ready: press ⬆ update`)
  return found
}

/** Installs every update found, then reloads the plugins into this session: no restart, from any surface. */
async function applyUpdates($: $): Promise<string> {
  const updates = await read($, updatesA)
  if (!updates.length || (await read($, updatingA))) return updates.length ? 'An update is already running.' : 'Every plugin is up to date.'
  await update($, updatingA, () => true)
  const done: string[] = []
  const failed: string[] = []
  for (const u of updates) {
    const r = await $.process
      .run(['claude', 'plugin', 'update', u.id], { timeoutMs: 180_000 })
      .catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    if (r.exitCode === 0) done.push(`${u.id} ${u.from} → ${u.to}`)
    else failed.push(`${u.id}: ${oneLine(r.stderr || r.stdout, 160)}`)
  }
  await update($, updatesA, list => list.filter(u => !done.some(d => d.startsWith(`${u.id} `))))
  await update($, updatingA, () => false)
  const said = [done.length ? `Updated ${done.join(', ')}.` : '', failed.length ? `Failed: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ')
  if (done.length) {
    $.ui.toast(`${said} Reloading plugins…`)
    // The reload replaces this module, so it runs once this press or command has answered.
    void $.clock
      .sleep(300)
      .then(() => $.command.run({ command: 'reload-plugins' }))
      .catch(() => $.ui.toast('Updated: run /reload-plugins to load it'))
  } else $.ui.toast(said)
  return said
}

export function wireUpdates(on: On) {
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    void checkUpdates($).catch(() => {})
    $.clock.every(CHECK_EVERY_MS, () => void checkUpdates($).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'streams' }, async ($, e, next) => {
    if (e.args.trim().split(/\s+/)[0] !== 'update') return next(e)
    await checkUpdates($, true)
    return { text: await applyUpdates($) }
  })

  // The ⬆ update button (control.tsx, key `update`), in the bar or the pane: one press installs and reloads.
  on('ui.press', { plugin: 'streams', element: 'update' }, async ($, e, next) => {
    await applyUpdates($)
    return next(e)
  })
}
