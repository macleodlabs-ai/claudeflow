// The relay and the devices in miniature, for the session's tests: real devices (the app's own device core, real
// keys, software passkeys) and a room that numbers their frames, with the link's post cycle as index.ts runs it.
import { newIdentity, publicKeyOf, randomId } from '../hooks/remote/seal'
import { createDevice } from '../hooks/remote/device'
import type { Answered, Device, Identity, Link, OutFrame, Pairing, UpBody, UpResponse } from '../hooks/remote/link'
import type { PhoneCommand, Snapshot } from '../hooks/remote/snapshot'
import { authenticator } from './authenticator'

export const RELAY = 'https://relay.example.workers.dev'
export const ORIGIN = RELAY
export const SESSION = 'sess-1'

/** A phone or tablet as the app runs it: device.ts with its own id and keys, and a passkey for Face ID. */
export function phone(account: Identity, label: string) {
  const keys = { id: randomId(), ...newIdentity() }
  const passkey = authenticator(ORIGIN, `cred-${label}`)
  const core = createDevice({ device: keys, room: account.room, accountPk: publicKeyOf(account.sk), label })
  return {
    id: keys.id,
    pk: keys.pk,
    /** The device as $.store keeps it once paired. */
    stored: (): Device => ({ id: keys.id, pk: keys.pk, credentialId: passkey.credentialId, credentialKey: passkey.spki, label, pairedAt: 0 }),
    /**
     * A new connection's hello: pairing with the QR code's secret, or unlocking with Face ID made at `now` (the
     * device's clock). A registration or an assertion may be made for another challenge, origin or key.
     */
    hello(o: { now: number; secret?: string; origin?: string; key?: Uint8Array; challenge?: string }): Record<string, unknown> {
      if (o.secret !== undefined) return core.pairHello(o.secret, passkey.register(o.challenge ?? core.pairChallenge(), { origin: o.origin })).data
      return core.unlockHello(passkey.assert(core.unlockChallenge(o.now), { origin: o.origin, key: o.key }))?.data ?? {}
    },
    /** Reads what the session sent: a welcome opens the channel, a box opens with it. */
    receive: (data: unknown) => core.receive(SESSION, data as Record<string, unknown>),
    isUnlocked: () => core.isUnlocked(),
    command: (command: PhoneCommand) => core.seal(SESSION, command)?.data,
    /** An Allow with Face ID over this request on this connection. */
    allow: (requestId: string, key?: Uint8Array): PhoneCommand => ({
      id: randomId(),
      kind: 'permission',
      requestId,
      decision: 'allow',
      passkey: passkey.assert(core.allowChallenge(requestId) ?? '', { key }),
    }),
  }
}

export type Phone = ReturnType<typeof phone>
export type Room = ReturnType<typeof room>

export function snapshot(at: number, extra: Partial<Snapshot> = {}): Snapshot {
  return { v: 1, session: { id: SESSION, account: 'macleod', project: 'p', busy: false }, at, streams: [], status: [], limits: [], updates: [], permissions: [], ...extra }
}

/** The room in miniature: device frames get a seq, and frames from the session reach their device. */
export function room(phones: Phone[]) {
  let seq = 0
  const queued: UpResponse['frames'] = []
  return {
    from: (p: Phone, data: unknown) => queued.push({ seq: ++seq, from: p.id, data }),
    answer: (active: Phone[] = phones): UpResponse => ({ frames: queued.splice(0), devices: phones.map(p => ({ id: p.id, isActive: active.includes(p) })) }),
    /** Delivers the session's frames, returning what each phone read. */
    deliver(frames: OutFrame[]): Map<string, unknown[]> {
      const got = new Map<string, unknown[]>()
      for (const f of frames) {
        const p = phones.find(x => x.id === f.to)
        if (!p) continue
        got.set(p.id, [...(got.get(p.id) ?? []), p.receive(f.data)])
      }
      return got
    },
  }
}

export function account(): Identity {
  return { room: randomId(), token: randomId(32), sk: newIdentity().sk }
}

export const T0 = 1_700_000_000_000

export const tOf = (f: OutFrame) => (f.data as { t: string }).t

/**
 * One tick of the session, as index.ts runs it: post when the link says so, the room answers (or is down), the
 * phones read what came, and again while the link asks. By default a permission is held, so every call posts.
 */
export function cycle(link: Link, relay: Room, k: { devices: Device[]; pairing?: Pairing; now: number; snapshot?: Snapshot; isHolding?: boolean; active?: Phone[]; isDown?: boolean }) {
  const out = { posts: [] as UpBody[], paired: [] as Device[], commands: [] as Answered['commands'], read: new Map<string, unknown[]>() }
  let devices = k.devices
  const known = () => ({ devices, pairing: k.pairing, now: k.now, snapshot: k.snapshot ?? snapshot(k.now), isHolding: k.isHolding ?? true })
  let post = link.next(known())
  while (post) {
    out.posts.push(post)
    if (!k.isDown) for (const [id, got] of relay.deliver(post.frames)) out.read.set(id, [...(out.read.get(id) ?? []), ...got])
    const got = link.answered(k.isDown ? undefined : JSON.stringify(relay.answer(k.active)), k.now)
    out.paired.push(...got.paired)
    out.commands.push(...got.commands)
    devices = [...devices.filter(d => !got.paired.some(p => p.id === d.id)), ...got.paired]
    post = got.again ? link.next(known()) : undefined
  }
  return { ...out, frames: out.posts.flatMap(p => p.frames) }
}
