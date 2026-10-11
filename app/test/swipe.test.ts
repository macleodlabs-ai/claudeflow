import { describe, expect, test } from 'bun:test'
import { lockOf, swipeGoes } from '../src/swipe'

// A swipe on a phone is quick and a little careless: it must go on what the finger meant, not on a long exact drag.
describe('swipe intent', () => {
  test('a short, slow, clear move left archives; it needs no drag across the card', () => {
    expect(swipeGoes(-50, 0, -1)).toBe(true)
    expect(swipeGoes(-30, 0, -1)).toBe(false)
  })

  test('a quick flick left archives from a short way', () => {
    expect(swipeGoes(-20, -0.5, -1)).toBe(true)
  })

  test('a finger that turns back before lifting changes its mind, however far it went', () => {
    expect(swipeGoes(-120, 0.6, -1)).toBe(false)
  })

  test('a move the other way never goes', () => {
    expect(swipeGoes(80, 0.5, -1)).toBe(false)
    expect(swipeGoes(80, 0.5, 1)).toBe(true)
  })

  test('a move leaning sideways is a swipe even with some drift; one leaning up or down stays a scroll', () => {
    expect(lockOf(-10, 7)).toBe('side')
    expect(lockOf(-6, 10)).toBe('scroll')
    expect(lockOf(-4, 3)).toBeUndefined()
  })
})
