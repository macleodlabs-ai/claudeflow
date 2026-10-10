// The pairing page the Mac opens (`/pair#r=…&k=…&s=…`): it draws a QR code of the app's own pairing link for the
// phone to scan. The fragment never reaches a server, and the code is drawn here, with nothing loaded from elsewhere.
import qrcode from 'qrcode-generator'
import { linkFragment, parseLink } from './links'

/** The QR code as one SVG path of dark modules, with the four-module quiet zone scanners need. */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const n = qr.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">
    <rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}

const link = parseLink(location.hash)
const box = document.getElementById('qr')!
const note = document.getElementById('note')!
if (link?.secret) {
  box.innerHTML = qrSvg(`${location.origin}/${linkFragment(link)}`)
} else {
  box.hidden = true
  note.textContent = 'This pairing link is incomplete. Run /streams phone in Claude Code again.'
}
