/**
 * GET /api/workspace-settings?workspace_id=xxx
 * POST /api/workspace-settings
 *
 * CRUD for per-workspace integration settings (gateway URL, webhook secret,
 * polling interval, state mapping, max retry count).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getWorkspaceSettings, upsertWorkspaceSettings } from '@/lib/openclaw/workspace-settings';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspace_id');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
  }

  try {
    const settings = getWorkspaceSettings(workspaceId);
    return NextResponse.json(settings);
  } catch (error) {
    console.error('[workspace-settings] GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workspace_id, ...updates } = body;

    if (!workspace_id) {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }

    const settings = upsertWorkspaceSettings(workspace_id, updates);
    return NextResponse.json(settings);
  } catch (error) {
    console.error('[workspace-settings] POST error:', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
