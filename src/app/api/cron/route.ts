import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Cron } from 'croner';

export const dynamic = 'force-dynamic';

interface CronJob {
  id: string;
  expression: string;
  label?: string;
  description?: string;
  agentId?: string;
  enabled?: boolean;
  lastRun?: string;
  nextRun?: string;
}

interface CronCalendarEvent {
  id: string;
  type: 'cron';
  jobId: string;
  label: string;
  description: string | null;
  agentId: string | null;
  expression: string;
  date: string;
  time: string;
}

function normaliseExpression(expression: string): { expr: string; useDefault: boolean } {
  const parts = expression.trim().split(/\s+/);
  if (parts.length === 6) {
    // 6-field expression with leading seconds — strip the seconds field
    return { expr: parts.slice(1).join(' '), useDefault: false };
  }
  return { expr: expression, useDefault: false };
}

function computeMonthlyOccurrences(jobs: CronJob[], year: number, month: number): CronCalendarEvent[] {
  const monthStart = new Date(year, month - 1, 1, 0, 0, 0);
  const monthEnd = new Date(year, month, 1, 0, 0, 0);

  const events: CronCalendarEvent[] = [];

  for (const job of jobs) {
    try {
      const { expr } = normaliseExpression(job.expression);
      const cron = new Cron(expr, { legacyMode: false });
      let next = cron.nextRun(monthStart);

      while (next && next < monthEnd) {
        events.push({
          id: `${job.id}-${next.toISOString()}`,
          type: 'cron',
          jobId: job.id,
          label: job.label ?? job.id,
          description: job.description ?? null,
          agentId: job.agentId ?? null,
          expression: job.expression,
          date: next.toISOString().split('T')[0],
          time: next.toTimeString().slice(0, 5),
        });
        const previous = next;
        next = cron.nextRun(next);
        if (next && next.getTime() === previous.getTime()) break;
      }
    } catch (err) {
      console.warn(`Skipping cron job "${job.id}" — invalid expression "${job.expression}":`, err);
    }
  }

  return events;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const year = parseInt(searchParams.get('year') ?? String(new Date().getFullYear()));
  const month = parseInt(searchParams.get('month') ?? String(new Date().getMonth() + 1));

  const jobsPath = path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');

  let jobs: CronJob[] = [];
  try {
    const raw = await fs.readFile(jobsPath, 'utf-8');
    jobs = JSON.parse(raw);
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.debug('Cron jobs file not found at', jobsPath, '— returning empty list');
    } else {
      console.error('Failed to read cron jobs:', err);
    }
    return NextResponse.json({ events: [] });
  }

  const events = computeMonthlyOccurrences(jobs.filter(j => j.enabled !== false), year, month);
  return NextResponse.json({ events });
}
