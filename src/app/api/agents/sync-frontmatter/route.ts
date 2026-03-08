import { NextResponse } from 'next/server';
import { queryAll, run } from '@/lib/db';
import { parseAgentFrontmatter, validateAgentTopology } from '@/lib/openclaw/frontmatter';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/agents/sync-frontmatter
 *
 * Re-reads SOUL.md frontmatter for all gateway-imported agents and updates
 * mc_role + frontmatter_parse_error in the database. Returns topology warnings.
 */
export async function POST() {
  try {
    const agents = queryAll<Agent>(
      `SELECT * FROM agents WHERE source = 'gateway' AND gateway_agent_id IS NOT NULL`,
    );

    const now = new Date().toISOString();
    const updated: { id: string; gateway_agent_id: string; mc_role: string | null }[] = [];

    for (const agent of agents) {
      if (!agent.gateway_agent_id) continue;

      const frontmatter = parseAgentFrontmatter(agent.gateway_agent_id);

      run(
        `UPDATE agents SET mc_role = ?, frontmatter_parse_error = ?, updated_at = ? WHERE id = ?`,
        [frontmatter.mc_role, frontmatter.frontmatter_parse_error, now, agent.id],
      );

      updated.push({
        id: agent.id,
        gateway_agent_id: agent.gateway_agent_id,
        mc_role: frontmatter.mc_role,
      });
    }

    const warnings = validateAgentTopology(updated);
    for (const w of warnings) {
      console.warn(`[Frontmatter sync] ${w}`);
    }

    return NextResponse.json({
      synced: updated.length,
      agents: updated,
      warnings,
    });
  } catch (error) {
    console.error('Failed to sync agent frontmatter:', error);
    return NextResponse.json(
      { error: 'Failed to sync agent frontmatter' },
      { status: 500 },
    );
  }
}
