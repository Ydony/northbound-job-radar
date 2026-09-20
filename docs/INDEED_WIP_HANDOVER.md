# WIP handover — 2026-09-20: implementation paused at owner direction

The owner says another agent is implementing Indeed and Claude is reviewing. Codex
has switched to read-only review issues #79, #80 and #81. Do not merge this WIP as-is.
This worktree is isolated; the primary checkout and its servers were not modified.

Uncommitted draft: normalization, source registration, persistent collection guard
(migration 18), local/admin-only configuration, search/report integration, readiness
panel, private-copy separation, account read/write filtering and synthetic D1 tests.

Owner's latest decision: VPN is OPTIONAL for local admin Indeed only. Follow-up #73
tracks optional VPN work. Other restricted sources retain their VPN requirements.
The last edits removed the Indeed VPN argument; tests still need their call sites
updated. Do not repeat the previous green typecheck/build claim for this final WIP.

Last evidence before that decision: 215/216 tests passed (the one failure was the
old blocked-vs-disabled expectation, subsequently updated), typecheck/lint/build
passed. Four new integration tests passed using synthetic responses and real D1.
No new live upstream integration search was run. Standalone transport proof remains
in the merged PR #71 and its documentation. No actual credentials are bundled.

A disposable dev server was started from THIS worktree on port 3100 with new empty
state and independently generated secrets; Indeed is disabled. No owner server was
stopped or restarted. No browser/API acceptance was completed before this handover.

## Independent finding still NOT fixed

P1: `app/api/feedback/route.ts` exports all corrections for the current account
without filtering private sources. After administrator demotion, this can disclose
Indeed source names, titles and saved description evidence, even while `/api/state`
hides them. Filter in SQL before LIMIT, include `j.user_id = f.user_id`, and test
direct feedback export after demotion. The independent reviewer stopped after this
finding; their review was not complete.

Other unfinished items: current-master reconciliation (language normalization is now
version 7, while this draft changes its older baseline 5 to 6; NEVER downgrade it),
check migration 18 remains free, update docs after the VPN change, verify complete
read/write/export isolation in dev and built test, review request counts/cancellation,
source aliases and persisted stop state, browser QA and explicit stable promotion.
