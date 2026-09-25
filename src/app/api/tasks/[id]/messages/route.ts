import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import {
  broadcastTaskMessage,
  createTaskMessage,
  deliverTaskMessage,
  listTaskMessages,
} from '@/lib/task-chat';

export const dynamic = 'force-dynamic';

const MessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
  sender_type: z.enum(['human', 'agent', 'system']).optional().default('human'),
  sender_agent_id: z.string().uuid().nullable().optional(),
  sender_name: z.string().trim().min(1).max(100).optional(),
  idempotency_key: z.string().trim().min(8).max(200),
  retry: z.boolean().optional().default(false),
});

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const after = request.nextUrl.searchParams.get('after') || undefined;
  return NextResponse.json(listTaskMessages(params.id, after));
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const parsed = MessageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid message', details: parsed.error.issues }, { status: 400 });
  }
  try {
    const { content, sender_type, sender_agent_id, sender_name, idempotency_key, retry } = parsed.data;
    const result = createTaskMessage(params.id, {
      content,
      senderType: sender_type,
      senderAgentId: sender_agent_id,
      senderName: sender_name,
      idempotencyKey: idempotency_key,
      retry,
    });
    broadcastTaskMessage(result.message);
    const message = sender_type === 'human'
      ? await deliverTaskMessage(params.id, result.message.id)
      : result.message;
    return NextResponse.json(message, { status: result.created ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create message';
    const status = message === 'Task not found' ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
}
