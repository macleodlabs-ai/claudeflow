/** One installed plugin with a newer release in its marketplace. */
export type Update = { id: string; from: string; to: string }

/** What `claude plugin list --json` says of one installed plugin. */
export type Installed = { id: string; version: string; installPath: string }

/** A plugin entry in a marketplace's `marketplace.json`. */
export type MarketEntry = { name: string; version?: string; source?: unknown }

/** Hours between marketplace refreshes: each one fetches every marketplace's repository. */
export const CHECK_EVERY_MS = 6 * 3600_000

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/

/** Whether `to` is a later release than `from`; false when either is not a version (a git sha). */
export function isNewer(to: string, from: string): boolean {
  const a = SEMVER.exec(to.trim())
  const b = SEMVER.exec(from.trim())
  if (!a || !b) return false
  for (const i of [1, 2, 3]) {
    const d = Number(a[i]) - Number(b[i])
    if (d) return d > 0
  }
  // 1.2.0 is later than 1.2.0-beta; two pre-releases compare as text.
  if (!a[4] !== !b[4]) return !a[4]
  return (a[4] ?? '') > (b[4] ?? '')
}

/** The plugins folder an installed plugin lives under: `<config>/plugins`, from its cache path. */
export const pluginsDirOf = (installPath: string): string | undefined => {
  const at = installPath.indexOf('/plugins/cache/')
  return at < 0 ? undefined : installPath.slice(0, at + '/plugins'.length)
}

/** Where a marketplace entry's own manifest is, when its source is a folder of the marketplace. */
export const manifestPathOf = (marketDir: string, entry: MarketEntry): string | undefined => {
  if (typeof entry.source !== 'string') return undefined
  const rel = entry.source.replace(/^\.\/?/, '').replace(/\/$/, '')
  return `${marketDir}${rel ? `/${rel}` : ''}/.claude-plugin/plugin.json`
}

/** Installed plugins whose marketplace offers a later version, by the versions read for them. */
export const updatesOf = (installed: readonly Installed[], latest: Record<string, string | undefined>): Update[] =>
  installed.flatMap(p => {
    const to = latest[p.id]
    return to && isNewer(to, p.version) ? [{ id: p.id, from: p.version, to }] : []
  })
