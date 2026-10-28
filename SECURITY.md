# Security and privacy

> Български: [SECURITY.bg.md](SECURITY.bg.md). License: [LICENSE](LICENSE) ([на български](LICENSE.bg.md)).

## Data on the device (IndexedDB `p2p-messenger`, version 5)

Every store except `identity` holds only AES-256-GCM ciphertext (WebCrypto, random 12-byte IV,
associated data that binds each record to its store and key). The keys exist only in memory
after unlock; they are derived from the identity seed (`deriveHistoryKey`), which is itself
stored encrypted under the passkey PRF or the password.

| Store | Visible in plaintext | Encrypted |
|---|---|---|
| `identity` | DID, public key, unlock method, credential id | seed |
| `contactsSealed` | `id` = HMAC-SHA-256(contact MAC key, DID), row count | DID, public key, name, verified flag, timestamps |
| `contacts` (legacy, pre-v5) | empty after first unlock on v5 | — |
| `messages` | peer DID, direction, timestamp | content |
| `files` | owner, id | file bytes and metadata |
| `groups` / `groupMessages` | owner tag, random group id, timestamps | group state, keys, members, messages |

### Contacts (since v5)
- Keys: HKDF-SHA-256 from the history key, info `p2p-messenger/contacts/aes/v1` (AES-GCM) and
  `p2p-messenger/contacts/id-mac/v1` (HMAC), non-extractable `CryptoKey`s.
- The index is HMAC(DID), not the DID: every lookup starts from a DID the app already holds,
  so nothing needs the plaintext key. The DID still appears in the `messages` store's
  `peerDid` index, so this hides the contact list itself, not who you have chatted with.
- AAD = `p2p-contacts/v1|contactsSealed|<id>`; after decrypting, HMAC(DID) must equal the row id.
- While locked, every contact call throws `ContactsLockedError`.

### Migration v4 → v5
The upgrade only adds the `contactsSealed` store (no key is available inside `onupgradeneeded`).
On the first unlock, `unlockContacts` reads the plaintext rows, encrypts them, then in ONE
readwrite transaction over both stores writes the sealed rows and deletes the plaintext rows.
Either both happen or neither does. Malformed legacy rows are left untouched rather than lost.
If the migration fails the app still unlocks, and the next unlock retries.
Note: deleted IndexedDB rows may survive in the browser's storage files until compaction.

## Moving the identity to a new device (threat model)

Design: `docs/MULTIDEVICE.md`. Code: `src/transfer/`, `src/identity/seedTransfer.ts`.

One-time MOVE, not sync. The old device sends the 64-byte BIP39 seed and the contact book to the new device over a WebRTC data channel set up with QR codes or pasted text (no server). The old device then offers to wipe itself.

- **Key agreement:** ephemeral X25519 per transfer, HKDF-SHA-256 with a transcript that includes both SDPs (so the DTLS fingerprints), frames in AES-256-GCM with a per-direction key and strict counter. Replayed, reordered, dropped or altered frames abort the transfer.
- **Confirmation (SAS):** 6 words (66 bits) shown on both screens; the seed is released only after both people confirmed. A mismatch aborts and nothing is sent.
- **One-time, short-lived:** an offer lives 10 minutes and accepts one answer. It carries no DID and no signature.
- **Re-authentication:** starting a transfer needs the password or a passkey tap even when the app is unlocked.
- **The new device protects the seed with its own passkey or password.** Nothing about the old device's unlock method is sent.
- **No Double Ratchet state is copied** (none is stored on disk), groups and history are not transferred, so no ratchet or group chain exists on two devices after a move.

Attacks and what stops them: a camera or shoulder-surfer seeing the QR codes cannot derive the keys (they lack the ephemeral secrets) but can race the legitimate new device; the SAS comparison and the one-answer rule make that visible and fail it. An active network attacker cannot change an SDP or key without changing the SAS and breaking the first frame. Pasting the code through an untrusted channel lets that channel replace it: the SAS is then the only defence.

Residual risks: the plaintext seed is in memory on both devices during the transfer; a compromised old or new device defeats everything; choosing "Later" leaves the identity on both devices; the seed is the root of the identity, so anyone who completes a transfer (with both SAS confirmations) holds it. Message history is not transferred and is deleted with the old device.

## The signalling Worker

Scope: the Cloudflare Worker at `tg.dyrakarmy.online` (`worker/`). Messages, photos and calls never pass through it; they go device to device over WebRTC.

### What the Worker keeps

| Data | Where | How long | Notes |
|---|---|---|---|
| Short-code invitation (`/invite`) | Workers KV | 10 minutes, deleted on first fetch | Signed `p2p1:` text; contains network addresses (ICE candidates) but no keys or messages |
| Telegram delivery record | Workers KV | until the recipient presses the delete button, or about 10 minutes (cron purge every minute; KV TTL as a backstop) | Recipient chat id, message id, due time. No text, no invitation |
| Demo room frames | Durable Object memory only | relayed, not stored; room closes after 10 minutes | Nothing is written to Durable Object storage except the expiry alarm time |
| Rate-limit key | Cloudflare Rate Limiting binding | 60-second window | HMAC-SHA-256 of the client IP, keyed with a Worker secret, first 8 bytes. The raw IP is not passed to the limiter and not stored by the Worker |

### What the Worker logs

Nothing. The code has no `console.*` calls, `observability` is explicitly `enabled: false` in `worker/wrangler.jsonc` (Workers Logs and invocation logs off), and no Logpush job or tail consumer is configured. A test (`tests/worker/privacy.test.ts`) fails if a console call appears or the setting changes. Turning logs on would store request URLs, which contain invitation and room codes, so do not do it without changing this file.

### What Cloudflare as a platform still sees

The Worker runs on Cloudflare, and Cloudflare terminates TLS. As the platform operator it can see, outside the control of this code: client IP addresses, request URLs (including codes), headers and timing for every request, and the plaintext of invitations and demo-room frames passing through the Worker. It keeps its own operational and abuse-prevention logs and aggregate analytics under its own policy. Account owners also see the usage metrics in the dashboard. Invitations are signed and contain no message keys, so this exposes who connects and when, not message content.

### What Telegram sees

In the Telegram path, Telegram sees the sender and recipient chats, the invitation text and the bot messages. The bot is not an encrypted channel.

## Optional TURN relay (user-configured)

Off by default. The app ships no TURN server and no credentials. A person can enter their own `turn:` / `turns:` URL, username and credential in the Identity tab (Settings: own TURN relay); `src/p2p/turnConfig.ts` validates it (only `turn:`/`turns:`, no credentials inside the URL, a warning for private-range hosts and for plain `turn:`).

- **What a relay sees:** traffic metadata only: both endpoints' IP addresses, timing and packet sizes. Not content: the data channel is DTLS, and the messages inside are encrypted again end to end (Double Ratchet), so the relay operator cannot read them. A relay you do not run is a third party that learns who talks to whom and when; use your own or one you trust.
- **Relay only (optional):** sets `iceTransportPolicy: "relay"` and leaves STUN out, so neither the other person nor STUN servers see this device's IP. Cost: slower, and the relay sees every connection. Without it, a relay is used only when direct paths fail, but the relay candidate is part of the invitation (it contains the relay's address, which the other person then learns).
- **At rest:** the whole record (URL, username, credential, flags) is AES-256-GCM encrypted with a key derived from the history key (`src/p2p/turnStore.ts`, using `atRestCrypto.ts`), so nothing readable is stored while locked. After unlock it sits in memory and is dropped on lock. The credential is a TURN password in the ICE configuration, so page scripts in the same origin could read it while unlocked, like any other in-memory secret; the CSP (`script-src 'self'`) is the mitigation.
- **CSP:** unchanged. WebRTC ICE/TURN traffic is not governed by `connect-src` (which covers fetch, XHR, WebSocket, EventSource and beacons).
- **Not changed:** the Worker and Telegram paths still see only what is listed above. TURN credentials are never sent to them.

## Reporting

Report vulnerabilities privately to the repository owner (GitHub Security Advisories).
