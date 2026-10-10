import { describe, expect, test } from 'bun:test'
import jsQR from 'jsqr'
import qrcode from 'qrcode-generator'
import { linkFragment } from '../src/links'
import { pairLinkOf } from '../src/scan'

const ORIGIN = 'https://relay.claudeflow.workers.dev'
const LINK = { room: 'roomroomroomroom', pk: 'pkpkpkpkpkpkpkpkpkpkpkpkpkpkpkpkpkpkpkpkpkp', secret: 'S'.repeat(43) }

/** The pairing page's QR code as camera pixels: 6 px a module, a white quiet zone, RGBA. */
function pixelsOf(text: string) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const px = 6
  const size = (n + 8) * px
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue
      for (let y = 0; y < px; y++)
        for (let x = 0; x < px; x++) {
          const i = (((r + 4) * px + y) * size + (c + 4) * px + x) * 4
          data[i] = data[i + 1] = data[i + 2] = 0
        }
    }
  return { data, size }
}

describe('pairing by camera, in the app', () => {
  test('the code the Mac shows decodes to the pairing link this app takes', () => {
    // The Home Screen app cannot follow a scanned link into itself, so it must read the code and pair here.
    const { data, size } = pixelsOf(`${ORIGIN}/${linkFragment(LINK)}`)
    const code = jsQR(data, size, size)
    expect(pairLinkOf(code!.data, ORIGIN)).toEqual(LINK)
  })

  test('a code for another relay is refused with why: this app passkeys belong to its own address', () => {
    expect(pairLinkOf(`https://relay.other.workers.dev/${linkFragment(LINK)}`, ORIGIN)).toEqual({ why: expect.stringContaining('relay.other.workers.dev') })
  })

  test('anything else is ignored and scanning goes on: a link without a secret, or not a link', () => {
    expect(pairLinkOf(`${ORIGIN}/${linkFragment({ room: LINK.room, pk: LINK.pk })}`, ORIGIN)).toBe(undefined)
    expect(pairLinkOf('hello', ORIGIN)).toBe(undefined)
  })
})
