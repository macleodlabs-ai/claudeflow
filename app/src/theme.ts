// Light, dark, or the device's own setting. styles.css draws both from one set of tokens (light-dark()); this only
// pins the colour scheme when the person picked one, and keeps the browser chrome (theme-color) in step.
export type Theme = 'auto' | 'light' | 'dark'

const ORDER: Theme[] = ['auto', 'light', 'dark']
const KEY = 'cf:theme'
/** The page colour behind everything, per scheme: the status bar and the PWA chrome match it. */
const CHROME = { light: '#f6f6f8', dark: '#111113' }

/** What a stored value means: anything unknown (an old build, a cleared store) is the device's setting. */
export const themeOf = (v: unknown): Theme => (ORDER.includes(v as Theme) ? (v as Theme) : 'auto')

/** One tap on the switch: to the other look from the one showing (auto, until the first tap, follows the device). */
export const nextTheme = (isDark: boolean): Theme => (isDark ? 'light' : 'dark')

/** The switch shows where a tap goes: a sun while it is dark, a moon while it is light. */
export const switchGlyph = (isDark: boolean): string => (isDark ? '☀' : '☾')
const switchLabel = (isDark: boolean): string => (isDark ? 'Switch to light' : 'Switch to dark')

const stored = (): Theme => {
  try {
    return themeOf(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return 'auto'
  }
}

/** Pins (or unpins) the scheme on <html> and recolours the browser chrome; returns the theme applied. */
export function applyTheme(t: Theme = stored()): Theme {
  const root = document.documentElement
  if (t === 'auto') delete root.dataset.theme
  else root.dataset.theme = t
  const isDark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark ? CHROME.dark : CHROME.light)
  const btn = document.getElementById('theme')
  if (btn) {
    btn.textContent = switchGlyph(isDark)
    btn.setAttribute('aria-label', switchLabel(isDark))
    btn.title = switchLabel(isDark)
  }
  return t
}

/** Wires the header switch and follows the device while on auto. */
export function startTheme() {
  let t = applyTheme()
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(t))
  document.getElementById('theme')?.addEventListener('click', () => {
    t = nextTheme(t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches))
    try {
      localStorage.setItem(KEY, JSON.stringify(t))
    } catch {}
    applyTheme(t)
  })
}
