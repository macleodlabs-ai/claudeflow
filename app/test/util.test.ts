import { describe, expect, test } from 'bun:test'
import { color } from '../src/views/util'

// Streams and statuses must never share a colour: a stream drawn in running yellow next to a RUNNING pill reads as one signal.
describe('stream colours', () => {
  const strands = ['#7cc8ff', '#6ff0c0', '#ffb88a', '#b9a2ff', '#ff94d1', '#d9c6ff', '#5fe4f2', '#e08cff', '#b6e6a0', '#c9d6ff']

  test("the plugin's pastels become the brand's strands", () => {
    expect(color('#a5d8ff')).toBe('#7cc8ff')
    expect(color('#FFEC99')).toBe('#d9c6ff')
  })

  test('a colour the brand does not know becomes the nearest strand, never itself', () => {
    for (const c of ['#ffd33d', '#79c0ff', '#ff0000', '#0f0', '#123456aa']) expect(strands).toContain(color(c))
  })

  test('anything that is not a hex colour falls back, so nothing else reaches a style attribute', () => {
    expect(color('red; background:url(x)')).toBe('#8a90c8')
    expect(color(undefined)).toBe('#8a90c8')
  })
})
