/**
 * Parse timestamps returned by Mission Control's SQLite database.
 *
 * SQLite's datetime('now') returns UTC without a timezone designator
 * (for example, "2026-08-06 03:00:41"). JavaScript otherwise treats that
 * value as local time, which makes relative timestamps wrong by the local
 * UTC offset. Explicit ISO timestamps already carrying an offset are left
 * unchanged.
 */
export function parseDatabaseDate(value: string): Date {
  const sqliteUtcPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
  return new Date(sqliteUtcPattern.test(value) ? `${value.replace(' ', 'T')}Z` : value);
}
