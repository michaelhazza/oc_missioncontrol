# Mission Control ↔ OpenClaw Wiring — Setup Prompt
**Version:** 1.0  
**Date:** 2026-03-07  
**Purpose:** Canonical prompt to wire Mission Control's task lifecycle into any OpenClaw orchestrator agent instance. Fill in all placeholders before use.

---

## ⚠️ PLACEHOLDER REFERENCE — Fill These In Before Use

| Placeholder | Description | Where to Find It |
|---|---|---|
| `{{MC_BASE_URL}}` | Base URL of the Mission Control instance | The URL where MC is running, e.g. `http://localhost:4040` or `https://mc.yourdomain.com`. Check `MISSION_CONTROL_URL` env var or the port in `package.json`. |
| `{{MC_API_TOKEN}}` | Bearer token for MC API (if auth is enabled) | Set in the MC `.env.local` as `MC_API_TOKEN`. If not set, omit the Authorization header entirely. |
| `{{ORCHESTRATOR_AGENT_ID}}` | The MC agent `id` for the orchestrator agent | Found in Mission Control UI → Team tab, or query `SELECT id FROM agents WHERE is_master = 1`. |
| `{{ORCHESTRATOR_AGENT_NAME}}` | Human-readable name of the orchestrator agent | E.g. "Switch", "Manager", "Coordinator" — whatever the agent is called in this instance. |
| `{{WORKSPACE_ID}}` | The MC workspace ID tasks should be created in | Query `SELECT id FROM workspaces` in the MC SQLite DB, or check MC UI → workspace slug. Default is `default`. |
| `{{SPECIALIST_AGENT_IDs}}` | MC agent IDs for each specialist agent | MC UI → Team tab → each non-master agent's ID. List all: researcher, coder, analyst, etc. |
| `{{OPENCLAW_GATEWAY_URL}}` | OpenClaw gateway base URL | From OpenClaw config or `openclaw gateway status`. Typically `http://localhost:18789`. |
| `{{OPENCLAW_GATEWAY_TOKEN}}` | OpenClaw gateway auth token | From `~/.openclaw/config.json` or `openclaw gateway status`. |

---

## THE PROMPT

You are being configured to wire an orchestrator agent in an OpenClaw instance to Mission Control for full task lifecycle tracking. This setup prompt covers four areas:

1. Orchestrator task intake — creating MC tasks when work is received
2. Specialist agent write-back — posting progress and completion to MC
3. Cron job task spawning — creating MC task instances at trigger time
4. Orchestrator SOUL/config update — adding the intake and reporting behaviour permanently

Read and implement all four sections below exactly as written, substituting all `{{PLACEHOLDER}}` values with the real values provided above.

---

### SECTION 1 — ORCHESTRATOR TASK INTAKE

The orchestrator agent must perform the following steps every time it receives a task from the user or decides to delegate work to a specialist agent:

**Step 1A — Create a Mission Control task**

Immediately after receiving a request that requires delegation (or upon deciding to spawn a specialist), call the Mission Control API to create a task record:

```
POST {{MC_BASE_URL}}/api/tasks
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "title": "<concise task title — 1 sentence>",
  "brief": "<full markdown brief including: task description, inputs/context, success criteria, output format expected, and any constraints>",
  "assigned_agent_id": "<MC agent ID of the specialist being assigned — see {{SPECIALIST_AGENT_IDs}}>",
  "created_by_agent_id": "{{ORCHESTRATOR_AGENT_ID}}",
  "workspace_id": "{{WORKSPACE_ID}}",
  "priority": "<low | normal | high | urgent>",
  "trigger_type": "manual",
  "trigger_source": "{{ORCHESTRATOR_AGENT_NAME}}"
}
```

The response will be a JSON object containing the task. Extract and store the `id` field — this is the **Task ID**. You will pass it to the specialist and use it for all subsequent updates.

**Step 1B — Log a dispatch activity**

After creating the task, log a dispatch activity so the audit trail reflects the delegation:

```
POST {{MC_BASE_URL}}/api/tasks/<TASK_ID>/activities
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "activity_type": "assigned",
  "message": "Delegated to <specialist agent name>. Brief provided in task record.",
  "agent_id": "{{ORCHESTRATOR_AGENT_ID}}"
}
```

**Step 1C — Include the Task ID in the specialist brief**

When sending the brief to the specialist agent (via `sessions_send` or equivalent), include the following block at the top of the message:

```
## Mission Control Task
Task ID: <TASK_ID>
MC URL: {{MC_BASE_URL}}
MC Token: {{MC_API_TOKEN}}

You MUST post progress updates and a completion update to this task using the activities endpoint.
See reporting instructions below.
```

Then continue with the full task brief.

**Step 1D — On completion, update task status**

When you receive a completion report from a specialist, update the task status in Mission Control:

```
PATCH {{MC_BASE_URL}}/api/tasks/<TASK_ID>
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "status": "done",
  "updated_by_agent_id": "{{ORCHESTRATOR_AGENT_ID}}"
}
```

If the task was blocked or failed, use `"status": "blocked"` instead.

---

### SECTION 2 — SPECIALIST AGENT WRITE-BACK

Every specialist agent (researcher, coder, analyst, etc.) must follow this reporting protocol when they receive a brief that includes a Mission Control Task ID.

**Step 2A — Log a start activity**

As the very first action after reading the brief, before beginning any work:

```
POST {{MC_BASE_URL}}/api/tasks/<TASK_ID>/activities
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "activity_type": "progress",
  "message": "Task received. Starting work.",
  "agent_id": "<YOUR MC AGENT ID>"
}
```

**Step 2B — Log progress updates during work**

Post a progress update at meaningful checkpoints (e.g. after completing a major sub-task, hitting a blocker, or finishing a phase):

```
POST {{MC_BASE_URL}}/api/tasks/<TASK_ID>/activities
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "activity_type": "progress",
  "message": "<short description of what was completed or found>",
  "agent_id": "<YOUR MC AGENT ID>"
}
```

Use `"activity_type": "blocked"` if you encounter a blocker and cannot proceed.

**Step 2C — Log a completion activity**

When your work is complete, post a final completion activity before returning results to the orchestrator:

```
POST {{MC_BASE_URL}}/api/tasks/<TASK_ID>/activities
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "activity_type": "completed",
  "message": "<2-4 sentence summary of what was done and what was produced>",
  "agent_id": "<YOUR MC AGENT ID>"
}
```

**Step 2D — Add deliverables (if applicable)**

If your output includes a file, URL, or artifact, register it:

```
POST {{MC_BASE_URL}}/api/tasks/<TASK_ID>/deliverables
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "deliverable_type": "<file | url | artifact>",
  "title": "<descriptive title of the deliverable>",
  "path": "<file path or URL>",
  "description": "<optional: what this deliverable contains>"
}
```

**Step 2E — Return results to the orchestrator**

After completing all MC write-back calls, send your completion message to the orchestrator session. Always include the Task ID in your completion message so the orchestrator can reconcile it:

```
Task ID: <TASK_ID>
Status: Complete

<your full output here>
```

**Activity type reference:**

| Type | When to use |
|---|---|
| `progress` | Checkpoint updates, phase completions |
| `blocked` | Cannot proceed — waiting on input or hit an error |
| `completed` | Final completion before returning to orchestrator |
| `note` | Informational note that doesn't fit other types |
| `status_changed` | If you are explicitly moving the task through a workflow stage |

---

### SECTION 3 — CRON JOB TASK SPAWNING

For any cron job that is intended to be tracked in Mission Control, replace the existing dispatch logic with the following two-step sequence at trigger time:

**Step 3A — Create a task instance via cron-spawn endpoint**

```
POST {{MC_BASE_URL}}/api/tasks/cron-spawn
Authorization: Bearer {{MC_API_TOKEN}}
Content-Type: application/json

{
  "cron_job_id": "<the job ID from jobs.json — e.g. daily-morning-briefing>",
  "title": "<task title — may include date/time token, e.g. 'Morning Briefing — 2026-03-08'>",
  "brief": "<full markdown brief for the agent — same as you would send manually>",
  "assigned_agent_id": "<MC agent ID of the agent who handles this job>",
  "priority": "<normal | high | urgent>",
  "workspace_id": "{{WORKSPACE_ID}}"
}
```

The response is the created task object. Extract the `id` — this is the **Task ID** for this run.

This endpoint automatically:
- Sets `trigger_type = 'cron'`
- Logs a `created` activity: "Task spawned by cron job: {cron_job_id}"
- Logs an `assigned` activity: "Assigned to {agent_name}"
- Broadcasts a `task_created` SSE event to Mission Control UI

**Step 3B — Dispatch to the agent with Task ID in the brief**

After the cron-spawn API call succeeds, send the session message to the assigned agent. Include the Task ID block at the top of the message (same format as Section 1C):

```
## Mission Control Task
Task ID: <TASK_ID>
MC URL: {{MC_BASE_URL}}
MC Token: {{MC_API_TOKEN}}

You MUST post progress updates and a completion update to this task using the activities endpoint.
See Section 2 of your agent configuration for the reporting protocol.
```

The agent then follows the standard specialist write-back protocol in Section 2.

**Cron job registration note:**  
Cron jobs are defined in `~/.openclaw/cron/jobs.json`. Each job's `id` field becomes the `cron_job_id` in the spawn request. The Mission Control calendar view will automatically link task instances back to the job using this ID and display last-run status.

---

### SECTION 4 — ORCHESTRATOR SOUL/CONFIG UPDATE

The following behaviour rules must be added to the orchestrator agent's `SOUL.md` (or equivalent identity/configuration file) so they persist across all sessions. Add this block to the relevant section of the SOUL.md file:

---

```markdown
## Mission Control Task Lifecycle

Every task delegated to a specialist agent MUST be tracked in Mission Control. This is not optional. The audit trail in Mission Control is the source of truth for all work in progress.

### On every delegation:

1. **Create a task in Mission Control first** — before sending the brief to the agent
   - Use `POST {{MC_BASE_URL}}/api/tasks`
   - Store the returned task `id`

2. **Log a dispatch activity** — `POST {{MC_BASE_URL}}/api/tasks/<id>/activities`
   - `activity_type: "assigned"`
   - Note which specialist was assigned and why

3. **Include the Task ID in every brief** — paste the MC task block at the top:
   ```
   ## Mission Control Task
   Task ID: <id>
   MC URL: {{MC_BASE_URL}}
   MC Token: {{MC_API_TOKEN}}
   ```

4. **On completion** — update task status to `done` or `blocked` via PATCH

### On receiving a completion report:

- Confirm the Task ID in the message matches an open MC task
- Call `PATCH {{MC_BASE_URL}}/api/tasks/<id>` with `status: "done"`
- Synthesise and surface the output to the user

### Hard rules:

- Never delegate work without first creating a MC task
- Never mark a task done without the specialist's completion activity being logged
- If a task was missed (no MC task exists), create it retroactively and note it was created after the fact
- If MC API is unreachable, log a local note and retry before the next delegation
```

---

## VALIDATION CHECKLIST

After completing this setup, verify the following:

- [ ] Orchestrator successfully creates a task in MC when given a test instruction — task appears in MC UI with correct title, brief, and assigned agent
- [ ] Task ID appears in the brief sent to the specialist agent
- [ ] Specialist posts `progress` and `completed` activities — they appear in the MC Task Modal → Activity tab
- [ ] Orchestrator updates task status to `done` on completion — task moves to Done column in MC
- [ ] Cron spawn endpoint creates a task instance with `trigger_type = 'cron'` — verify with `GET {{MC_BASE_URL}}/api/tasks?trigger_type=cron`
- [ ] MC calendar shows cron job history with last-run status
- [ ] SOUL.md updated and loaded correctly — verify by asking the orchestrator to describe its MC task lifecycle behaviour

---

## API QUICK REFERENCE

| Action | Method | Endpoint |
|---|---|---|
| Create task | POST | `/api/tasks` |
| Get task | GET | `/api/tasks/<id>` |
| Update task status | PATCH | `/api/tasks/<id>` |
| Log activity | POST | `/api/tasks/<id>/activities` |
| Get activities | GET | `/api/tasks/<id>/activities` |
| Add deliverable | POST | `/api/tasks/<id>/deliverables` |
| Spawn cron task | POST | `/api/tasks/cron-spawn` |
| Filter by trigger type | GET | `/api/tasks?trigger_type=cron` |
| Filter by cron job | GET | `/api/tasks?cron_job_id=<job-id>` |

All endpoints accept and return JSON. Include `Authorization: Bearer {{MC_API_TOKEN}}` header if `MC_API_TOKEN` is set on the instance.

**Task status values:** `pending_dispatch` → `planning` → `inbox` → `assigned` → `in_progress` → `testing` → `review` → `verification` → `blocked` → `done`

**Activity types:** `created` | `assigned` | `progress` | `blocked` | `completed` | `note` | `status_changed` | `spawned` | `updated` | `file_created`
