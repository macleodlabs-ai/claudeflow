import { describe, expect, test } from 'bun:test'
import { gateOf, linkFragment, paired, parseLink, refused, withLink, type Pairing } from '../src/links'

const room = 'AAAAAAAAAAAAAAAAAAAAAA'
const pk = 'B'.repeat(43)
const secret = 'C'.repeat(43)

describe('pairing links', () => {
  test('a link from /streams phone round-trips through the fragment', () => {
    expect(parseLink(linkFragment({ room, pk, secret }))).toEqual({ room, pk, secret })
    expect(parseLink(`#r=${room}&k=${pk}`)).toEqual({ room, pk })
  })

  test('malformed links are no link: their values become key material and URL paths', () => {
    // A room id with a slash would change the WebSocket path; a short key is no X25519 key.
    expect(parseLink(`#r=../evil/AAAAAAAAAAAA&k=${pk}&s=${secret}`)).toBeUndefined()
    expect(parseLink(`#r=${room}&k=short&s=${secret}`)).toBeUndefined()
    expect(parseLink(`#r=${room}&k=${pk}&s=bad!`)).toBeUndefined()
    expect(parseLink('')).toBeUndefined()
  })
})

describe('rooms kept from links', () => {
  test('a first scan starts pairing with the secret', () => {
    const rooms = withLink({}, { room, pk, secret })
    expect(gateOf(rooms[room]!, false)).toBe('pair')
  })

  test('the link left in the address does not offer pairing again once it worked', () => {
    // Add to Home Screen keeps the fragment, so every launch parses the same link again.
    let rooms = withLink({}, { room, pk, secret })
    rooms = { [room]: paired({ ...rooms[room]!, credentialId: 'cred' }) }
    const again = withLink(rooms, { room, pk, secret })
    expect(again).toBe(rooms)
    expect(gateOf(again[room]!, false)).toBe('locked')
    expect(again[room]!.credentialId).toBe('cred')
  })

  test('a new code for a paired room keeps the passkey and only allows pairing again', () => {
    const was: Pairing = { room, pk, isPaired: true, credentialId: 'cred', spent: secret }
    const fresh = 'D'.repeat(43)
    const now = withLink({ [room]: was }, { room, pk, secret: fresh })[room]!
    expect(now).toMatchObject({ isPaired: true, credentialId: 'cred', secret: fresh })
    expect(gateOf(now, false)).toBe('locked')
  })

  test('a changed account key starts over: the old passkey belongs to a different identity', () => {
    const was: Pairing = { room, pk, isPaired: true, credentialId: 'cred' }
    const now = withLink({ [room]: was }, { room, pk: 'E'.repeat(43), secret })[room]!
    expect(now.isPaired).toBe(false)
    expect(now.credentialId).toBeUndefined()
  })

  test('a refused pairing cannot be retried with the same secret', () => {
    const p = refused({ room, pk, secret, isPaired: false })
    expect(gateOf(p, false)).toBe('not-paired')
    expect(withLink({ [room]: p }, { room, pk, secret })[room]).toBe(p)
  })
})
