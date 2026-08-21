import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnoseBrowserReadiness, loadAllowlistedSource, parseClaudeEnvelope, REASONS, runBrowserReview, runClaudeReadOnlyReview } from '../scripts/review-gates.mjs';

test('allowlisted source is readable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-gate-'));
  const file = path.join(root, 'spec.md'); await writeFile(file, 'safe');
  assert.equal((await loadAllowlistedSource(file, [root])).content, 'safe');
});

test('out-of-root source fails closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-root-'));
  await assert.rejects(loadAllowlistedSource(import.meta.filename, [root]), (e) => e.reasonCode === REASONS.SOURCE_OUTSIDE_ALLOWLIST);
});

test('genuine terminal verdict is preserved', () => assert.equal(parseClaudeEnvelope('{"result":"VERDICT: READY\\nEvidence"}'), 'VERDICT: READY\nEvidence'));
test('tool activity or missing final verdict is rejected', () => assert.throws(() => parseClaudeEnvelope('{"result":"I inspected a file"}'), (e) => e.reasonCode === REASONS.REVIEW_MISSING_VERDICT));
test('malformed output is rejected', () => assert.throws(() => parseClaudeEnvelope('noise'), (e) => e.reasonCode === REASONS.REVIEW_MALFORMED_JSON));

test('browser exact profile ready', () => assert.deepEqual(diagnoseBrowserReadiness({profile:'user',running:true,cdpReady:true,pageReady:true}, 'user'), {ok:true,reasonCode:REASONS.BROWSER_READY,humanAction:'none'}));
test('profile mismatch never silently falls back', () => assert.equal(diagnoseBrowserReadiness({profile:'openclaw',running:true,cdpReady:true,pageReady:true}, 'user').reasonCode, REASONS.BROWSER_PROFILE_MISMATCH));
test('stopped browser is bounded-recoverable', () => assert.equal(diagnoseBrowserReadiness({profile:'user',running:false,cdpReady:false,pageReady:false}, 'user').reasonCode, REASONS.BROWSER_STOPPED));
test('stale page is separately diagnosed', () => assert.equal(diagnoseBrowserReadiness({profile:'user',running:true,cdpReady:true,pageReady:false}, 'user').reasonCode, REASONS.BROWSER_PAGE_NOT_READY));

test('Claude background invocation returns a genuine terminal verdict with no tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-claude-'));
  const source = path.join(root, 'spec.md');
  const invocation = path.join(root, 'invocation.json');
  const fakeClaude = path.join(root, 'claude');
  await writeFile(source, 'specification evidence');
  await writeFile(fakeClaude, `#!/bin/sh\nprintf '%s\\n' "$@" > '${invocation}'\nprintf '%s' '{"result":"VERDICT: READY\\nAllowed source inspected."}'\n`);
  await chmod(fakeClaude, 0o755);
  const result = await runClaudeReadOnlyReview({ source, roots: [root], prompt: 'Review', claudeBin: fakeClaude, timeoutMs: 2_000 });
  assert.match(result.verdict, /^VERDICT: READY/);
  assert.equal(result.permissionContract, 'no-tools/injected-allowlisted-source');
  const args = await import('node:fs/promises').then(({ readFile }) => readFile(invocation, 'utf8'));
  assert.match(args, /--permission-mode\ndontAsk/);
  assert.match(args, /--tools\n\n--/);
});

test('Claude disallowed source is blocked before any process launches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-blocked-'));
  const marker = path.join(root, 'launched');
  const fakeClaude = path.join(root, 'claude');
  await writeFile(fakeClaude, `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(fakeClaude, 0o755);
  await assert.rejects(
    runClaudeReadOnlyReview({ source: import.meta.filename, roots: [root], prompt: 'Review', claudeBin: fakeClaude }),
    (error) => error.reasonCode === REASONS.SOURCE_OUTSIDE_ALLOWLIST,
  );
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(marker)));
});

test('browser orchestration starts, rediscovers and reopens a stale project tab', async () => {
  const calls = [];
  let running = false;
  let probes = 0;
  const adapter = {
    findCompleted: async () => null,
    status: async () => ({ profile: 'user', running, cdpReady: running, pageReady: running }),
    start: async () => { calls.push('start'); running = true; },
    tabs: async () => { calls.push('tabs'); return [{ id: 'stale', title: 'Automation V1' }]; },
    discoverProject: async ({ tabs }) => tabs[0],
    openProject: async () => null,
    probe: async () => { probes += 1; return probes > 1; },
    reopen: async () => { calls.push('reopen'); },
    review: async () => ({ result: 'VERDICT: READY\nBrowser review complete.', url: 'https://chatgpt.test/project/review' }),
    preserve: async () => { calls.push('preserve'); },
  };
  const result = await runBrowserReview({ adapter, expectedProfile: 'user', projectName: 'Automation V1', prompt: 'Review', idempotencyKey: 'spec@abc', retryDelayMs: 0 });
  assert.match(result.verdict, /^VERDICT: READY/);
  assert.deepEqual(calls, ['start', 'tabs', 'reopen', 'tabs', 'preserve']);
  assert.equal(result.attempts, 2);
});

test('browser orchestration reuses a preserved terminal result idempotently', async () => {
  const adapter = { findCompleted: async () => ({ verdict: 'VERDICT: READY', url: 'saved' }) };
  const result = await runBrowserReview({ adapter, expectedProfile: 'user', projectName: 'Automation V1', prompt: 'Review', idempotencyKey: 'same' });
  assert.equal(result.reused, true);
  assert.equal(result.url, 'saved');
});

test('browser recovery is bounded and fails closed with a precise reason', async () => {
  let starts = 0;
  const adapter = {
    findCompleted: async () => null,
    status: async () => ({ profile: 'user', running: false, cdpReady: false, pageReady: false }),
    start: async () => { starts += 1; },
    tabs: async () => [], discoverProject: async () => null, openProject: async () => null,
  };
  await assert.rejects(
    runBrowserReview({ adapter, expectedProfile: 'user', projectName: 'Automation V1', prompt: 'Review', idempotencyKey: 'bounded', maxAttempts: 2, retryDelayMs: 0 }),
    (error) => error.reasonCode === REASONS.BROWSER_RECOVERY_EXHAUSTED && error.causeReasonCode === REASONS.BROWSER_PROJECT_NOT_FOUND,
  );
  assert.equal(starts, 2);
});
