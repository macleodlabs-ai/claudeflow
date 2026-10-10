# Claudeflow architecture

Claude Code sessions on a Mac, watched and steered from any number of phones and tablets at once, through a relay on
Cloudflare's free plan that forwards only sealed messages. No local server, no VPN, nothing installed on the Mac beyond
the plugin.

```
Claude Code sessions (each one, every account)            Phones / tablets (any number)
  streams plugin                                            Claudeflow app (static, from the Worker's assets)
   │ HTTPS, $.http.fetch only:                               │ one WebSocket each, hibernating
   │ POST /v1/room/{room}/up  (send sealed + collect)         │ GET /v1/room/{room}/device?id=…
   └──────────────►  Worker ─► Durable Object "Room" (one per account)  ◄──────────┘
                     routes sealed frames; knows ids, sizes, timing; holds no keys
```

## Components and where they live

| Path | What | Depends on |
| --- | --- | --- |
| `plugins/streams/hooks/vendor/noble.js` (+ `.d.ts`) | @noble/curves, ciphers, hashes **2.4.0**, bundled to one ESM file (`bun build`, target browser). The plugin runtime's `crypto.subtle` has only `digest`, so all crypto is pure JS. | — |
| `plugins/streams/hooks/remote/seal.ts` | The protocol's crypto, shared by plugin and app (the app build imports this same file). | vendor/noble |
| `plugins/streams/hooks/remote/device.ts` | The device's side of the protocol (hello, welcome, sealed snapshots and commands), pure: passkey assertions come in as data. Shared like seal.ts: the app's `transport.ts` adds only the WebSocket and WebAuthn, and the plugin's tests run it against the real session link. | seal |
| `plugins/streams/hooks/remote/` (other files) | The session's side: identity, pairing, per-device channels, snapshot fan-out, commands, held permissions, passkey checks. `link.ts` is pure and owns the whole post cycle (what to post and when, backoff, retries); `index.tsx` only runs its effects. | seal |
| `plugins/streams/hooks/` (rest) | Streams: classify/routing (`classify.ts`), state, terminal UI split into components (`ui/`), updates. Each module exports `wireX(on)` and registers its own hooks; `register.tsx` only calls them in order (the order decides which hook answers first). Pure cores the hooks share: `streams/model.ts` `streamsNow` (each stream's health, status rows and tickets, read by the heartbeat, the bar, the pane, routing and the remote alike), `history.ts` `itemsOf`/`rowOf` (one transcript-to-row rule for live filing and the import), `streams/importPlan.ts` (the import's decisions; it asks for model calls by `yield`). | — |
| `relay/cloudflare/` | Worker + Durable Object `Room` (SQLite-backed: the free plan's only kind). Serves the app as static assets. | — |
| `app/` | The phone/tablet app source: static HTML + CSS + TS modules, built by `app/build.sh` (bun build) into `relay/cloudflare/public/`. Includes the pairing page with the QR code (qrcode-generator **2.0.4**, bundled). | seal, device |
| `e2e/run.ts` | The end-to-end proof: `wrangler dev`, a session played by `remote/link.ts`, two headless Chrome devices with virtual passkeys, and a refused stranger. | all of the above |

Removed: the local bridge (`plugins/streams/bridge/`), launchd install, Tailscale mode, the Bun relay (`relay/server.ts`, `relay/Dockerfile`), and the Pane's `mobile` surface branch (no phone client draws plugin UI).

## Identity, rooms, devices

- **Account identity** (one per Claude config dir, shared by all its sessions): kept in `$.store` under `remote:identity` = `{ room, token, sk }`. `room`: random 22-char id (16 bytes, base64url). `token`: 32 random bytes, base64url. `sk`: X25519 secret key, base64url. The public key `pk` is derived.
- **Devices** (phones, tablets): each has its own id (16 bytes b64u), its own X25519 key pair, and its own passkey. Paired devices are kept in `$.store` under `remote:devices` = `[{ id, pk, credentialId, credentialKey, label, pairedAt }]` (`credentialKey`: the passkey's P-256 public key as SPKI, b64u).
- **Many devices at once**: every unlocked device gets every session's snapshots, each sealed for that device. Commands from any device are taken.
- **Sessions**: each Claude Code session has its own id (`$.session.id()`) and runs its own channel with each device. The app shows one tab per session, across accounts that the device has paired with (a device may pair with several rooms).

## Protocol (v2)

Encoding: binary values are base64url without padding. JSON frames.

### Crypto (`seal.ts`)

- `connectionKeys({ ownSk, peerPk, ownEphSk, peerEphPk, sessionNonce, deviceNonce })` → `{ sessionToDevice, deviceToSession }` (32 bytes each) =
  HKDF-SHA256(ikm = X25519(ownEph, peerEph) ‖ X25519(ownStatic, peerStatic), salt = sessionNonce ‖ deviceNonce, info = `claudeflow-remote-v2`, 64 bytes); first 32 = session→device.
- `channel(sendKey, recvKey)`: `seal(obj)` → `"<n>.<b64u ciphertext>"`, XChaCha20-Poly1305, nonce = 16 zero bytes ‖ n as 8-byte big-endian, n counts from 0. `open(box)` rejects n ≤ last opened (replay, reorder) and any tampering.
- `pairingProof(secret, ...parts)` = HMAC-SHA256(key = secret bytes, msg = UTF-8 of parts joined by `|`), b64u. A pairing hello's parts are `device, pk, credentialId, publicKey`: everything the session stores for the device, so the relay, which sees the hello in the clear and may replay it while the pairing is open, cannot swap in its own passkey or another device's id.
- `verifyPasskey({ authenticatorData, clientDataJSON, signature }, credentialKeySpki, challenge, origin)`: clientData.type `webauthn.get`, `challenge` (b64u) equal, `origin` equal; authenticatorData[0..32] = SHA-256(hostname of origin); flags UP (0x01) and UV (0x04) set; ES256 signature (DER, high S accepted: authenticators are not required to normalise it) verifies over authenticatorData ‖ SHA-256(clientDataJSON) with the P-256 point from the SPKI (its last 65 bytes).
- `passkeyChallenge(...parts)` = b64u(SHA-256(UTF-8 of parts joined by `|`)).

### Relay API (`relay/cloudflare`)

- `POST /v1/room/{room}/up` — from a session. Body `{ token, session, since, frames: [{ to, data }] }`. `to` is a device id. Response `{ frames: [{ seq, from, data }], devices: [{ id, isActive }] }`: the device frames addressed to this session or to `*` with `seq > since`, and the devices connected now (`isActive`: the app reported itself visible in the last 30 s). The first request for a room stores SHA-256(token); later ones must match (403 otherwise). Max body 1 MB.
- `GET /v1/room/{room}/device?id={device}` — WebSocket from a device (Hibernation API, `acceptWebSocket` with tag `device:{id}`). Device → room messages: `{ to, data }` (`to` = session id or `*`), or `{ here: true }` (visible ping, plaintext presence only). Room → device: `{ from, data }` (from = session id).
- The Room keeps device→session frames in its SQLite storage with a sequence number, for 2 minutes, at most 500 and at most 1 MB of `data` (oldest dropped first), so one `up` answer stays readable. Session→device frames go straight to the connected socket and are dropped if the device is not connected.
- Room, device and session ids and the token are base64url, 16 to 64 characters (400 otherwise). A frame's `data` is a JSON object or string; the relay never looks inside it.
- Device sockets need no token, so the Room limits them: a device message over 16 KB is dropped, and a socket that sends more than 30 messages in a minute is closed with 1008 (a device pings 4 times a minute, plus a hello and a few commands).
- A device that reconnects with the same id replaces its older socket (closed with code 4000). A newly connected device is `isActive: false` until its first `{ here: true }`, so the app pings as soon as it is welcomed.
- Static assets: `/` the app, `/pair` the pairing page.

### Session ↔ device messages (the `data` of frames)

Plain (public values only):
- device → `*`: `{ t: "hello", device, pk, eph, nonce, passkey, proof?, registration?, label? }` (`label`: up to 60 characters, stored with the device at pairing)
  - `passkey`: an assertion over `passkeyChallenge("hello", room, eph, minute)` where `minute` = floor(unix seconds / 60); sessions accept the current or previous minute. One Face ID per connection, checked by every session.
  - First pairing only: `proof` = pairingProof(secret, device, pk, credentialId, publicKey) and `registration` = `{ credentialId, publicKey (SPKI b64u), clientDataJSON }` (type `webauthn.create`, origin = relay origin, challenge = `passkeyChallenge("pair", room, device, pk)`). In that case `passkey` is omitted: the registration ceremony itself had user verification.
- session → device: `{ t: "welcome", session, eph, nonce }` or `{ t: "denied", why }`, `why` one of `not paired`, `pairing expired`, `bad pairing proof`, `bad registration`, `passkey not verified`. A hello with `proof` takes the pairing path even for a known id, so a reinstalled app can pair again.
- The registration's `clientDataJSON` is checked for type, origin and challenge (its signature is not checked: no attestation); the pairing proof is what ties the stored passkey to this pairing.

Sealed (after welcome; `{ t: "box", b }`):
- session → device: `{ t: "snapshot", snapshot }` (the existing `Snapshot` shape, plus `permissions`, `questions` and `settled`; see "Held prompts"), on change and every 30 s. Nothing in it is a running clock: a stream carries its clocks as times (`since`, last active; `nextAt`, a loop's next tick; epoch ms, copied from its status line) beside a `detail` with no clock in it, and an agent carries `startedAt` and `endedAt`, not its elapsed time. So an unchanged session is not news every tick. The terminal and the app both count the time as they draw (`status.ts` `lineText`).
- session → device: `{ t: "ack", id, ok, why? }`, sealed like a snapshot: what came of the command `id`. Every `answer`, `stop`, `permission` and `choose` is acked, so the phone shows a definite outcome on a slow network instead of guessing. `why` is one of `allowed`, `denied`, `chosen`, `answered on Mac`, `moved to Mac`, `chose recommended`, `passkey not verified`, `unknown request`; a late tap on something already settled is told what settled it. Older apps open it and ignore it.
- device → session: `{ t: "command", command }` with the commands `answer`, `stop`, `permission`, `choose` (an option for a held question, `{ requestId, label }`). Command ids are random per tap and the session takes each id once: a command sent again under the same id (a Retry, a resend after lag) runs once and gets its ack again. An `allow` carries `command.passkey`: an assertion over `passkeyChallenge("allow", requestId, eph)`, `eph` being the device's ephemeral key from this connection's hello. A request gets up to 3 Allow tries (`MAX_ALLOW_TRIES`), each with its own command id and its own valid assertion; a failed check uses a try and is acked `passkey not verified`, and a 4th try is refused.

### Held prompts (`remote/index.tsx`)

- **While a paired device is looking** (`isLooking()`: unlocked and visible), a permission prompt (`tool.check` answering `ask`) is held for an answer, and so is an AskUserQuestion call with one single-choice question (`tool.call`; several questions, multi-select, text or number questions stay with the terminal's dialog). The snapshot lists them in `permissions` (`{ id, tool, summary, at, since }`) and `questions` (`{ id, question, header, options: [{ label, description?, isRecommended }], since }`). `since` is when it was raised; the phone shows "waiting 3m" from it. There is **no deadline**.
- **Who answers:** the phone (Allow with Face ID, Deny, or an option), or the Mac: for a permission, an Allow / Deny band above the prompt (`ui.render` on `AbovePrompt`, "also on your phone"); for a question, the terminal's own dialog, which stays up (`next(e)` in flight). The first answer wins; the other side clears, and a late tap is acked with what won.
- **Nobody there:** when no paired device has looked for `NO_DEVICE_MS` (2 minutes) straight, the session stops waiting on the phone. A **permission is never allowed on its own**: it goes to the terminal's prompt (the hook returns the engine's `ask`), since a tool call has no recommended answer and an unattended Allow would run something nobody approved. (`tool.check`'s `next(e)` gives the engine's verdict, and it is `ask` whenever a prompt is held, so there is no suggested deny to take.) A **question** takes the option whose label ends in "(Recommended)" and tells Claude ("No answer from the person after 2 minutes; chose the recommended option: …", as the result's `context`); the band above the prompt says "Chose the recommended answer: … (no answer for 2m)" for two minutes. With no option marked, the terminal's dialog stays the only way to answer.
- **`settled`:** what became of each held prompt that left, for 10 minutes (`{ id, why, label?, at }`), so a phone that was away says "Answered on your Mac", "Moved to your Mac" or "Chose the recommended answer: …" rather than guess, then collapses the card.
- **The hook budget:** the engine gives a hook 10 s of its own time per dispatch (`HookBudget.ms`) and counts a `$.clock` wait, or any promise of the plugin's, against it; only a `$` call in flight stops that clock. So a held prompt waits in 2 s steps, each keeping a `/bin/sleep 2` (`$.process.run`) in flight beside the clock's wait. A hold that only awaited the clock would be dropped by the engine after 10 s, and the terminal would ask.

### Pairing

`/streams phone` makes a pairing secret (32 bytes, valid 10 minutes, any number of devices within that time), stores it in `$.store` (`remote:pairing`), and opens `${relay}/pair#r=${room}&k=${pk}&s=${secret}` in the Mac's browser. The pair page draws a QR code of `${relay}/#r=…&k=…&s=…`. Everything after `#` never reaches a server.

### Polling budget (free plan: 100k requests/day across Worker + Room)

A session ticks every 2 s and posts `up` when its sealed snapshot changes or it has frames to send; every tick while it holds a prompt or a question (the Allow should land fast); every 6 s while a device is active, and for a minute after it welcomes a device (the device counts as active only once its ping reaches a later answer, and its first tap should not wait for the heartbeat); otherwise every 30 s. Only paired devices count as active (any device while a pairing is open): anyone with the room id can open a socket, and must not keep the account polling fast. A session whose account has no paired device and no open pairing never calls the relay. When it answers hellos it posts again in the same tick, so the welcome and the first snapshot arrive together; likewise once with the acks for the commands it took. Device pings every 15 s while visible (WebSocket messages count 1/20). All of this is decided in `remote/link.ts` (`next` says what to post and when, `answered` reads the answer or the failure); `remote/index.tsx` and `e2e/run.ts` only make the posts.

Counted for 3 sessions (each post is one Worker and one Room request): idle with nothing looking, 3 × 2,880 posts = 17,280 requests a day; with a device looking, 3 × 600 posts = 3,600 requests an hour, so about 23 hours of looking a day fit in the rest. Posts on change come on top: a session that is working changes often.

## Rules for the code

- Small modules with one job each; pure logic separate from I/O; no file over ~400 lines.
- Plugin engine calls are written `$.noun.verb(...)` at the call site, never through a helper that takes `$` (the hot-reload loader refuses it; `plugin validate` and `plugin test` do not catch it). `$` is followed only into functions declared in the same file, and an atom must be declared in the file that reads or updates it: so modules do not call each other's `$` code, they each register their own hooks. One event hooked by several modules needs a matcher on each registration (`{}` will do).
- Tests encode intent (why the behaviour matters). Security properties get tests: tampering, replay, swapped keys, expired pairing, wrong passkey, unpaired device.
- Libraries pinned to exact latest versions.
