# Runtime refresh verification — 2026-11-05

Implementation: direct local runtime refresh, right-aligned header actions, on-demand `?refresh=true` window, optional `sampleWindowMs` decoding, legacy cache display. Pure icon controls and manual-only reads remain.

## Commands and results

- `npx playwright test e2e/engine-manual-diagnostics.spec.ts e2e/engine-resource-presentation.spec.ts e2e/p1-engine-runtime-contract.spec.ts --workers=1`: **20 passed**, including optional window validation, missing-field compatibility, legacy same-time cache identification, no polling, and late-result rejection.
- Fresh standalone Electron build: **passed**. Full npm build/typecheck: **failed on concurrent browser changes**, preserved verbatim in [build-typecheck.log](build-typecheck.log).
- Initial 3-spec/4-test Electron run: real PID/storage **passed (5.0s)**; controlled HTTP runtime **passed (50.5s)**. The two remaining cases needed test-only corrections: remove an outdated footer text assertion without restoring removed source text, and wait for initial OS diagnostics before saving its baseline.
- Targeted rerun of those two cases against the **same fresh product build**: **2 passed (35.6s)**. Original command output is in [live-rerun.log](live-rerun.log).

| Electron case | Final result | Evidence |
|---|---|---|
| Real PID, physical storage, cache/refresh, health | Passed in initial run | Real OS/SQLite values from isolated embedded engine |
| Resource page and header layout | Passed in rerun, 10.1s | Right edge alignment, status adjacent, icon-only buttons, actual added 2 MiB file counted, no timer/hide-resume reads |
| Real V8 / event-loop runtime | Passed in rerun, 21.9s | `sampleWindowMs=200`, immediate request timestamps advance, >15s quiet with no engine reads followed by one local click yields available ELU/delay; local refresh leaves OS snapshot unchanged; top refresh updates both |
| Controlled HTTP runtime UI | Passed in initial run, 50.5s | Mouse and Enter issue GET with `refresh=true`; sample time and heap values change; summary stays open; loading/reduced-motion; local runtime remains usable while diagnostics IPC is held |

The controlled IPC hold is installed only inside the isolated Electron test application through public `ipcMain` APIs. It is not a production mock or a measurement of a real user's data.

## Saved screenshots

- [monitor-heading.png](monitor-heading.png): real embedded-engine monitor, refresh at the far right after status, 34px accent control.
- [runtime-live-light.png](runtime-live-light.png), [runtime-live-dark.png](runtime-live-dark.png): **real isolated engine**, showing a 200ms window and approximately 0.2s ELU interval.
- [runtime-ui-dark.png](runtime-ui-dark.png): **controlled HTTP fixture**, used for interaction regression; its numerical values are synthetic, including the displayed 5s interval. It is not the evidence for the real short measurement window.

All Electron runs used separate `.e2e-tmp` user data. Embedded fixtures used port 12417; the HTTP fixture used its own ephemeral loopback port. Workers=1, no CUA/sky, no current user window or database operations. All test applications closed normally.
