/**
 * Task Dispatch Service — Mission Control → OpenClaw Gateway
 *
 * Dispatches tasks to the OpenClaw gateway via WebSocket RPC (chat.send).
 * Generates a correlationId (UUID) for round-trip tracking, stores it as
 * gateway_task_id in the local SQLite task record. If the gateway is
 * unreachable, saves the task with sync_status='pending_sync' for later
 * retry via the /api/openclaw/retry-sync endpoint.
 *
 * This module is the single source of truth for gateway dispatch logic.
 * API routes should call dispatchTaskToGateway() instead of inlining
 * dispatch code.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import { abandonDispatchExecution, startExecution, type ExecutionRun } from '@/lib/openclaw/execution-supervision';
import type { Task, Agent, OpenClawSession } from '@/lib/types';

export interface DispatchResult {
  success: boolean;
  correlationId: string;
  error?: string;
}

export function buildMattermostThreadInstruction(task: Task): string {
  if (!task.mattermost_root_post_id) return '';
  const destination = task.mattermost_thread_url ||
    `Mattermost channel ${task.mattermost_channel_id || '(current channel)'}, root post ${task.mattermost_root_post_id}`;
  return `\n**Originating Mattermost thread:** ${destination}\n**Single-speaker requirement:** You are the sole routine speaker for this task. Post only meaningful, complete checkpoints and the final result in this exact thread (reply_to/root_id: \`${task.mattermost_root_post_id}\`). Never post acknowledgements, internal status labels, token-stream fragments, heartbeat confirmations, or messages such as "working", "checking", or "I". Mission Control heartbeats and routine lifecycle transitions are silent. Do not post a new top-level DM message.`;
}

/**
 * Dispatch a task to the OpenClaw gateway via chat.send.
 *
 * @param taskId - The Mission Control task ID
 * @returns DispatchResult with success status and correlationId
 */
export async function dispatchTaskToGateway(taskId: string): Promise<DispatchResult> {
  const correlationId = uuidv4();
  const now = new Date().toISOString();

  // Fetch task with assigned agent info
  const task = queryOne<Task & { assigned_agent_name?: string }>(
    `SELECT t.*, a.name as assigned_agent_name
     FROM tasks t
     LEFT JOIN agents a ON t.assigned_agent_id = a.id
     WHERE t.id = ?`,
    [taskId],
  );

  if (!task) {
    return { success: false, correlationId, error: 'Task not found' };
  }

  if (!task.assigned_agent_id) {
    return { success: false, correlationId, error: 'Task has no assigned agent' };
  }

  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [task.assigned_agent_id]);
  if (!agent) {
    return { success: false, correlationId, error: 'Assigned agent not found' };
  }

  // Store the correlationId before attempting dispatch.
  // correlation_id is stable across retries; gateway_task_id may be updated
  // by OpenClaw on each dispatch attempt.
  const existingCorrelationId = task.correlation_id;
  const finalCorrelationId = existingCorrelationId || correlationId;
  let execution: ExecutionRun | undefined;
  run(
    'UPDATE tasks SET correlation_id = COALESCE(correlation_id, ?), gateway_task_id = ?, last_sync_attempt = ?, updated_at = ? WHERE id = ?',
    [finalCorrelationId, correlationId, now, now, taskId],
  );

  // Attempt gateway dispatch
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Get or create OpenClaw session for the agent
    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = ?',
      [agent.id, 'active'],
    );

    if (!session) {
      const sessionId = uuidv4();
      const openclawSessionId = `mission-control-${agent.name.toLowerCase().replace(/\s+/g, '-')}`;
      run(
        `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, channel, status, task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [sessionId, agent.id, openclawSessionId, 'mission-control', 'active', taskId, now, now],
      );
      session = queryOne<OpenClawSession>('SELECT * FROM openclaw_sessions WHERE id = ?', [sessionId]);
    }

    if (!session) {
      throw new Error('Failed to create agent session');
    }

    const prefix = agent.session_key_prefix || 'agent:main:';
    const sessionKey = `${prefix}${session.openclaw_session_id}`;
    execution = startExecution({ taskId, agentId: agent.id, sessionKey, runIdentity: correlationId, leaseOwner: `dispatch:${uuidv4()}` });
    const priorityEmoji: Record<string, string> = { low: '🔵', normal: '⚪', high: '🟡', urgent: '🔴' };
    const taskMessage = buildTaskMessage(task, agent, finalCorrelationId, priorityEmoji[task.priority] || '⚪', execution);

    // Send via chat.send RPC
    await client.call('chat.send', {
      sessionKey,
      message: taskMessage,
      idempotencyKey: `dispatch-${correlationId}`,
    });

    // Mark as synced
    run(
      'UPDATE tasks SET sync_status = ?, updated_at = ? WHERE id = ?',
      ['synced', now, taskId],
    );

    // Log event
    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(), 'task_dispatched', agent.id, taskId,
        `Task "${task.title}" dispatched to ${agent.name} via gateway`,
        JSON.stringify({ correlationId: finalCorrelationId, sessionKey }),
        now,
      ],
    );

    // Broadcast update
    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return { success: true, correlationId: finalCorrelationId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown dispatch error';
    if (execution) abandonDispatchExecution(execution.id, errorMsg, task.status, new Date());
    console.error(`[Dispatch] Failed to dispatch task ${taskId}:`, errorMsg);

    // Save as pending_sync for retry
    run(
      `UPDATE tasks SET sync_status = ?, retry_count = COALESCE(retry_count, 0),
       last_sync_attempt = ?, planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
      ['pending_sync', now, `Gateway dispatch failed: ${errorMsg}`, now, taskId],
    );

    // Log integration error to events and broadcast
    run(
      `INSERT INTO events (id, type, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(), 'system', taskId,
        `Gateway dispatch failed for "${task.title}": ${errorMsg}`,
        JSON.stringify({ correlationId, error: errorMsg }),
        now,
      ],
    );

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
    broadcast({
      type: 'integration_error',
      payload: { taskId, sessionId: '', agentName: agent.name, summary: `Dispatch failed: ${errorMsg}` },
    });

    return { success: false, correlationId: finalCorrelationId, error: errorMsg };
  }
}

/**
 * Retry dispatch for a single task that is in pending_sync state.
 */
export async function retryDispatch(taskId: string, maxRetries: number): Promise<DispatchResult> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return { success: false, correlationId: '', error: 'Task not found' };

  if ((task.retry_count ?? 0) >= maxRetries) {
    const now = new Date().toISOString();
    run(
      'UPDATE tasks SET sync_status = ?, updated_at = ? WHERE id = ?',
      ['sync_failed', now, taskId],
    );
    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });
    return { success: false, correlationId: task.gateway_task_id || '', error: 'Max retries exceeded' };
  }

  // Increment retry count
  run(
    'UPDATE tasks SET retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?',
    [taskId],
  );

  return dispatchTaskToGateway(taskId);
}

/**
 * Build the structured message sent to the agent via chat.send.
 *
 * The message is intentionally lean — the full brief lives in MC and the
 * agent must fetch it via GET /api/tasks/{id} before starting work. This
 * keeps LLM context tight and MC as the single source of truth.
 */
export function buildTaskMessage(
  task: Task & { assigned_agent_name?: string },
  agent: Agent,
  correlationId: string,
  priorityEmoji: string,
  execution: ExecutionRun,
): string {
  const mcUrl = (process.env.MISSION_CONTROL_URL || 'http://localhost:4000').replace(/\/$/, '');

  const mattermostLine = agent.mattermost_channel
    ? `\n**Output channel:** Post final output to Mattermost \`#${agent.mattermost_channel}\`, then log the post URL as a deliverable (step 3 below).`
    : '';
  const mattermostThreadLine = buildMattermostThreadInstruction(task);

  const masterDelegationNote = agent.is_master
    ? `\n**As orchestrator:** When you delegate this task to a specialist, first update the task status to \`assigned\` and set \`assigned_agent_id\` to the specialist's MC agent ID (step 1a below), then move it to \`in_progress\` once they begin.`
    : '';

  return `${priorityEmoji} **TASK ASSIGNED**

**Task:** ${task.title}
**Task ID:** \`${task.id}\`
**Full brief:** ${mcUrl}/api/tasks/${task.id}
${task.due_date ? `**Due:** ${task.due_date}\n` : ''}
Fetch the full brief via \`GET ${mcUrl}/api/tasks/${task.id}\` and its completion contract via \`GET ${mcUrl}/api/tasks/${task.id}/completion-contract\` before starting work. The completion contract is authoritative for acceptance criteria, protected boundaries, and closure.${mattermostLine}${mattermostThreadLine}${masterDelegationNote}

---

**MANDATORY API CALLS — execute in this order:**

1. **Acknowledge and renew the durable execution** immediately when you begin, then every 60–120 seconds while working:
\`\`\`
POST ${mcUrl}/api/tasks/${task.id}/execution
Content-Type: application/json
{ "action": "heartbeat", "runId": "${execution.id}", "leaseOwner": "${execution.lease_owner}", "leaseEpoch": ${execution.lease_epoch}, "eventKey": "heartbeat:<monotonic-sequence>", "checkpoint": { "phase": "<current phase>", "next": "<next action>" } }
\`\`\`
Persist these values for this run. A \`409 STALE_LEASE\` means a newer fenced worker owns recovery: stop immediately. Progress activities also renew the lease as a compatibility path, but explicit checkpoint heartbeats are authoritative.
${agent.is_master ? `\n1a. **When delegating to a specialist**, set assigned agent first:\n\`\`\`\nPATCH ${mcUrl}/api/tasks/${task.id}\nContent-Type: application/json\n{ "status": "assigned", "assigned_agent_id": "<specialist_mc_agent_id>" }\n\`\`\`\n` : ''}
2. **Log deliverables** for each output (file path, URL, or artifact):
\`\`\`
POST ${mcUrl}/api/tasks/${task.id}/deliverables
Content-Type: application/json
{ "deliverable_type": "url", "title": "<output title>", "path": "<url or file path>", "description": "<optional>" }
\`\`\`
${agent.mattermost_channel ? `Use \`deliverable_type: "url"\` to record the Mattermost post URL from \`#${agent.mattermost_channel}\`.` : ''}

3. **Submit the completion report** before signalling completion:

\`POST ${mcUrl}/api/tasks/${task.id}/completion-contract\`

\`\`\`json
{
  "criteria": [{ "id": "<GET response id>", "status": "passed", "evidence": "<specific evidence>" }],
  "boundaries": [{ "id": "<GET response id>", "status": "intact", "evidence": "<specific evidence>" }],
  "plan_vs_actual": "<what was planned versus delivered>",
  "deviations": [],
  "deferred_work": [],
  "verification_commands": [{ "command": "<exact command>", "exit_code": 0, "output_summary": "<result>" }],
  "verification_ran_at": "<ISO-8601 timestamp>",
  "next_action": "None — task complete",
  "submitted_by_agent_id": "${agent.id}"
}
\`\`\`
Address every returned criterion and boundary exactly once by ID. Mission Control rejects closure if any criterion lacks evidence, a boundary is violated, verification failed/staled, or the report is incomplete. Waivers must be explicit and evidenced.

4. **Signal completion** — end your final response with this exact line:
\`TASK_COMPLETE[${correlationId}]: [one-line summary of what you did]\`

The correlationId \`${correlationId}\` is required for Mission Control to detect completion. Do not omit or alter it.
Before emitting it, close the durable run through the execution endpoint with action \`transition\`, the lease values above, a unique event key, and state \`complete\`. Use \`waiting_input\`, \`blocked\`, \`failed\`, or \`cancelled\` when appropriate.
Do not send any other messages after completion. Do not report back to any agent or ask for confirmation.

**If you cannot complete the task** (blocker, missing info, unrecoverable error): call \`POST ${mcUrl}/api/tasks/${task.id}/fail\` with \`{"reason": "description of the blocker"}\` and stop.`;
}
