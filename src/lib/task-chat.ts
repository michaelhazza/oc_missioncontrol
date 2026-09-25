import { randomUUID } from 'crypto';

import { broadcast } from '@/lib/events';
import { getDb, queryAll, queryOne, run, transaction } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import type { Agent, Task, TaskMessage, TaskMessageSender } from '@/lib/types';

type TaskChatTask = Task & { assigned_agent_name?: string };

export interface CreateTaskMessageInput {
  content: string;
  senderType?: TaskMessageSender;
  senderAgentId?: string | null;
  senderName?: string;
  idempotencyKey: string;
  retry?: boolean;
}

export function getTaskMessage(taskId: string, messageId: string): TaskMessage | undefined {
  return queryOne<TaskMessage>(
    `SELECT m.*, a.name AS agent_name, a.avatar_emoji AS agent_avatar_emoji
       FROM task_messages m
       LEFT JOIN agents a ON a.id = m.sender_agent_id
      WHERE m.task_id = ? AND m.id = ?`,
    [taskId, messageId],
  );
}

export function listTaskMessages(taskId: string, afterSeq = 0): TaskMessage[] {
  const params: unknown[] = [taskId];
  let cursor = '';
  if (afterSeq > 0) {
    cursor = ' AND m.seq > ?';
    params.push(afterSeq);
  }
  return queryAll<TaskMessage>(
    `SELECT m.*
       FROM task_messages m
      WHERE m.task_id = ?${cursor}
      ORDER BY m.seq ASC
      LIMIT 500`,
    params,
  );
}

export function getTaskMessageState(taskId: string, readerKey: string) {
  const task = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [taskId]);
  if (!task) throw new Error('Task not found');
  const lastSeq = queryOne<{ value: number }>('SELECT COALESCE(MAX(seq),0) AS value FROM task_messages WHERE task_id = ?', [taskId])?.value || 0;
  const lastReadSeq = queryOne<{ last_read_seq: number }>(
    'SELECT last_read_seq FROM task_message_reads WHERE task_id = ? AND reader_key = ?', [taskId, readerKey],
  )?.last_read_seq || 0;
  const unreadCount = queryOne<{ value: number }>(
    `SELECT COUNT(*) AS value FROM task_messages
      WHERE task_id = ? AND seq > ? AND sender_type != 'human'`, [taskId, lastReadSeq],
  )?.value || 0;
  return { lastSeq, lastReadSeq, unreadCount };
}

export function markTaskMessagesRead(taskId: string, readerKey: string, throughSeq?: number) {
  const state = getTaskMessageState(taskId, readerKey);
  const target = Math.max(0, Math.min(throughSeq ?? state.lastSeq, state.lastSeq));
  const now = new Date().toISOString();
  run(`INSERT INTO task_message_reads(task_id,reader_key,last_read_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(task_id,reader_key) DO UPDATE SET
       last_read_seq=MAX(task_message_reads.last_read_seq,excluded.last_read_seq),updated_at=excluded.updated_at`,
      [taskId, readerKey, target, now]);
  return getTaskMessageState(taskId, readerKey);
}

export function resolveLiveTaskExecution(taskId: string, agentId: string) {
  return queryOne<{ id: string; session_key: string }>(
    `SELECT id,session_key FROM task_execution_runs
      WHERE task_id = ? AND agent_id = ?
        AND state IN ('running','waiting_input','blocked','recovering')
      ORDER BY updated_at DESC LIMIT 1`,
    [taskId, agentId],
  );
}

function resolveSender(task: TaskChatTask, input: CreateTaskMessageInput) {
  const senderType = input.senderType || 'human';
  if (senderType === 'agent') {
    const agentId = input.senderAgentId || task.assigned_agent_id;
    if (!agentId || agentId !== task.assigned_agent_id) {
      throw new Error('Agent messages must come from the currently assigned agent');
    }
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
    if (!agent) throw new Error('Assigned agent not found');
    return { senderType, senderAgentId: agent.id, senderName: agent.name, status: 'received' as const };
  }
  if (senderType === 'system') {
    return { senderType, senderAgentId: null, senderName: input.senderName || 'Mission Control', status: 'received' as const };
  }
  return { senderType, senderAgentId: null, senderName: input.senderName || 'Michael', status: 'queued' as const };
}

export function createTaskMessage(taskId: string, input: CreateTaskMessageInput): { message: TaskMessage; created: boolean } {
  const task = queryOne<TaskChatTask>(
    `SELECT t.*, a.name AS assigned_agent_name
       FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id
      WHERE t.id = ?`,
    [taskId],
  );
  if (!task) throw new Error('Task not found');

  const existing = queryOne<TaskMessage>(
    'SELECT * FROM task_messages WHERE task_id = ? AND client_idempotency_key = ?',
    [taskId, input.idempotencyKey],
  );
  if (existing) {
    if (input.retry && existing.sender_type === 'human' && existing.delivery_status === 'failed') {
      run(
        `UPDATE task_messages SET delivery_status = 'queued', delivery_error = NULL, updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), existing.id],
      );
      return { message: getTaskMessage(taskId, existing.id)!, created: false };
    }
    return { message: existing, created: false };
  }

  const sender = resolveSender(task, input);
  const now = new Date().toISOString();
  const id = randomUUID();
  transaction(() => {
    const seq = queryOne<{ value: number }>(
      'SELECT COALESCE(MAX(seq),0)+1 AS value FROM task_messages WHERE task_id = ?', [taskId],
    )!.value;
    run(
      `INSERT INTO task_messages
        (id, task_id, seq, sender_type, sender_agent_id, sender_name, content,
         client_idempotency_key, delivery_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, taskId, seq, sender.senderType, sender.senderAgentId, sender.senderName,
       input.content, input.idempotencyKey, sender.status, now, now],
    );
    run('UPDATE tasks SET updated_at = ? WHERE id = ?', [now, taskId]);
  });
  return { message: getTaskMessage(taskId, id)!, created: true };
}

function taskReplyInstruction(task: TaskChatTask, agent: Agent, message: TaskMessage) {
  const baseUrl = (process.env.MISSION_CONTROL_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `MISSION CONTROL LIVE CHAT — TASK-SCOPED MESSAGE

Task: ${task.title}
Task ID: ${task.id}
Message ID: ${message.id}
From: ${message.sender_name}

${message.content}

Respond to this message in the same task chat after acting on it. POST your concise response to:
${baseUrl}/api/tasks/${task.id}/messages
with JSON {"content":"<your response>","sender_type":"agent","sender_agent_id":"${agent.id}","idempotency_key":"reply-${message.id}"}.
If MC_API_TOKEN is configured, include Authorization: Bearer $MC_API_TOKEN. Log detailed work through the existing task activity API; do not include secrets or raw sensitive tool output in chat.`;
}

export async function deliverTaskMessage(taskId: string, messageId: string): Promise<TaskMessage> {
  const message = getTaskMessage(taskId, messageId);
  if (!message) throw new Error('Message not found');
  if (message.sender_type !== 'human') return message;
  if (message.delivery_status === 'delivered') return message;
  run('UPDATE task_messages SET delivery_attempts=delivery_attempts+1,updated_at=? WHERE id=?',
    [new Date().toISOString(), messageId]);

  const task = queryOne<TaskChatTask>(
    `SELECT t.*, a.name AS assigned_agent_name
       FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id
      WHERE t.id = ?`, [taskId],
  );
  if (!task?.assigned_agent_id) return markFailed(taskId, messageId, 'Task has no assigned agent');
  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [task.assigned_agent_id]);
  if (!agent) return markFailed(taskId, messageId, 'Assigned agent not found');

  const execution = resolveLiveTaskExecution(taskId, agent.id);
  if (!execution) return markFailed(taskId, messageId, 'Assigned agent has no live execution context for this task');

  const sessionKey = execution.session_key;
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) await client.connect();
    const result = await client.call<Record<string, unknown>>('chat.send', {
      sessionKey,
      message: taskReplyInstruction(task, agent, message),
      idempotencyKey: `task-chat-${message.id}`,
    });
    const gatewayMessageId = typeof result?.runId === 'string' ? result.runId : null;
    run(
      `UPDATE task_messages
          SET delivery_status = 'delivered', delivery_error = NULL,
              gateway_session_key = ?, gateway_message_id = ?, updated_at = ?
        WHERE id = ?`,
      [sessionKey, gatewayMessageId, new Date().toISOString(), messageId],
    );
    const updated = getTaskMessage(taskId, messageId)!;
    broadcast({ type: 'task_message_updated', payload: updated });
    return updated;
  } catch (error) {
    return markFailed(taskId, messageId, error instanceof Error ? error.message : String(error));
  }
}

function markFailed(taskId: string, messageId: string, error: string): TaskMessage {
  run(
    `UPDATE task_messages SET delivery_status = 'failed', delivery_error = ?, updated_at = ? WHERE id = ?`,
    [error.slice(0, 1000), new Date().toISOString(), messageId],
  );
  const updated = getTaskMessage(taskId, messageId)!;
  broadcast({ type: 'task_message_updated', payload: updated });
  return updated;
}

export function broadcastTaskMessage(message: TaskMessage) {
  broadcast({ type: 'task_message_updated', payload: message });
}
