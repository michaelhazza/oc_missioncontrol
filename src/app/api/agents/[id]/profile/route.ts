import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { queryOne } from '@/lib/db';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

const WORKSPACE = path.join(process.env.HOME || '/Users/aiteam', '.openclaw', 'workspace');

/**
 * Resolve the filesystem directory for an agent's config files.
 * Switch (main) lives at workspace root; all others in workspace/agents/<gatewayId>/
 */
function agentDir(gatewayAgentId: string): string {
  if (gatewayAgentId === 'main') {
    return WORKSPACE;
  }
  return path.join(WORKSPACE, 'agents', gatewayAgentId);
}

function readFile(dir: string, filename: string): { content: string | null; exists: boolean } {
  const filepath = path.join(dir, filename);
  // Security: ensure resolved path stays within workspace
  const resolved = path.resolve(filepath);
  if (!resolved.startsWith(path.resolve(WORKSPACE))) {
    return { content: null, exists: false };
  }
  if (!fs.existsSync(filepath)) {
    return { content: null, exists: false };
  }
  try {
    return { content: fs.readFileSync(filepath, 'utf-8'), exists: true };
  } catch {
    return { content: null, exists: false };
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const agent = queryOne<Agent>(`SELECT * FROM agents WHERE id = ?`, [params.id]);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const gatewayId = agent.gateway_agent_id;
    if (!gatewayId) {
      return NextResponse.json({
        soul_md: null,
        user_md: null,
        agents_md: null,
        identity_md: null,
        error: 'Agent has no gateway_agent_id — cannot resolve filesystem path',
      });
    }

    const dir = agentDir(gatewayId);
    const dirExists = fs.existsSync(dir);

    const soul    = readFile(dir, 'SOUL.md');
    const user    = readFile(dir, 'USER.md');
    const agents  = readFile(dir, 'AGENTS.md');
    const identity = readFile(dir, 'IDENTITY.md');

    return NextResponse.json({
      gateway_agent_id: gatewayId,
      agent_dir: dir,
      dir_exists: dirExists,
      soul_md:    soul.content,
      soul_exists: soul.exists,
      user_md:    user.content,
      user_exists: user.exists,
      agents_md:  agents.content,
      agents_exists: agents.exists,
      identity_md: identity.content,
      identity_exists: identity.exists,
    });
  } catch (error) {
    console.error('GET /api/agents/[id]/profile error:', error);
    return NextResponse.json({ error: 'Failed to read agent profile' }, { status: 500 });
  }
}
