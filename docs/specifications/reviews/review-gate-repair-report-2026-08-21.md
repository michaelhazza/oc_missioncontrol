# Unattended review gate repair report

## Root causes

- Claude review jobs used a coordinator permission mode (`plan`) that cannot execute the review path unattended and surfaced an approval in a background process with no interactive channel.
- ChatGPT readiness was checked against the external `user` attachment profile. The authenticated, persistent session and Automation V1 Project were in the managed `openclaw` profile, which was already running and page-ready.

## Permanent repair

- Standalone Claude reviews now read only an explicitly allowlisted source, inject its contents, launch with `--permission-mode dontAsk --tools ""`, enforce timeout/budget, and preserve the genuine terminal verdict from Claude's JSON envelope.
- Out-of-root sources, process/timeout failures, malformed JSON and missing verdicts fail closed with precise reason codes. Mutation, credential, network, deployment and elevated requests are impossible because no tools are exposed.
- Browser diagnosis distinguishes invalid status, wrong profile, stopped browser and non-ready page. Recovery is bounded to starting and re-checking the configured managed profile; profile mismatch never falls back silently.
- The managed `openclaw` profile was verified authenticated, `pageReady=true`, and the exact `Automation V1` Project was discovered. A fresh project conversation returned an independent review verdict.

## Verification and residual risk

- `npm test`: 16/16 passing, covering read-only allowlists, blocked out-of-root access, genuine final output, reason codes, exact-profile recovery and non-recoverable mismatch.
- Browser live proof: managed profile status reported `running=true`, `cdpReady=true`, `pageReady=true`; fresh Automation V1 conversation URL is recorded in the raw review.
- Human action remains required only for genuine login, 2FA, CAPTCHA or ambiguous account/Project. UI-selector changes remain an operational risk, contained by readiness diagnostics and fail-closed behavior.
- No product features, deployment, merge, credential changes, public exposure or broad unattended permissions were introduced.
