import { isValidMttrPeriod, previousMttrPeriod, type MttrPeriod } from './mttr.ts';

export type MttrDateMode = 'auto' | 'manual';
export type MttrPeriodSettings = {
  dateMode: MttrDateMode;
  baseline: MttrPeriod;
  current: MttrPeriod;
};

/** Use the viewer's civil calendar date, not the UTC date of the same instant. */
export function localToday(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid current date.');
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Last seven local calendar dates through today versus the preceding seven. */
export function automaticMttrPeriods(now = new Date()): { baseline: MttrPeriod; current: MttrPeriod } {
  const to = localToday(now);
  // Once today's civil date is known, UTC arithmetic avoids DST-length days.
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const current = { from, to };
  const baseline = previousMttrPeriod(current);
  if (!baseline) throw new RangeError('Current date is outside the supported comparison range.');
  return { baseline, current };
}

/**
 * V2 makes automatic/manual intent explicit. Legacy settings only stored dates,
 * so restoring those dates forever could leave a future/stale comparison active.
 * An automatic selection is recalculated even when stored dates look valid.
 */
export function restoreMttrPeriodSettings(stored: unknown, now = new Date()): MttrPeriodSettings {
  const automatic = (): MttrPeriodSettings => ({ dateMode: 'auto', ...automaticMttrPeriods(now) });
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return automatic();
  const value = stored as Record<string, unknown>;
  if (value.version !== 2 || value.dateMode !== 'manual') return automatic();
  const baseline = value.mttrBaseline as MttrPeriod;
  const current = value.mttrCurrent as MttrPeriod;
  if (!isValidMttrPeriod(baseline) || !isValidMttrPeriod(current)) return automatic();
  return {
    dateMode: 'manual',
    baseline: { from: baseline.from, to: baseline.to },
    current: { from: current.from, to: current.to },
  };
}
