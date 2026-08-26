import { createHmac } from 'node:crypto';

const retryableStatus = status => status === 429 || status >= 500;

export async function deliverIntakePayload(payload, config, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = deps.now || Date.now;
  const configuredAttempts = Number(config.deliveryAttempts ?? 3);
  const attempts = Number.isInteger(configuredAttempts) ? Math.min(5, Math.max(1, configuredAttempts)) : 3;
  const raw = JSON.stringify(payload);
  // Keep the signed envelope stable across retries so Mission Control sees the
  // same provider event and can safely deduplicate an ambiguous first attempt.
  const timestamp = String(Math.floor(now() / 1000));
  const signature = createHmac('sha256', config.secret).update(`${timestamp}.${raw}`).digest('hex');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mc-timestamp': timestamp,
          'x-mc-signature': `sha256=${signature}`,
        },
        body: raw,
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) return { ok: true, attempts: attempt };
      const detail = (await response.text()).slice(0, 300);
      if (!retryableStatus(response.status) || attempt === attempts) {
        return { ok: false, attempts: attempt, status: response.status, detail };
      }
    } catch (error) {
      if (attempt === attempts) {
        return { ok: false, attempts: attempt, error: error instanceof Error ? error.message : String(error) };
      }
    }
    await sleep(100 * 2 ** (attempt - 1));
  }
}
