/** Only filtered, valid, closed tickets are included in these daily aggregates. */
export type MttrDay = { date: string; count: number; totalSeconds: number };
export type MttrDataset = {
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
  /** Baseline mean − current mean, in seconds per closed ticket. */
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
function aggregate(dataset: MttrDataset | null, period: MttrPeriod): MttrAggregate {
  const result: MttrAggregate = { ...period, days: 0, count: 0, totalSeconds: 0, meanSeconds: null };
  if (!isValidMttrPeriod(period)) return result;
  result.days = Math.round((stamp(period.to) - stamp(period.from)) / DAY) + 1;
  for (const day of dataset?.days ?? []) {
    if (!Number.isFinite(stamp(day.date)) || day.date < period.from || day.date > period.to ||
        !Number.isSafeInteger(day.count) || day.count <= 0 || !Number.isFinite(day.totalSeconds) || day.totalSeconds < 0) continue;
    result.count += day.count;
    result.totalSeconds += day.totalSeconds;
  }
  if (result.count > 0) result.meanSeconds = result.totalSeconds / result.count;
  return result;
}
/**
 * Overall arithmetic mean by close date, weighted by ticket count, not by date.
 * Missing dates contribute no tickets; absence of tickets is not a zero-hour MTTR.
 * Comparing these means alone does not establish a causal project improvement.
 */
export function compareMttr(dataset: MttrDataset | null, baselinePeriod: MttrPeriod, currentPeriod: MttrPeriod): MttrComparison {
  const baseline = aggregate(dataset, baselinePeriod), current = aggregate(dataset, currentPeriod);
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
