# Three High-Leverage Mission Control Operating Features

Status: review candidate. Date: 2026-08-21. Scope: specification only.

## Architectural baseline

Mission Control already persists Mattermost channel/root/source/thread identity on `tasks`; validates channel/root pairing at intake; pins dispatched specialist output to the root; suppresses routine automated Mattermost milestones; supervises fenced executions; evaluates criteria-level completion contracts; and runs a deterministic Oracle completion controller. The proposal tightens source/thread validation and extends these controls rather than creating parallel task, message, or completion systems.

### Reuse and gap map

| Concern | Reuse unchanged | Increment supplied here |
|---|---|---|
| Thread identity | Existing task channel/root/source/thread fields and dispatch guard | Account identity, durable inbound-event ledger, canonical thread ownership and revision history |
| Delivery | Existing fenced dispatch and outbox schema/claim idioms; the current Mattermost drain is globally disabled | Capture-to-dispatch plus a narrow allowlist of `task_exception`, `completion_rework`, and `executive_synthesis`; legacy milestones remain suppressed |
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

Michael sends a new Mattermost DM. A signed OpenClaw inbound event creates exactly one task rooted at that post, generates the default completion contract, and dispatches only after intake validation. Replies enrich the same task; they never create sibling tasks. Allowed completion rework, exception alerts, and executive synthesis use the original root; routine checkpoints remain suppressed.

### Requirements

- Accept only signed, allowlisted Mattermost direct-channel events from the configured account, sender and channel identities. Reject group/channel events even when the sender is allowlisted.
- Stable root identity is `(workspace_id, mattermost_account_id, channel_id, root_post_id)`; `lineage_id` is deterministically derived from that root and stored as an immutable attribute, not a fifth uniqueness-key field. Exactly one task is the current lineage member; source post IDs are append-only observations.
- Classify `task_request | reply | correction | non_task` using deterministic thread context first. Any model-assisted intent score is advisory; uncertainty creates an inbox candidate and never dispatches.
- Preserve verbatim source reference plus normalized brief; corrections create brief revisions, not destructive edits.
- Existing manually created tasks may claim a thread only through a conflict-checked link operation.
- A thread has one canonical task lineage. Replies update its current member; intentional follow-on work after completion requires an explicit child-task command and records `parent_task_id`. No classifier silently starts a new lineage.

### Data and API

- Add `mattermost_account_id`, `parent_task_id`, `lineage_id`, `is_current_lineage_member`, `deleted_at`, `commitment_due_at` (nullable UTC), and `evidence_version DEFAULT 0` to `tasks`; Mattermost identity is immutable after dispatch. `overdue` is derived only from `commitment_due_at`; null means no overdue exception. A follow-on child shares root identity and lineage, atomically retires the prior current member, and becomes current.
- `task_intake_events(id, workspace_id, mattermost_account_id, provider_event_id, sender_id, channel_id, channel_type, root_post_id, source_post_id, provider_created_at, provider_revision, event_kind, payload_hash, received_at, processing_lease_id, processing_lease_expires_at, candidate_state, candidate_reason, processed_at, disposition, task_id, error)` with unique `(workspace_id, mattermost_account_id, provider_event_id)`. `candidate_state` is `open | resolved`; `candidate_reason` is `ambiguous_intent | terminal_follow_on | identity_collision | ambiguous_correction`. Closed disposition domain: `received | processing | captured_pending_dispatch | captured | linked | corrected | follow_on_created | non_task | duplicate | needs_classification | rejected | failed`; only terminal values other than `received | processing | captured_pending_dispatch | needs_classification` are complete. `provider_event_id` is derived from provider-stable post ID, event kind, and edit revision; where no monotonic revision exists, use stable `update_at`/`edit_at` plus normalized payload hash. Gateway delivery IDs are forbidden. Identical edit replays deduplicate; distinct edits remain processable.
- `task_brief_revisions(id, task_id, revision, source_post_id, provider_created_at, provider_revision, payload_hash, brief, created_at)` with unique `(task_id,revision)`. Current revision and Feature 3 digest input use total order `(provider_created_at, provider_revision_or_update_at, payload_hash, source_post_id)`; `revision` remains append order only.
- The closed `candidate_reason` domain also includes `processing_failed | permanent_failure`; these values are normative additions to the recovery paths below.
- Unique partial index on `(workspace_id, mattermost_account_id, mattermost_channel_id, mattermost_root_post_id) WHERE deleted_at IS NULL AND is_current_lineage_member = 1 AND all Mattermost identity columns IS NOT NULL`; `lineage_id` is an attribute derived once from that canonical root and is not part of the uniqueness key. Account IDs are installation-scoped, not assumed globally unique, and are immutably bound to a configured workspace connection.
- `POST /api/intake/mattermost` signed webhook; `GET /api/tasks/:id/intake`; `POST /api/tasks/:id/intake/link` operator-only.
- `GET /api/intake/candidates?workspace=&state=open` lists candidates by stable event ID. `POST /api/intake/candidates/:eventId/resolve` accepts `non_task | link_existing | create_task | create_follow_on | record_correction`, with idempotency key and expected event version. `create_task` atomically creates task/default contract and binds root/lineage; `link_existing` uses task-link conflict checks; `create_follow_on` delegates to the sole follow-on transaction and records `parent_task_id`; `record_correction` allocates the next brief revision without relinking. Each advances disposition under the same lease fence. If the follow-on endpoint is called directly with an open candidate event ID, its transaction closes that candidate as `follow_on_created`; exact retries return the terminal disposition.
- `POST /api/tasks/:id/follow-ons` is the only child-task command. It requires a terminal current member, idempotency key, and expected task version; one transaction creates the child/default contract with `parent_task_id`, retains root/lineage, retires the prior member, and makes the child current. Dispatch occurs only after commit through the existing fence.
- `PATCH /api/tasks/:id/commitment` is operator-only and requires an idempotency key plus expected task version. It sets or clears `commitment_due_at` from an explicit UTC value; intake/model extraction may only propose, never write it. A change increments `evidence_version`, invalidates the current completion review, and becomes the sole source of exception `due_at`.
- Emit `intake.received`, `task.captured`, `intake.duplicate`, `intake.needs_classification`, `brief.revised` using event IDs as idempotency keys.

### Failure and recovery

Transient intake failures retry at most three times under newly fenced leases. Exhaustion sets `candidate_state='open'`, `candidate_reason='processing_failed'`, and `disposition='needs_classification'` with sanitized detail so an operator can retry or reject it. `failed` is reserved for permanently malformed/safety-invalid input and remains visible through the candidate API with reason `permanent_failure` until acknowledged.

Persist-before-dispatch. Intake processing uses a bounded lease: duplicate delivery returns a terminal prior disposition, or joins/retries an expired/in-progress lease; it never treats an unset disposition as complete. Every disposition/task-link write is lease-fenced with `WHERE processing_lease_id=?`; a stale worker changes zero rows and stops. Gateway outage leaves `captured_pending_dispatch`; bounded retry uses the existing dispatch outbox/fence. Missing root identity fails closed to inbox. Brief revisions allocate `revision` transactionally with unique-conflict retry; current brief and digest input use the four-part total order defined in Data and API while `revision` remains append order, so out-of-order delivery is deterministic without rewriting history.

Signature validation includes timestamp skew and replay protection. The raw body is used for verification before JSON parsing. Linking rejects dispatched tasks, occupied roots and cross-workspace identities. If a reply arrives after the current task is terminal, it remains attached as context and creates an inbox candidate with reason `terminal_follow_on`; it does not enter the Feature 2 taxonomy, reopen, or create work automatically. Backfill root collisions likewise create candidates with reason `identity_collision`.

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
- Severity combines impact, urgency, confidence and reversibility; model prose may explain but never set severity or authority. P0 is an imminent irreversible boundary, security, data-loss, financial, or external-commitment breach. P1 is a blocked critical path or due/overdue commitment with no safe autonomous recovery. P2 is material but recoverable risk outside the critical path. P3 is drill-down-only information. The deterministic rule table is versioned per workspace; confidence may reduce alertability but never upgrade severity. Missing inputs fail closed to dashboard-only P2 pending operator classification.
- `overdue` and due-date severity derive only from `tasks.commitment_due_at`; null means no overdue exception. Persist `occurrence_ordinal` on each exception version, starting at 1 and incrementing exactly when a resolved logical identity reopens; all versions within one open occurrence retain it, making rebuild fingerprints reproducible.
- Assign each logical exception a stable `(workspace_id, task_id, type, authority_scope)` identity and version it when evidence, severity, deadline or decision options change. `authority_scope` is one of `operator`, `workspace_admin`, `task_owner`, or `ceo`; additions require a schema-version change. Fingerprints identify occurrences/versions, not logical cards. Compute them as SHA-256 over schema-versioned UTF-8 canonical JSON with sorted object keys and stable arrays containing logical identity, occurrence ordinal, decision version, evidence IDs/hashes, severity, deadline and decision schema. An atomic partial unique index permits at most one current open version per logical identity; creating a new version supersedes the prior row in the same transaction. A concurrent loser re-reads the winner, recomputes against current evidence, and only then decides whether to emit a material-change alert. Cooldowns suppress unchanged repeats; material changes bypass cooldown.
- CEO actions are `decide`, `delegate`, `snooze`, `acknowledge`; none imply objective completion.
- Feature 2 introduces the minimum human-principal substrate: `workspace_principals(id, workspace_id, provider, provider_subject_id, display_name, status)`, unique `(workspace_id, provider, provider_subject_id)`; `workspace_principal_roles(workspace_id, principal_id, role, granted_by, granted_at, revoked_at)` where role is `operator | workspace_admin | task_owner | ceo`; and `task_human_owners(task_id, principal_id, granted_at, revoked_at)`. Provider identity comes only from the verified server session or signed gateway assertion, never a request-body actor ID. `task_owner` additionally requires an active task-owner row. Initial grants are approved migration/config inputs; roles are not inferred from the existing agent authority enum.
- Active role/owner rows are those with `revoked_at IS NULL`, enforced by partial unique indexes on `(workspace_id, principal_id, role)` and `(task_id, principal_id)` respectively.
- The action transaction resolves the authenticated principal and active workspace/task grants to `authority_scope`, checks expected `decision_version`, then validates `decision_value`. Missing identity/grant returns `401/403`; stale version returns `409`; none writes an action or side effect. `workspace_alert_routes(workspace_id, event_family, principal_id, mattermost_account_id, channel_id, enabled, approved_at)` binds a recipient to a verified principal. Root-thread delivery is allowed only when that route principal has the required active authority and the destination equals the immutable task root; otherwise the card is dashboard-only.
- `workspace_alert_routes` includes primary key `id` and unique `(workspace_id, event_family, principal_id)`; enabled rows are the only approved route IDs accepted by the outbox.
- Dashboard defaults to open P0/P1 exceptions; routine status, activities and heartbeats require task drill-down.

### Data and API

- `task_exceptions(id, workspace_id, task_id, type, authority_scope, occurrence_ordinal, decision_version, supersedes_id, is_current, severity, status, fingerprint UNIQUE, owner_agent_id, impact, evidence_json, recommendation, decision_schema, due_at, first_seen_at, last_seen_at, resolved_at)` with unique `(workspace_id, task_id, type, authority_scope, decision_version)` and one current open row per logical identity. `decision_version` is monotonic across all recurrences of a logical identity and never resets. `decision_schema` is JSON-Schema validated when the exception version is created; `decision_value` is validated against that stored schema in the action transaction before any effect.
- `exception_actions(id, workspace_id, exception_id, actor_principal_id, idempotency_key, expected_decision_version, action, decision_value, created_at)` append-only with unique `(workspace_id, actor_principal_id, idempotency_key)`.
- `GET /api/ceo/exceptions?severity=&type=&workspace=`; `POST /api/exceptions/:id/actions`; SSE `exception.created|changed|resolved`.
- Reuse the outbox schema and claim/fence logic, but replace the global `AND 0=1` drain guard with a server-side family allowlist containing only `task_exception`, `completion_rework`, and `executive_synthesis`. Queue rejects every other family before insert; drain repeats the allowlist predicate. Existing/future routine milestone rows remain undeliverable. Enabled rows require complete immutable root identity, an approved alert-route ID where authority is required, and a unique action key.
- Exceptions for tasks without complete immutable thread identity are dashboard-only; the outbox mechanically rejects incomplete identity and never falls back to a top-level message.

### Failure and recovery

Projection is rebuildable from tasks, executions, contracts and controller actions. Stale projections display `data_stale` and suppress alert delivery. Outbox claims remain fenced and bounded. Snooze expiry re-evaluates current evidence rather than replaying stale prose.

Projection freshness is measured from the latest source event and watermark. A failed rebuild preserves the last known view with an explicit stale banner and rejects decisions against superseded versions. It records one deduplicated row in `operational_incidents(id, workspace_id, task_id, kind, fingerprint, status, detail_json, opened_at, resolved_at)`, unique on open `(workspace_id, kind, fingerprint)`; this is the explicit admin incident substrate, not a claimed existing stream or external sender. Retry resolution closes that incident. `acknowledge` suppresses notification only; `snooze` has an expiry; neither resolves evidence.

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
- Bind review to immutable workspace ID, task ID, observed `evidence_version`, evidence timestamps, freshness-policy version, and hashes of task brief revision, criteria/boundaries, deliverables and verification evidence. Canonicalize those evidence inputs as UTF-8 JSON with sorted object keys, stable array order, explicit schema version, UTC timestamps and SHA-256; store component hashes and aggregate digest. `reviewed_as_of` is a separate review attribute explicitly excluded from digest input. Freshness verdict is reproducible from `(digest, reviewed_as_of)` and an expired pass is never reused as current.
- Rule engine decides `pass | rework | human_decision`; an optional LLM summarizes only validated fields and must cite evidence IDs.
- `human_decision` creates or updates the deterministic Feature 2 `decision_required` exception with constant `authority_scope='ceo'` and never closes the task. Legacy controller `authority='michael'` maps exactly to `ceo`; other legacy authority values do not produce this exception identity.
- Synthesis schema: `objective_outcome`, `delivered`, `impact`, `risks`, `decisions_required`, `deferred_work`, `verification`, `evidence_links`.
- Changed evidence invalidates the prior review and synthesis. Closing remains governed by the existing controller and authority matrix; synthesis cannot transition task status.

### Data and API

- `completion_reviews(id, workspace_id, task_id, evidence_version, evidence_digest, freshness_policy_version, freshness_boundary_at, freshness_bucket, reviewed_as_of, verdict, findings_json, reviewed_at, reviewer_version, current_synthesis_id)` with unique `(workspace_id, task_id, evidence_digest, freshness_bucket)`. Sort evidence expiry timestamps; `freshness_boundary_at` is the first expiry strictly after `reviewed_as_of`, or pinned UTC sentinel `9999-12-31T23:59:59Z`. `freshness_bucket = SHA-256(canonical_json({freshness_policy_version, expired_evidence_ids_at_reviewed_as_of, freshness_boundary_at}))`; crossing any expiry changes the bucket and requires re-evaluation. `tasks.current_completion_review_id` is a nullable foreign key to the sole current review.
- `executive_syntheses(id, review_id, schema_version, generation_key, content_json, model_identity, prompt_hash, created_at)` with unique `(review_id, schema_version, generation_key)`. `generation_key = SHA-256(model_identity || prompt_hash)` permits audited regeneration after model/prompt change while exact retries deduplicate; `current_synthesis_id` selects the sole current result. Insert synthesis first, then set the nullable review pointer in one transaction; invalidation clears `current_synthesis_id` rather than mutating synthesis rows.
- `POST /api/tasks/:id/completion-review` requires an idempotency key and expected `evidence_version`; `GET /api/tasks/:id/executive-synthesis`; controller consumes only passing current reviews.
- Emit `completion.reviewed`, `completion.rework_required`, `synthesis.created`, `synthesis.invalidated`.

### Failure and recovery

Review is idempotent by `(evidence_digest, freshness_bucket)`. Missing/stale evidence fails closed. LLM outage does not block deterministic review; it queues synthesis retry and exposes structured validated fields. Hallucinated evidence IDs fail schema validation. Controller never closes from a synthesis alone.

Every brief, criterion, boundary, deliverable or verification-evidence mutation increments `tasks.evidence_version`, clears `current_completion_review_id` and the linked review's `current_synthesis_id`, and emits `synthesis.invalidated` in the same transaction. Review creation reads all digest components and `evidence_version` in one database snapshot. Store `freshness_boundary_epoch` as an integer Unix second alongside the canonical UTC display timestamp. Currency is installed with one guarded write: `UPDATE tasks SET current_completion_review_id=? WHERE id=? AND evidence_version=? AND unixepoch() < ?`, binding that integer boundary; zero changed rows leaves the review historical and triggers a new review bucket. Rework and final synthesis use the explicitly enabled root-thread outbox families; retries use review ID, synthesis schema version, and generation key.

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

Default retention: provider IDs, hashes, decisions and review audit metadata follow the task audit policy. `task_brief_revisions.brief` is audit-retained task content because it participates in evidence digests/citations; access is workspace-authorized and erasure replaces content with a tombstone plus preserved hash. Other minimized excerpts expire after 30 days unless held. Raw webhook bodies are not persisted. Erasure preserves non-content integrity records and records the event. Final values remain configurable per workspace before rollout.

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

Dependencies requiring confirmation before activation: authoritative Mattermost account/sender mapping; webhook signature scheme/replay window; approved initial principal grants and alert routes; audit retention owner; and workspace severity-rule overrides, if any. The default severity policy and authorization substrate are specified above. Feature 2 can dark-run after Feature 1 identity migration. Feature 3 shares Feature 1's `tasks.evidence_version` expand migration and can proceed in parallel only after that migration and the digest contract are approved. Feature 3 `human_decision` writes the same `decision_required` identity consumed by the controller; the controller's legacy `authority='michael'` route becomes a compatibility producer, not a second card or classifier.

## Explicitly out of scope

Agent runtime replacement, new chat platform, autonomous CEO decisions, customer-facing dashboards, production deployment in this task, task-content semantic search, broad analytics, live infrastructure/config changes, and automatic closure from model prose.

## Build-readiness gate

Ready for implementation decision when independent reviews accept the specified ambiguity resolution, principal/authority substrate, narrowly enabled outbox families, severity rules, evidence freshness/digest canonicalization, and retention policy. Runtime values—Mattermost sender/account identity, signed-session provider mapping, initial principal grants, and alert routes—are activation configuration, not missing architecture. Build must start with Feature 1 and dark-run fixtures before automatic dispatch. Production activation, schema contraction, principal grants, and alert enablement each require separate human approval.
