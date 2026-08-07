# Dev Brief: Calendar ↔ OpenClaw Cron Integration

**Date:** 2026-03-08  
**Feature:** Show recurring cron jobs on the Mission Control Calendar  
**Scope:** Read-only display + optional create/toggle from calendar UI  

---

## Context

The Mission Control Calendar (`/workspace/[slug]/calendar/page.tsx`) currently shows tasks from the SQLite DB that have a `due_date`. It already has the cron event type defined (`type: 'cron'`, `color: 'bg-orange-400/70'`) but never fetches real cron data.

OpenClaw exposes cron jobs via its Gateway API (WebSocket/RPC). The CLI uses this internally. The job store lives at `~/.openclaw/cron/jobs.json`.

---

## Goal

Display OpenClaw cron jobs on the Mission Control calendar as recurring events, so Michael has a single place to see what's scheduled and when it next fires — alongside tasks.

---

## Approach: Proxy API Route

**Do NOT** call the OpenClaw Gateway directly from the browser (auth token would be exposed client-side).

Instead: create a Next.js API route that calls the Gateway on the server side and returns normalised cron data.

---

## Step 1 — Create API Route `/api/cron`

**File:** `src/app/api/cron/route.ts`

```typescript
import { NextResponse } from 'next/server';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

export async function GET() {
  try {
    // OpenClaw Gateway exposes cron jobs at this endpoint
    // Auth via Bearer token from environment
    const res = await fetch(`${GATEWAY_URL}/api/cron/jobs`, {
      headers: {
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      // Server-side only — no CORS issue
    });

    if (!res.ok) {
      // Fallback: read jobs.json directly from filesystem
      return await readJobsFromFilesystem();
    }

    const data = await res.json();
    return NextResponse.json(normaliseCronJobs(data));
  } catch {
    // Fallback: read from filesystem if Gateway not reachable
    return await readJobsFromFilesystem();
  }
}

async function readJobsFromFilesystem() {
  try {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    
    const jobsPath = path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');
    const raw = await fs.readFile(jobsPath, 'utf-8');
    const data = JSON.parse(raw);
    return NextResponse.json(normaliseCronJobs(data));
  } catch {
    return NextResponse.json([]);
  }
}

// Normalise cron job records into calendar-friendly shape
function normaliseCronJobs(data: any): NormalisedCronJob[] {
  const jobs = Array.isArray(data) ? data : (data.jobs || []);
  
  return jobs
    .filter((job: any) => job.enabled !== false) // skip disabled jobs
    .map((job: any) => ({
      id: job.jobId || job.id,
      name: job.name || 'Unnamed Job',
      description: job.description || '',
      schedule: job.schedule,
      agentId: job.agentId || null,
      enabled: job.enabled !== false,
      nextRun: job.nextRun || null,
      lastRun: job.lastRun || null,
      sessionTarget: job.sessionTarget || 'isolated',
      // Compute human-readable schedule string
      scheduleLabel: getScheduleLabel(job.schedule),
      // Compute which days of the month this fires (for calendar display)
      occurrences: getMonthOccurrences(job.schedule),
    }));
}

interface NormalisedCronJob {
  id: string;
  name: string;
  description: string;
  schedule: any;
  agentId: string | null;
  enabled: boolean;
  nextRun: string | null;
  lastRun: string | null;
  sessionTarget: string;
  scheduleLabel: string;
  occurrences: string[]; // ISO date strings (YYYY-MM-DD) for current month
}

function getScheduleLabel(schedule: any): string {
  if (!schedule) return 'Unknown';
  if (schedule.kind === 'at') return `Once: ${new Date(schedule.at).toLocaleString()}`;
  if (schedule.kind === 'every') {
    const mins = Math.round(schedule.everyMs / 60000);
    return mins < 60 ? `Every ${mins}m` : `Every ${Math.round(mins / 60)}h`;
  }
  if (schedule.kind === 'cron') return `Cron: ${schedule.expr}`;
  return 'Scheduled';
}

function getMonthOccurrences(schedule: any): string[] {
  if (!schedule) return [];
  
  if (schedule.kind === 'at') {
    const d = new Date(schedule.at);
    return [d.toISOString().split('T')[0]];
  }
  
  if (schedule.kind === 'cron') {
    // Parse cron expression to find firing days this month
    // Use a lightweight cron parser — see note below
    return parseCronOccurrences(schedule.expr, schedule.tz);
  }
  
  if (schedule.kind === 'every') {
    // For interval jobs, mark all days (fires multiple times daily)
    return getAllDaysThisMonth();
  }
  
  return [];
}
```

> **Note on cron parsing:** To compute which calendar days a cron expression fires on, install `croner` (already used by OpenClaw internally):
> ```bash
> npm install croner
> ```
> Then use `Cron` from `croner` to iterate occurrences for the current month.

### Cron occurrence parser using `croner`:

```typescript
import { Cron } from 'croner';

function parseCronOccurrences(expr: string, tz?: string): string[] {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    const job = new Cron(expr, { timezone: tz || undefined, startAt: startOfMonth });
    const dates = new Set<string>();
    
    let next = job.nextRun();
    let limit = 200; // safety cap
    
    while (next && next <= endOfMonth && limit-- > 0) {
      dates.add(next.toISOString().split('T')[0]);
      next = job.nextRun();
    }
    
    return Array.from(dates);
  } catch {
    return [];
  }
}

function getAllDaysThisMonth(): string[] {
  const now = new Date();
  const days: string[] = [];
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return days;
}
```

---

## Step 2 — Environment Variables

Add to `.env.local` (already exists in Mission Control):

```env
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=ea5702b4d3ac1bcb31eb3af711361ec011e93ecd86fbb0f8
```

---

## Step 3 — Update Calendar Page

**File:** `src/app/workspace/[slug]/calendar/page.tsx`

### Add cron fetch to `loadData`:

```typescript
// Add CronJob type
interface CronJob {
  id: string;
  name: string;
  description: string;
  scheduleLabel: string;
  agentId: string | null;
  nextRun: string | null;
  occurrences: string[]; // YYYY-MM-DD strings
}

// Inside loadData(), update the Promise.all:
const [tasksRes, cronRes] = await Promise.all([
  fetch(`/api/tasks?workspace_id=${workspaceId}`),
  fetch('/api/cron'),
]);

// After existing task mapping, add:
if (cronRes.ok) {
  const cronJobs: CronJob[] = await cronRes.json();
  for (const job of cronJobs) {
    for (const dateStr of job.occurrences) {
      allEvents.push({
        id: `cron-${job.id}-${dateStr}`,
        title: job.name,
        date: new Date(dateStr + 'T00:00:00'), // avoid timezone shift
        type: 'cron',
        status: 'cron',
        color: STATUS_COLORS['cron'],
        // Pass extra info for detail panel
        meta: {
          scheduleLabel: job.scheduleLabel,
          agentId: job.agentId,
          nextRun: job.nextRun,
        },
      });
    }
  }
}
```

### Update CalendarEvent type:

```typescript
interface CalendarEvent {
  id: string;
  title: string;
  date: Date;
  type: 'task' | 'cron';
  status?: string;
  color: string;
  meta?: {
    scheduleLabel?: string;
    agentId?: string | null;
    nextRun?: string | null;
  };
}
```

### Update the day detail panel to show cron info:

In the selected day panel, differentiate cron events:

```tsx
{selectedDayEvents.map(event => (
  <div key={event.id} className="flex items-start gap-3 text-sm">
    {event.type === 'task' ? (
      <CheckSquare className="w-4 h-4 text-mc-accent shrink-0 mt-0.5" />
    ) : (
      <Clock className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
    )}
    <div className="flex-1 min-w-0">
      <span className="text-mc-text">{event.title}</span>
      {event.type === 'cron' && event.meta?.scheduleLabel && (
        <p className="text-xs text-mc-text-secondary mt-0.5">{event.meta.scheduleLabel}</p>
      )}
      {event.type === 'cron' && event.meta?.agentId && (
        <p className="text-xs text-orange-400/70 mt-0.5">→ {event.meta.agentId}</p>
      )}
    </div>
    <span className={`text-xs px-2 py-0.5 rounded-full text-white shrink-0 ${event.color}`}>
      {event.type === 'cron' ? 'cron' : event.status}
    </span>
  </div>
))}
```

### Add cron to the legend:

The `STATUS_COLORS['cron']` is already defined. Make sure "cron" appears in the legend slice:

```tsx
// Change slice(0, 6) to include cron explicitly:
{['done', 'in_progress', 'review', 'assigned', 'inbox', 'cron'].map(status => (
  <div key={status} className="flex items-center gap-1.5">
    <div className={`w-2.5 h-2.5 rounded-full ${STATUS_COLORS[status]}`} />
    <span className="text-xs text-mc-text-secondary capitalize">{status.replace('_', ' ')}</span>
  </div>
))}
```

---

## Step 4 — Handle Month Navigation

When Michael navigates to a different month, the cron occurrences need to be re-fetched for that month. Pass the month to the API:

```
GET /api/cron?year=2026&month=4
```

Update the API route to accept `?year=&month=` params and compute occurrences for that month range instead of the current month.

Update `loadData` to pass `currentMonth`:

```typescript
fetch(`/api/cron?year=${currentMonth.getFullYear()}&month=${currentMonth.getMonth() + 1}`)
```

---

## Step 5 — Tooltip / Hover Detail (Optional Enhancement)

For a cleaner UX, add a tooltip on cron events showing:
- Schedule expression (e.g., "Every Monday at 8:00 AM AEST")
- Target agent
- Next scheduled run timestamp

Use a simple `title` attribute first; upgrade to a Radix tooltip component if desired.

---

## File Summary

| File | Action |
|---|---|
| `src/app/api/cron/route.ts` | **Create** — server-side proxy to Gateway + filesystem fallback |
| `src/app/workspace/[slug]/calendar/page.tsx` | **Edit** — fetch cron, merge into events, update UI |
| `.env.local` | **Edit** — add `OPENCLAW_GATEWAY_URL` + `OPENCLAW_GATEWAY_TOKEN` |
| `package.json` | **Edit** — add `croner` dependency |

---

## Notes for Claude Code

1. **Try the filesystem fallback first** — `~/.openclaw/cron/jobs.json` is the simplest path and doesn't require figuring out the Gateway's internal API surface. If the file is readable, use it; only hit the Gateway HTTP endpoint if you can confirm the route.

2. **`croner` is already in OpenClaw's stack** — safe to install as a direct dependency in Mission Control. It handles 5-field and 6-field cron expressions and IANA timezones.

3. **Don't mutate cron jobs from the calendar** — read-only for now. The OpenClaw control UI at `localhost:18789/cron` is the management surface. We may add create/toggle later.

4. **Timezone:** Cron jobs store IANA timezone in `schedule.tz`. Render event dates in that timezone when displaying times, but for calendar day placement use local date only.

5. **Colour:** Orange (`bg-orange-400/70`) is already in the codebase for cron — use it consistently.
