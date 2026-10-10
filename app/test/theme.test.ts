import { describe, expect, test } from 'bun:test'
import { nextTheme, themeOf } from '../src/theme'

describe('theme switch', () => {
  test('one tap at a time reaches every theme and comes back to the device setting', () => {
    expect(nextTheme('auto')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('auto')
  })

  test('a stored value this build does not know falls back to the device setting, not a pinned scheme', () => {
    for (const v of [null, undefined, 'night', 3, {}]) expect(themeOf(v)).toBe('auto')
    expect(themeOf('dark')).toBe('dark')
  })
})
