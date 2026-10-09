// The bridge's side of the hosted relay: one outbound connection to the relay, a sealed channel per paired phone,
// and passkeys. A phone pairs with the one-time secret in the QR code and registers a passkey; every connection is then
// unlocked by a passkey signature over a challenge from this Mac, and every Allow needs a fresh one. The Mac checks the
// signatures itself, against the passkey's public key it kept at pairing: the relay can neither read nor forge them.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { b64u, channel, connectionKeys, exportPair, exportPub, importPair, newKeyPair, pairingProof, randomId } from './seal.js'

type Paired = { phone: string; phonePub: string; credentialId: string; credentialKey: string; pairedAt: number }
type Identity = { mac: string; token: string; key: { priv: JsonWebKey; pub: string } }
type Conn = {
  open?: (box: string) => Promise<any>
  seal?: (obj: unknown) => Promise<string>
  isUnlocked: boolean
  challenge?: string
  paired?: Paired
}

export type Remote = {
  pairLink: () => Promise<string>
  publish: (sessions: unknown) => void
  phones: () => number
}

const PAIRING_MS = 10 * 60_000
/** Safari and the Home Screen app keep separate storage: the QR link pairs each of them once. */
const PAIRING_USES = 2

const readJson = <T,>(path: string, fallback: T): T => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}
const writePrivate = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}

const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

/** A WebAuthn ES256 signature arrives DER-encoded; WebCrypto wants r and s side by side. */
function derToRaw(der: Uint8Array): Uint8Array {
  let i = 2
  const part = () => {
    if (der[i] !== 0x02) throw new Error('bad signature')
    const len = der[i + 1]!
    let v = der.slice(i + 2, i + 2 + len)
    i += 2 + len
    while (v.length > 32 && v[0] === 0) v = v.slice(1)
    const out = new Uint8Array(32)
    out.set(v, 32 - v.length)
    return out
  }
  return new Uint8Array([...part(), ...part()])
}

/** Checks a passkey signature the way a WebAuthn server does: the challenge, the origin, the user's presence and verification. */
export async function verifyAssertion(
  a: { authenticatorData: string; clientDataJSON: string; signature: string },
  credentialKey: string,
  challenge: string,
  origin: string,
): Promise<boolean> {
  try {
    const clientJson = b64u.dec(a.clientDataJSON)
    const client = JSON.parse(new TextDecoder().decode(clientJson)) as { type: string; challenge: string; origin: string }
    if (client.type !== 'webauthn.get' || client.challenge !== challenge || client.origin !== origin) return false
    const auth = b64u.dec(a.authenticatorData)
    const rpIdHash = await sha256(new TextEncoder().encode(new URL(origin).hostname))
    if (!rpIdHash.every((b, k) => b === auth[k])) return false
    const flags = auth[32]!
    if (!(flags & 0x01) || !(flags & 0x04)) return false
    const key = await crypto.subtle.importKey('spki', b64u.dec(credentialKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const signed = new Uint8Array([...auth, ...(await sha256(clientJson))])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(b64u.dec(a.signature)), signed)
  } catch {
    return false
  }
}

/** Connects this bridge to the relay at `relayUrl` and keeps it connected; commands from unlocked phones go to `onCommand`. */
export async function startRemote(
  dir: string,
  relayUrl: string,
  onCommand: (cmd: Record<string, unknown>) => boolean,
  onVisible: () => void,
  log: (line: string) => void,
): Promise<Remote> {
  const origin = new URL(relayUrl).origin
  const idPath = join(dir, 'relay-identity.json')
  const phonesPath = join(dir, 'phones.json')
  let id = readJson<Identity | undefined>(idPath, undefined)
  if (!id) {
    id = { mac: randomId(), token: randomId(32), key: await exportPair(await newKeyPair()) }
    writePrivate(idPath, id)
  }
  const identity = id
  const own = await importPair(identity.key)
  let paired = readJson<Paired[]>(phonesPath, [])
  let pairing: { secret: string; until: number; uses: number } | undefined
  const conns = new Map<string, Conn>()
  let ws: WebSocket | undefined
  let latest: unknown = []

  const send = (phone: string, data: unknown) => ws?.readyState === 1 && ws.send(JSON.stringify({ to: phone, data: JSON.stringify(data) }))
  const sendSealed = async (phone: string, c: Conn, obj: unknown) => c.seal && send(phone, { t: 'box', b: await c.seal(obj) })

  async function onHello(phone: string, m: any) {
    let p = paired.find(x => x.phone === phone && x.phonePub === m.phonePub)
    if (!p) {
      // A new phone: it must prove it saw the QR code, and bring the passkey it just made.
      const ok =
        pairing && Date.now() < pairing.until && pairing.uses > 0 && typeof m.proof === 'string' && m.proof === (await pairingProof(pairing.secret, m.phonePub))
      const reg = m.registration
      if (!ok || !reg || typeof reg.credentialId !== 'string' || typeof reg.publicKey !== 'string') return send(phone, { t: 'denied', why: 'not paired' })
      const client = JSON.parse(new TextDecoder().decode(b64u.dec(reg.clientDataJSON))) as { type: string; origin: string }
      if (client.type !== 'webauthn.create' || client.origin !== origin) return send(phone, { t: 'denied', why: 'passkey not made here' })
      pairing!.uses--
      p = { phone, phonePub: m.phonePub, credentialId: reg.credentialId, credentialKey: reg.publicKey, pairedAt: Date.now() }
      paired = [...paired.filter(x => x.phone !== phone), p]
      writePrivate(phonesPath, paired)
      log(`paired a phone (${paired.length} in all)`)
    }
    const eph = await newKeyPair()
    const macNonce = randomId()
    const keys = await connectionKeys({
      ownStatic: own,
      peerStaticPub: p.phonePub,
      ownEphemeral: eph,
      peerEphemeralPub: m.ephPub,
      macNonce,
      phoneNonce: m.nonce,
    })
    const ch = channel(keys.macToPhone, keys.phoneToMac)
    const challenge = randomId(32)
    conns.set(phone, { open: ch.open, seal: ch.seal, isUnlocked: false, challenge, paired: p })
    send(phone, { t: 'welcome', ephPub: await exportPub(eph.publicKey), nonce: macNonce, challenge, credentialId: p.credentialId })
  }

  async function onBox(phone: string, box: string) {
    const c = conns.get(phone)
    if (!c?.open || !c.paired) return
    const msg = await c.open(box).catch(() => undefined)
    if (!msg) return
    if (msg.t === 'unlock') {
      if (c.challenge && (await verifyAssertion(msg.assertion, c.paired.credentialKey, c.challenge, origin))) {
        c.isUnlocked = true
        c.challenge = undefined
        await sendSealed(phone, c, { t: 'sessions', sessions: latest })
      } else await sendSealed(phone, c, { t: 'locked', why: 'passkey did not verify' })
      return
    }
    if (!c.isUnlocked) return
    if (msg.t === 'visible') return onVisible()
    if (msg.t === 'challenge') {
      c.challenge = randomId(32)
      return sendSealed(phone, c, { t: 'challenge', challenge: c.challenge })
    }
    if (msg.t === 'command') {
      // An Allow is the one command that needs a fresh passkey signature of its own.
      if (msg.command?.kind === 'permission' && msg.command?.decision === 'allow') {
        const fresh = c.challenge
        c.challenge = undefined
        if (!fresh || !(await verifyAssertion(msg.assertion ?? {}, c.paired.credentialKey, fresh, origin))) return
      }
      onCommand(msg.command ?? {})
      onVisible()
    }
  }

  function connect(delay = 1000) {
    const url = `${relayUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/mac?id=${identity.mac}&token=${identity.token}`
    ws = new WebSocket(url)
    ws.onopen = () => log(`connected to the relay ${origin}`)
    ws.onmessage = async ev => {
      const frame = JSON.parse(String(ev.data)) as { from: string; data: string }
      const m = JSON.parse(frame.data)
      if (m.t === 'hello') await onHello(frame.from, m).catch(err => log(`hello failed: ${err}`))
      else if (m.t === 'box') await onBox(frame.from, m.b).catch(err => log(`message failed: ${err}`))
    }
    ws.onclose = () => {
      conns.clear()
      setTimeout(() => connect(Math.min(delay * 2, 30_000)), delay)
    }
  }
  connect()

  return {
    async pairLink() {
      pairing = { secret: randomId(32), until: Date.now() + PAIRING_MS, uses: PAIRING_USES }
      return `${origin}/#m=${identity.mac}&k=${identity.key.pub}&s=${pairing.secret}`
    },
    publish(sessions) {
      latest = sessions
      for (const [phone, c] of conns) if (c.isUnlocked) void sendSealed(phone, c, { t: 'sessions', sessions })
    },
    phones: () => paired.length,
  }
}

export const relayUrlOf = (dir: string): string | undefined => {
  const fromEnv = process.env.CLAUDEFLOW_RELAY
  if (fromEnv) return fromEnv
  const file = join(dir, 'relay-url')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined
}
