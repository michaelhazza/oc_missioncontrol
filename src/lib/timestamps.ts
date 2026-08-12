import { parseDatabaseDate } from './dates';

/**
 * Parse timestamps read from Mission Control persistence.
 *
 * SQLite's datetime('now') returns UTC without a timezone designator. JavaScript
 * otherwise interprets that legacy shape as host-local time, so normalise only
 * that exact storage format to UTC. RFC 3339 values keep their explicit offset.
 */
export function parseStoredTimestamp(value: string): number {
  return parseDatabaseDate(value).getTime();
}

/** Canonical API representation without rewriting the stored audit value. */
export function normalizeStoredTimestamp(value: string): string {
  const parsed = parseDatabaseDate(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}
