# Three High-Leverage Mission Control Operating Features

Status: review candidate. Date: 2026-08-21. Scope: specification only.

## Architectural baseline

Mission Control already persists Mattermost channel/root/source/thread identity on `tasks`; validates the four-field identity at intake; pins dispatched specialist output to the root; suppresses routine automated Mattermost milestones; supervises fenced executions; evaluates criteria-level completion contracts; and runs a deterministic Oracle completion controller. The proposal extends these controls rather than creating parallel task, message, or completion systems.

### Reuse and gap map

| Concern | Reuse unchanged | Increment supplied here |
|---|---|---|
| Thread identity | Existing task channel/root/source/thread fields and dispatch guard | Account identity, durable inbound-event ledger, canonical thread ownership and revision history |
| Delivery | Existing fenced dispatch and Mattermost outbox | A capture-to-dispatch state transition and one new exception-only outbox event family |
| Exception judgment | Existing execution state and completion-controller classifications | Rebuildable CEO projection, material-change policy and decision actions |
| Completion validation | Existing completion contract, evidence freshness and controller authority | Immutable review snapshot, evidence digest and citation-bound executive synthesis |

No feature may introduce a second task store, message sender, execution supervisor, completion authority or generic notification stream.

## Delivery sequence

1. Thread intake and identity deduplication.
2. Exception projection API and CEO dashboard.
3. Evidence-backed completion synthesis.

Each feature ships behind a workspace flag, dark-reads existing data first, and may be independently rolled back.

The flags are evaluated server-side and default off. Rollback disables new writes and sends while retaining audit rows; it never deletes or rewrites captured events, decisions, reviews or syntheses.

## Feature 1 — automatic thread-rooted task capture

### Journey

Michael sends a new Mattermost DM. A signed OpenClaw inbound event creates exactly one task rooted at that post, generates the default completion contract, and dispatches only after intake validation. Replies enrich the same task; they never create sibling tasks. Every human-visible specialist checkpoint and final result uses the original root.

### Requirements

- Accept only signed, allowlisted Mattermost direct-channel events from the configured account, sender and channel identities. Reject group/channel events even when the sender is allowlisted.
- Stable idempotency key: `(mattermost_account_id, channel_id, root_post_id)`; source post IDs are append-only observations.
- Classify `task_request | reply | correction | non_task` using deterministic thread context first. Any model-assisted intent score is advisory; uncertainty creates an inbox candidate and never dispatches.
- Preserve verbatim source reference plus normalized brief; corrections create brief revisions, not destructive edits.
- Existing manually created tasks may claim a thread only through a conflict-checked link operation.
- A thread has one canonical task lineage. Replies update its current member; intentional follow-on work after completion requires an explicit child-task command and records `parent_task_id`. No classifier silently starts a new lineage.

### Data and API

- Add `mattermost_account_id` to `tasks`; the canonical identity is `(mattermost_account_id, mattermost_channel_id, mattermost_root_post_id)` and all three values are immutable after dispatch.
- `task_intake_events(id, workspace_id, mattermost_account_id, provider_event_id, sender_id, channel_id, channel_type, root_post_id, source_post_id, provider_created_at, event_kind, payload_hash, received_at, processed_at, disposition, task_id, error)` with unique `(workspace_id, mattermost_account_id, provider_event_id)`.
- `task_brief_revisions(id, task_id, revision, source_post_id, brief, created_at)` with unique `(task_id,revision)`.
- Unique partial index on `(workspace_id, mattermost_account_id, mattermost_channel_id, mattermost_root_post_id) WHERE deleted_at IS NULL AND all three Mattermost identity columns IS NOT NULL`. Account IDs are installation-scoped, not assumed globally unique, and are immutably bound to a configured workspace connection.
- `POST /api/intake/mattermost` signed webhook; `GET /api/tasks/:id/intake`; `POST /api/tasks/:id/intake/link` operator-only.
- Emit `intake.received`, `task.captured`, `intake.duplicate`, `intake.needs_classification`, `brief.revised` using event IDs as idempotency keys.

### Failure and recovery

Persist-before-dispatch. Duplicate delivery returns the prior disposition. Gateway outage leaves `captured_pending_dispatch`; bounded retry uses the existing dispatch outbox/fence. Missing root identity fails closed to inbox. Reply-order inversion is reconciled by provider timestamps without rewriting prior events.

Signature validation includes timestamp skew and replay protection. The raw body is used for verification before JSON parsing. Linking rejects dispatched tasks, occupied roots and cross-workspace identities. If a reply arrives after the current task is terminal, it remains attached as context and raises an operator decision; it does not reopen or create work automatically.

### Acceptance tests

- Replaying an inbound post 100 times creates one task and one dispatch.
- All updates contain the original root; top-level DM posting is mechanically rejected.
- A correction creates revision 2 and retains revision 1.
- Invalid signature, wrong sender, partial thread identity and ambiguous intent never dispatch.
- Crash after task insert/before dispatch resumes once from durable state.
- A DM reply to a terminal task creates neither a task nor a dispatch until an explicit follow-on action.
- Concurrent capture and manual link attempts resolve to one owner and an auditable conflict.

## Feature 2 — exception-only CEO dashboard and alerts

### Journey

Michael opens one view showing only decisions, confirmed blockers, overdue commitments and material risks. Each card states owner, impact, age, evidence, recommended action and deadline. Routine progress is absent until drill-down. A thread-rooted alert is sent only for a new or materially changed exception.

### Requirements

- Deterministic exception types: `decision_required`, `blocked`, `overdue`, `material_risk`, `verification_failed`, `lease_recovery_exhausted`. They are derived from existing task, execution and completion-controller facts; a second classifier is prohibited.
- Severity combines impact, urgency, confidence and reversibility; model prose may explain but never set severity or authority.
- Assign each logical exception a stable `(workspace_id, task_id, type, authority_scope)` identity and version it when evidence, severity, deadline or decision options change. `authority_scope` is one of `operator`, `workspace_admin`, `task_owner`, or `ceo`; additions require a schema-version change. Fingerprints identify versions, not logical cards. Compute them as SHA-256 over schema-versioned UTF-8 canonical JSON with sorted object keys and stable arrays containing the logical identity, evidence IDs/hashes, severity, deadline and decision schema. An atomic partial unique index permits at most one current open version per logical identity; creating a new version supersedes the prior row in the same transaction. Cooldowns suppress unchanged repeats; material changes bypass cooldown.
- CEO actions are `decide`, `delegate`, `snooze`, `acknowledge`; none imply objective completion.
- Dashboard defaults to open P0/P1 exceptions; routine status, activities and heartbeats require task drill-down.

### Data and API

- `task_exceptions(id, workspace_id, task_id, type, authority_scope, decision_version, supersedes_id, is_current, severity, status, fingerprint UNIQUE, owner_agent_id, impact, evidence_json, recommendation, decision_schema, due_at, first_seen_at, last_seen_at, resolved_at)` with unique `(workspace_id, task_id, type, authority_scope, decision_version)` and one current open row per logical identity. `decision_schema` is JSON-Schema validated when the exception version is created; `decision_value` is validated against that stored schema in the action transaction before any effect.
- `exception_actions(id, exception_id, actor_id, action, decision_value, created_at)` append-only.
- `GET /api/ceo/exceptions?severity=&type=&workspace=`; `POST /api/exceptions/:id/actions`; SSE `exception.created|changed|resolved`.
- Reuse the Mattermost outbox with a new `task_exception` event family, root identity and unique action keys. Do not re-enable suppressed legacy milestone messages.

### Failure and recovery

Projection is rebuildable from tasks, executions, contracts and controller actions. Stale projections display `data_stale` and suppress alert delivery. Outbox claims remain fenced and bounded. Snooze expiry re-evaluates current evidence rather than replaying stale prose.

Projection freshness is measured from the latest source event and watermark. A failed rebuild preserves the last known view with an explicit stale banner and rejects decisions against superseded versions. It records one deduplicated `projection_rebuild_failed` operational incident in Mission Control's existing admin incident/activity stream, keyed by `(workspace_id, projection, failed_watermark)`; no new sender or external notification path is introduced. Retry resolution closes that incident. `acknowledge` suppresses notification only; `snooze` has an expiry; neither resolves evidence.

### Acceptance tests

- Healthy progress and heartbeats never appear in the CEO default view or alerts.
- Identical scans produce no duplicate cards/messages.
- Changed decision options produce a new fingerprint and one alert.
- Resolved evidence removes the card without deleting its audit trail.
- Tenant/workspace filters and authorization prevent cross-workspace disclosure.
- A decision action with a stale `decision_version` returns `409` and has no side effect.
- P0/P1 changed exceptions reach the originating root once; routine transitions and lower-severity records remain dashboard-only by default.

## Feature 3 — automated completion review and executive synthesis

### Journey

When a specialist submits a completion contract, Mission Control verifies every objective, boundary, deliverable and fresh command result. A deterministic review record is generated. Only a passing record becomes an executive synthesis: outcome, business impact, residual risks and decisions. Failed or incomplete evidence returns precise rework to the originating thread and never claims completion.

### Requirements

- Extend the existing completion contract/controller; do not parse free-form completion prose as evidence.
- Bind review to immutable workspace ID, task ID and hashes of task brief revision, criteria/boundaries, deliverables and verification evidence. Canonicalize as UTF-8 JSON with sorted object keys, stable array order, explicit schema version, UTC timestamps and SHA-256; store component hashes as well as the aggregate digest.
- Rule engine decides `pass | rework | human_decision`; an optional LLM summarizes only validated fields and must cite evidence IDs.
- Synthesis schema: `objective_outcome`, `delivered`, `impact`, `risks`, `decisions_required`, `deferred_work`, `verification`, `evidence_links`.
- Changed evidence invalidates the prior review and synthesis. Closing remains governed by the existing controller and authority matrix; synthesis cannot transition task status.

### Data and API

- `completion_reviews(id, workspace_id, task_id, evidence_digest, verdict, findings_json, reviewed_at, reviewer_version)` with unique `(workspace_id, task_id, evidence_digest)`; `tasks.current_completion_review_id` is a nullable foreign key to the sole current review.
- `executive_syntheses(id, review_id UNIQUE, schema_version, content_json, model_identity, prompt_hash, created_at)`.
- `POST /api/tasks/:id/completion-review`; `GET /api/tasks/:id/executive-synthesis`; controller consumes only passing current reviews.
- Emit `completion.reviewed`, `completion.rework_required`, `synthesis.created`, `synthesis.invalidated`.

### Failure and recovery

Review is idempotent by evidence digest. Missing/stale evidence fails closed. LLM outage does not block deterministic review; it queues synthesis retry and exposes structured validated fields. Hallucinated evidence IDs fail schema validation. Controller never closes from a synthesis alone.

Review creation reads all digest components in one database snapshot. In the same transaction, a compare-and-swap updates `tasks.current_completion_review_id` only when the task's freshly recomputed digest still equals the reviewed digest; otherwise the review remains historical. Rework and the final synthesis linked to the current review are delivered through the existing root-thread outbox; retries use the review ID and synthesis schema version as idempotency inputs.

### Acceptance tests

- One missing criterion, violated boundary, stale command or absent deliverable yields rework.
- Replaying identical evidence returns one review/synthesis.
- Mutating a deliverable invalidates the old digest and review.
- Every synthesis claim resolves to a persisted evidence ID.
- LLM failure preserves the verified verdict and queues bounded retry without closure drift.
- A race that changes evidence during review leaves the result historical, never current.
- Every outcome, impact, risk and decision claim has at least one valid evidence citation or is omitted.

## Cross-cutting controls

### Security and privacy

Verify webhook signatures before body processing; allowlist account/sender/channel; store hashes and minimal message excerpts; encrypt sensitive payloads; redact secrets; retain provider IDs for audit; enforce workspace authorization on every read/action. LLM summarization receives only allowlisted, minimized validated fields. No task event authorizes external communication beyond the originating internal thread.

Default retention: provider IDs, hashes, decisions and review audit metadata follow the task audit policy; minimized message excerpts expire after 30 days unless placed on legal/operational hold. Raw webhook bodies are not persisted. Erasure must preserve non-content integrity records and record the erasure event. Final values remain configurable per workspace before rollout.

### Non-functional requirements

- Intake p95 under 2 seconds excluding dispatch; dashboard p95 under 500 ms for 10,000 open tasks; deterministic review under 5 seconds excluding verification commands.
- At-least-once inputs with exactly-once effects through unique keys and transactions.
- Full restart recovery, UTC timestamps, append-only decisions, 90-day operational metrics, and structured correlation IDs.
- Availability target 99.9% for reads; degraded mode is visible and fail-closed for writes/alerts/closure.
- Accessibility: CEO view supports keyboard navigation, semantic status labels and WCAG 2.1 AA contrast. All action endpoints require an idempotency key and expected record version.

### Observability

Metrics: intake accepted/duplicate/ambiguous/failed; capture-to-dispatch latency; open exceptions by type/severity/age; alert suppression/delivery/failure; review verdict/latency/staleness; synthesis retry and invalid-citation count. Dashboards and alerts exclude message bodies and secrets.

### Migration and backfill

Add tables/indexes without rewriting existing tasks. Backfill thread identity only where all existing fields are complete; collisions become operator exceptions. Build initial exception projection in dry-run and compare against current controller classifications. Completion reviews apply prospectively; legacy tasks retain the current contract path until new evidence is submitted.

Migration runs in expand/backfill/verify/contract phases. Account identity backfill comes from the configured Mattermost connection, never a guessed default. Before enabling capture, report null identities, duplicate roots and cross-workspace collisions; any unresolved collision blocks activation. Rollback leaves new nullable columns and audit tables in place.

## Rollout gates and success measures

1. **Thread capture:** shadow-ingest fixtures and production-shaped events with zero unauthorized dispatches, zero duplicate tasks, and 100% root preservation; then enable capture for one allowlisted account.
2. **CEO exceptions:** dark-project for seven days; achieve 100% precision on sampled P0/P1 cards and no routine messages before alerts are enabled.
3. **Completion synthesis:** shadow-review at least 30 terminal submissions; zero false passes, zero uncited claims, and deterministic replay equality before controller consumption is enabled.

Within 30 days of rollout, target at least 90% of eligible DM requests captured without manual task creation, zero duplicate root alerts, a 50% reduction in routine CEO notifications, and 100% of surfaced completions carrying a current deterministic review. These are operational targets, not authorization to deploy.

## Dependencies, effort and risk

| Feature | Dependency | Estimate | Primary risk |
|---|---|---:|---|
| Thread capture | Mattermost signed inbound events; sender mapping | 5–8 days | duplicate/ambiguous task creation |
| CEO exceptions | capture identity; controller/execution projections | 7–10 days | alert fatigue or hidden routine detail |
| Completion synthesis | completion contracts/controller | 8–12 days | plausible summary outrunning evidence |

Recommended total: 4–6 engineering weeks including review, migration rehearsal and staged rollout. Highest-risk controls are deterministic classification, unique identities, evidence digests and human authority—not UI complexity.

Dependencies requiring confirmation before implementation: authoritative Mattermost account/sender mapping; webhook signature scheme and replay window; workspace/tenant authorization source; existing controller authority policy; audit retention owner; and the canonical severity/impact policy. Feature 2 can dark-run after Feature 1 identity migration but does not depend on automatic capture for manually linked tasks. Feature 3 can be developed in parallel after the digest contract is approved.

## Explicitly out of scope

Agent runtime replacement, new chat platform, autonomous CEO decisions, customer-facing dashboards, production deployment in this task, task-content semantic search, broad analytics, live infrastructure/config changes, and automatic closure from model prose.

## Build-readiness gate

Ready for implementation decision only after independent reviews accept: Mattermost sender/account identity source; ambiguous-intent operator flow; severity policy and decision authority; evidence-digest canonicalization; and retention/redaction policy. Build must start with Feature 1 and dark-run fixtures before any automatic dispatch. Production activation, schema contraction and alert enablement each require a separate human approval.
