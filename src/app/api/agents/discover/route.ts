import { NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { parseAgentFrontmatter, validateAgentTopology } from '@/lib/openclaw/frontmatter';
import type { Agent, DiscoveredAgent } from '@/lib/types';

// This route must always be dynamic - it queries live Gateway state + DB
export const dynamic = 'force-dynamic';

// Shape of an agent returned by the OpenClaw Gateway `agents.list` call
interface GatewayAgent {
  id?: string;
  name?: string;
  label?: string;
  identity?: {
    name?: string;
    emoji?: string;
  };
  model?: string;
  channel?: string;
  status?: string;
  [key: string]: unknown;
}

// GET /api/agents/discover - Discover existing agents from the OpenClaw Gateway
export async function GET() {
  try {
    const client = getOpenClawClient();

    if (!client.isConnected()) {
      try {
        await client.connect();
      } catch {
        return NextResponse.json(
          { error: 'Failed to connect to OpenClaw Gateway. Is it running?' },
          { status: 503 }
        );
      }
    }

    let gatewayAgents: GatewayAgent[];
    try {
      gatewayAgents = (await client.listAgents()) as GatewayAgent[];
    } catch (err) {
      console.error('Failed to list agents from Gateway:', err);
      return NextResponse.json(
        { error: 'Failed to list agents from OpenClaw Gateway' },
        { status: 502 }
      );
    }

    if (!Array.isArray(gatewayAgents)) {
      return NextResponse.json(
        { error: 'Unexpected response from Gateway agents.list' },
        { status: 502 }
      );
    }

    // Get all agents already imported from the gateway
    const existingAgents = queryAll<Agent>(
      `SELECT * FROM agents WHERE gateway_agent_id IS NOT NULL`
    );
    const importedGatewayIds = new Map(
      existingAgents.map((a) => [a.gateway_agent_id, a.id])
    );

    // Map gateway agents to our DiscoveredAgent type, with frontmatter info
    const discovered: (DiscoveredAgent & { mc_role?: string | null; frontmatter_parse_error?: number })[] = gatewayAgents.map((ga) => {
      const gatewayId = ga.id || ga.name || '';
      const alreadyImported = importedGatewayIds.has(gatewayId);
      const frontmatter = parseAgentFrontmatter(gatewayId);
      return {
        id: gatewayId,
        name: ga.identity?.name || ga.name || ga.label || gatewayId,
        label: ga.label,
        model: ga.model,
        channel: ga.channel,
        status: ga.status,
        already_imported: alreadyImported,
        existing_agent_id: alreadyImported ? importedGatewayIds.get(gatewayId) : undefined,
        mc_role: frontmatter.mc_role,
        frontmatter_parse_error: frontmatter.frontmatter_parse_error,
      };
    });

    // Validate topology and surface warnings
    const warnings = validateAgentTopology(
      discovered.map(a => ({ id: a.id, mc_role: a.mc_role ?? null })),
    );
    for (const w of warnings) {
      console.warn(`[Agent discovery] ${w}`);
    }

    return NextResponse.json({
      agents: discovered,
      total: discovered.length,
      already_imported: discovered.filter((a) => a.already_imported).length,
      warnings,
    });
  } catch (error) {
    console.error('Failed to discover agents:', error);
    return NextResponse.json(
      { error: 'Failed to discover agents from Gateway' },
      { status: 500 }
    );
  }
}
