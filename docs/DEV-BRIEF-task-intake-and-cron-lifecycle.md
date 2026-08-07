# DEV BRIEF: Task Intake, Agent Delegation & Cron Lifecycle
**Codebase:** Mission Control (`mission-control/`)  
**Date:** 2026-03-07  
**Priority:** High  
**Author:** Switch (on behalf of Michael Hazilias)

---

## Context

Every task — whether triggered by Michael directly (via chat or Mattermost) or by a scheduled cron job — must be tracked as a first-class record in Mission Control. The goal is a full audit trail: who created the task, what the brief was, which agent it was assigned to, what updates were made, and how it completed.

This brief covers the **Mission Control-side changes only** (DB + API + UI). OpenClaw-side wiring (Switch intake logic + agent delegation instructions) will be handled separately.

---

## Scope of Work

### 1. Schema Changes

#### 1a. Add `brief` column to `tasks` table
A structured brief field to store the full context handed to the agent when the task is created.

```sql
ALTER TABLE tasks ADD COLUMN brief TEXT;
```

- Type: TEXT (markdown supported)
- Optional on creation, editable afterwards
- Displayed in the Task Modal under a "Brief" tab or section

#### 1b. Add `trigger_type` and `trigger_source` columns to `tasks` table
Distinguish how a task came into existence.

```sql
ALTER TABLE tasks ADD COLUMN trigger_type TEXT DEFAULT 'manual' 
  CHECK (trigger_type IN ('manual', 'cron', 'agent', 'webhook'));

ALTER TABLE tasks ADD COLUMN trigger_source TEXT;
```

- `trigger_type`: how it was created — `manual` (Switch/human), `cron` (scheduled job), `agent` (spawned by another agent), `webhook` (external trigger)
- `trigger_source`: free-text reference — e.g. cron job ID (`daily-morning-briefing`), agent name, webhook origin
- Used for filtering/display in the UI

#### 1c. Add `cron_job_id` column to `tasks` table (for cron-spawned tasks)
Links a task instance back to its cron job definition.

```sql
ALTER TABLE tasks ADD COLUMN cron_job_id TEXT;
```

- Nullable — only set when `trigger_type = 'cron'`
- References the job ID from `~/.openclaw/cron/jobs.json`
- Enables: "show all runs of this cron job" query

#### 1d. Add migration
Add as migration `015` in `src/lib/db/migrations.ts` following the existing pattern. Run all three `ALTER TABLE` statements with column-exists guards.

---

### 2. API Changes

#### 2a. `POST /api/tasks` — accept new fields
Update the task creation endpoint to accept and store:
- `brief` (string, optional)
- `trigger_type` (enum, optional, defaults to `'manual'`)
- `trigger_source` (string, optional)
- `cron_job_id` (string, optional)

#### 2b. `PATCH /api/tasks/[id]` — allow brief editing
Ensure `brief` is included in the updatable fields on the existing PATCH endpoint.

#### 2c. `POST /api/tasks/cron-spawn` — new endpoint
Creates a task from a cron trigger. This is the dedicated intake endpoint for cron-initiated tasks.

**Request body:**
```json
{
  "cron_job_id": "daily-morning-briefing",
  "title": "Morning Briefing — {date}",
  "brief": "Full brief text here...",
  "assigned_agent_id": "roland",
  "priority": "normal",
  "workspace_id": "default"
}
```

**Behaviour:**
1. Create the task with `trigger_type = 'cron'`, `trigger_source = cron_job_id`, `status = 'assigned'`
2. Log a `task_activities` entry: `activity_type = 'created'`, message: `"Task spawned by cron job: {cron_job_id}"`
3. Log a second `task_activities` entry: `activity_type = 'assigned'`, message: `"Assigned to {agent_name}"`
4. Broadcast SSE event `task_created`
5. Return the full task object

**Note:** Actual dispatch to OpenClaw (sending the session message) is handled by OpenClaw-side logic, not this endpoint. This endpoint is purely the MC record-creation step.

#### 2d. `GET /api/tasks` — add filter params
Add support for:
- `?trigger_type=cron` — filter to cron-spawned tasks
- `?cron_job_id=daily-morning-briefing` — filter to instances of a specific cron job

---

### 3. UI Changes

#### 3a. Task Modal — add "Brief" section
In `src/components/TaskModal.tsx`:
- Add a "Brief" tab or collapsible section alongside the existing Planning/Activity tabs
- Render `brief` as formatted markdown (use existing markdown rendering if present, or a simple `<pre>` with whitespace-pre-wrap)
- Allow editing the brief inline (textarea, save on blur or explicit Save button)

#### 3b. Task cards / list — add trigger badge
In the task list / `MissionQueue.tsx`:
- Show a small badge on tasks where `trigger_type !== 'manual'`:
  - `cron` → 🕐 badge
  - `agent` → 🤖 badge
  - `webhook` → 🔗 badge
- Tooltip on hover: `"Triggered by: {trigger_source}"`

#### 3c. Task Modal — show trigger metadata
In the task detail view, under the title/status area:
- If `trigger_type = 'cron'`: display `"Cron: {cron_job_id}"` with clock emoji
- If `trigger_type = 'agent'`: display `"Spawned by: {trigger_source}"`

---

### 4. Cron Calendar Integration (existing `/api/cron` route)

The existing cron calendar (`src/app/api/cron/route.ts`) reads `~/.openclaw/cron/jobs.json` and renders upcoming occurrences.

**Enhancement:** When rendering a calendar event for a cron job, also query MC for recent task instances of that job and show a "last run" status on the calendar event.

```
GET /api/cron?year=2026&month=3
```

Add to each calendar event object:
```json
{
  "lastTaskId": "abc-123",
  "lastTaskStatus": "done",
  "lastTaskCompletedAt": "2026-03-07T08:12:00Z"
}
```

Implementation: for each cron job in the response, do a quick SQLite query:
```sql
SELECT id, status, updated_at FROM tasks 
WHERE cron_job_id = ? 
ORDER BY created_at DESC 
LIMIT 1
```

---

## What This Does NOT Include

The following are **out of scope** for this brief (handled by OpenClaw-side wiring):

- Switch automatically creating a MC task when Michael sends a message
- Agents reading their brief from MC and posting updates back
- The OpenClaw cron trigger mechanism that calls `/api/tasks/cron-spawn`
- Agent completion flow that marks a task `done` in MC

These will be implemented in a separate OpenClaw-side brief once the MC API surface is ready.

---

## Acceptance Criteria

- [ ] Migration 015 runs cleanly on an existing DB with no errors
- [ ] `POST /api/tasks` accepts and stores `brief`, `trigger_type`, `trigger_source`, `cron_job_id`
- [ ] `POST /api/tasks/cron-spawn` creates task + 2 activity log entries + broadcasts SSE
- [ ] `GET /api/tasks?trigger_type=cron` filters correctly
- [ ] Task Modal renders `brief` as markdown in a dedicated section, editable
- [ ] Task list shows trigger badge for non-manual tasks
- [ ] Cron calendar events include `lastTaskId` + `lastTaskStatus` when a matching task exists
- [ ] No regressions on existing task CRUD, planning flow, or activities

---

## Files to Modify

| File | Change |
|---|---|
| `src/lib/db/schema.ts` | Add new columns to tasks table definition |
| `src/lib/db/migrations.ts` | Add migration 015 |
| `src/app/api/tasks/route.ts` | Accept new fields on POST |
| `src/app/api/tasks/[id]/route.ts` | Allow brief on PATCH |
| `src/app/api/tasks/cron-spawn/route.ts` | **New file** |
| `src/app/api/cron/route.ts` | Add last-run enrichment |
| `src/app/api/tasks/route.ts` | Add filter params to GET |
| `src/components/TaskModal.tsx` | Brief section + trigger metadata |
| `src/components/MissionQueue.tsx` | Trigger badge on task cards |

---

## Notes for the Developer

- Follow the existing migration pattern exactly — always guard `ALTER TABLE` with a column-exists check using `PRAGMA table_info`
- The `task_activities` table is already the correct place for agent update logs — no new table needed
- SSE broadcasting uses `broadcast()` from `src/lib/events.ts` — use the same pattern as the activities route
- Keep the `cron-spawn` endpoint simple and stateless — no queueing, no retries at this layer
