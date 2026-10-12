# Smoke C timeout re-audit

This supersedes the initial diagnosis based on events.jsonl error snapshots. That diagnosis incorrectly treated contaminated harness error evidence as session authority and inferred a parent hang from a 22-second final-response interval. Neither inference is supported.

## Authoritative evidence

Read-only evidence: `.ae/soak/real-20261012/sessions/default/` JSONL transcripts, one file per parent and child. Root IDs and model IDs below come from persisted assistant/user metadata, not the shared AbortController error. No engine code was changed or process restarted during this audit.

| Parent session suffix | True root run | Actual parent/child model | Parent elapsed through cancellation | Parent tool results | Child execution | Child calls / recorded tool time |
| --- | --- | --- | --- | --- | --- | --- |
| engineering-smoke-20261012c-shared-1 | ca84c0fb-6652-49c9-a5f2-3198733cf973 | qwen3.8-flash | 600.127 s | 12 | succeeded, 465.938 s | 13 / 279 ms |
| engineering-smoke-20261012c-shared-2 | c6345ce0-f141-4415-bf10-8642f65f39b0 | deepseek-v4.1-flash | 600.680 s | 14 | cancelled by parent, 467.900 s | 15 / 128 ms |
| engineering-smoke-20261012c-shared-3 | d36dd707-981f-4d8b-8f03-c4a40a5d403b | qwen3.8-flash | 600.812 s | 20 | cancelled by parent, 149.938 s | 7 / 82 ms |

All three child runs waited only 2 ms between creation and start. This excludes a multi-minute child pool queue as the cause in these runs. Tool-duration sums are recorded execution time, not elapsed model processing time or a reliable CPU-time measurement.

## Detailed timeline (UTC)

- Shared 1 starts 02:21:12.491. Its commands finish at 02:22:33.218 and 02:22:36.975 successfully. Child `e8ab26d1-941c-43d0-9c95-3847f4c69804` runs 02:23:04.444–02:30:50.382. Last child file read completes 02:28:14.602; final response completes 155.780 s later, with 10,486 output characters. Total stored child reasoning across responses is 67,365 characters. Parent receives the child result at 02:30:50.934, then cancellation writes an assistant row at 02:31:12.618. That interval is 21.684 s. The empty assistant is explicitly a cancellation row, not evidence of a completed empty model answer. No hang is proven.
- Shared 2 starts 02:21:12.487. At 02:23:24.816 the parent asks for a regression command and a child review in one batch. Child `ab98b07a-3d09-49d5-b9cd-f615b051bc77` runs 02:23:24.980–02:31:12.880, then records parent cancellation. Its last file read is 02:29:02.211. Cancellation preserves 3,792 characters of partial response and 32,542 characters of reasoning from the last response; across stored child responses reasoning totals 122,010 characters. The command result is published after batch settlement at 02:31:13.167 but its recorded duration is only 154 ms, exit 1, 11 tests passed / 2 failed. It is not an eight-minute hung process. The failing generated tests assert that locale order must differ for the chosen sample, and expect 3 rows where the output has 4; the parent never gets an opportunity to repair them before cancellation. No evidence shows model switching to Qwen in this actual session.
- Shared 3 starts 02:21:12.498. It performs 20 calls, including an edit mismatch followed by reread and successful edit, and a failing regression followed by repair and a successful rerun. These are bounded corrections, not evidence of an infinite tool loop. Its child `f31aeb9e-e29f-4cb6-93ec-a68b58d57a7e` starts only at 02:28:43.368, about 451 seconds into the parent's total budget. Seven reads finish by 02:29:11.921. Cancellation at 02:31:13.306 occurs 149.938 seconds after child start; the last assistant cancellation record retains 20,536 reasoning characters. It was still producing model reasoning, not blocked on a command or approval.

## Conclusion and limits

The direct stopping mechanism is the harness's total 600-second watchdog, shared cancellation ending the remaining sessions. The authoritative evidence is consistent with legitimate but verbose model analysis/review being cut short. It does not establish a ReAct deadlock, missing child deadline, session routing defect, or a need to force a final response. The long child reviews (roughly 466–468 s) are dominated by time between tool responses, while actual file calls are milliseconds. Persisted history alone cannot distinguish provider queue time, token generation speed, transport pauses and local stream processing within those intervals; request-attempt timing or streaming heartbeat measurements are required for that decomposition.

The harness error-evidence aliasing is separately confirmed by the soak owner and fixed by cloning per-turn error evidence. `events.jsonl` failure entries that report shared-2 using shared-3's Qwen run must not be used as product routing evidence.

Next validation should retain all artifact correctness and real model/subagent requirements, use independently attributed turn evidence, and measure last actual stream progress separately from a total workload budget. A total budget exhaustion must be reported as incomplete workload, not a hung product. Do not force model completion or weaken assertions to obtain a pass. Also retain Shared 2's genuine generated regression failures for subsequent repair and verification.
