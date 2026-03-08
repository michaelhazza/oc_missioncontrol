# Mission Control — Task Completion & Status Rules

## Rule 1: MC is the Only Source of Truth

Mission Control is the only authoritative record of task state. Switch has no persistent memory between sessions and must never rely on session context to make claims about task status.

### Before routing a new task

Before delegating any task to a specialist agent, query MC to check whether a task with the same intent or `correlationId` already exists.

If a matching task is found:
- **status is `review` or `done`** — Report this to Michael. The task is done or awaiting his review. Do not re-delegate.
- **status is `in_progress`** — Report that the task is active and with the agent. Do not re-delegate unless Michael explicitly asks to.
- **No matching task exists** — Proceed with delegation as normal.

### Before answering any status question

If Michael asks whether a task has been done, is pending, or was sent — query MC first. Never answer from memory. A task that appears unfinished from session context may already be in `review` or `done` in MC.

Never say "waiting on the agent" or "task sent 20 minutes ago" without first confirming the current MC status.

### How to query

```
GET http://localhost:3000/api/tasks                    # list all, filter by agent/status/keyword
GET http://localhost:3000/api/tasks/:id               # look up a specific task by ID
```

**Rule: MC status always overrides session memory. If MC says complete, it is complete — regardless of what Switch remembers from the current conversation.**

---

## Rule 2: Completed Tasks Must Move to `review`, Not `done`

When a specialist agent finishes a task, the task must be moved to **`review`** status — not `done`, not `complete`, not `testing`.

The `review` status is the human checkpoint. Michael (or another human) reviews the work and marks it `done` when satisfied. Agents must never skip this step.

### What specialists must do on task completion

When a specialist finishes their work, they must call the MC API to update the task status:

```
PATCH http://localhost:3000/api/tasks/:task_id
Content-Type: application/json

{
  "status": "review",
  "summary": "Brief description of what was completed"
}
```

Alternatively, use the agent-completion webhook:

```
POST http://localhost:3000/api/webhooks/agent-completion
Content-Type: application/json

{
  "task_id": "uuid",
  "summary": "Brief description of what was completed"
}
```

Or emit the completion marker in the session output (picked up automatically by the WebSocket sync):

```
TASK_COMPLETE[correlationId]: Brief summary of what was done
```

### What must NOT happen

- Do **not** mark the task as `done` — only Michael can do this after reviewing the work.
- Do **not** skip the API call — if no status update reaches MC, the task stays `in_progress` and Michael has no visibility that it's finished.
- Do **not** assume the task is "done" because the work is done. Done in MC means reviewed and approved by a human.

### The status lifecycle

```
inbox → assigned → in_progress → review → done
                                   ↑
                          Specialists land here.
                          Human reviews, then marks done.
```

Tasks in `review` are visible on the Kanban board under the REVIEW column. This is how Michael knows work is ready for him.

---

## Rule 3: Switch Reads MC Before Reporting Status

Switch (the orchestrator) must never tell Michael a task is "complete" or "in review" based on memory. It must query MC first.

Example flow:
1. Michael asks: "Did Coder finish the authentication task?"
2. Switch queries: `GET /api/tasks?keyword=authentication&agent=coder`
3. Switch reads the `status` field from the response
4. Switch reports the actual MC status — not what it remembers from the conversation

If MC says `in_progress`, tell Michael it's still in progress.
If MC says `review`, tell Michael it's ready for his review.
If MC says `done`, tell Michael it's been completed and approved.
