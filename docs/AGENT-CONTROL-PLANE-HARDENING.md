# Agent control-plane hardening

## Executive summary for SynthetOS

Treat every long-running agent job as a durable state machine, not as a chat session. The database owns execution identity, leases, checkpoints, waits, event ordering, permissions, evidence, and memory lifecycle. Model context can disappear without losing authoritative progress.

This reference implementation is deliberately fail-closed: migration `040` grants no tools; external actions require a separate confirmer; duplicate keys with changed content are rejected; and the agent that built a result cannot independently certify it. SynthetOS should target durable fenced runs, explicit state transitions, typed tool contracts, least-privilege grants, content-addressed idempotency, independent evidence, separated memory planes, and reconstructable audit decisions.

## Outcome

Mission Control now has a fail-closed reference contract for long-running agent work that crosses a tool boundary. Existing fenced execution leases remain the durable owner. The reference workflow adds optimistic event versions, idempotent event keys, explicit `waiting_input`, restart-safe checkpoints, and an independent evaluator who cannot be the workflow owner.

Tool calls are admitted only through a versioned contract and an unrevoked, unexpired agent grant. Contracts declare required input fields, risk and a database-enforced rate window. External and destructive actions always pause for confirmation by a different principal. Every request, confirmation, completion digest or failure is retained as an audit row. No default grants are seeded, so migration cannot widen an existing agent.

## Reference lifecycle

1. Start a workflow bound to one durable `task_execution_run`.
2. Request a typed tool invocation with an idempotency key and payload digest.
3. For external/destructive risk, transition to `waiting_input` and persist the invocation ID in the checkpoint.
4. A distinct confirmer authorizes the invocation; the caller records only a result digest.
5. An idempotent event resumes execution and later submits verification evidence.
6. A different agent evaluates the evidence. Only a passed independent evaluation completes the reference workflow.

Duplicate event keys return the existing state. Reused invocation keys with different payloads fail. Stale workflow versions, missing grants, malformed inputs, self-confirmation, premature resume and rate excess all fail closed.

### Reference state machine

`prepare/running → confirmation/waiting_input → execute/running → evaluation/evaluating → complete|failed`

The workflow is bound to the same task, execution run, and owner as the fenced execution lease. Transitions use an expected version, so stale writers cannot overwrite progress. Each event also has an idempotency key and canonical payload; replay is accepted only when the original type, version, and payload match.

### Tool authorization invariants

- Contract name/version pairs are immutable identifiers and schemas reject unknown fields.
- A matching, unrevoked, unexpired per-agent grant is mandatory.
- Task, run, run owner, and assigned task agent must agree.
- External/destructive calls stop in `pending_confirmation`.
- The agent cannot self-confirm; the confirmer must be the authority that issued the grant.
- Completion replay is accepted only for the same canonical result digest.
- Rate windows and audit decisions are durable; audit rows contain digests rather than raw payloads.

## Memory boundaries

- `session_context` is transient and requires an explicit retention deadline.
- `curated_fact` contains deliberate, source-linked facts and preferences.
- `semantic_memory` contains derived long-term recall and remains distinguishable from curated truth.
- Corrections must stay in the same workspace, subject and plane. The superseded content is tombstoned while its hash remains for integrity.
- Deletion removes content, retains the non-content hash/source audit, and requires a reason.

No automatic promotion between planes is implemented. Retrieval must select a plane explicitly. Retention purge scheduling remains an operational activation concern and must use the same audited deletion operation.

### Memory lifecycle rules

1. Session context requires a future expiry and scheduled purge.
2. Curated facts require a source and deliberate write path; inference cannot silently promote into this plane.
3. Semantic memory remains derived recall, never canonical truth.
4. Corrections must match workspace, subject, and plane, tombstone old content, and link the replacement.
5. Deletion removes plaintext, preserves an integrity hash and reason, and is audited.
6. Retrieval should require an explicit plane and enforce workspace boundaries before similarity search.

## Orchestration decision

Use one agent when the work has one authority domain, one bounded deliverable and deterministic verification. Add agents only for genuinely independent roles: parallel domain work with non-overlapping mutations, or evaluation where the builder must not verify itself. More agents are not a substitute for durable state, typed permissions or evidence gates.

## Safety and rollout

Migration `040` is additive and seeds no contracts or grants. Production activation requires security-owned contract registration and grants, an authenticated human confirmation principal, retention-owner approval, and monitoring for denied/rate-limited invocations. This change does not deploy infrastructure, alter credentials or enable any external action by itself.

The repository-owned OpenClaw intake plugin now retries only network errors, HTTP 429, and HTTP 5xx, with a bounded 1–5 attempt policy. Every retry reuses the exact body, timestamp, signature, and provider event ID so Mission Control's intake idempotency remains authoritative. Other HTTP 4xx responses fail immediately. The plugin itself does not provide a durable disk queue; if OpenClaw exits after exhausting retries, Mission Control recovery cannot recreate an event it never received. Closing that residual requires an OpenClaw-owned durable outbound queue rather than Mission Control application logic.

## Verification evidence

- `npm run test:execution`: 44 deterministic tests passed across migration, compatibility, permission denial, schema validation, authority separation, rate limits, replay, restart recovery, independent evidence, and memory lifecycle.
- `node --test tests/openclaw-intake-plugin.test.mjs`: 5 tests passed across allowlisting, canonical identity, stable retry envelopes, and terminal 4xx handling.
- `npm run test:review-gates`: 14 tests passed.
- `npm run lint`: passed with one pre-existing calendar React-hook warning.
- `npm run build`: production compilation and type checking passed.
- `npm run native:check`: SQLite native ABI passed.

## SynthetOS implementation checklist

- [ ] Persist run ID, task ID, owner, lease epoch/expiry, state, checkpoint, and version.
- [ ] Require compare-and-swap transitions and reject stale lease epochs.
- [ ] Persist waits with typed wake conditions; never rely on a blocked in-memory worker.
- [ ] Uniquely store inbound event IDs and canonical payload digests.
- [ ] Define versioned tool schemas and reject additional properties.
- [ ] Issue narrow grants with issuer, expiry, revocation, and audit records.
- [ ] Bind every tool call to a live run and assigned owner.
- [ ] Require separate confirmation authority for external/destructive effects.
- [ ] Store result digests and reject conflicting replay.
- [ ] Require cited evidence and an evaluator distinct from the builder for sensitive completion.
- [ ] Split memory planes physically or by an enforced discriminator and retrieval API.
- [ ] Implement retention purge, correction, export, and deletion with audit evidence.
- [ ] Test worker death, ambiguous response replay, stale writers, revoked grants, rate exhaustion, malformed schemas, and populated-database migration.
- [ ] Default to one agent; add agents only for non-overlapping parallel work or independent evaluation.

## Further improvement opportunities

1. Add a durable OpenClaw outbound queue; bounded retry cannot survive process death.
2. Replace grant-issuer confirmation with an explicit principal/role policy service when organizational identity is available.
3. Encrypt or externalize sensitive audit references while preserving hashes and key identifiers.
4. Add an automated retention sweeper with legal holds and deletion receipts.
5. Add property-based state-machine tests and fault injection around commit/response ambiguity.
6. Emit metrics for denials, stale versions, retry exhaustion, confirmation latency, lease recovery, and retention backlog.
7. Version memory schemas/retrieval policies so embeddings can be rebuilt safely.
8. Add UI/API surfaces for grants, revocation, pending confirmations, workflow timelines, and evidence inspection.
