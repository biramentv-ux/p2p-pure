# ADR-005: Disappearing messages and file resume in groups

**Status:** Accepted
**Date:** 2026-11-16
**Feature:** group-timer-resume
**Author:** 10x-Team (Architect + Staff Engineer)

## Context
Н5 and Н7 shipped for 1:1 chats only. Groups had no timer, and a group file cut off by a dropped
pairwise link failed. ChatScreen held the timer and file logic inline (over 800 lines), so the
group could not reuse it.

## Decision
- Timer rules move into `history/timerSync.ts` (no React). The 1:1 chat uses it through
  `useDisappearingTimer`; `GroupSession` uses it directly.
- The group setting is a group message `\u0001T|{"ms","at"}` (epoch key, signed), and is
  also sent on every new pairwise link so an offline member catches up. Any member may change it;
  newer setting wins, ties go to the shorter timer. Received texts lose `\u0001`, and `sendText`
  strips it too, so text cannot pose as a setting.
- Group history rows carry clear `expiresAt`/`fileId` like 1:1 rows; `expiresAt` is in the AAD
  only when present (old rows still open). `purgeExpired` sweeps both stores in one transaction.
- Group links get resume options with a lazy key `group:<groupId>:<did>` in the shared
  `parkedFiles`; null before the group is known. Parked transfers of removed members and of a
  group this device left are dropped.

## Alternatives Considered
| Alternative | Pros | Cons | Why Not |
|---|---|---|---|
| Admin-only timer | One authority | Admin offline blocks changes; differs from 1:1 | Signal-like "any member" is simpler to explain |
| Timer in the signed snapshot (gsnap) | Rides membership sync | Only the admin signs snapshots | Same as above |
| Resume keyed by did only | No group id needed | Collides with the 1:1 chat with the same person | Separate key space is safer |

## Consequences
### Positive
- One implementation of the timer rules for chats and groups; ChatScreen is 756 lines.
### Negative
- A member who never links again after a change keeps the old timer until it does.
### Risks
- A malicious member can set a timer; that only deletes their peers' copies sooner, which any
  member could request anyway. Notices show who changed it.
