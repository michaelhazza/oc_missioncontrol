/**
 * POST /api/content/generate-script
 *
 * Dispatches a script generation task to the OpenClaw gateway via the
 * agent-task helper. Replaces the previous direct LiteLLM call so that
 * script generation flows through the agent orchestration system.
 *
 * The content card shows a 'generating' state while the task is in
 * progress. When the agent completes, the webhook/SSE listener populates
 * the script into the content card automatically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { createAndDispatchAgentTask } from '@/lib/openclaw/agent-task';
import type { ContentItem } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, description, platform = 'youtube', notes, content_id, workspace_id } = body;

    if (!title) {
      return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    }

    const workspaceId = workspace_id || 'default';

    // Mark content item as generating if content_id provided
    if (content_id) {
      run(
        "UPDATE content_items SET generation_status = ?, updated_at = datetime('now') WHERE id = ?",
        ['generating', content_id],
      );

      const item = queryOne<ContentItem>('SELECT * FROM content_items WHERE id = ?', [content_id]);
      if (item) broadcast({ type: 'content_updated', payload: item });
    }

    // Build the agent task description
    const taskDescription = `You are a professional content creator. Write a complete, engaging script for the following piece of content.

Title: ${title}
Platform: ${platform}
${description ? `Description: ${description}` : ''}
${notes ? `Additional notes: ${notes}` : ''}

Write a full script with:
- A strong hook opening (first 15 seconds for video, or attention-grabbing first line)
- Clear sections/chapters
- Engaging storytelling
- A strong call to action at the end

Format the script clearly with section headers.

IMPORTANT: Return ONLY the script content in your response, followed by your TASK_COMPLETE marker.`;

    // Dispatch to gateway
    const result = await createAndDispatchAgentTask({
      title: `Generate script: ${title}`,
      description: taskDescription,
      workspaceId,
      priority: 'normal',
      metadata: {
        type: 'content_script_generation',
        content_id: content_id || null,
        platform,
      },
    });

    // Link the gateway task to the content item
    if (content_id && result.correlationId) {
      run(
        "UPDATE content_items SET gateway_task_id = ?, updated_at = datetime('now') WHERE id = ?",
        [result.correlationId, content_id],
      );
    }

    if (!result.success) {
      // Dispatch failed but task saved locally — mark content as failed
      if (content_id) {
        run(
          "UPDATE content_items SET generation_status = ?, updated_at = datetime('now') WHERE id = ?",
          ['failed', content_id],
        );
        const item = queryOne<ContentItem>('SELECT * FROM content_items WHERE id = ?', [content_id]);
        if (item) broadcast({ type: 'content_updated', payload: item });
      }

      return NextResponse.json({
        error: 'Script generation dispatched but gateway unreachable. Task saved for retry.',
        task_id: result.taskId,
        correlation_id: result.correlationId,
      }, { status: 202 });
    }

    return NextResponse.json({
      status: 'generating',
      message: 'Script generation task dispatched to agent',
      task_id: result.taskId,
      correlation_id: result.correlationId,
    });
  } catch (error) {
    console.error('POST /api/content/generate-script error:', error);
    return NextResponse.json({ error: 'Failed to dispatch script generation' }, { status: 500 });
  }
}
