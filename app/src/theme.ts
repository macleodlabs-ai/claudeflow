// Light, dark, or the device's own setting. styles.css draws both from one set of tokens (light-dark()); this only
// pins the colour scheme when the person picked one, and keeps the browser chrome (theme-color) in step.
export type Theme = 'auto' | 'light' | 'dark'

const ORDER: Theme[] = ['auto', 'light', 'dark']
const KEY = 'cf:theme'
/** The page colour behind everything, per scheme: the status bar and the PWA chrome match it. */
const CHROME = { light: '#f6f6f8', dark: '#111113' }

/** What a stored value means: anything unknown (an old build, a cleared store) is the device's setting. */
export const themeOf = (v: unknown): Theme => (ORDER.includes(v as Theme) ? (v as Theme) : 'auto')

/** One tap on the switch: auto, then light, then dark, then back to auto. */
export const nextTheme = (t: Theme): Theme => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length]

export const THEME_LABEL: Record<Theme, string> = { auto: 'Theme: matches this device', light: 'Theme: light', dark: 'Theme: dark' }
export const THEME_GLYPH: Record<Theme, string> = { auto: '◐', light: '☀', dark: '☾' }

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
    btn.textContent = THEME_GLYPH[t]
    btn.setAttribute('aria-label', THEME_LABEL[t])
    btn.title = THEME_LABEL[t]
  }
  return t
}

/** Wires the header switch and follows the device while on auto. */
export function startTheme() {
  let t = applyTheme()
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyTheme(t))
  document.getElementById('theme')?.addEventListener('click', () => {
    t = nextTheme(t)
    try {
      localStorage.setItem(KEY, JSON.stringify(t))
    } catch {}
    applyTheme(t)
  })
}
