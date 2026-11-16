# group-timer-resume (SDE)
- Review fixes from #95/#96 (Codex): resume installs all transfers before awaiting, auto-lock
  hidden grace, bundle dmAt, panic/unlock generation, call track leaks and ICE gathering wait,
  rendezvous offer freshness and expiry callback.
- ChatScreen 898 → 756 lines: `timerSync.ts`, `useDisappearingTimer`, `useChatFiles`, `useChatCall`.
- Groups: timer (`setTimer`, `T|` frame, prune every 5 s, persisted in the group record),
  history expiry in groupStore, purgeExpired over group rows, file resume with lazy key,
  `FileResumeStore.peers/dropPrefix`, `ResumeOptions.peer` may be a function.
- UI: timer select over group messages, ⏱ on expiring messages, paused phase in the transfer list.
- Fixed a stale e2e check (ui.mjs expected 6 safety words; main uses 12 since f667496).
- Tests: tests/group/groupTimerResume.test.ts, groupStore expiry/timer, timerSync.
