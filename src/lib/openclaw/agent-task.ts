/**
 * Reusable Agent Task Helper
 *
 * Generic helper for any UI feature to dispatch a task to the OpenClaw
 * gateway and track the result via webhook/SSE. Used by the content
 * pipeline (Generate Script) and any future AI-powered features.
 *
 * This helper creates a structured task, dispatches it to the gateway,
 * and returns the correlationId so the caller can listen for completion
 * via SSE events.
 */

import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { dispatchTaskToGateway } from './dispatch';
import type { Task } from '@/lib/types';

export interface AgentTaskRequest {
  /** Human-readable title for the task */
  title: string;
  /** Detailed description / prompt for the agent */
  description: string;
  /** Workspace to create the task in */
  workspaceId: string;
  /** Task priority */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** Optional due date */
  dueDate?: string;
  /** Optional metadata stored as JSON in the task */
  metadata?: Record<string, unknown>;
}

export interface AgentTaskResult {
  /** Whether the task was created and dispatched successfully */
  success: boolean;
  /** The local Mission Control task ID */
  taskId: string;
  /** The correlationId for tracking the round-trip */
  correlationId: string;
  /** Error message if dispatch failed (task still saved locally) */
  error?: string;
}

/**
 * Create a task and dispatch it to the OpenClaw gateway.
 *
 * The task is always saved locally first. If gateway dispatch fails,
 * the task is saved with sync_status='pending_sync' for later retry.
 *
 * The caller should listen for SSE events matching the returned
 * correlationId to receive the agent's response.
 */
export async function createAndDispatchAgentTask(request: AgentTaskRequest): Promise<AgentTaskResult> {
  const taskId = uuidv4();
  const now = new Date().toISOString();

  // Create the task locally
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, due_date, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      request.title,
      request.description,
      'assigned',
      request.priority || 'normal',
      request.workspaceId,
      request.dueDate || null,
      'local',
      now,
      now,
    ],
  );

  // Log creation event
  run(
    `INSERT INTO events (id, type, task_id, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), 'task_created', taskId,
      `Agent task created: ${request.title}`,
      request.metadata ? JSON.stringify(request.metadata) : null,
      now,
    ],
  );

  // Broadcast creation
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (task) broadcast({ type: 'task_created', payload: task });

  // Dispatch to gateway
  const result = await dispatchTaskToGateway(taskId);

  return {
    success: result.success,
    taskId,
    correlationId: result.correlationId,
    error: result.error,
  };
}

/**
 * Find a task by its correlationId.
 */
export function findTaskByCorrelationId(correlationId: string): Task | undefined {
  return queryOne<Task>(
    'SELECT * FROM tasks WHERE correlation_id = ?',
    [correlationId],
  ) ?? queryOne<Task>(
    'SELECT * FROM tasks WHERE gateway_task_id = ?',
    [correlationId],
  );
}
