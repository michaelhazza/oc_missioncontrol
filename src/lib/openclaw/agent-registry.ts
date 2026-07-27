import fs from 'fs';
import os from 'os';
import path from 'path';
import { queryAll, run } from '@/lib/db';
import type { Agent } from '@/lib/types';
import type { OpenClawClient } from './client';

interface GatewayAgent {
  id?: string;
  name?: string;
  identity?: {
    name?: string;
    emoji?: string;
  };
}

interface WorkspaceIdentity {
  name?: string;
  role?: string;
  emoji?: string;
}

const EXECUTING_TASK_STATUSES = ['in_progress', 'testing', 'verification'];

function identityPath(gatewayAgentId: string): string {
  const workspace = path.join(os.homedir(), '.openclaw', 'workspace');
  return gatewayAgentId === 'main'
    ? path.join(workspace, 'IDENTITY.md')
    : path.join(workspace, 'agents', gatewayAgentId, 'IDENTITY.md');
}

function readWorkspaceIdentity(gatewayAgentId: string): WorkspaceIdentity {
  try {
    const content = fs.readFileSync(identityPath(gatewayAgentId), 'utf8');
    const field = (name: string) => {
      const match = content.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'mi'));
      return match?.[1]?.trim();
    };
    return {
      name: field('Name'),
      role: field('Role'),
      emoji: field('Emoji'),
    };
  } catch {
    return {};
  }
}

/**
 * Refresh imported Mission Control agents from OpenClaw's configured registry.
 * Identity files/configuration remain authoritative; Mission Control only
 * stores a local projection for joins and historical records.
 */
export async function syncConfiguredAgents(client: OpenClawClient): Promise<number> {
  const gatewayAgents = await client.listAgents() as GatewayAgent[];
  const imported = queryAll<Agent>(
    'SELECT * FROM agents WHERE gateway_agent_id IS NOT NULL',
  );
  const localByGatewayId = new Map(imported.map(agent => [agent.gateway_agent_id, agent]));
  const now = new Date().toISOString();
  let updated = 0;

  for (const gatewayAgent of gatewayAgents) {
    const gatewayId = gatewayAgent.id;
    if (!gatewayId) continue;
    const local = localByGatewayId.get(gatewayId);
    if (!local) continue;

    const fileIdentity = readWorkspaceIdentity(gatewayId);
    const name = gatewayAgent.identity?.name || fileIdentity.name || gatewayAgent.name || local.name;
    const role = fileIdentity.role || local.role;
    // IDENTITY.md is the human-maintained source for persona metadata. It also
    // avoids propagating legacy mojibake such as "????" from old config writes.
    const emoji = fileIdentity.emoji || gatewayAgent.identity?.emoji || local.avatar_emoji;

    if (name !== local.name || role !== local.role || emoji !== local.avatar_emoji) {
      run(
        'UPDATE agents SET name = ?, role = ?, avatar_emoji = ?, updated_at = ? WHERE id = ?',
        [name, role, emoji, now, local.id],
      );
      updated += 1;
    }
  }

  return updated;
}

/**
 * Agent activity is derived from Mission Control task state, not a sticky flag.
 * This prevents agents remaining "working" after tasks are closed out-of-band.
 */
export function reconcileAgentStatuses(workspaceId?: string): number {
  const agents = queryAll<Agent>(
    workspaceId
      ? 'SELECT * FROM agents WHERE workspace_id = ?'
      : 'SELECT * FROM agents',
    workspaceId ? [workspaceId] : [],
  );
  const now = new Date().toISOString();
  let updated = 0;

  for (const agent of agents) {
    const placeholders = EXECUTING_TASK_STATUSES.map(() => '?').join(', ');
    const active = queryAll<{ id: string }>(
      `SELECT id FROM tasks
       WHERE assigned_agent_id = ? AND status IN (${placeholders})
       LIMIT 1`,
      [agent.id, ...EXECUTING_TASK_STATUSES],
    ).length > 0;
    const status = active ? 'working' : 'standby';

    if (agent.status !== status) {
      run('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?', [status, now, agent.id]);
      updated += 1;
    }
  }

  return updated;
}
