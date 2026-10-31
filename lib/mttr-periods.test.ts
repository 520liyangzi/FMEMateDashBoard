import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticMttrPeriods, localToday, restoreMttrPeriodSettings } from './mttr-periods.ts';

const local = (year: number, month: number, date: number) => new Date(year, month - 1, date, 12, 30);

test('automatic MTTR periods use today inclusive and adjacent non-overlapping seven-day ranges', () => {
  assert.deepEqual(automaticMttrPeriods(local(2026, 10, 31)), {
    current: { from: '2026-10-25', to: '2026-10-31' },
    baseline: { from: '2026-10-18', to: '2026-10-24' },
  });
});

test('automatic period arithmetic crosses months, leap days and years', () => {
  assert.deepEqual(automaticMttrPeriods(local(2024, 3, 2)), {
    current: { from: '2024-02-25', to: '2024-03-02' },
    baseline: { from: '2024-02-18', to: '2024-02-24' },
  });
  assert.deepEqual(automaticMttrPeriods(local(2026, 1, 3)), {
    current: { from: '2025-12-28', to: '2026-01-03' },
    baseline: { from: '2025-12-21', to: '2025-12-27' },
  });
});

test('localToday reads civil date getters instead of the UTC date', () => {
  const date = new Date('2026-10-30T17:30:00Z');
  // Simulate the local getter view at UTC+7 while retaining the original instant.
  date.getFullYear = () => 2026;
  date.getMonth = () => 9;
  date.getDate = () => 31;
  assert.equal(date.toISOString().slice(0, 10), '2026-10-30');
  assert.equal(localToday(date), '2026-10-31');
  assert.equal(automaticMttrPeriods(date).current.to, '2026-10-31');
});

test('legacy settings with a stale future December 14 selection migrate to today automatically', () => {
  const result = restoreMttrPeriodSettings({
    mttrBaseline: { from: '2026-12-01', to: '2026-12-07' },
    mttrCurrent: { from: '2026-12-08', to: '2026-12-14' },
  }, local(2026, 10, 31));
  assert.deepEqual(result, { dateMode: 'auto', ...automaticMttrPeriods(local(2026, 10, 31)) });
});

test('automatic mode advances on the next day and disregards persisted dates', () => {
  const stored = {
    version: 2, dateMode: 'auto',
    mttrBaseline: { from: '2026-10-18', to: '2026-10-24' },
    mttrCurrent: { from: '2026-10-25', to: '2026-10-31' },
  };
  const restored = restoreMttrPeriodSettings(stored, local(2026, 11, 1));
  assert.equal(restored.dateMode, 'auto');
  assert.deepEqual(restored.current, { from: '2026-10-26', to: '2026-11-01' });
  assert.deepEqual(restored.baseline, { from: '2026-10-19', to: '2026-10-25' });
});

test('explicit valid manual dates persist unchanged and are copied', () => {
  const stored = {
    version: 2, dateMode: 'manual',
    mttrBaseline: { from: '2026-12-01', to: '2026-12-07' },
    mttrCurrent: { from: '2026-12-08', to: '2026-12-14' },
  };
  const restored = restoreMttrPeriodSettings(stored, local(2026, 10, 31));
  assert.deepEqual(restored, { dateMode: 'manual', baseline: stored.mttrBaseline, current: stored.mttrCurrent });
  assert.notEqual(restored.baseline, stored.mttrBaseline);
  assert.notEqual(restored.current, stored.mttrCurrent);
});

test('malformed and unsupported settings fall back to today rather than stale saved dates', () => {
  const expected = { dateMode: 'auto', ...automaticMttrPeriods(local(2026, 10, 31)) };
  for (const stored of [null, undefined, '', [], { version: 1, dateMode: 'manual' },
    { version: 2, dateMode: 'unknown' },
    { version: 2, dateMode: 'manual', mttrBaseline: { from: '2026-02-30', to: '2026-03-01' }, mttrCurrent: { from: '2026-03-02', to: '2026-03-08' } },
    { version: 2, dateMode: 'manual', mttrBaseline: { from: '2026-10-05', to: '2026-10-01' }, mttrCurrent: { from: '2026-10-06', to: '2026-10-09' } },
    { version: 2, dateMode: 'manual', mttrBaseline: null, mttrCurrent: null },
  ]) assert.deepEqual(restoreMttrPeriodSettings(stored, local(2026, 10, 31)), expected);
});
