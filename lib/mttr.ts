/** Filtered, valid work items: closed tickets in legacy data; matched FINISHED Jobs in V3. */
export type MttrDay = { date: string; count: number; totalSeconds: number };
export type MttrPersonDay = MttrDay & { assignee: string };
export type MttrColumnMapping = {B:string;F:string;J:string;S:string;U:string};
export type MttrTtMapping = { ttId: string; category: string };
export type MttrJobMapping = { jobId: string; ttId: string; created: string; finished: string; assignee: string; status: string };
/** A caller may supply one mapping while retaining defaults for the other source. */
export type MttrPairMappings = { tt?: MttrTtMapping; job?: MttrJobMapping };
export type MttrSourceInfo = {
  filename: string; sheetName: string; importedAt: string; sourceRows: number;
};
export type MttrSources = {
  tt: MttrSourceInfo & { matchedRows: number; uniqueIds: number; duplicates: number; missingIds: number };
  job: MttrSourceInfo & {
    statusMatches: number; validRows: number; invalidDates: number; negativeDurations: number;
    missingIds: number; duplicates: number; addedRows: number; unmatchedTt: number; missingAssignee: number;
  };
};
export type MttrDataset = {
  /** Canonical roles (ID/create/close/status/category) mapped to actual workbook columns. */
  columnMapping?: MttrColumnMapping;
  /** V2 counts refer to the latest file; days/totalTickets cover all unique saved ticket IDs. */
  formatVersion?: 2 | 3;
  /** V3 durations/counts are FINISHED Jobs joined to the filtered TT ID set. */
  totalJobs?: number;
  storedJobs?: number;
  storedTtIds?: number;
  personDays?: MttrPersonDay[];
  sources?: MttrSources;
  mappings?: { tt: MttrTtMapping; job: MttrJobMapping };
  sourceHeaders?: { tt: Record<string, string>; job: Record<string, string> };
  totalTickets?: number;
  addedRows?: number;
  duplicateRows?: number;
  missingIds?: number;
  sheetName?: string;
  headerColumns?: Record<string,string>;
  diagnostics?: {categoryMatches:number;statusMatches:number};
  filename: string;
  importedAt: string;
  sourceRows: number;
  matchedRows: number;
  validRows: number;
  invalidDates: number;
  negativeDurations: number;
  excludedRows: number;
  days: MttrDay[];
  earliestDate: string;
  latestDate: string;
};
export type MttrPeriod = { from: string; to: string };
export type MttrAggregate = MttrPeriod & {
  /** Inclusive calendar dates in the selected period. */
  days: number;
  count: number;
  totalSeconds: number;
  meanSeconds: number | null;
};
export type MttrStatus = 'available' | 'no_dataset' | 'invalid_range' | 'no_baseline_tickets' | 'no_current_tickets' | 'zero_baseline';
export type MttrComparison = {
  baseline: MttrAggregate;
  current: MttrAggregate;
  /** (Baseline mean − current mean) / baseline mean × 100. Positive means shorter. */
  reductionRate: number | null;
  /** Baseline mean − current mean, in seconds per work item. */
  savedSeconds: number | null;
  status: MttrStatus;
  overlap: boolean;
  unequalDays: boolean;
};

const DAY = 86_400_000;
function stamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return NaN;
  const time = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}
export function isValidMttrPeriod(period: MttrPeriod): boolean {
  return !!period && Number.isFinite(stamp(period.from)) && Number.isFinite(stamp(period.to)) && period.from <= period.to;
}
function calendarDate(time: number): string | null {
  if (!Number.isFinite(time)) return null;
  const date = new Date(time).toISOString().slice(0, 10);
  return Number.isFinite(stamp(date)) ? date : null;
}
/** Move both ends by one inclusive period, without local timezone/DST arithmetic. */
export function shiftMttrPeriod(period: MttrPeriod, direction: -1 | 1): MttrPeriod | null {
  if (!isValidMttrPeriod(period) || (direction !== -1 && direction !== 1)) return null;
  const length = Math.round((stamp(period.to) - stamp(period.from)) / DAY) + 1;
  const from = calendarDate(stamp(period.from) + direction * length * DAY);
  const to = calendarDate(stamp(period.to) + direction * length * DAY);
  return from && to ? { from, to } : null;
}
export function previousMttrPeriod(period: MttrPeriod): MttrPeriod | null {
  return shiftMttrPeriod(period, -1);
}
function aggregate(dataset: MttrDataset | null, period: MttrPeriod, assignee?: string): MttrAggregate {
  const result: MttrAggregate = { ...period, days: 0, count: 0, totalSeconds: 0, meanSeconds: null };
  if (!isValidMttrPeriod(period)) return result;
  result.days = Math.round((stamp(period.to) - stamp(period.from)) / DAY) + 1;
  const source = assignee === undefined ? dataset?.days ?? [] : (dataset?.personDays ?? []).filter(day => day.assignee === assignee);
  for (const day of source) {
    if (!Number.isFinite(stamp(day.date)) || day.date < period.from || day.date > period.to ||
        !Number.isSafeInteger(day.count) || day.count <= 0 || !Number.isFinite(day.totalSeconds) || day.totalSeconds < 0) continue;
    result.count += day.count;
    result.totalSeconds += day.totalSeconds;
  }
  if (result.count > 0) result.meanSeconds = result.totalSeconds / result.count;
  return result;
}
/**
 * Overall arithmetic mean by finish/close date, weighted by work-item count, not date.
 * Missing dates contribute no items; absence of items is not a zero-hour MTTR.
 * Comparing these means alone does not establish a causal project improvement.
 */
export function compareMttr(dataset: MttrDataset | null, baselinePeriod: MttrPeriod, currentPeriod: MttrPeriod, assignee?: string): MttrComparison {
  const baseline = aggregate(dataset, baselinePeriod, assignee), current = aggregate(dataset, currentPeriod, assignee);
  const valid = isValidMttrPeriod(baselinePeriod) && isValidMttrPeriod(currentPeriod);
  const overlap = valid && baseline.from <= current.to && current.from <= baseline.to;
  const unequalDays = valid && baseline.days !== current.days;
  const savedSeconds = valid && baseline.meanSeconds !== null && current.meanSeconds !== null
    ? baseline.meanSeconds - current.meanSeconds : null;
  const status: MttrStatus = !valid ? 'invalid_range' : !dataset ? 'no_dataset' : !baseline.count ? 'no_baseline_tickets'
    : !current.count ? 'no_current_tickets' : baseline.meanSeconds === 0 ? 'zero_baseline' : 'available';
  return {
    baseline, current, savedSeconds, status, overlap, unequalDays,
    reductionRate: status === 'available' ? savedSeconds! / baseline.meanSeconds! * 100 : null,
  };
}

export type MttrPersonComparison = { assignee: string; comparison: MttrComparison; rank: number | null };
/**
 * Rank observed assignees by their own signed reduction, never average their
 * percentages into the overall MTTR. Missing-period, zero-baseline, unassigned,
 * and below-minimum samples remain visible, but do not receive a rank.
 * Ties share a competition rank (1, 1, 3). Unavailable rows sort by assignee.
 */
export function analyzeMttrPeople(dataset: MttrDataset | null, baseline: MttrPeriod, current: MttrPeriod, minimumCount = 1): MttrPersonComparison[] {
  const minimum = Number.isSafeInteger(minimumCount) && minimumCount >= 1 ? minimumCount : 1;
  const groups = new Map<string, MttrDay[]>();
  for (const day of dataset?.personDays ?? []) {
    if (typeof day.assignee !== 'string') continue;
    let days = groups.get(day.assignee);
    if (!days) { days = []; groups.set(day.assignee, days); }
    days.push(day);
  }
  const rows = [...groups].map(([assignee, days]): MttrPersonComparison => ({
    assignee, comparison: compareMttr({ ...dataset!, days }, baseline, current), rank: null,
  }));
  const eligible = (row: MttrPersonComparison) => !!row.assignee.trim() && row.comparison.reductionRate !== null &&
    row.comparison.baseline.count >= minimum && row.comparison.current.count >= minimum;
  rows.sort((a, b) => {
    const ea = eligible(a), eb = eligible(b);
    if (ea !== eb) return ea ? -1 : 1;
    if (ea && a.comparison.reductionRate !== b.comparison.reductionRate) return b.comparison.reductionRate! - a.comparison.reductionRate!;
    return a.assignee < b.assignee ? -1 : a.assignee > b.assignee ? 1 : 0;
  });
  let lastRate: number | null = null, lastRank = 0;
  rows.forEach((row, index) => {
    if (!eligible(row)) return;
    if (row.comparison.reductionRate !== lastRate) lastRank = index + 1;
    row.rank = lastRank;
    lastRate = row.comparison.reductionRate;
  });
  return rows;
}
