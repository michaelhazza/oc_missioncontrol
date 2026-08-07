import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateTaskSchema } from '@/lib/validation';
import { populateTaskRolesFromAgents } from '@/lib/workflow-engine';
import { getMissionControlUrl } from '@/lib/config';
import { releaseReadyDependentTasks } from '@/lib/task-dependencies';
import type { Task, CreateTaskRequest, Agent } from '@/lib/types';

// GET /api/tasks - List all tasks with optional filters

export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const businessId = searchParams.get('business_id');
    const workspaceId = searchParams.get('workspace_id');
    const assignedAgentId = searchParams.get('assigned_agent_id');
    const mattermostRootPostId = searchParams.get('mattermost_root_post_id');

    let sql = `
      SELECT
        t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name
      FROM tasks t
      LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
      LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (status) {
      // Support comma-separated status values (e.g., status=inbox,testing,in_progress)
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        sql += ' AND t.status = ?';
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        sql += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }
    if (businessId) {
      sql += ' AND t.business_id = ?';
      params.push(businessId);
    }
    if (workspaceId) {
      sql += ' AND t.workspace_id = ?';
      params.push(workspaceId);
    }
    if (assignedAgentId) {
      sql += ' AND t.assigned_agent_id = ?';
      params.push(assignedAgentId);
    }
    if (mattermostRootPostId) {
      sql += ' AND t.mattermost_root_post_id = ?';
      params.push(mattermostRootPostId);
    }

    const triggerType = searchParams.get('trigger_type');
    if (triggerType) {
      sql += ' AND t.trigger_type = ?';
      params.push(triggerType);
    }

    const cronJobId = searchParams.get('cron_job_id');
    if (cronJobId) {
      sql += ' AND t.cron_job_id = ?';
      params.push(cronJobId);
    }

    sql += ' ORDER BY t.created_at DESC';

    const tasks = queryAll<Task & { assigned_agent_name?: string; assigned_agent_emoji?: string; created_by_agent_name?: string }>(sql, params);

    // Transform to include nested agent info
    const transformedTasks = tasks.map((task) => ({
      ...task,
      assigned_agent: task.assigned_agent_id
        ? {
            id: task.assigned_agent_id,
            name: task.assigned_agent_name,
            avatar_emoji: task.assigned_agent_emoji,
          }
        : undefined,
    }));

    return NextResponse.json(transformedTasks);
  } catch (error) {
    console.error('Failed to fetch tasks:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

// POST /api/tasks - Create a new task
export async function POST(request: NextRequest) {
  try {
    const body: CreateTaskRequest = await request.json();
    console.log('[POST /api/tasks] Received body:', JSON.stringify(body));

    // Validate input with Zod
    const validation = CreateTaskSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const validatedData = validation.data;

    const id = uuidv4();
    const now = new Date().toISOString();

    const workspaceId = validatedData.workspace_id || 'default';
    const dependencyIds = Array.from(new Set(validatedData.depends_on_task_ids || []));
    const missingDependencies = dependencyIds.filter(
      dependencyId => !queryOne<Task>('SELECT id FROM tasks WHERE id = ?', [dependencyId])
    );
    if (missingDependencies.length > 0) {
      return NextResponse.json(
        { error: 'Dependency task not found', task_ids: missingDependencies },
        { status: 400 }
      );
    }
    if (dependencyIds.length > 0 && !validatedData.assigned_agent_id) {
      return NextResponse.json(
        { error: 'Dependent tasks require an assigned agent for automatic dispatch' },
        { status: 400 }
      );
    }

    // Dependent tasks are parked until the final prerequisite completion
    // atomically releases them for dispatch.
    const status = dependencyIds.length > 0 ? 'pending_dispatch' : (validatedData.status || 'inbox');

    // Use an explicitly requested workflow when supplied; otherwise use the
    // workspace default. Strict multi-role workflows must be opt-in.
    let workflowTemplateId = validatedData.workflow_template_id || null;
    if (workflowTemplateId) {
      const requestedTemplate = queryOne<{ id: string }>(
        'SELECT id FROM workflow_templates WHERE id = ? AND workspace_id = ?',
        [workflowTemplateId, workspaceId]
      );
      if (!requestedTemplate) {
        return NextResponse.json(
          { error: 'Workflow template not found', workflow_template_id: workflowTemplateId },
          { status: 400 }
        );
      }
    } else {
      const defaultTemplate = queryOne<{ id: string }>(
        'SELECT id FROM workflow_templates WHERE workspace_id = ? AND is_default = 1 LIMIT 1',
        [workspaceId]
      );
      workflowTemplateId = defaultTemplate?.id || null;
    }

    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, created_by_agent_id, workspace_id, business_id, due_date, workflow_template_id, brief, trigger_type, trigger_source, cron_job_id, mattermost_channel_id, mattermost_root_post_id, mattermost_source_post_id, mattermost_thread_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        validatedData.title,
        validatedData.description || null,
        status,
        validatedData.priority || 'normal',
        validatedData.assigned_agent_id || null,
        validatedData.created_by_agent_id || null,
        workspaceId,
        validatedData.business_id || 'default',
        validatedData.due_date || null,
        workflowTemplateId,
        validatedData.brief || null,
        validatedData.trigger_type || 'manual',
        validatedData.trigger_source || null,
        validatedData.cron_job_id || null,
        validatedData.mattermost_channel_id || null,
        validatedData.mattermost_root_post_id || null,
        validatedData.mattermost_source_post_id || null,
        validatedData.mattermost_thread_url || null,
        now,
        now,
      ]
    );

    for (const dependencyId of dependencyIds) {
      run(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
         VALUES (?, ?, ?)`,
        [id, dependencyId, now]
      );
    }

    // Log event
    let eventMessage = `New task: ${validatedData.title}`;
    if (validatedData.created_by_agent_id) {
      const creator = queryOne<Agent>('SELECT name FROM agents WHERE id = ?', [validatedData.created_by_agent_id]);
      if (creator) {
        eventMessage = `${creator.name} created task: ${validatedData.title}`;
      }
    }

    run(
      `INSERT INTO events (id, type, agent_id, task_id, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_created', body.created_by_agent_id || null, id, eventMessage, now]
    );

    // Fetch created task with all joined fields
    let task = queryOne<Task>(
      `SELECT t.*,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        ca.name as created_by_agent_name,
        ca.avatar_emoji as created_by_agent_emoji
       FROM tasks t
       LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
       LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
       WHERE t.id = ?`,
      [id]
    );
    
    // Auto-populate workflow roles from workspace agents
    populateTaskRolesFromAgents(id, workspaceId);

    // Close the race where every prerequisite completed before this dependent
    // task was created. Normal releases happen in PATCH /api/tasks/:id when
    // the final prerequisite reaches done.
    if (dependencyIds.length > 0) {
      const released = releaseReadyDependentTasks(dependencyIds[0])
        .some(releasedTask => releasedTask.id === id);

      if (released) {
        const missionControlUrl = getMissionControlUrl();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (process.env.MC_API_TOKEN) {
          headers.Authorization = `Bearer ${process.env.MC_API_TOKEN}`;
        }
        try {
          const dispatchRes = await fetch(
            `${missionControlUrl}/api/tasks/${id}/dispatch`,
            { method: 'POST', headers }
          );
          if (!dispatchRes.ok) {
            const errorText = await dispatchRes.text();
            run(
              'UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?',
              [`Dependency release dispatch failed (${dispatchRes.status}): ${errorText}`, new Date().toISOString(), id]
            );
          }
        } catch (err) {
          run(
            'UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?',
            [`Dependency release dispatch error: ${(err as Error).message}`, new Date().toISOString(), id]
          );
        }
        task = queryOne<Task>(
          `SELECT t.*,
            aa.name as assigned_agent_name,
            aa.avatar_emoji as assigned_agent_emoji,
            ca.name as created_by_agent_name,
            ca.avatar_emoji as created_by_agent_emoji
           FROM tasks t
           LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
           LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
           WHERE t.id = ?`,
          [id]
        );
      }
    }

    // Broadcast task creation via SSE
    if (task) {
      broadcast({
        type: 'task_created',
        payload: task,
      });
    }

    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    console.error('Failed to create task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}
