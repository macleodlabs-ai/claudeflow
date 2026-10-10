// Makes the relay's VAPID key pair for Web Push. Run once per relay; a new key turns off every phone's notifications
// until it taps "Notify me" again. The private key goes straight into the Worker secret through a pipe, so it never
// shows on screen or lands in shell history:
//   bun vapid.ts --secret-only | npx wrangler secret put VAPID_PRIVATE_KEY      (from relay/cloudflare)
// Without --secret-only it prints only how to run it. It sends nothing anywhere and runs no wrangler command.
import { b64u, vapidOf } from './src/push'

if (!process.argv.includes('--secret-only')) {
  console.log(`Store a new VAPID key as the relay Worker's secret (the key is piped, never printed):
  bun vapid.ts --secret-only | npx wrangler secret put VAPID_PRIVATE_KEY

Optional, a contact for push services (VAPID "sub"; the relay's https origin otherwise):
  npx wrangler secret put VAPID_SUBJECT     (e.g. mailto:you@example.com)

The app reads the public key from the deployed relay at /v1/push/key.`)
  process.exit(0)
}

const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
const secret = b64u(new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer))
const vapid = await vapidOf(secret, '')
if (!vapid) throw new Error('the new key did not read back')
// Only the secret on stdout, for the pipe; the public key on stderr, for the record.
console.error(`VAPID public key: ${vapid.publicKey}`)
process.stdout.write(secret)
