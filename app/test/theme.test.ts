import { describe, expect, test } from 'bun:test'
import { nextTheme, switchGlyph, themeOf } from '../src/theme'

describe('theme switch', () => {
  test('the switch shows where a tap goes, a sun in the dark and a moon in the light, and a tap goes there', () => {
    // Showing the current scheme read as the wrong way round: the icon is the action, as on most switches.
    expect(switchGlyph(true)).toBe('☀')
    expect(nextTheme(true)).toBe('light')
    expect(switchGlyph(false)).toBe('☾')
    expect(nextTheme(false)).toBe('dark')
  })

  test('a stored value this build does not know falls back to the device setting, not a pinned scheme', () => {
    for (const v of [null, undefined, 'night', 3, {}]) expect(themeOf(v)).toBe('auto')
    expect(themeOf('dark')).toBe('dark')
  })
})
