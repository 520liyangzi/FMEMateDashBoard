import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMttrPeople, compareMttr, previousMttrPeriod, shiftMttrPeriod, isValidMttrPeriod, type MttrDataset } from './mttr.ts';

const dataset = (days: MttrDataset['days']): MttrDataset => ({
  filename: 'tickets.xlsx', importedAt: '2026-10-31T00:00:00Z', sourceRows: 0, matchedRows: 0,
  validRows: days.reduce((sum, d) => sum + d.count, 0), invalidDates: 0, negativeDurations: 0, excludedRows: 0,
  earliestDate: days[0]?.date ?? '', latestDate: days.at(-1)?.date ?? '', days,
});
const baseline = { from: '2026-10-01', to: '2026-10-03' }, current = { from: '2026-10-04', to: '2026-10-06' };

test('MTTR is weighted by ticket count and includes close-date boundaries', () => {
  const result = compareMttr(dataset([
    { date: '2026-09-30', count: 10, totalSeconds: 999999 },
    { date: '2026-10-01', count: 1, totalSeconds: 36000 },
    { date: '2026-10-03', count: 9, totalSeconds: 32400 },
    { date: '2026-10-04', count: 2, totalSeconds: 7200 },
    { date: '2026-10-06', count: 2, totalSeconds: 7200 },
    { date: '2026-10-07', count: 4, totalSeconds: 999999 },
  ]), baseline, current);
  assert.equal(result.baseline.count, 10);
  assert.equal(result.baseline.meanSeconds, 6840); // 1.9h, not the unweighted daily 5.5h.
  assert.equal(result.current.meanSeconds, 3600);
  assert.equal(result.savedSeconds, 3240);
  assert.ok(Math.abs(result.reductionRate! - 47.3684210526) < 1e-8);
  assert.equal(result.status, 'available');
  assert.equal(result.overlap, false);
  assert.equal(result.unequalDays, false);
});

test('slower MTTR is negative and zero duration remains a valid ticket', () => {
  let result = compareMttr(dataset([{ date: '2026-10-01', count: 1, totalSeconds: 10 }, { date: '2026-10-04', count: 1, totalSeconds: 15 }]), baseline, current);
  assert.equal(result.reductionRate, -50);
  assert.equal(result.savedSeconds, -5);
  result = compareMttr(dataset([{ date: '2026-10-01', count: 1, totalSeconds: 10 }, { date: '2026-10-04', count: 2, totalSeconds: 0 }]), baseline, current);
  assert.equal(result.current.count, 2);
  assert.equal(result.reductionRate, 100);
});

test('missing data and a zero baseline do not fabricate a reduction rate', () => {
  assert.equal(compareMttr(null, baseline, current).status, 'no_dataset');
  assert.equal(compareMttr(null, baseline, current).reductionRate, null);
  const d = dataset([{ date: '2026-10-01', count: 1, totalSeconds: 0 }]);
  let result = compareMttr(d, baseline, current);
  assert.equal(result.current.meanSeconds, null);
  assert.equal(result.status, 'no_current_tickets');
  assert.equal(result.reductionRate, null);
  result = compareMttr(d, current, baseline);
  assert.equal(result.status, 'no_baseline_tickets');
  d.days.push({ date: '2026-10-04', count: 1, totalSeconds: 10 });
  result = compareMttr(d, baseline, current);
  assert.equal(result.status, 'zero_baseline');
  assert.equal(result.reductionRate, null);
  assert.equal(result.savedSeconds, -10);
});

test('overlapping and unequal-length comparison periods are reported explicitly', () => {
  const result = compareMttr(dataset([{ date: '2026-10-03', count: 2, totalSeconds: 20 }]), baseline, { from: '2026-10-03', to: '2026-10-06' });
  assert.equal(result.overlap, true);
  assert.equal(result.unequalDays, true);
  assert.equal(result.baseline.days, 3);
  assert.equal(result.current.days, 4);
  assert.equal(result.reductionRate, 0);
});

test('invalid calendar dates and reversed periods return unavailable', () => {
  for (const period of [{ from: '2026-02-29', to: '2026-03-02' }, { from: '2026-10-03', to: '2026-10-01' }, { from: '', to: '' }, { from: '0000-01-01', to: '0000-01-02' }]) {
    assert.equal(isValidMttrPeriod(period), false);
    assert.equal(compareMttr(dataset([]), period, current).status, 'invalid_range');
    assert.equal(previousMttrPeriod(period), null);
  }
});

test('equal-period navigation crosses months, leap days and years without timezone effects', () => {
  assert.deepEqual(previousMttrPeriod(current), baseline);
  assert.deepEqual(shiftMttrPeriod(baseline, 1), current);
  assert.deepEqual(previousMttrPeriod({ from: '2024-03-01', to: '2024-03-03' }), { from: '2024-02-27', to: '2024-02-29' });
  assert.deepEqual(previousMttrPeriod({ from: '2026-01-01', to: '2026-01-07' }), { from: '2025-12-25', to: '2025-12-31' });
  assert.equal(previousMttrPeriod({ from: '0001-01-01', to: '0001-01-01' }), null);
  assert.equal(shiftMttrPeriod({ from: '9999-12-31', to: '9999-12-31' }, 1), null);
});

function peopleDataset(): MttrDataset {
  const personDays = [
    { assignee: 'Alex', date: '2026-10-01', count: 1, totalSeconds: 100 },
    { assignee: 'Alex', date: '2026-10-04', count: 1, totalSeconds: 50 },
    { assignee: 'Blake', date: '2026-10-03', count: 9, totalSeconds: 900 },
    { assignee: 'Blake', date: '2026-10-06', count: 9, totalSeconds: 1125 },
    { assignee: '', date: '2026-10-01', count: 1, totalSeconds: 1000 },
    { assignee: '', date: '2026-10-04', count: 1, totalSeconds: 0 },
  ];
  return { ...dataset(personDays), formatVersion: 3, personDays, totalJobs: 22, totalTickets: 22 };
}

test('V3 assignee filtering uses exact person-day records and includes unassigned only when requested', () => {
  const d = peopleDataset();
  assert.equal(compareMttr(d, baseline, current, 'Alex').reductionRate, 50);
  assert.equal(compareMttr(d, baseline, current, 'Blake').reductionRate, -25);
  assert.equal(compareMttr(d, baseline, current, '').reductionRate, 100);
  assert.equal(compareMttr(d, baseline, current, 'alex').status, 'no_baseline_tickets');
  assert.equal(compareMttr(d, baseline, current).baseline.count, 11);
  assert.equal(compareMttr(d, baseline, current).current.count, 11);
  assert.equal(compareMttr(d, baseline, current).reductionRate, 41.25);
  assert.equal(compareMttr(dataset(d.days), baseline, current, 'Alex').reductionRate, null);
});

test('person ranks use individual signed reductions while overall MTTR remains weighted', () => {
  const d = peopleDataset(), rows = analyzeMttrPeople(d, baseline, current);
  assert.deepEqual(rows.map(r => [r.assignee, r.rank]), [['Alex', 1], ['Blake', 2], ['', null]]);
  assert.equal(rows[0].comparison.reductionRate, 50);
  assert.equal(rows[1].comparison.reductionRate, -25);
  // (50 - 25) / 2 is 12.5%; the actual weighted overall reduction is 41.25%.
  assert.equal(compareMttr(d, baseline, current).reductionRate, 41.25);
});

test('missing-period, zero-baseline and low-sample assignees remain visible without a rank', () => {
  const d = peopleDataset();
  d.personDays!.push(
    { assignee: 'New', date: '2026-10-04', count: 2, totalSeconds: 10 },
    { assignee: 'Absent', date: '2026-10-01', count: 2, totalSeconds: 10 },
    { assignee: 'Zero', date: '2026-10-01', count: 2, totalSeconds: 0 },
    { assignee: 'Zero', date: '2026-10-04', count: 2, totalSeconds: 10 },
  );
  const rows = analyzeMttrPeople(d, baseline, current, 2);
  assert.equal(rows[0].assignee, 'Blake');
  assert.equal(rows[0].rank, 1);
  for (const name of ['', 'Alex', 'New', 'Absent', 'Zero']) assert.equal(rows.find(r => r.assignee === name)!.rank, null);
  assert.equal(rows.find(r => r.assignee === 'New')!.comparison.status, 'no_baseline_tickets');
  assert.equal(rows.find(r => r.assignee === 'Absent')!.comparison.status, 'no_current_tickets');
  assert.equal(rows.find(r => r.assignee === 'Zero')!.comparison.status, 'zero_baseline');
  assert.deepEqual(analyzeMttrPeople(null, baseline, current), []);
});

test('ties use deterministic competition ranks and invalid ranges do not create ranked people', () => {
  const d = peopleDataset();
  d.personDays!.push(
    { assignee: 'Aaron', date: '2026-10-01', count: 2, totalSeconds: 40 },
    { assignee: 'Aaron', date: '2026-10-04', count: 2, totalSeconds: 20 },
  );
  assert.deepEqual(analyzeMttrPeople(d, baseline, current).map(r => [r.assignee, r.rank]), [['Aaron', 1], ['Alex', 1], ['Blake', 3], ['', null]]);
  const rows = analyzeMttrPeople(d, { from: '', to: '' }, current);
  assert.equal(rows.every(r => r.rank === null && r.comparison.reductionRate === null), true);
});
