/**
 * POST /api/tasks/cron-spawn
 * Dedicated intake for cron-triggered tasks.
 * Creates the task record, logs activity entries, and broadcasts via SSE.
 */

import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task, Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { cron_job_id, title, assigned_agent_id, brief, priority, workspace_id } = body;

    // Validate required fields
    if (!cron_job_id || !title || !assigned_agent_id) {
      return NextResponse.json(
        { error: 'Missing required fields: cron_job_id, title, assigned_agent_id' },
        { status: 400 }
      );
    }

    const id = uuidv4();
    const now = new Date().toISOString();
    const taskPriority = priority || 'normal';
    const taskWorkspace = workspace_id || 'default';

    // 1. Create the task
    run(
      `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, brief, trigger_type, trigger_source, cron_job_id, created_at, updated_at)
       VALUES (?, ?, 'assigned', ?, ?, ?, ?, 'cron', ?, ?, ?, ?)`,
      [
        id,
        title,
        taskPriority,
        assigned_agent_id,
        taskWorkspace,
        brief || null,
        cron_job_id,
        cron_job_id,
        now,
        now,
      ]
    );

    // 2. Log 'created' activity
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
       VALUES (?, ?, 'created', ?, ?)`,
      [uuidv4(), id, `Task spawned by cron job: ${cron_job_id}`, now]
    );

    // 3. Log 'assigned' activity
    const agent = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [assigned_agent_id]);
    const agentName = agent?.name || assigned_agent_id;
    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'assigned', ?, ?)`,
      [uuidv4(), id, assigned_agent_id, `Assigned to ${agentName}`, now]
    );

    // 4. Fetch the full task object
    const task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       WHERE t.id = ?`,
      [id]
    );

    // 5. Broadcast SSE event
    if (task) {
      broadcast({
        type: 'task_created',
        payload: task,
      });
    }

    return NextResponse.json(task);
  } catch (error) {
    console.error('Failed to create cron-spawned task:', error);
    return NextResponse.json({ error: 'Failed to create cron-spawned task' }, { status: 500 });
  }
}
