# Oracle controller initial reconciliation — 2026-08-06

The mandatory first run was executed against a transactionally consistent SQLite backup, not the live database. It was report-only; no task, activity, assignment, execution, or external message was mutated.

## Before

- 48 total tasks: 31 done and 17 non-terminal.
- Non-terminal statuses: 13 review, 1 verification, and 3 in progress.
- The deployed older dispatch path had left the three in-progress tasks without healthy controller-visible ownership; execution supervision had already escalated some as missing-lease.

## Proposed after classification

- 14 awaiting objective verification/Oracle evidence review.
- 3 stalled and delegated to the existing execution supervisor; the completion controller proposes no duplicate recovery.
- 0 objectively ready to close.
- 0 mutations, dispatches, verification prompts, closes, or external communications performed.

The first classifier revision would have considered completion prose plus deliverables sufficient for 12 closures. That was rejected during Tank review as unsafe. The final contract additionally requires explicit objective verification evidence, so the dry run proposes no fabricated closure.

## Activation gate

Do not enable active mode until the durable dispatch integration is deployed and a dry-run scan of the live service shows healthy leases for newly dispatched tasks. Then review the 14 legacy verification candidates individually or through a separately approved evidence backfill process; never manufacture verification activities.
