import { isCountableClient, parseTime, type LogRecord } from './analytics.ts';

export type RetentionDay = {
  date: string;
  previousDate: string;
  previousUsers: number;
  retainedUsers: number;
  /** Percentage in the range 0–100. Null means the rate is not observable. */
  rate: number | null;
  /** Browser activity in the selected scene; excluded from the identifiable cohorts. */
  previousBrowserUses: number;
  currentBrowserUses: number;
  status: 'available' | 'missing_previous_logs' | 'missing_current_logs' | 'no_previous_users' | 'invalid_range';
};

export type RetentionAnalysis = {
  latest: RetentionDay & {
    previousClientIds: string[];
    retainedClientIds: string[];
    /** Not observed in D's selected-scene logs; this does not establish churn. */
    notObservedClientIds: string[];
  };
  daily: RetentionDay[];
  range: { from: string; to: string };
  /** Earlier selected days omitted from daily; latest always represents `to`. */
  omittedDays: number;
};

const DAY = 86_400_000;
const MAX_DAILY_DAYS = 3660;
const stamp = (date: string) => Date.parse(`${date}T00:00:00Z`);
const calendarDate = (time: number) => new Date(time).toISOString().slice(0, 10);
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && parseTime(date)?.date === date;
/** Empty selector means all scenes; NUL is the UI's explicit empty-scene selector. */
const sceneMatches = (record: LogRecord, scene?: string) => !scene || (scene === '\u0000' ? !record.scene : record.scene === scene);

type ActivityDay = { users: Set<string>; browserUses: number };

/**
 * Exact next-calendar-day repeat-user retention, not a conversion metric.
 * Coverage is observed from all scenes; both cohorts use the selected scene.
 * Client IDs are trimmed defensively and remain case-sensitive (except browser).
 */
export function analyzeRetention(records: LogRecord[], from: string, to: string, scene?: string): RetentionAnalysis {
  const emptyIds = { previousClientIds: [], retainedClientIds: [], notObservedClientIds: [] };
  if (!validDate(from) || !validDate(to) || from > to) {
    return {
      latest: {
        date: to,
        previousDate: validDate(to) ? calendarDate(stamp(to) - DAY) : '',
        previousUsers: 0, retainedUsers: 0, rate: null,
        previousBrowserUses: 0, currentBrowserUses: 0,
        status: 'invalid_range', ...emptyIds,
      },
      daily: [], range: { from, to }, omittedDays: 0,
    };
  }

  const coverage = new Set<string>();
  const activity = new Map<string, ActivityDay>();
  const seenTasks = new Set<string>();
  const earliestSourceDate = calendarDate(stamp(from) - DAY);
  for (const record of records) {
    const taskId = record.taskId.trim();
    if (seenTasks.has(taskId)) continue;
    seenTasks.add(taskId);
    // Deduplicate the complete source before selecting dates or scenes.
    if (!validDate(record.date) || record.date < earliestSourceDate || record.date > to) continue;
    coverage.add(record.date);
    if (!sceneMatches(record, scene)) continue;
    let day = activity.get(record.date);
    if (!day) { day = { users: new Set(), browserUses: 0 }; activity.set(record.date, day); }
    const clientId = record.clientId.trim();
    if (!isCountableClient(clientId)) day.browserUses++;
    else if (clientId) day.users.add(clientId);
  }

  const describe = (date: string): RetentionAnalysis['latest'] => {
    const previousDate = calendarDate(stamp(date) - DAY);
    const previous = activity.get(previousDate);
    const current = activity.get(date);
    const previousClientIds = [...(previous?.users ?? [])].sort();
    const retainedClientIds = previousClientIds.filter(id => current?.users.has(id));
    const notObservedClientIds = previousClientIds.filter(id => !current?.users.has(id));
    const status: RetentionDay['status'] = !coverage.has(previousDate) ? 'missing_previous_logs'
      : !coverage.has(date) ? 'missing_current_logs'
      : !previousClientIds.length ? 'no_previous_users'
      : 'available';
    return {
      date, previousDate,
      previousUsers: previousClientIds.length,
      retainedUsers: retainedClientIds.length,
      rate: status === 'available' ? retainedClientIds.length / previousClientIds.length * 100 : null,
      previousBrowserUses: previous?.browserUses ?? 0,
      currentBrowserUses: current?.browserUses ?? 0,
      status, previousClientIds, retainedClientIds, notObservedClientIds,
    };
  };

  const selectedDays = Math.round((stamp(to) - stamp(from)) / DAY) + 1;
  const omittedDays = Math.max(0, selectedDays - MAX_DAILY_DAYS);
  const daily: RetentionDay[] = [];
  for (let offset = omittedDays; offset < selectedDays; offset++) {
    const { previousClientIds: _previous, retainedClientIds: _retained, notObservedClientIds: _notObserved, ...day } = describe(calendarDate(stamp(from) + offset * DAY));
    daily.push(day);
  }
  return { latest: describe(to), daily, range: { from, to }, omittedDays };
}

export type RepeatUsageUser = {
  clientId: string;
  activeDays: number;
  /** Observed active dates / selected calendar days × 100; not retention. */
  activeDayShare: number;
  longestStreak: number;
  firstDate: string;
  lastDate: string;
};

export const DEFAULT_REPEAT_DAYS = 3;
/** Whole-day thresholds from 2 to 3660 are supported; invalid values use the default. */
export function normalizeRepeatDays(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 2 && value <= 3660 ? value : DEFAULT_REPEAT_DAYS;
}

export type RepeatUsageAnalysis = {
  minimumActiveDays: number;
  range: { from: string; to: string; days: number };
  status: 'available' | 'single_day_range' | 'insufficient_period' | 'insufficient_logs' | 'no_identifiable_users' | 'invalid_range';
  totalUsers: number;
  repeatUsers: number;
  /** Users active on at least minimumActiveDays distinct dates / all identifiable users × 100. */
  rate: number | null;
  /** All-scene observed dates. Unobserved dates do not establish inactivity or missing imports. */
  observedDays: number;
  daysWithoutLogs: number;
  users: RepeatUsageUser[];
};

/** Multi-day repeat usage in one selected period, separate from next-day retention. */
export function analyzeRepeatUsage(records: LogRecord[], from: string, to: string, scene?: string, minimumActiveDays = DEFAULT_REPEAT_DAYS): RepeatUsageAnalysis {
  minimumActiveDays = normalizeRepeatDays(minimumActiveDays);
  if (!validDate(from) || !validDate(to) || from > to) {
    return { minimumActiveDays, range: { from, to, days: 0 }, status: 'invalid_range', totalUsers: 0, repeatUsers: 0, rate: null, observedDays: 0, daysWithoutLogs: 0, users: [] };
  }
  const days = Math.round((stamp(to) - stamp(from)) / DAY) + 1;
  const observed = new Set<string>();
  const activity = new Map<string, Set<string>>();
  const seenTasks = new Set<string>();
  for (const record of records) {
    const taskId = record.taskId.trim();
    if (seenTasks.has(taskId)) continue;
    seenTasks.add(taskId);
    if (!validDate(record.date) || record.date < from || record.date > to) continue;
    observed.add(record.date);
    if (!sceneMatches(record, scene)) continue;
    const clientId = record.clientId.trim();
    if (!clientId || !isCountableClient(clientId)) continue;
    let dates = activity.get(clientId);
    if (!dates) { dates = new Set(); activity.set(clientId, dates); }
    dates.add(record.date);
  }
  const users: RepeatUsageUser[] = [...activity].map(([clientId, active]) => {
    const dates = [...active].sort();
    let longestStreak = 1, streak = 1;
    for (let index = 1; index < dates.length; index++) {
      streak = stamp(dates[index]) - stamp(dates[index - 1]) === DAY ? streak + 1 : 1;
      longestStreak = Math.max(longestStreak, streak);
    }
    return { clientId, activeDays: dates.length, activeDayShare: dates.length / days * 100, longestStreak, firstDate: dates[0], lastDate: dates[dates.length - 1] };
  }).sort((a, b) => b.activeDays - a.activeDays || b.longestStreak - a.longestStreak || a.clientId.localeCompare(b.clientId));
  const totalUsers = users.length;
  const repeatUsers = users.filter(user => user.activeDays >= minimumActiveDays).length;
  const status: RepeatUsageAnalysis['status'] = days === 1 ? 'single_day_range'
    : days < minimumActiveDays ? 'insufficient_period'
    : observed.size < minimumActiveDays ? 'insufficient_logs'
    : totalUsers === 0 ? 'no_identifiable_users'
    : 'available';
  return {
    minimumActiveDays, range: { from, to, days }, status, totalUsers, repeatUsers,
    rate: status === 'available' ? repeatUsers / totalUsers * 100 : null,
    observedDays: observed.size, daysWithoutLogs: days - observed.size, users,
  };
}
