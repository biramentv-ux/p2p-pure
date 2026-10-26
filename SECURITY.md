# Security and privacy of the signalling Worker

Scope: the Cloudflare Worker at `tg.dyrakarmy.online` (`worker/`). Messages, photos and calls never pass through it; they go device to device over WebRTC.

## What the Worker keeps

| Data | Where | How long | Notes |
|---|---|---|---|
| Short-code invitation (`/invite`) | Workers KV | 10 minutes, deleted on first fetch | Signed `p2p1:` text; contains network addresses (ICE candidates) but no keys or messages |
| Telegram delivery record | Workers KV | until the recipient presses the delete button, or about 10 minutes (cron purge every minute; KV TTL as a backstop) | Recipient chat id, message id, due time. No text, no invitation |
| Demo room frames | Durable Object memory only | relayed, not stored; room closes after 10 minutes | Nothing is written to Durable Object storage except the expiry alarm time |
| Rate-limit key | Cloudflare Rate Limiting binding | 60-second window | HMAC-SHA-256 of the client IP, keyed with a Worker secret, first 8 bytes. The raw IP is not passed to the limiter and not stored by the Worker |

## What the Worker logs

Nothing. The code has no `console.*` calls, `observability` is explicitly `enabled: false` in `worker/wrangler.jsonc` (Workers Logs and invocation logs off), and no Logpush job or tail consumer is configured. A test (`tests/worker/privacy.test.ts`) fails if a console call appears or the setting changes. Turning logs on would store request URLs, which contain invitation and room codes, so do not do it without changing this file.

## What Cloudflare as a platform still sees

The Worker runs on Cloudflare, and Cloudflare terminates TLS. As the platform operator it can see, outside the control of this code: client IP addresses, request URLs (including codes), headers and timing for every request, and the plaintext of invitations and demo-room frames passing through the Worker. It keeps its own operational and abuse-prevention logs and aggregate analytics under its own policy. Account owners also see the usage metrics in the dashboard. Invitations are signed and contain no message keys, so this exposes who connects and when, not message content.

## What Telegram sees

In the Telegram path, Telegram sees the sender and recipient chats, the invitation text and the bot messages. The bot is not an encrypted channel.

## Reporting

Report vulnerabilities privately to the repository owner (GitHub Security Advisories).
