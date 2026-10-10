// Pairing from inside the app: the camera reads the QR code the Mac shows, and the pairing link in it is taken here,
// so a Home Screen app (whose storage is its own, apart from Safari's) pairs without opening another window.
import jsQR from 'jsqr'
import { parseLink, type PairLink } from './links'

/**
 * The pairing link a scanned code holds, if it is one for this app: the code is `<origin>/#r=…&k=…&s=…`. A code for
 * another relay is refused, as this app's passkeys belong to this address.
 */
export function pairLinkOf(text: string, origin: string): PairLink | { why: string } | undefined {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  const link = parseLink(url.hash)
  if (!link?.secret) return undefined
  return url.origin === origin ? link : { why: `That code is for ${url.host}; this app is ${new URL(origin).host}.` }
}

/** Scans with the back camera until a pairing code is read or the person cancels; the link, or why not. */
export function scanPairing(origin: string): Promise<PairLink | { why: string } | undefined> {
  return new Promise(resolve => {
    const box = document.createElement('div')
    box.className = 'scanner'
    box.innerHTML = `<video playsinline muted autoplay></video><div class="frame" aria-hidden="true"></div>
      <p class="hint">Point at the code <b>/streams phone</b> shows on your Mac.</p><button type="button" class="btn ghost">Cancel</button>`
    document.body.append(box)
    const video = box.querySelector('video')!
    const canvas = document.createElement('canvas')
    let stream: MediaStream | undefined
    let frame = 0
    let done = false
    const finish = (r: PairLink | { why: string } | undefined) => {
      if (done) return
      done = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach(t => t.stop())
      box.remove()
      resolve(r)
    }
    box.querySelector('button')!.addEventListener('click', () => finish(undefined))
    const look = () => {
      if (done) return
      if (video.readyState >= 2 && video.videoWidth) {
        // A smaller frame reads as well and keeps the phone cool.
        const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight))
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const g = canvas.getContext('2d', { willReadFrequently: true })!
        g.drawImage(video, 0, 0, canvas.width, canvas.height)
        const img = g.getImageData(0, 0, canvas.width, canvas.height)
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
        const got = code ? pairLinkOf(code.data, origin) : undefined
        if (got) return finish(got)
      }
      frame = requestAnimationFrame(look)
    }
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(s => {
        stream = s
        if (done) return s.getTracks().forEach(t => t.stop())
        video.srcObject = s
        void video.play().catch(() => {})
        frame = requestAnimationFrame(look)
      })
      .catch(() => finish({ why: 'The camera is not available. Allow camera access for this app in Settings, then try again.' }))
  })
}
