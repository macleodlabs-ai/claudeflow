// Photos and files sent with a prompt. A plugin's prompt cannot carry an image, so the file goes to the session in
// sealed base64 chunks (each under the relay's per-message cap); the session saves it and the prompt names its path.
import { randomId } from '../../plugins/streams/hooks/remote/seal'
import { CHUNK_B64, MAX_FILE_B64, type PhoneCommand, type PhoneFile } from '../../plugins/streams/hooks/remote/snapshot'
import type { Sent } from './transport'

/** A file read and sized on the phone, ready to send. `preview` is an object URL for an image. */
export type Ready = { name: string; type: string; b64: string; preview?: string }

/** The longest side a photo is sent at, first try; it shrinks further if the file is still too large. */
const MAX_SIDE = 1600

/** Bytes as base64, in slices so a large file does not overflow the call stack. */
export function b64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** The base64 split into the chunks the session takes, in order. */
export const chunksOf = (b64: string): string[] => Array.from({ length: Math.max(1, Math.ceil(b64.length / CHUNK_B64)) }, (_, i) => b64.slice(i * CHUNK_B64, (i + 1) * CHUNK_B64))

const tooLarge = (name: string) => ({ why: `${name} is too large to send (about ${Math.round((MAX_FILE_B64 * 3) / 4 / 1000)} KB at most)` })

/** A photo decoded by an <img>, where createImageBitmap cannot (some Safari versions with HEIC). */
async function viaImg(f: File): Promise<HTMLImageElement | undefined> {
  const img = new Image()
  img.src = URL.createObjectURL(f)
  const ok = await img.decode().then(() => true, () => false)
  return ok ? img : undefined
}

/** A photo redrawn as JPEG, smaller each try until it fits; undefined where the browser cannot draw it. */
async function shrink(f: File): Promise<Blob | undefined> {
  const img = (await createImageBitmap(f).catch(() => undefined)) ?? (await viaImg(f))
  if (!img) return undefined
  for (const [side, quality] of [[MAX_SIDE, 0.82], [1280, 0.72], [960, 0.65], [720, 0.6]] as const) {
    const scale = Math.min(1, side / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', quality))
    if (blob && (blob.size * 4) / 3 <= MAX_FILE_B64) return blob
  }
  return undefined
}

/** A picked or pasted file made ready: a photo shrunk to fit, any other file sent as it is if it is small enough. */
export async function attachOf(f: File): Promise<Ready | { why: string }> {
  const name = f.name || (f.type.startsWith('image/') ? 'pasted.jpg' : 'file')
  if (/^image\/(png|jpe?g|heic|heif|webp)$/.test(f.type)) {
    const blob = await shrink(f)
    if (!blob) return tooLarge(name)
    return { name: name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', b64: b64Of(new Uint8Array(await blob.arrayBuffer())), preview: URL.createObjectURL(blob) }
  }
  if ((f.size * 4) / 3 > MAX_FILE_B64) return tooLarge(name)
  return { name, type: f.type || 'application/octet-stream', b64: b64Of(new Uint8Array(await f.arrayBuffer())) }
}

/** Sends each file's chunks in order; the files to name in the prompt, or why one did not go. */
export async function sendFiles(files: readonly Ready[], send: (c: PhoneCommand) => Promise<Sent>): Promise<{ files: PhoneFile[] } | { why: string }> {
  const out: PhoneFile[] = []
  for (const f of files) {
    const blob = randomId(12)
    const parts = chunksOf(f.b64)
    for (const [part, data] of parts.entries()) {
      const r = await send({ id: randomId(), kind: 'chunk', blob, part, of: parts.length, data })
      if (!r.ok) return { why: r.isOffline ? 'Not sent: no line to the session. Try again.' : `Not sent: ${r.why}` }
    }
    out.push({ blob, name: f.name, type: f.type })
  }
  return { files: out }
}
