/**
 * Task Activities API
 * Endpoints for logging and retrieving task activities
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateActivitySchema } from '@/lib/validation';
import type { TaskActivity } from '@/lib/types';
import { heartbeatFromActivity, transitionFromActivity } from '@/lib/openclaw/execution-supervision';

export const dynamic = 'force-dynamic';

/**
 * GET /api/tasks/[id]/activities
 * Retrieve all activities for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const db = getDb();

    // Get activities with agent info
    const activities = db.prepare(`
      SELECT 
        a.*,
        ag.id as agent_id,
        ag.name as agent_name,
        ag.avatar_emoji as agent_avatar_emoji
      FROM task_activities a
      LEFT JOIN agents ag ON a.agent_id = ag.id
      WHERE a.task_id = ?
      ORDER BY a.created_at DESC
    `).all(taskId) as any[];

    // Transform to include agent object
    const result: TaskActivity[] = activities.map(row => ({
      id: row.id,
      task_id: row.task_id,
      agent_id: row.agent_id,
      activity_type: row.activity_type,
      message: row.message,
      metadata: row.metadata,
      created_at: row.created_at,
      agent: row.agent_id ? {
        id: row.agent_id,
        name: row.agent_name,
        avatar_emoji: row.agent_avatar_emoji,
        role: '',
        status: 'working' as const,
        is_master: false,
        workspace_id: 'default',
        source: 'local' as const,
        description: '',
        created_at: '',
        updated_at: '',
      } : undefined,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching activities:', error);
    return NextResponse.json(
      { error: 'Failed to fetch activities' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tasks/[id]/activities
 * Log a new activity for a task
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const body = await request.json();
    
    // Validate input with Zod
    const validation = CreateActivitySchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { activity_type, message, agent_id, author, metadata } = validation.data;

    const db = getDb();

    // Resolve agent_id from author name if agent_id not provided
    let resolvedAgentId = agent_id || null;
    if (!resolvedAgentId && author) {
      const agent = db.prepare('SELECT id FROM agents WHERE name = ? OR id = ? LIMIT 1').get(author, author) as { id: string } | undefined;
      if (agent) {
        resolvedAgentId = agent.id;
      }
    }

    const id = crypto.randomUUID();

    const task = db.prepare(
      'SELECT status, assigned_agent_id FROM tasks WHERE id = ?'
    ).get(taskId) as { status: string; assigned_agent_id: string | null } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const now = new Date().toISOString();
    let taskStarted = false;

    const insertActivity = db.transaction(() => {
      db.prepare(`
        INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        taskId,
        resolvedAgentId,
        activity_type,
        message,
        metadata ? JSON.stringify(metadata) : null
      );

      // A progress acknowledgement from the assigned agent is authoritative:
      // the agent has accepted the task and started work. Keeping the task in
      // "assigned" after this point makes the board disagree with reality.
      if (
        activity_type === 'progress' &&
        task.status === 'assigned' &&
        resolvedAgentId !== null &&
        resolvedAgentId === task.assigned_agent_id
      ) {
        db.prepare(
          'UPDATE tasks SET status = ?, planning_dispatch_error = NULL, updated_at = ? WHERE id = ?'
        ).run('in_progress', now, taskId);
        taskStarted = true;
      }
    });

    insertActivity();

    // Normal agent activity is the compatibility bridge into durable
    // supervision. Explicit /execution checkpoint heartbeats remain the
    // preferred contract, but existing agents now renew ownership without a
    // second prompt channel.
    if (resolvedAgentId && resolvedAgentId === task.assigned_agent_id) {
      try {
        if (activity_type === 'progress') {
          const metadataRecord = metadata as unknown as Record<string, unknown> | undefined;
          const suppliedCheckpoint = metadataRecord?.checkpoint && typeof metadataRecord.checkpoint === 'object'
            ? (metadataRecord.checkpoint as object)
            : undefined;
          heartbeatFromActivity(taskId, resolvedAgentId, `activity:${id}`, suppliedCheckpoint, new Date(now));
        } else if (activity_type === 'completed') {
          transitionFromActivity(taskId, resolvedAgentId, `activity:${id}:complete`, 'complete', message, new Date(now));
        } else if (activity_type === 'blocked') {
          transitionFromActivity(taskId, resolvedAgentId, `activity:${id}:blocked`, 'blocked', message, new Date(now));
        }
      } catch (executionError) {
        console.error('[Activities] Durable execution projection failed:', executionError);
      }
    }

    // If activity_type is 'completed', also mark the task as done
    if (activity_type === 'completed') {
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('done', now, taskId);

      // Broadcast task update
      const updatedTask = db.prepare(`
        SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
        FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
        WHERE t.id = ?
      `).get(taskId);
      if (updatedTask) {
        broadcast({ type: 'task_updated', payload: updatedTask as any });
      }
    }

    if (taskStarted) {
      const updatedTask = db.prepare(`
        SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
        FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
        WHERE t.id = ?
      `).get(taskId);
      if (updatedTask) {
        broadcast({ type: 'task_updated', payload: updatedTask as any });
      }
    }

    // Get the created activity with agent info
    const activity = db.prepare(`
      SELECT 
        a.*,
        ag.id as agent_id,
        ag.name as agent_name,
        ag.avatar_emoji as agent_avatar_emoji
      FROM task_activities a
      LEFT JOIN agents ag ON a.agent_id = ag.id
      WHERE a.id = ?
    `).get(id) as any;

    const result: TaskActivity = {
      id: activity.id,
      task_id: activity.task_id,
      agent_id: activity.agent_id,
      activity_type: activity.activity_type,
      message: activity.message,
      metadata: activity.metadata,
      created_at: activity.created_at,
      agent: activity.agent_id ? {
        id: activity.agent_id,
        name: activity.agent_name,
        avatar_emoji: activity.agent_avatar_emoji,
        role: '',
        status: 'working' as const,
        is_master: false,
        workspace_id: 'default',
        source: 'local' as const,
        description: '',
        created_at: '',
        updated_at: '',
      } : undefined,
    };

    // Broadcast to SSE clients
    broadcast({
      type: 'activity_logged',
      payload: result,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error('Error creating activity:', error);
    return NextResponse.json(
      { error: 'Failed to create activity' },
      { status: 500 }
    );
  }
}
