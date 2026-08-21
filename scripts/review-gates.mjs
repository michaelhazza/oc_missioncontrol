import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const REASONS = Object.freeze({
  SOURCE_OUTSIDE_ALLOWLIST: 'SOURCE_OUTSIDE_ALLOWLIST',
  SOURCE_READ_FAILED: 'SOURCE_READ_FAILED',
  REVIEW_TIMEOUT: 'REVIEW_TIMEOUT',
  REVIEW_PROCESS_FAILED: 'REVIEW_PROCESS_FAILED',
  REVIEW_MALFORMED_JSON: 'REVIEW_MALFORMED_JSON',
  REVIEW_MISSING_VERDICT: 'REVIEW_MISSING_VERDICT',
  BROWSER_PROFILE_MISMATCH: 'BROWSER_PROFILE_MISMATCH',
  BROWSER_STOPPED: 'BROWSER_STOPPED',
  BROWSER_PAGE_NOT_READY: 'BROWSER_PAGE_NOT_READY',
  BROWSER_PROJECT_NOT_FOUND: 'BROWSER_PROJECT_NOT_FOUND',
  BROWSER_REVIEW_FAILED: 'BROWSER_REVIEW_FAILED',
  BROWSER_RECOVERY_EXHAUSTED: 'BROWSER_RECOVERY_EXHAUSTED',
  BROWSER_READY: 'BROWSER_READY',
});

export async function loadAllowlistedSource(source, roots) {
  let resolved;
  try { resolved = await realpath(source); } catch (cause) {
    throw Object.assign(new Error(REASONS.SOURCE_READ_FAILED), { reasonCode: REASONS.SOURCE_READ_FAILED, cause });
  }
  const allowed = await Promise.all(roots.map((root) => realpath(root)));
  if (!allowed.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw Object.assign(new Error(REASONS.SOURCE_OUTSIDE_ALLOWLIST), { reasonCode: REASONS.SOURCE_OUTSIDE_ALLOWLIST });
  }
  return { resolved, content: await readFile(resolved, 'utf8') };
}

export function parseClaudeEnvelope(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout); } catch (cause) {
    throw Object.assign(new Error(REASONS.REVIEW_MALFORMED_JSON), { reasonCode: REASONS.REVIEW_MALFORMED_JSON, cause });
  }
  const result = typeof envelope.result === 'string' ? envelope.result.trim() : '';
  if (!result || !/\bVERDICT\s*:/i.test(result)) {
    throw Object.assign(new Error(REASONS.REVIEW_MISSING_VERDICT), { reasonCode: REASONS.REVIEW_MISSING_VERDICT });
  }
  return result;
}

export async function runClaudeReadOnlyReview({ source, roots, prompt, claudeBin = 'claude', timeoutMs = 180_000 }) {
  const loaded = await loadAllowlistedSource(source, roots);
  const input = `${prompt}\n\n--- BEGIN ALLOWLISTED SOURCE: ${loaded.resolved} ---\n${loaded.content}\n--- END SOURCE ---`;
  // `--tools` is variadic in Claude CLI; `--` prevents it from consuming the prompt.
  const args = ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--tools', '', '--', input];
  const stdout = await new Promise((resolve, reject) => {
    execFile(claudeBin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, out, stderr) => {
      if (error) {
        const reasonCode = error.killed || error.signal === 'SIGTERM' ? REASONS.REVIEW_TIMEOUT : REASONS.REVIEW_PROCESS_FAILED;
        reject(Object.assign(new Error(`${reasonCode}: ${String(stderr).trim()}`), { reasonCode, cause: error }));
      } else resolve(out);
    });
  });
  return { verdict: parseClaudeEnvelope(stdout), source: loaded.resolved, permissionContract: 'no-tools/injected-allowlisted-source' };
}

export function diagnoseBrowserReadiness(status, expectedProfile) {
  if (!status || typeof status !== 'object') return { ok: false, reasonCode: REASONS.BROWSER_PAGE_NOT_READY, humanAction: 'inspect browser status response' };
  if (status.profile !== expectedProfile) return { ok: false, reasonCode: REASONS.BROWSER_PROFILE_MISMATCH, humanAction: `select configured profile ${expectedProfile}` };
  if (!status.running || !status.cdpReady) return { ok: false, reasonCode: REASONS.BROWSER_STOPPED, recoverable: true, humanAction: 'none; start managed backing profile once and retry' };
  if (!status.pageReady) return { ok: false, reasonCode: REASONS.BROWSER_PAGE_NOT_READY, recoverable: true, humanAction: 'none; reopen stale/closed tab once and retry' };
  return { ok: true, reasonCode: REASONS.BROWSER_READY, humanAction: 'none' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded, restart-safe browser-review orchestration. The adapter deliberately
 * owns browser-specific selectors; this function owns profile fidelity,
 * discovery, recovery, terminal-output validation and idempotency.
 */
export async function runBrowserReview({
  adapter,
  expectedProfile,
  projectName,
  prompt,
  maxAttempts = 3,
  retryDelayMs = 250,
  idempotencyKey,
}) {
  if (!adapter || !expectedProfile || !projectName || !idempotencyKey) {
    throw new TypeError('adapter, expectedProfile, projectName and idempotencyKey are required');
  }

  const existing = await adapter.findCompleted?.({ idempotencyKey });
  if (existing) return { ...existing, reused: true };

  let lastReason = REASONS.BROWSER_PAGE_NOT_READY;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let status = await adapter.status({ profile: expectedProfile });
    let readiness = diagnoseBrowserReadiness(status, expectedProfile);

    if (readiness.reasonCode === REASONS.BROWSER_PROFILE_MISMATCH) {
      throw Object.assign(new Error(readiness.reasonCode), readiness);
    }
    if (readiness.reasonCode === REASONS.BROWSER_STOPPED) {
      await adapter.start({ profile: expectedProfile });
      status = await adapter.status({ profile: expectedProfile });
      readiness = diagnoseBrowserReadiness(status, expectedProfile);
    }

    let tabs = await adapter.tabs({ profile: expectedProfile });
    let tab = await adapter.discoverProject({ tabs, projectName, profile: expectedProfile });
    if (!tab) {
      tab = await adapter.openProject({ projectName, profile: expectedProfile });
      tabs = await adapter.tabs({ profile: expectedProfile });
      tab = tab || await adapter.discoverProject({ tabs, projectName, profile: expectedProfile });
    }

    if (!tab) {
      lastReason = REASONS.BROWSER_PROJECT_NOT_FOUND;
    } else {
      const pageReady = await adapter.probe({ tab, profile: expectedProfile });
      if (!pageReady) {
        await adapter.reopen({ tab, projectName, profile: expectedProfile });
        lastReason = REASONS.BROWSER_PAGE_NOT_READY;
      } else {
        const output = await adapter.review({ tab, prompt, idempotencyKey, profile: expectedProfile });
        const result = typeof output?.result === 'string' ? output.result.trim() : '';
        if (result && /\bVERDICT\s*:/i.test(result)) {
          const completed = { verdict: result, url: output.url, idempotencyKey, attempts: attempt, reused: false };
          await adapter.preserve?.(completed);
          return completed;
        }
        lastReason = REASONS.BROWSER_REVIEW_FAILED;
      }
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }

  throw Object.assign(new Error(`${REASONS.BROWSER_RECOVERY_EXHAUSTED}: ${lastReason}`), {
    reasonCode: REASONS.BROWSER_RECOVERY_EXHAUSTED,
    causeReasonCode: lastReason,
    humanAction: lastReason === REASONS.BROWSER_PROJECT_NOT_FOUND
      ? `confirm the authenticated account contains the unambiguous ${projectName} Project`
      : 'inspect the managed browser session; login, 2FA or CAPTCHA only if visibly requested',
  });
}
