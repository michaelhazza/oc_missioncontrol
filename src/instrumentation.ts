/**
 * Next.js Instrumentation Hook
 *
 * Runs exactly once per process on startup. Initialises persistent
 * server-side singletons that must survive across requests:
 *
 * 1. Gateway client — shared WebSocket connection to OpenClaw
 * 2. Completion listener — processes agent completion events
 * 3. Retry queue — sweeps pending_sync tasks every 60s
 * 4. Monitor cron — detects stale tasks on configurable interval
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getOpenClawClient } = await import('./lib/openclaw/client');
    const { registerCompletionListener } = await import('./lib/openclaw/sync');
    const { startRetryQueue } = await import('./lib/openclaw/retry-queue');
    const { startMonitorCron } = await import('./lib/openclaw/monitor-cron');
    const { startTaskWatchdog } = await import('./lib/openclaw/task-watchdog');
    const { startCompletionController } = await import('./lib/openclaw/completion-controller');
    const { syncConfiguredAgents, reconcileAgentStatuses } = await import('./lib/openclaw/agent-registry');
    const { startOperatingFeatures } = await import('./lib/operating-features');

    // Initialise gateway connection (non-blocking — uses auto-reconnect)
    try {
      const client = getOpenClawClient();
      await client.connect();
      console.log('[Instrumentation] Gateway client connected');
      const synced = await syncConfiguredAgents(client);
      console.log(`[Instrumentation] Synced ${synced} configured agent identity record(s)`);
    } catch (err) {
      console.warn('[Instrumentation] Gateway client connection failed — will auto-reconnect:', err);
    }

    const reconciled = reconcileAgentStatuses();
    console.log(`[Instrumentation] Reconciled ${reconciled} agent status record(s)`);

    // Register WebSocket event listener for completions
    registerCompletionListener();

    // Start DB-backed retry queue (60s sweep)
    startRetryQueue();

    // Start monitor cron (interval from workspace_settings)
    startMonitorCron();

    // Resume stale Tank work every 30 minutes without duplicating live sessions.
    startTaskWatchdog();

    // Deterministic lifecycle governance. Disabled by default; rollout begins
    // with MISSION_CONTROL_COMPLETION_CONTROLLER=dry_run.
    startCompletionController();

    // Project decision/blocker/overdue exceptions continuously. Routine task
    // progress remains absent from this projection by construction.
    startOperatingFeatures();

    // Warn if OPENCLAW_WEBHOOK_SECRET is not set
    if (!process.env.OPENCLAW_WEBHOOK_SECRET) {
      console.warn('[Instrumentation] OPENCLAW_WEBHOOK_SECRET is not set. Webhook signature verification will be skipped.');
    }

    console.log('[Instrumentation] All server-side singletons initialised');
  }
}
