# Integration Architecture — Mission Control + OpenClaw

## Overview

Mission Control is the **state of record** for all tasks. OpenClaw is the **execution layer** — it routes tasks to agents and runs them. There is no task state machine on the OpenClaw side; all task lifecycle management lives in Mission Control's SQLite database.

## Architecture Diagram

```
┌──────────────────┐         WebSocket RPC         ┌──────────────────┐
│                  │◄──────────────────────────────►│                  │
│  Mission Control │   chat.send (dispatch)         │  OpenClaw        │
│  (Next.js)       │   sessions.* (management)      │  Gateway         │
│                  │   agents.list (discovery)       │                  │
│  SQLite DB       │                                │  Agent Runtime   │
│  (state of       │◄─── WebSocket events ──────────│                  │
│   record)        │   (completion detection)        │                  │
│                  │                                │                  │
│  SSE Broadcast ──┼──► Browser UI                  │                  │
└──────────────────┘                                └──────────────────┘
         ▲                                                    │
         │              HTTP Webhook (future)                 │
         └────────────────────────────────────────────────────┘
         POST /api/webhooks/openclaw-task-update
```

## Three Integration Layers

### Layer 1 — Task Dispatch (Mission Control → OpenClaw)

**Flow:**
1. Task created in Mission Control (saved to SQLite)
2. `dispatchTaskToGateway()` generates a `correlationId` (UUID)
3. correlationId stored as `gateway_task_id` in the task record
4. Structured message sent to agent via `chat.send` WebSocket RPC
5. On success: `sync_status = 'synced'`
6. On failure: `sync_status = 'pending_sync'` for later retry

**Key files:**
- `src/lib/openclaw/dispatch.ts` — Dispatch service
- `src/app/api/openclaw/retry-sync/route.ts` — Retry queue endpoint

**Transport:** WebSocket RPC via `chat.send` (NOT a REST endpoint). The `tasks.create` RPC method does not exist in the current OpenClaw RPC surface.

### Layer 2 — Status Sync (OpenClaw → Mission Control)

**Primary path:** WebSocket event listeners on the existing OpenClaw client connection.

**Secondary path:** HTTP webhook at `/api/webhooks/openclaw-task-update` (future-ready).

**Polling fallback:** `/api/openclaw/sync-tasks` queries session history for completion markers.

**Matching strategy:**
1. **correlationId match** (primary): Agent echoes `TASK_COMPLETE[<uuid>]: <summary>` — matched by `gateway_task_id`
2. **Content-based match** (fallback): Legacy `TASK_COMPLETE: <summary>` — matched by session → agent → active task

**Key files:**
- `src/lib/openclaw/sync.ts` — WebSocket event listener
- `src/app/api/webhooks/openclaw-task-update/route.ts` — HTTP webhook
- `src/app/api/openclaw/sync-tasks/route.ts` — Polling fallback

### Layer 3 — Agent-Routed Task Creation from UI Features

**Correct pattern for all AI-powered features:**
```
User triggers action in UI
  ↓
Mission Control creates a structured task
  ↓
Task dispatched to OpenClaw gateway (Layer 1)
  ↓
Gateway routes to the most appropriate available agent
  ↓
Agent completes work, update detected via WebSocket events (Layer 2)
  ↓
Mission Control receives update, populates result into UI
```

**Mission Control NEVER decides which agent handles a task.** The gateway owns routing. Mission Control only describes what needs to be done.

**Key files:**
- `src/lib/openclaw/agent-task.ts` — Reusable helper for any UI feature
- `src/app/api/content/generate-script/route.ts` — Content script generation (refactored)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENCLAW_GATEWAY_URL` | Yes | `ws://127.0.0.1:18789` | WebSocket URL for OpenClaw gateway |
| `OPENCLAW_GATEWAY_TOKEN` | For remote | (none) | Auth token for gateway connection |
| `OPENCLAW_WEBHOOK_SECRET` | Production | (none) | HMAC secret for webhook signature verification. Startup warning logged if unset. |
| `MISSION_CONTROL_URL` | No | `http://localhost:4000` | URL for agent callback APIs |
| `MC_API_TOKEN` | Production | (none) | API authentication token |
| `WEBHOOK_SECRET` | Production | (none) | Legacy agent-completion webhook secret |
| `DATABASE_PATH` | No | `./mission-control.db` | SQLite database file path |

## Database Schema Changes

### New columns on `tasks` table (Migration 015):
- `gateway_task_id` TEXT — correlationId linking MC task to gateway dispatch
- `sync_status` TEXT — 'local' | 'synced' | 'pending_sync' | 'sync_failed'
- `retry_count` INTEGER — number of dispatch retry attempts
- `last_sync_attempt` TEXT — timestamp of last dispatch attempt
- `gateway_completion_notes` TEXT — agent's completion summary

### New table `workspace_settings` (Migration 016):
Per-workspace integration configuration with typed columns.

### New column on `agents` table (Migration 017):
- `capabilities` TEXT — JSON array of capability strings (e.g. `["content","code","research"]`)

### New columns on `content_items` table (Migration 018):
- `gateway_task_id` TEXT — links content item to its generation task
- `generation_status` TEXT — 'idle' | 'generating' | 'completed' | 'failed'

## State Mapping

OpenClaw task states are mapped to Mission Control statuses via per-workspace configuration stored in the `workspace_settings` table.

**Default mapping:**
```json
{
  "queued": "inbox",
  "assigned": "in_progress",
  "running": "in_progress",
  "completed": "done",
  "failed": "blocked"
}
```

Editable via Settings page → OpenClaw Integration → State Mapping editor.

## Known Gaps and Assumptions

### Verified
1. **No `tasks.*` RPC methods** — Task dispatch uses `chat.send` with correlationId. Confirmed: no task-specific RPC surface exists.
2. **No gateway task state machine** — All task state lives in MC's SQLite. OpenClaw is the execution layer, Mission Control is the state of record.
3. **No outbound HTTP webhooks from OpenClaw** — Primary sync uses WebSocket events. HTTP webhook endpoint built as future-ready secondary path.

### Requires Follow-Up
1. **Agent correlationId echoing** — Agents must include the correlationId in completion responses for reliable round-trip matching. This is NOT currently enforced in agent prompt templates. The sync listener falls back to content-based matching if correlationId is missing. **Action required:** Update agent prompt templates to enforce correlationId echoing.
2. **Agent capabilities from gateway** — The `capabilities` field on agents is currently manual entry only. The `agents.list` RPC response should be verified against the OpenClaw RPC surface when the agent team is fully configured. If the gateway includes capabilities metadata, import logic should be updated to populate this field automatically.
3. ~~**State mapping "blocked" status**~~ — **Resolved.** `"blocked"` is now a first-class task status in the CHECK constraint (Migration 019), the `TaskStatus` type, the Zod validation schema, and the Mission Queue board UI.

## Webhook Setup

See `WEBHOOKS.md` for detailed webhook configuration instructions.
