import { parseTime, type LogRecord } from './analytics.ts';
import { analyzeRepeatUsage } from './retention.ts';

const DAY = 86_400_000;
export type Workweek = { from: string; to: string };

/** Use the calendar dates printed in the workbook, independently of the viewer's timezone. */
export function workweekOf(date: string): Workweek | null {
  if (!date || parseTime(date)?.date !== date) return null;
  const anchor = new Date(date + 'T00:00:00Z');
  const daysSinceMonday = (anchor.getUTCDay() + 6) % 7;
  const monday = anchor.getTime() - daysSinceMonday * DAY;
  return {
    from: new Date(monday).toISOString().slice(0, 10),
    to: new Date(monday + 4 * DAY).toISOString().slice(0, 10),
  };
}

export function importedWorkweeks(records: LogRecord[]): Workweek[] {
  const weeks = new Map<string, Workweek>();
  for (const date of new Set(records.map(record => record.date))) {
    const week = workweekOf(date);
    if (week) weeks.set(week.from, week);
  }
  return [...weeks.values()].sort((a, b) => b.from.localeCompare(a.from));
}

export function analyzeWeeklyUsage(records: LogRecord[], week: Workweek | null, scene: string) {
  // Reuse the report's first-seen Task IDs, scene matching and per-account distinct dates.
  const { users, observedDays } = analyzeRepeatUsage(records, week?.from ?? '', week?.to ?? '', scene);
  const userDays = users.reduce((sum, user) => sum + user.activeDays, 0);
  return { week, users, userDays, observedDays, mean: users.length ? userDays / users.length : null };
}
