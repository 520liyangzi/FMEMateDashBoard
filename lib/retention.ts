import { isCountableClient, parseTime, type LogRecord } from './analytics.ts';

export type RetentionDay = {
  date: string;
  previousDate: string;
  windowStart: string;
  windowDays: number;
  observedWindowDays: number;
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
  windowDays: number;
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

/** Invalid follow-up lengths use one day, preserving existing reports. */
export function normalizeRetentionDays(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 3660 ? value : 1;
}

/** Baseline-day users observed at least once in the following N calendar days. */
export function analyzeRetention(records: LogRecord[], from: string, to: string, scene?: string, windowDays = 1): RetentionAnalysis {
  windowDays = normalizeRetentionDays(windowDays);
  const emptyIds = { previousClientIds: [], retainedClientIds: [], notObservedClientIds: [] };
  if (!validDate(from) || !validDate(to) || from > to) {
    return { windowDays, latest: {
      date: to, previousDate: validDate(to) ? calendarDate(stamp(to) - windowDays * DAY) : '',
      windowStart: validDate(to) ? calendarDate(stamp(to) - (windowDays - 1) * DAY) : '',
      windowDays, observedWindowDays: 0, previousUsers: 0, retainedUsers: 0, rate: null,
      previousBrowserUses: 0, currentBrowserUses: 0, status: 'invalid_range', ...emptyIds,
    }, daily: [], range: { from, to }, omittedDays: 0 };
  }
  const selectedDays = Math.round((stamp(to) - stamp(from)) / DAY) + 1;
  const omittedDays = Math.max(0, selectedDays - MAX_DAILY_DAYS);
  const firstEnd = stamp(from) + omittedDays * DAY;
  const coverage = new Set<string>();
  const activity = new Map<string, ActivityDay>();
  const seenTasks = new Set<string>();
  const earliestSourceDate = calendarDate(firstEnd - windowDays * DAY);
  for (const record of records) {
    const taskId = record.taskId.trim();
    if (seenTasks.has(taskId)) continue;
    seenTasks.add(taskId);
    if (!validDate(record.date) || record.date < earliestSourceDate || record.date > to) continue;
    coverage.add(record.date);
    if (!sceneMatches(record, scene)) continue;
    let day = activity.get(record.date);
    if (!day) { day = { users: new Set(), browserUses: 0 }; activity.set(record.date, day); }
    const clientId = record.clientId.trim();
    if (!isCountableClient(clientId)) day.browserUses++;
    else if (clientId) day.users.add(clientId);
  }
  // Slide a counted union rather than rescanning N dates for every daily cohort.
  const windowUsers = new Map<string, number>();
  let observedWindowDays = 0, currentBrowserUses = 0;
  const shift = (time: number, delta: number) => {
    const date = calendarDate(time), day = activity.get(date);
    if (coverage.has(date)) observedWindowDays += delta;
    currentBrowserUses += (day?.browserUses ?? 0) * delta;
    for (const id of day?.users ?? []) {
      const count = (windowUsers.get(id) ?? 0) + delta;
      if (count > 0) windowUsers.set(id, count); else windowUsers.delete(id);
    }
  };
  for (let i = 0; i < windowDays; i++) shift(firstEnd - i * DAY, 1);
  const describe = (end: number): RetentionAnalysis['latest'] => {
    const date = calendarDate(end), previousDate = calendarDate(end - windowDays * DAY);
    const previous = activity.get(previousDate);
    const previousClientIds = [...(previous?.users ?? [])].sort();
    const retainedClientIds = previousClientIds.filter(id => windowUsers.has(id));
    const notObservedClientIds = previousClientIds.filter(id => !windowUsers.has(id));
    const status: RetentionDay['status'] = !coverage.has(previousDate) ? 'missing_previous_logs'
      : observedWindowDays < windowDays ? 'missing_current_logs'
      : !previousClientIds.length ? 'no_previous_users' : 'available';
    return { date, previousDate, windowStart: calendarDate(end - (windowDays - 1) * DAY), windowDays, observedWindowDays,
      previousUsers: previousClientIds.length, retainedUsers: retainedClientIds.length,
      rate: status === 'available' ? retainedClientIds.length / previousClientIds.length * 100 : null,
      previousBrowserUses: previous?.browserUses ?? 0, currentBrowserUses,
      status, previousClientIds, retainedClientIds, notObservedClientIds };
  };
  const daily: RetentionDay[] = [];
  let latest = describe(firstEnd);
  for (let offset = omittedDays; offset < selectedDays; offset++) {
    const end = stamp(from) + offset * DAY;
    if (offset > omittedDays) { shift(end - windowDays * DAY, -1); shift(end, 1); }
    latest = describe(end);
    const { previousClientIds: _p, retainedClientIds: _r, notObservedClientIds: _n, ...day } = latest;
    daily.push(day);
  }
  return { windowDays, latest, daily, range: { from, to }, omittedDays };
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

export type RepeatMode = 'any' | 'consecutive';
export function normalizeRepeatMode(value: unknown): RepeatMode { return value === 'consecutive' ? 'consecutive' : 'any'; }

export type RepeatUsageAnalysis = {
  mode: RepeatMode;
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
export function analyzeRepeatUsage(records: LogRecord[], from: string, to: string, scene?: string, minimumActiveDays = DEFAULT_REPEAT_DAYS, mode: RepeatMode = 'any'): RepeatUsageAnalysis {
  minimumActiveDays = normalizeRepeatDays(minimumActiveDays);
  mode = normalizeRepeatMode(mode);
  if (!validDate(from) || !validDate(to) || from > to) {
    return { mode, minimumActiveDays, range: { from, to, days: 0 }, status: 'invalid_range', totalUsers: 0, repeatUsers: 0, rate: null, observedDays: 0, daysWithoutLogs: 0, users: [] };
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
  const repeatUsers = users.filter(user => (mode === 'consecutive' ? user.longestStreak : user.activeDays) >= minimumActiveDays).length;
  const status: RepeatUsageAnalysis['status'] = days === 1 ? 'single_day_range'
    : days < minimumActiveDays ? 'insufficient_period'
    : observed.size < minimumActiveDays ? 'insufficient_logs'
    : totalUsers === 0 ? 'no_identifiable_users'
    : 'available';
  return {
    mode, minimumActiveDays, range: { from, to, days }, status, totalUsers, repeatUsers,
    rate: status === 'available' ? repeatUsers / totalUsers * 100 : null,
    observedDays: observed.size, daysWithoutLogs: days - observed.size, users,
  };
}
