# Mission Control — Full Integration Build Plan

## OpenClaw RPC Methods Used (Derived from Codebase)

All communication with OpenClaw uses the existing WebSocket RPC client at `src/lib/openclaw/client.ts`.

| Method | Purpose | Used By |
|--------|---------|---------|
| `chat.send` | Dispatch task to agent session (with correlationId) | Layer 1 — Task Dispatch |
| `sessions.create` | Create agent session if none exists | Layer 1 — Task Dispatch |
| `sessions.list` | Check active sessions / gateway health | Settings page ping |
| `agents.list` | Discover agents, import metadata + capabilities | Agent sync, capability model |
| `models.list` | Model discovery | Existing functionality |
| `config.get` | Gateway config snapshot | Existing functionality |
| `sessions.history` | Retrieve session message history | Polling fallback sync |

**Assumed RPC surface (flagged for verification):**

1. **No `tasks.create` or `tasks.*` methods exist** — task dispatch is modeled entirely around `chat.send` with a Mission Control-generated `correlationId` (UUID) included in the structured message payload. The agent must echo this back in completion responses.

2. **No outbound HTTP webhook capability in OpenClaw** — primary sync uses WebSocket event listeners on the existing client. The HTTP webhook endpoint is built as a future-ready secondary path.

3. **Agent completion detection via `chat.send` response convention** — we assume agents include `TASK_COMPLETE: [summary]` or structured JSON with the `correlationId` in their responses. This pattern already exists in the codebase (`/api/webhooks/agent-completion`).

4. **`agents.list` returns agent metadata** — we assume this includes fields like `capabilities`, `model`, `status`. If capabilities are not present in the response, we allow manual entry via the UI.

---

## Database Migrations Required

### Migration 015 — Integration Columns on Tasks Table

```sql
ALTER TABLE tasks ADD COLUMN gateway_task_id TEXT;
ALTER TABLE tasks ADD COLUMN sync_status TEXT DEFAULT 'local'
  CHECK (sync_status IN ('local', 'synced', 'pending_sync', 'sync_failed'));
ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_sync_attempt TEXT;
ALTER TABLE tasks ADD COLUMN gateway_completion_notes TEXT;

CREATE INDEX idx_tasks_sync_status ON tasks(sync_status);
CREATE INDEX idx_tasks_gateway_task_id ON tasks(gateway_task_id);
```

### Migration 016 — Workspace Settings Table

```sql
CREATE TABLE IF NOT EXISTS workspace_settings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
  gateway_url TEXT,
  webhook_secret TEXT,
  polling_interval_seconds INTEGER DEFAULT 60,
  state_mapping TEXT DEFAULT '{"queued":"backlog","assigned":"in_progress","running":"in_progress","completed":"done","failed":"blocked"}',
  max_retry_count INTEGER DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_workspace_settings_workspace ON workspace_settings(workspace_id);
```

### Migration 017 — Agent Capabilities Column

```sql
ALTER TABLE agents ADD COLUMN capabilities TEXT;
```

Stored as JSON array string, e.g. `'["content","code","research"]'`.

### Migration 018 — Content Items Gateway Tracking

```sql
ALTER TABLE content_items ADD COLUMN gateway_task_id TEXT;
ALTER TABLE content_items ADD COLUMN generation_status TEXT DEFAULT 'idle'
  CHECK (generation_status IN ('idle', 'generating', 'completed', 'failed'));
```

---

## State Mapping Configuration

- **Storage:** `workspace_settings.state_mapping` column (JSON text)
- **Scope:** Per-workspace. Each workspace can customize independently.
- **Default:** Applied at application layer when no `workspace_settings` row exists:
  ```json
  {
    "queued": "backlog",
    "assigned": "in_progress",
    "running": "in_progress",
    "completed": "done",
    "failed": "blocked"
  }
  ```
  Note: Mission Control task statuses are `pending_dispatch | planning | inbox | assigned | in_progress | testing | review | verification | done`. The mapping maps OpenClaw states → MC statuses. "backlog" doesn't exist as a MC status — **this will be mapped to "inbox" unless you want a new status added**. Flagging for verification.

- **Editable via:** Settings page → Integration section → inline JSON editor
- **Loaded at runtime:** `getWorkspaceSettings(workspaceId)` helper function, never hardcoded

---

## Background Retry Queue

- **Mechanism:** DB-based. No `setTimeout` or in-memory state.
- **Storage:** Tasks with `sync_status = 'pending_sync'` and `retry_count` column
- **Retry endpoint:** `POST /api/openclaw/retry-sync`
  - Queries tasks WHERE `sync_status = 'pending_sync'` AND `retry_count < max_retry_count`
  - For each, attempts `chat.send` dispatch via WebSocket RPC
  - On success: sets `sync_status = 'synced'`
  - On failure: increments `retry_count`, updates `last_sync_attempt`
  - When `retry_count >= max_retry_count`: sets `sync_status = 'sync_failed'`
- **Trigger:** Designed for cron or manual trigger from Settings page
- **UI:** Manual re-sync button on each task card for `sync_failed` tasks
- **Workspace-scoped:** Retry-sync endpoint accepts `workspace_id` parameter

---

## File-by-File Implementation Plan

### New Files

| File | Purpose |
|------|---------|
| `src/lib/openclaw/dispatch.ts` | Task dispatch service — creates correlationId, sends via chat.send, handles failure → pending_sync |
| `src/lib/openclaw/agent-task.ts` | Reusable helper for any UI feature to dispatch a task and await result via WebSocket events/SSE |
| `src/lib/openclaw/sync.ts` | WebSocket event listener that processes agent responses, matches by correlationId, updates tasks |
| `src/lib/openclaw/workspace-settings.ts` | CRUD helpers for workspace_settings table, default values |
| `src/app/api/webhooks/openclaw-task-update/route.ts` | HTTP webhook endpoint (future-ready) with signature verification |
| `src/app/api/openclaw/retry-sync/route.ts` | Polling endpoint to sweep pending_sync tasks and retry dispatch |
| `src/app/api/openclaw/sync-tasks/route.ts` | Polling fallback — queries OpenClaw sessions for status changes |
| `WEBHOOKS.md` | Webhook setup documentation |
| `INTEGRATION.md` | Full integration architecture documentation |

### Modified Files

| File | Changes |
|------|---------|
| `src/lib/db/schema.ts` | Add gateway_task_id, sync_status, retry_count, last_sync_attempt, gateway_completion_notes to tasks; add workspace_settings table; add capabilities to agents; add gateway_task_id + generation_status to content_items |
| `src/lib/db/migrations.ts` | Add migrations 015-018 |
| `src/lib/types.ts` | Add WorkspaceSettings interface, update Task/Agent/ContentItem types, add new sync types |
| `src/app/api/tasks/route.ts` | After task creation, call dispatch service (Layer 1). On failure, save with pending_sync |
| `src/app/api/tasks/[id]/route.ts` | On agent assignment (PATCH), trigger dispatch. Show sync_status in response |
| `src/app/api/content/generate-script/route.ts` | Remove direct LiteLLM call. Replace with agent-task dispatch via OpenClaw |
| `src/app/workspace/[slug]/content/page.tsx` | Fix workspace resolution from slug. Add `generating` state display. Handle webhook/SSE for script completion |
| `src/app/settings/page.tsx` | Add Integration section: gateway URL, webhook secret, polling interval, state mapping editor, manual retry-sync trigger, live connection status |
| `src/lib/events.ts` | No structural changes — existing broadcast is sufficient |
| `src/hooks/useSSE.ts` | Add handler for new event types (script_generated, sync_status_changed) |
| `src/lib/openclaw/client.ts` | Add event listener registration for incoming agent notifications (for primary WebSocket sync) |
| `src/app/api/agents/discover/route.ts` | Extract capabilities from gateway agent metadata on import |
| `src/app/api/agents/import/route.ts` | Store capabilities on import |
| `.env.example` | Add OPENCLAW_WEBHOOK_SECRET |
| `src/lib/validation.ts` | Add validation schemas for new endpoints |

---

## New Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `OPENCLAW_WEBHOOK_SECRET` | Shared secret for HTTP webhook signature verification | (none — validation disabled if unset) |

All other integration settings (gateway URL, polling interval, max retries, state mapping) are stored per-workspace in the `workspace_settings` table and managed via the Settings page. The existing `OPENCLAW_GATEWAY_URL` and `OPENCLAW_GATEWAY_TOKEN` remain as the server-wide defaults.

---

## Assumptions Flagged for Verification

1. **No `tasks.*` RPC methods** — Task dispatch uses `chat.send` with correlationId. Verify no task-specific RPC surface exists.

2. **Agent echoes correlationId** — Agents must include the correlationId in completion responses for round-trip matching. Verify this is documented/enforced in agent prompt templates.

3. **`agents.list` capabilities field** — We assume the gateway may include a `capabilities` array in agent metadata. If not present, capabilities must be set manually in Mission Control.

4. **State mapping "backlog" → "inbox"** — The default mapping includes `"queued": "backlog"` but MC has no "backlog" status. Will map to "inbox" unless a new status is desired.

5. **WebSocket events for completion** — We assume the OpenClaw client receives `notification` events when agents complete work. The existing `handleMessage` → `emit('notification')` flow should capture these. Verify the event shape includes session info for matching.

6. **Content script generation timeout** — When replacing the direct LiteLLM call with an agent task, the generation becomes asynchronous. The UI must show a `generating` state and wait for the webhook/SSE update. There is no guaranteed SLA for agent response time.

7. **No gateway-side task state machine** — Since OpenClaw doesn't have a task concept, all task state management remains in Mission Control's SQLite. The "status sync" from OpenClaw is really "agent completion detection" via WebSocket events, not a bidirectional state sync.

---

## Execution Order

1. **Prerequisite:** Fix workspace resolution in content page
2. **Migrations:** 015-018 (tasks sync columns, workspace_settings, agent capabilities, content gateway tracking)
3. **Layer 1:** Dispatch service, retry queue, task creation integration
4. **Layer 2:** WebSocket event listener, HTTP webhook endpoint, polling fallback, state mapping
5. **Layer 3:** Replace generate-script LiteLLM call, agent-task helper, content pipeline UI updates
6. **Cross-cutting:** Settings page integration section, error handling, agent capabilities, SSE event types
7. **Documentation:** WEBHOOKS.md, INTEGRATION.md
