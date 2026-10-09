// Pairing links (`#r=room&k=accountPk&s=secret`) and the rooms a device keeps from them. Pure: no DOM, no crypto,
// so the pairing page can use it without pulling the crypto into its bundle.

/** What a pairing link carries: the account's room and public key, and the one-time pairing secret. */
export type PairLink = { room: string; pk: string; secret?: string }

/** One account this device pairs with, as kept in localStorage. */
export type Pairing = {
  room: string
  pk: string
  /** The pairing secret from the link, until a session welcomes the device with it. */
  secret?: string
  /** The secret already used, so the link left in the address does not offer pairing again after it worked. */
  spent?: string
  /** This room's passkey, made at pairing. */
  credentialId?: string
  /** A session welcomed this device: from now on it unlocks with its passkey. */
  isPaired: boolean
  /** The account name, learnt from the first snapshot (the link has none). */
  label?: string
}

const ROOM = /^[A-Za-z0-9_-]{16,64}$/
const KEY = /^[A-Za-z0-9_-]{43}$/

/** Reads a link's fragment; anything malformed is no link at all, since the values go straight into keys. */
export function parseLink(hash: string): PairLink | undefined {
  const h = new URLSearchParams(hash.replace(/^#/, ''))
  const room = h.get('r') ?? ''
  const pk = h.get('k') ?? ''
  const secret = h.get('s') ?? undefined
  if (!ROOM.test(room) || !KEY.test(pk)) return undefined
  if (secret !== undefined && !KEY.test(secret)) return undefined
  return secret ? { room, pk, secret } : { room, pk }
}

export const linkFragment = (l: PairLink): string => `#r=${l.room}&k=${l.pk}${l.secret ? `&s=${l.secret}` : ''}`

/**
 * Keeps a scanned link. A new room, or a room whose account key changed, starts pairing afresh; a paired room keeps
 * its passkey, and only remembers a new (unspent) secret so the device can pair again if the Mac turns it away.
 */
export function withLink(rooms: Record<string, Pairing>, l: PairLink): Record<string, Pairing> {
  const was = rooms[l.room]
  if (!was || was.pk !== l.pk) return { ...rooms, [l.room]: { room: l.room, pk: l.pk, secret: l.secret, isPaired: false } }
  if (!l.secret || l.secret === was.spent || l.secret === was.secret) return rooms
  return { ...rooms, [l.room]: { ...was, secret: l.secret } }
}

/** Which screen a room shows before its sessions: pair, unlock, nothing to do (open), or nothing it can do. */
export type Gate = 'pair' | 'locked' | 'open' | 'not-paired'

export function gateOf(p: Pairing, isUnlocked: boolean): Gate {
  if (p.isPaired) return isUnlocked ? 'open' : 'locked'
  if (isUnlocked) return 'open'
  return p.secret ? 'pair' : 'not-paired'
}

/** A session welcomed the device: it is paired, and the secret it used cannot pair anything again. */
export const paired = (p: Pairing): Pairing => ({ ...p, isPaired: true, secret: undefined, spent: p.secret ?? p.spent })

/** A session turned the device away while pairing: the secret has expired or was refused, so it is dropped. */
export const refused = (p: Pairing): Pairing => ({ ...p, secret: undefined, spent: p.secret ?? p.spent })
