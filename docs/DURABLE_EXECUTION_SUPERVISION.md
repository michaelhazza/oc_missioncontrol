# Durable agent execution supervision and Oracle recovery

## Operating model

Mission Control is the source of truth. An `in_progress` task is healthy only when it has a non-expired execution lease and a recent heartbeat. Agents create an execution run when work starts, renew it every 1–2 minutes, and attach a compact durable checkpoint. The one-minute watchdog is a reconciliation fallback, not the execution engine.

The reconciler permits exactly one automatic resume for an expired/stale run. It increments the lease epoch (fencing the old worker), resumes the recorded OpenClaw session with an idempotency key, and preserves the checkpoint. A second stall becomes an Oracle escalation. Oracle decides whether to reassign, block/fail, or authorize a bounded new run.

## API

`POST /api/tasks/:id/execution`

Start:

```json
{"action":"start","agentId":"<MC agent UUID>","sessionKey":"agent:tank:<session>","runIdentity":"<gateway run/session ID>","leaseOwner":"<worker UUID>"}
```

Heartbeat (every 60–120 seconds):

```json
{"action":"heartbeat","runId":"<run UUID>","leaseOwner":"<worker UUID>","leaseEpoch":1,"eventKey":"heartbeat:<monotonic sequence>","checkpoint":{"phase":"tests","head":"abc123","next":"review failures"}}
```

Terminal or pause transition:

```json
{"action":"transition","runId":"<run UUID>","leaseOwner":"<worker UUID>","leaseEpoch":1,"eventKey":"transition:<sequence>","state":"waiting_input","reason":"Requires Michael-only product decision","checkpoint":{"head":"abc123"}}
```

`GET /api/tasks/:id/execution` returns the latest durable run, current fencing epoch, lease, heartbeat, checkpoint, retry/resume counters and Oracle status.

All commands are idempotent by run identity or event key. A stale owner/epoch receives HTTP 409 `STALE_LEASE`; an attempt to create a second live run receives 409 `EXECUTION_CONFLICT`.

## State and recovery rules

- Lease TTL: 3 minutes; heartbeat target: 90 seconds; stale threshold: 4 minutes.
- States: `running`, `waiting_input`, `blocked`, `stalled`, `recovering`, `failed`, `cancelled`, `complete`.
- Only `running`, `recovering`, and `stalled` runs for `in_progress` tasks are reconciled automatically.
- `waiting_input` and `blocked` are intentional pauses and consume no automatic resumes.
- One live run per task is enforced by a partial unique SQLite index.
- Every lease, heartbeat, transition, stale detection, resume, delivery result and Oracle escalation is written to task activities and the append-only execution event table.
- Fencing epoch prevents a recovered old worker from heartbeating or completing after ownership changes.

## Observability

Alert on: `execution_stalled`, `resume_delivery_failed`, `oracle_escalation`, heartbeat age over four minutes, lease expiry, and repeated runs for one task. Dashboard queries should distinguish healthy executing tasks from stored `in_progress` tasks.

Suggested metrics: active valid leases, stale runs, resume count, Oracle pending count, heartbeat lag, recovery delivery failures, time in recovering, and terminal outcome by failure code.

## Rollout

1. Back up SQLite and apply migration 030 in staging.
2. Deploy the API and persistence with `MISSION_CONTROL_TASK_WATCHDOG=disabled`; update one synthetic agent to start/heartbeat/checkpoint/transition.
3. Verify activities and stale-lease HTTP 409 behavior.
4. Enable the watchdog for the synthetic task only in a staging process, simulate inactivity and restart, and verify one resume plus fencing.
5. Simulate a second stall and verify a single Oracle hook.
6. Roll out per agent, starting with Tank, while retaining the old 30-minute cron disabled.

Rollback: disable `MISSION_CONTROL_TASK_WATCHDOG` first. Older application code ignores the new tables. Keep migration data for audit; dropping tables is unnecessary and discouraged. Restore the pre-migration database only if schema rollback is mandatory.

## Reconciliation with the Development Supervisor specification

This implementation applies the specification's durable leases, fencing, event log, checkpoint/resume, bounded retry and Oracle escalation concepts to current OpenClaw agent runs inside Mission Control. It intentionally does not implement the future remote Claude Code runner protocol, signed manifests or worktree verifier. Those remain a separate execution-plane build. The current heartbeat is agent/API-driven and the gateway message is only the single recovery signal.
