# Development Brief: Task Lifecycle & Agent Display Fixes

## Problem Summary

Four issues identified in Mission Control that break the core task management workflow:

1. **Agent names not showing from avatars** — Imported gateway agents show generic labels instead of their configured persona names
2. **Task descriptions empty** — When Switch delegates tasks, the detailed brief isn't stored in the task `description` field
3. **No deliverables on completion** — Completed tasks have empty Deliverables tab; no link to output (e.g. Mattermost post)
4. **Tasks stuck in INBOX** — Completed tasks remain in INBOX column instead of progressing through ASSIGNED → IN PROGRESS → TESTING → DONE

---

## Issue 1: Agent Names Not Showing Correctly

### Root Cause

When agents are imported from the OpenClaw Gateway via `POST /api/agents/import`, they are stored with:
- `name`: The gateway agent ID string (e.g. `"researcher"`, `"coder"`)
- `role`: Hard-coded to `"Imported Agent"`

**File:** `src/app/api/agents/import/route.ts:108`

```typescript
run(
  `INSERT INTO agents (id, name, role, ...)`,
  [id, agentReq.name, 'Imported Agent', ...]  // ← name is gateway ID, role is generic
);
```

The gateway `agents.list` API returns `{ id, name, label, model, channel, status }` but the **label** field (which contains the human-readable name like "Roland" or "Research Analyst") is not used. The `name` field from gateway is typically the agent's directory name (e.g. `"researcher"`), not a friendly display name.

Meanwhile, the sidebar (`AgentsSidebar.tsx:217`) displays `agent.name` as the primary identifier, and `agent.role` as the secondary label. Since `role` is "Imported Agent" for all imported agents, they all look the same.

The **Switch** agent looks correct because it's either manually configured or was created by a different flow that sets proper `name` and `role` values.

### Fix Required

**A) Enhance the import flow to pull richer metadata:**

In `src/app/api/agents/import/route.ts`:
- Map the gateway agent's `label` field to `name` (fallback to `name` if no label)
- Parse the agent's SOUL.md frontmatter for display metadata (the frontmatter parser already exists at `src/lib/openclaw/frontmatter.ts`)
- Read the SOUL.md content body for the agent's role description — it typically contains lines like `"You are Roland, a Research Analyst"` which can be parsed for a proper `role` value

**B) Add a SOUL.md frontmatter schema extension:**

Extend the frontmatter YAML block in each agent's SOUL.md to include display metadata:

```yaml
---
mission_control:
  role: orchestrator
  display_name: "Roland"
  display_role: "Research Analyst"
  avatar_emoji: "🔬"
---
```

Update `src/lib/openclaw/frontmatter.ts` (`parseAgentFrontmatter()`) to extract these fields and pass them through to the import flow.

**C) Add a "Sync from Gateway" action:**

For agents already imported with stale names, add a re-sync endpoint or button that re-reads SOUL.md and updates the DB record. This can be added to the `AgentModal.tsx` edit form or as a bulk action on the Team page.

### Files to Modify

| File | Change |
|------|--------|
| `src/lib/openclaw/frontmatter.ts` | Add `display_name`, `display_role`, `avatar_emoji` to `FrontmatterResult` |
| `src/app/api/agents/import/route.ts` | Use frontmatter display fields when inserting agent records |
| `src/app/api/agents/discover/route.ts` | Surface `label` and frontmatter display fields in discovery response |
| `src/components/DiscoverAgentsModal.tsx` | Show richer agent info in discovery UI |
| `src/app/api/agents/[id]/route.ts` | Add PATCH support for re-syncing from SOUL.md |

### Estimated Effort
Small — mostly data mapping changes in the import pipeline.

---

## Issue 2: Task Description Empty When Switch Creates Tasks

### Root Cause

When Switch (the orchestrator agent) creates a task via `POST /api/tasks`, the `description` field is optional and Switch is not including it. Looking at the task creation payload:

**File:** `src/app/api/tasks/route.ts:122-144`

The API accepts `description` and `brief` as separate fields. Switch appears to be calling this endpoint with only `title` and `assigned_agent_id`, not populating `description` or `brief`.

The **dispatch** system (`src/app/api/tasks/[id]/dispatch/route.ts:279-290`) builds a task message from `task.title`, `task.description`, and `task.brief` — but if those are empty, the agent only sees the title.

The key insight is that this is a **prompt engineering issue on the Switch/orchestrator side**. Switch needs to be instructed to:
1. Include a detailed `description` in the `POST /api/tasks` body
2. Optionally populate `brief` with structured requirements

### Fix Required

**A) Update Switch's dispatch prompt template:**

When MC dispatches to Switch (the master/orchestrator), the prompt should include explicit instructions to create tasks with full descriptions. This is in `src/app/api/tasks/[id]/dispatch/route.ts` (the `completionInstructions` for the builder role, lines 228-238).

Specifically, update the orchestrator's task creation instructions to require:
```
POST /api/tasks
Body: {
  "title": "Short task title",
  "description": "Detailed brief with context, requirements, acceptance criteria",
  "assigned_agent_id": "<agent-uuid>",
  "workspace_id": "<workspace-id>",
  "priority": "high"
}
```

**B) Update Switch's SOUL.md instructions:**

The Switch agent's SOUL.md (at `~/.openclaw/workspace/SOUL.md` since it's the master) should contain instructions that when delegating tasks, it must provide a detailed description. This is an OpenClaw-side configuration change.

**C) Fallback: Auto-populate description from activity log:**

When a task is created by an agent (`created_by_agent_id` is set) and `description` is null, MC could auto-populate it from the first activity log entry (which typically contains the delegation message). This acts as a safety net.

Add to `src/app/api/tasks/route.ts` (POST handler, after task creation):
```typescript
if (!validatedData.description && validatedData.created_by_agent_id) {
  // Look for delegation context from recent activities on the master agent's active task
  // Auto-populate description from the delegation message
}
```

### Files to Modify

| File | Change |
|------|--------|
| `src/app/api/tasks/[id]/dispatch/route.ts` | Update orchestrator prompt to require description in task creation |
| Switch SOUL.md (OpenClaw side) | Add delegation instructions requiring detailed descriptions |
| `src/app/api/tasks/route.ts` | Optional: auto-fill empty descriptions for agent-created tasks |

### Estimated Effort
Small — primarily prompt engineering + one optional API enhancement.

---

## Issue 3: No Deliverables Linked on Task Completion

### Root Cause

The deliverables system is fully built (`task_deliverables` table, `POST /api/tasks/[id]/deliverables`, `DeliverablesList.tsx` component), but agents are **not calling the deliverables API** when they complete tasks.

Looking at the dispatch prompt in `src/app/api/tasks/[id]/dispatch/route.ts:228-238`:

```
completionInstructions = `**IMPORTANT:** After completing work, you MUST call these APIs:
1. Log activity: POST .../api/tasks/${task.id}/activities
2. Register deliverable: POST .../api/tasks/${task.id}/deliverables
3. Update status: PATCH .../api/tasks/${task.id}
```

The instructions tell the agent to register deliverables, but:
1. Agents may not be following these instructions (they use `TASK_COMPLETE[uuid]: summary` which is caught by the WebSocket sync instead)
2. There's **no Mattermost integration** in the codebase — no way to link to a Mattermost post as a deliverable
3. The completion sync path (`src/lib/openclaw/sync.ts:190-238`) moves the task to `testing` and logs an activity, but **never creates deliverables**

### Fix Required

**A) Auto-create deliverables on task completion (sync.ts):**

In `src/lib/openclaw/sync.ts`, the `completeTask()` function should automatically create deliverables:

```typescript
function completeTask(task: Task, summary: string, now: string): void {
  // ... existing status update ...

  // Auto-register completion summary as a deliverable
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), task.id, 'artifact', 'Completion Summary', summary, now]
  );

  // Scan output directory for files and register them
  const projectDir = getProjectDir(task);
  if (fs.existsSync(projectDir)) {
    for (const file of fs.readdirSync(projectDir)) {
      run(
        `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), task.id, 'file', file, path.join(projectDir, file), now]
      );
    }
  }

  broadcast({ type: 'deliverable_added', payload: { task_id: task.id } });
}
```

**B) Add Mattermost integration for output linking:**

This requires new infrastructure:

1. **New config:** Add Mattermost server URL, API token, and channel mapping to workspace settings
2. **Agent config:** Each agent should have an `output_channel` field mapping to their Mattermost channel
3. **Post-completion hook:** After an agent completes a task, fetch the latest post from their Mattermost channel and register it as a URL deliverable
4. **New table/fields:**
   - Add `mattermost_channel_id` to agents table
   - Add `mattermost_url` to workspace settings

**New files needed:**

| File | Purpose |
|------|---------|
| `src/lib/mattermost/client.ts` | Mattermost API client (REST) |
| `src/lib/mattermost/types.ts` | Mattermost types (Post, Channel) |
| `src/app/api/integrations/mattermost/route.ts` | Config endpoint |
| DB migration | Add `mattermost_channel_id` to agents, workspace settings for MM URL/token |

**C) Enhance completion sync to create URL deliverables:**

In `completeTask()`, after completion, if the agent has a Mattermost channel configured:

```typescript
if (agent.mattermost_channel_id) {
  const mmClient = getMattermostClient();
  const latestPost = await mmClient.getLatestPostInChannel(agent.mattermost_channel_id);
  if (latestPost) {
    const postUrl = `${mmServerUrl}/${teamName}/pl/${latestPost.id}`;
    run(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), task.id, 'url', 'Output Post (Mattermost)', postUrl, now]
    );
  }
}
```

### Files to Modify

| File | Change |
|------|--------|
| `src/lib/openclaw/sync.ts` | Auto-create deliverables in `completeTask()` |
| `src/lib/db/schema.ts` | Add `mattermost_channel_id` to agents table |
| `src/lib/db/migrations.ts` | Migration for new columns |
| `src/lib/mattermost/client.ts` | **NEW** — Mattermost REST client |
| `src/app/api/integrations/mattermost/route.ts` | **NEW** — Config management |
| `src/components/AgentModal.tsx` | Add Mattermost channel field to agent edit form |

### Estimated Effort
Medium-Large — auto-deliverable creation is small; Mattermost integration is a new subsystem.

---

## Issue 4: Tasks Stuck in INBOX — Status Not Progressing

### Root Cause

This is the most critical issue. The lifecycle should be:

```
Switch creates task (INBOX) → Switch assigns agent (ASSIGNED) → Agent dispatched (IN_PROGRESS) → Agent completes (TESTING) → Verified (DONE)
```

The problem is that **Switch is creating tasks but not assigning them properly**. Looking at the flow:

1. **Switch creates a task** via `POST /api/tasks` — task goes to `inbox` status (line 113)
2. **Auto-promotion exists** in `PATCH /api/tasks/[id]` (lines 148-155): if `assigned_agent_id` is set while task is `inbox`, it auto-promotes to `assigned`
3. **BUT:** If Switch creates the task with both `assigned_agent_id` and no explicit status, the `POST` handler sets status to `inbox` and does NOT auto-promote. The auto-promotion logic only exists in the `PATCH` handler.

Additionally, the **WebSocket completion sync** (`sync.ts:190-195`) correctly moves tasks to `testing` when an agent completes, but if the task was never moved out of `inbox` (because it was never dispatched), the sync won't match it — the matching logic looks for tasks in `assigned` or `in_progress` status only (line 174).

### The Two Gaps:

**Gap 1: POST /api/tasks doesn't auto-promote INBOX → ASSIGNED**

When Switch creates a task with `assigned_agent_id` set, the task is inserted as `inbox` but never promoted. The auto-promotion logic is only in the PATCH handler.

**Gap 2: No auto-dispatch on task creation with assignment**

Even if we fix Gap 1, the task would be `assigned` but never dispatched (no `POST /api/tasks/[id]/dispatch` is triggered by task creation).

### Fix Required

**A) Add auto-promotion + auto-dispatch to POST /api/tasks:**

In `src/app/api/tasks/route.ts`, after task creation, if `assigned_agent_id` is set:

```typescript
// After task insertion...
if (validatedData.assigned_agent_id) {
  // Auto-promote from inbox → assigned
  run('UPDATE tasks SET status = ? WHERE id = ? AND status = ?', ['assigned', id, 'inbox']);

  // Trigger auto-dispatch
  const missionControlUrl = getMissionControlUrl();
  fetch(`${missionControlUrl}/api/tasks/${id}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }).catch(err => console.error('Auto-dispatch on create failed:', err));
}
```

**B) Fix the WebSocket content-based matching in sync.ts:**

In `handleCompletionByContentMatch()`, the query only looks for tasks in `assigned` or `in_progress` (line 174). Add `inbox` to handle the edge case where tasks are stuck:

```sql
WHERE ... AND t.status IN ('inbox', 'assigned', 'in_progress')
```

**C) Ensure dispatch route moves task to IN_PROGRESS:**

The dispatch route (`src/app/api/tasks/[id]/dispatch/route.ts:306-310`) already moves `assigned` → `in_progress`. Verify this also works for the auto-dispatch path.

**D) Ensure completeTask moves to TESTING:**

`sync.ts:completeTask()` already sets status to `testing`. This is correct.

**E) Add a "stuck task" detector:**

As a safety net, add a periodic check (via the existing cron system or a new SSE-triggered check) that finds tasks stuck in `inbox` with an `assigned_agent_id` set for more than N minutes and auto-promotes them.

### Files to Modify

| File | Change |
|------|--------|
| `src/app/api/tasks/route.ts` | Add auto-promote + auto-dispatch when task created with assignment |
| `src/lib/openclaw/sync.ts` | Broaden status matching in `handleCompletionByContentMatch` |
| `src/app/api/tasks/cron-spawn/route.ts` | Already does this correctly (creates at `assigned` + dispatches) — align main POST handler |

### Estimated Effort
Small-Medium — the core fix is adding auto-dispatch to the POST handler. The stuck-task detector is a nice-to-have.

---

## Implementation Priority

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| **P0** | #4 — Tasks stuck in INBOX | Small | **Critical** — blocks all task progression |
| **P1** | #2 — Empty descriptions | Small | High — agents work blind without context |
| **P1** | #1 — Agent names | Small | High — usability/identity confusion |
| **P2** | #3 — Deliverables (auto-create) | Small | Medium — visibility into completed work |
| **P3** | #3 — Deliverables (Mattermost) | Large | Medium — requires new integration subsystem |

---

## Local Setup: Wiring MC to Mac Mini & OpenClaw

This section covers the infrastructure configuration needed to connect Mission Control to the OpenClaw Gateway running on your Mac Mini.

### Prerequisites

1. **OpenClaw Gateway** running on the Mac Mini
2. **Tailscale** (or equivalent) for network connectivity between MC and the Mac Mini
3. **Mattermost** instance (if implementing Issue #3 Mattermost integration)

### Environment Variables (`.env.local`)

```bash
# OpenClaw Gateway connection
OPENCLAW_GATEWAY_URL=ws://<macmini-tailscale-ip>:3100
OPENCLAW_API_KEY=<your-openclaw-api-key>
OPENCLAW_WEBHOOK_SECRET=<shared-hmac-secret>

# Mission Control self-referencing URL (used for internal API calls during dispatch)
MISSION_CONTROL_URL=http://localhost:4040
# or if MC is on a different machine:
# MISSION_CONTROL_URL=http://<mc-tailscale-ip>:4040

# Optional: MC API token for internal auth
MC_API_TOKEN=<token-for-internal-api-calls>

# Mattermost Integration (if implementing)
MATTERMOST_URL=https://<mattermost-server>
MATTERMOST_API_TOKEN=<bot-token>
MATTERMOST_TEAM_NAME=<team-slug>
```

### Agent SOUL.md Frontmatter Setup

Each agent's SOUL.md on the Mac Mini (`~/.openclaw/workspace/agents/<agent-id>/SOUL.md`) should have frontmatter:

```yaml
---
mission_control:
  role: specialist           # orchestrator | specialist | monitor
  display_name: "Roland"     # Friendly name shown in MC sidebar
  display_role: "Research Analyst"  # Role shown under name
  avatar_emoji: "🔬"        # Emoji avatar
---
```

For the Switch (orchestrator) agent at `~/.openclaw/workspace/SOUL.md`:

```yaml
---
mission_control:
  role: orchestrator
  display_name: "Switch"
  display_role: "Strategist / Chief of Staff"
  avatar_emoji: "⚙️"
---
```

### Switch Orchestrator Prompt Requirements

Switch's SOUL.md must instruct it to create tasks with full details. Add to the orchestrator's instructions:

```markdown
## Task Delegation Protocol

When delegating tasks to specialists, ALWAYS create tasks via the Mission Control API with:
- `title`: Short, descriptive task title
- `description`: Detailed brief including context, requirements, expected output format, and acceptance criteria
- `assigned_agent_id`: The specialist's UUID from the team roster
- `priority`: Task urgency level
- `workspace_id`: Current workspace ID

Example API call:
POST {MC_URL}/api/tasks
{
  "title": "Top Crypto Coins by Growth — Last 7 Days",
  "description": "Research the top performing cryptocurrency coins by 7-day growth percentage. Include: coin name, ticker symbol, current price, 7-day % change, market cap, and brief analysis of growth drivers. Format as a structured report. Sources should include CoinGecko, CoinMarketCap, and crypto news outlets.",
  "assigned_agent_id": "<researcher-uuid>",
  "workspace_id": "default",
  "priority": "high"
}
```

### Mattermost Channel Mapping (If Implementing)

If implementing Mattermost integration, configure each agent's output channel:

1. Create a bot account in Mattermost with channel read permissions
2. Note each agent's output channel ID
3. In MC, edit each agent and set their `mattermost_channel_id`
4. The completion hook will auto-fetch the latest post and create a URL deliverable

### Network Architecture

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│  Mission     │◄──────────────────►│  OpenClaw Gateway │
│  Control     │   (ws://macmini)   │  (Mac Mini)       │
│  (Next.js)   │                    │                   │
│  :4040       │                    │  Agents:          │
│              │     HTTP webhook   │  - Switch (main)  │
│              │◄───────────────────│  - Researcher     │
│              │  (task completion) │  - Coder          │
└──────┬───────┘                    │  - Analyst        │
       │                            │  - Marketer       │
       │ SSE                        │  - Ops            │
       ▼                            └──────────┬────────┘
  Browser UI                                   │
  (Real-time updates)              ┌───────────▼────────┐
                                   │   Mattermost       │
                                   │   (Agent outputs)   │
                                   └────────────────────┘
```

### Verification Steps

After setup, verify the pipeline works end-to-end:

1. **MC → OpenClaw connection:** Click "Connect to OpenClaw" on Switch in the sidebar — should show green "OpenClaw Connected"
2. **Agent discovery:** Click "Import from Gateway" — should list all agents with their gateway IDs
3. **Task creation:** Create a task and assign to an agent — verify it moves INBOX → ASSIGNED → IN_PROGRESS
4. **Task completion:** Wait for agent to finish — verify task moves to TESTING and deliverables appear
5. **Agent names:** Verify sidebar shows proper names from SOUL.md frontmatter

---

## Summary of All Code Changes

### Must-Have (P0-P1)

1. `src/app/api/tasks/route.ts` — Auto-promote + auto-dispatch on create with assignment
2. `src/lib/openclaw/sync.ts` — Broaden matching; auto-create deliverables
3. `src/lib/openclaw/frontmatter.ts` — Parse display metadata from SOUL.md
4. `src/app/api/agents/import/route.ts` — Use frontmatter display fields
5. `src/app/api/tasks/[id]/dispatch/route.ts` — Update orchestrator prompt

### Nice-to-Have (P2-P3)

6. `src/lib/mattermost/client.ts` — **NEW** Mattermost client
7. `src/app/api/integrations/mattermost/route.ts` — **NEW** Config endpoint
8. `src/lib/db/schema.ts` + migrations — Mattermost fields
9. `src/components/AgentModal.tsx` — Mattermost channel field
