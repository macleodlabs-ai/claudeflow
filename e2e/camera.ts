// A fake camera for headless Chrome (--use-file-for-fake-video-capture): a short y4m video of a QR code, so the app's
// in-app pairing scan can be driven like a phone pointed at the Mac's pairing page.
import { writeFileSync } from 'node:fs'
import qrcode from '../app/node_modules/qrcode-generator/dist/qrcode.mjs'

export function qrVideo(path: string, text: string) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  const px = 6
  const [W, H] = [640, 480]
  const side = (n + 8) * px
  const top = Math.floor((H - side) / 2)
  const left = Math.floor((W - side) / 2)
  // Luma: light paper with dark modules; chroma: neutral grey.
  const Y = new Uint8Array(W * H).fill(235)
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.isDark(r, c))
        for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) Y[(top + (r + 4) * px + y) * W + left + (c + 4) * px + x] = 16
  const UV = new Uint8Array((W / 2) * (H / 2)).fill(128)
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV])
  writeFileSync(path, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), frame, frame, frame]))
}
