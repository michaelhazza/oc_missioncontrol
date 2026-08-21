# Claude Code independent review — preserved terminal output

Date: 2026-08-21. Invocation: Claude Code 2.1.220, background print mode, JSON output, `permission-mode=dontAsk`, empty tool allowlist, canonical spec injected as the sole source. No repository, network, credential, mutation, deployment, or elevated tool was exposed. Claude session ID: `e95ecdc8-8c86-4c63-b2b4-d764f5f97285`. Terminal reason: `completed`. Permission denials: none.

The following is the exact `result` field from the final JSON envelope:

> VERDICT: READY
>
> ## Blocker 1 — current-brief ordering: corrected
>
> Both statements now agree on a single rule, and neither asserts that `revision` selects the current brief.
>
> - Data and API (`task_brief_revisions`): “Current revision and Feature 3 digest input use total order `(provider_created_at, provider_revision_or_update_at, payload_hash, source_post_id)`; `revision` remains append order only.”
> - Failure and recovery: “current brief and digest input use the four-part total order defined in Data and API while `revision` remains append order.”
>
> The recovery text defers to the Data and API definition rather than restating a competing tuple, so there is one normative source. The four-part tuple is total (terminating in `source_post_id`, which is unique per event), which makes out-of-order delivery deterministic without renumbering, and it is consistent with the acceptance test “a correction creates revision 2 and retains revision 1” — that test constrains append numbering, not currency selection. Digest reproducibility follows, since Feature 3's digest input is bound to the same order.
>
> ## Blocker 2 — `processing_failed` / `permanent_failure`: corrected
>
> The domain is now closed over the values the recovery paths actually write:
>
> - Enumeration: `ambiguous_intent | terminal_follow_on | identity_collision | ambiguous_correction`, extended by the explicit bullet “The closed `candidate_reason` domain also includes `processing_failed | permanent_failure`; these values are normative additions.”
> - Retry exhaustion writes `candidate_state='open'`, `candidate_reason='processing_failed'`, `disposition='needs_classification'` — and `needs_classification` is excluded from the complete-disposition set, so the event stays retryable rather than being read as finished.
> - `failed` is reserved for permanently malformed/safety-invalid input with reason `permanent_failure`, remaining visible through the candidate API until acknowledged.
>
> Both values are reachable through `GET /api/intake/candidates?state=open` and resolvable through the existing resolve endpoint under the same lease fence, so neither state is a terminal dead end. Declaring the two additions in a separate bullet rather than inline in the enum is a drafting choice, not a specification gap — the union is stated normatively and the domain is still closed.
>
> ## Re-gate of the remainder
>
> No new material blocker surfaced. Spot checks that could have produced one:
>
> - `decision_version` is monotonic across recurrences and never resets, so the unique `(workspace_id, task_id, type, authority_scope, decision_version)` constraint survives reopen; `occurrence_ordinal` participates in the fingerprint, keeping rebuild fingerprints reproducible.
> - Feature 3's `human_decision` writes `authority_scope='ceo'`, a member of the declared scope enum, with the legacy `authority='michael'` mapping stated as a compatibility producer rather than a second classifier.
> - The outbox allowlist (`task_exception`, `completion_rework`, `executive_synthesis`) is referenced identically in Features 2 and 3, with rejection enforced at both queue and drain.
> - The currency guard binds `freshness_boundary_epoch` as an integer against `unixepoch()`, and the `9999-12-31T23:59:59Z` sentinel is representable, so the zero-rows path is well defined.
>
> Non-blocking observation, recorded only so it isn't mistaken for an omission later: `ambiguous_correction` is defined in the domain but has no recovery path that writes it, unlike the other five reasons. An unused-but-declared enum member does not affect implementability.
>
> Implementation may proceed under the specified sequencing: Feature 1 first, dark-run against fixtures before automatic dispatch, with production activation, schema contraction, principal grants, and alert enablement each gated on separate human approval.

The block quote above is verbatim. No tool activity or intermediate text was accepted as the verdict.
