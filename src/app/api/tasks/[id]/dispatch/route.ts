import { NextResponse } from 'next/server';

import { dispatchTaskToGateway } from '@/lib/openclaw/dispatch';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Dispatch exclusively through the durable execution service.
 *
 * Keeping a second inline gateway path here previously allowed PATCH-driven
 * and manual dispatches to mark tasks in progress without creating a fenced
 * execution lease. Oracle then had no safe checkpoint owner to resume.
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const { id } = await params;
  const result = await dispatchTaskToGateway(id);

  if (!result.success) {
    return NextResponse.json(
      { error: result.error || 'Dispatch failed', correlation_id: result.correlationId },
      { status: 503 },
    );
  }

  return NextResponse.json({
    success: true,
    task_id: id,
    correlation_id: result.correlationId,
    message: 'Task dispatched through durable execution supervision',
  });
}
