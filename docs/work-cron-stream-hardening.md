# Cron streaming and cancellation hardening — 2026-10-12

## Implemented

- The scheduler consumes SSE incrementally; it retains only the current frame (maximum 1,048,576 UTF-16 characters), current run identity, and terminal status. Whole transcripts are no longer retained by the scheduler.
- HTTP 200 alone is not success. JSON responses, malformed/error envelopes, absent terminal outcomes, wrong-session frames and conflicting run identities cannot produce a success log.
- Scheduler stop, timeout and stream-consumption errors cancel only an observed owned run. The cancellation response body must have code 200 as well as successful HTTP status.
- `/api/v1/chat/cancel` accepts optional `runId`. Under the history admission lock it validates tenant/session/run ownership, aborts only the matching stream controller and cancels command jobs scoped to that run. It does not abort preparing controllers or advance the session cancellation epoch. Existing user session-wide stop remains unchanged.

## Evidence

- `src/scheduler/__tests__/cron-stream.test.ts`: 4 passed. Fragmented UTF-8 and CRLF, 2.4 MB accumulated transcript with small bounded frames, oversized frame, conflicting identity, JSON/SSE error response.
- `src/scheduler/__tests__/cron-instance-auth.test.ts`: 13 passed. Auth/loopback/redirect isolation, overlap prevention, explicit thinking off, stop, terminal failure, owned-run cancellation response validation, malformed/oversized stream cleanup. Latest execution 2026-10-12 11:16 local.
- `src/api/http/routes/__tests__/command-jobs.test.ts`: 17 passed. Real HTTP and child processes; stale owned cancellation leaves newer same-session run and its commands executing, then precise newer-run cancellation stops both producer and commands. Existing history/cancellation/persistence lifecycle tests remain green.
- Total relevant regression coverage: 34 passing tests. Engine typecheck and build passed after final code change.
- Final source build: `sha256:2478d34186cee38cdf701b848dbfe66e482138dad9c4a16cbc0e35e8ecac66e5`.

## Honest remaining limit

If timeout occurs before the client receives the initial run identity, the scheduler does not send a session-wide cancellation. Disconnect cancels preparation, but an admitted durable producer whose first run frame is lost cannot be correlated safely with the current request. Closing that edge requires a persisted request-correlation/admission contract. This change deliberately avoids guessing the current session run and stopping later user work.

The current Cron total timeout remains 120 seconds. `lastRunAt` records a trigger attempt, not successful completion. These tests do not establish a 24/7 availability guarantee.

## Isolated restart

Run `node .ae/soak/real-20261012/resume-isolated.mjs` from `D:/dev/aether-code` after packaging. It uses port 12519, the existing isolated `agent.db`, and the token read in memory. It writes `engine-start.json` and sanitized logs. Do not print the token or credential-bearing model records. Verify the returned PID, UTC process ticks and package `stage-manifest.json` buildId. User engine 12323 must remain untouched.

## Follow-up: explicit per-job deadlines and continued model selection

The default remains 120 seconds for backward compatibility; jobs can now explicitly persist `timeoutSeconds` as an integer from 1 through 86400, or `null` to restore the default. This is not a global timeout increase. Migration 027 adds a nullable INTEGER with a database CHECK; both HTTP create/update and store methods validate bounds. Unrelated edits preserve the field. The scheduler writes its actual effective value to `root.requestConfig.cronTimeoutSeconds` alongside `cronJobId`, and passes that same value to the abort deadline.

The upcoming one-hour endurance test is configured explicitly with **600 seconds per Cron invocation**. This deadline is a declared workload configuration, not a repair for model mistakes. Failed terminal outcomes, tool errors, missing required actions, and invalid results remain failures.

A separate F-run audit identified an actual continuation model-selection bug: the parent request explicitly selected Qwen for its child, but when the tool omitted its model argument, the old child's DeepSeek model took precedence. Resolution is now explicit tool model > explicit parent child-model setting > prior child model > parent model. The child's persisted session, role and restricted capabilities are preserved.

Final combined verification: six files, 44 tests passed (11 storage/API timeout, five scheduler timeout including a real one-second HTTP cancellation, 13 cron transport, four stream, three lifecycle, eight reviewer/continuation). Typecheck, diff check and build passed. Source build: `sha256:b3714f163cfd8d9945145ce5cb03c589c75d837752b1fbdc8bfdecb2a20d2fd3`.

## Follow-up: real API audit-field projection

A real Cron preflight succeeded but exposed a gap in the prior evidence claim: scheduler request-body fields alone did not survive `RootRunStore.resumableRequest` or `publicRequestConfig`. Both explicit allowlists now include `cronJobId` and validated `cronTimeoutSeconds`. This does not alter the deadline itself.

Regression uses actual SQLite persistence plus real HTTP `/chat/runs`, `/chat/status`, and `/chat/snapshot` calls. It verifies the 600-second configuration and job identity are visible and private credentials remain excluded. All 17 chat-recovery tests, typecheck, diff check and build passed. Updated source build: `sha256:bf07846259fa6f3844bb9b2d14a8e03fd3c475638a4f77d2fc075ebda3d13d09`. A new real scheduled invocation must verify these fields before the formal endurance run; older runs whose fields were discarded cannot retrospectively gain them.
