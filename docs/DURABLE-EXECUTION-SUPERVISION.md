# Durable agent execution supervision

Mission Control is the source of truth for task state. An `in_progress` task is healthy only when its current `task_execution_runs` record has a recent heartbeat and an unexpired fenced lease.

## Runtime contract

- Start with `POST /api/tasks/:id/execution` action `start`. Persist the returned run ID, lease owner, epoch, session key, and run identity.
- Heartbeat every 60–120 seconds (90 seconds recommended). Every heartbeat has a unique event key and may include a JSON checkpoint. Lease TTL is three minutes.
- Every worker mutation carries the lease owner and epoch. A replaced worker receives `409 STALE_LEASE` and must stop.
- End with an explicit `complete`, `failed`, or `cancelled` transition. Agent prose never implies completion.
- Transient failures use action `transient_failure`; backoff is bounded at two retries.

The one-minute reconciler is a recovery backstop, not the execution engine. On expiry it schedules exactly one automatic resume with a higher fencing epoch. If that epoch also expires, the run is classified `stalled` and escalated idempotently to Oracle. Oracle must acknowledge and may reassign through `POST /api/tasks/:id/execution/recovery`; reassignment creates another fenced epoch and resumes from the persisted checkpoint.

Every lease, heartbeat, checkpoint, retry, stall, recovery, escalation, acknowledgement, reassignment, and terminal transition is written both to the immutable execution event stream and the task activity trail.

## Deployment integration

Normal `dispatchTaskToGateway` now creates the durable run before `chat.send` and embeds its run ID, lease owner, epoch, heartbeat cadence, checkpoint contract, and stale-fence stop rule in the assigned task message. If gateway delivery fails, the provisional run is terminally abandoned and the task returns to its pre-dispatch state before the existing retry queue handles it.

Explicit `/execution` heartbeats are authoritative. For compatibility, an assigned agent's `progress` activity renews the same fenced lease and may carry `metadata.checkpoint`; `completed` and `blocked` activities project terminal/pause state. Gateway correlation completion and the signed completion webhook also close the durable run, preventing a completed task from retaining a ghost live lease.

## Rollout and rollback

1. Back up `mission-control.db`; deploy migration 030 with the supervisor disabled using `MISSION_CONTROL_TASK_WATCHDOG=disabled`.
2. Exercise start/heartbeat/terminal APIs against a synthetic task and confirm activities and `GET /execution` evidence.
3. Dispatch one synthetic task through the normal gateway path. Confirm the assignment contains execution credentials, post progress/checkpoint activity, and verify its lease extends before enabling reconciliation.
4. Enable one-minute reconciliation for one agent. Kill its worker after a checkpoint, verify one resume, then kill the recovered worker and verify one Oracle escalation with no duplicate session.
5. Expand only after metrics show zero stale-fence writes and zero duplicate active runs.

Rollback is safe: disable the reconciler first, leave the additive tables intact, and return workers to the prior dispatch path. Do not drop migration 030 tables during rollback; they are audit evidence. No production deployment or infrastructure change is performed by this implementation.

## Observability

Alert on `execution_stalled`, `oracle_escalation_requested`, stale-lease 409 rates, heartbeat age over four minutes, and any uniqueness conflict on the one-live-run index. Dashboard counts should group by state, agent, resume count, retry count, failure code, and heartbeat age. Retain execution events at least as long as task activities.

## Specification reconciliation

The architecture specification proposes 15-second runner health and 60-second leases for the eventual remote runner product. This Mission Control agent layer uses a 90-second target heartbeat and three-minute lease because the implementation brief explicitly targets 1–2 minute agent heartbeats. Both preserve the same fencing and event-sourcing invariants; remote runner health remains a separate, faster signal when that standalone execution-plane package is built.
