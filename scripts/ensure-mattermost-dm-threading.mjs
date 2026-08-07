#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const openclawDir = path.join(os.homedir(), '.openclaw');
const config = JSON.parse(fs.readFileSync(path.join(openclawDir, 'openclaw.json'), 'utf8'));
const mode = config?.channels?.mattermost?.accounts?.switch?.replyToMode;
if (mode !== 'all') throw new Error(`Switch Mattermost replyToMode must be "all"; got ${JSON.stringify(mode)}`);

const projectsDir = path.join(openclawDir, 'npm', 'projects');
const accountBundles = [];
for (const project of fs.readdirSync(projectsDir, { withFileTypes: true })) {
  if (!project.isDirectory() || !project.name.startsWith('openclaw-mattermost-')) continue;
  const dist = path.join(projectsDir, project.name, 'node_modules', '@openclaw', 'mattermost', 'dist');
  if (!fs.existsSync(dist)) continue;
  for (const name of fs.readdirSync(dist)) {
    if (/^accounts-.*\.js$/.test(name)) accountBundles.push(path.join(dist, name));
  }
}
if (accountBundles.length === 0) throw new Error('No installed Mattermost accounts bundle found');

const legacy = /\/\*\*\s*\n\* Resolve the effective replyToMode for a given chat type\.\s*\n\* Mattermost auto-threading only applies to channel and group messages\.\s*\n\*\/\s*\nfunction resolveMattermostReplyToMode\(account, kind\) \{\s*\n\s*if \(kind === "direct"\) return "off";\s*\n\s*return account\.config\.replyToMode \?\? "off";\s*\n\}/;
const hardened = `/** Resolve the effective replyToMode for every Mattermost chat type, including DMs. */\nfunction resolveMattermostReplyToMode(account, kind) {\n\treturn account.config.replyToMode ?? "off";\n}`;

let patched = 0;
for (const bundle of accountBundles) {
  const source = fs.readFileSync(bundle, 'utf8');
  if (source.includes('return account.config.replyToMode ?? "off";') && !source.includes('if (kind === "direct") return "off";')) continue;
  if (!legacy.test(source)) throw new Error(`Mattermost reply-mode implementation changed unexpectedly: ${bundle}`);
  fs.writeFileSync(bundle, source.replace(legacy, hardened));
  patched += 1;
}

console.log(`Mattermost DM threading verified (${accountBundles.length} bundle(s), ${patched} patched)`);
