/**
 * SOUL.md Frontmatter Parser
 *
 * Reads and parses YAML frontmatter from agent SOUL.md files on disk.
 * Uses gray-matter for parsing. Mission Control never writes back to SOUL.md.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import matter from 'gray-matter';

export interface FrontmatterResult {
  mc_role: 'orchestrator' | 'specialist' | 'monitor' | null;
  frontmatter_parse_error: number;
}

const VALID_ROLES = ['orchestrator', 'specialist', 'monitor'] as const;

/**
 * Read and parse SOUL.md frontmatter for a given agent.
 *
 * @param agentId - The agent's gateway ID (used as directory name under ~/.openclaw/workspace/agents/)
 * @returns Parsed role and error flag
 */
export function parseAgentFrontmatter(agentId: string): FrontmatterResult {
  const soulPath = path.join(
    os.homedir(),
    '.openclaw',
    'workspace',
    'agents',
    agentId,
    'SOUL.md',
  );

  let mcRole: string | null = null;
  let frontmatterParseError = 0;

  try {
    const fileContent = fs.readFileSync(soulPath, 'utf-8');
    const { data } = matter(fileContent);

    const rawRole = data?.mission_control?.role;
    mcRole = typeof rawRole === 'string' ? rawRole.toLowerCase() : null;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      // File doesn't exist — not an error, mcRole stays null
      return { mc_role: null, frontmatter_parse_error: 0 };
    }
    // Genuine parse failure (malformed YAML) — flag it
    frontmatterParseError = 1;
    return { mc_role: null, frontmatter_parse_error: frontmatterParseError };
  }

  // Validate role value
  if (mcRole && !VALID_ROLES.includes(mcRole as typeof VALID_ROLES[number])) {
    console.warn(`Agent ${agentId}: unrecognised mc_role value "${mcRole}" — storing as null`);
    mcRole = null;
  }

  return {
    mc_role: mcRole as FrontmatterResult['mc_role'],
    frontmatter_parse_error: frontmatterParseError,
  };
}

/**
 * Validate agent topology after discovery/import.
 * Returns warnings (not errors) — discovery completes regardless.
 */
export function validateAgentTopology(
  agents: Array<{ id: string; mc_role: string | null }>,
): string[] {
  const warnings: string[] = [];

  const orchestrators = agents.filter(a => a.mc_role === 'orchestrator');
  const monitors = agents.filter(a => a.mc_role === 'monitor');

  if (orchestrators.length === 0) {
    warnings.push(
      'No orchestrator found. Task completion reporting will not work until one agent has role: orchestrator in SOUL.md.',
    );
  } else if (orchestrators.length > 1) {
    warnings.push(
      `${orchestrators.length} orchestrators found (${orchestrators.map(a => a.id).join(', ')}). Expected exactly one.`,
    );
  }

  if (monitors.length === 0) {
    warnings.push(
      'No monitor found. Stale task detection will be disabled until one agent has role: monitor in SOUL.md.',
    );
  } else if (monitors.length > 1) {
    warnings.push(
      `${monitors.length} monitors found (${monitors.map(a => a.id).join(', ')}). Expected exactly one.`,
    );
  }

  return warnings;
}
