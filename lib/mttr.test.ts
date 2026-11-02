import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMttrPeople, compareMttr, previousMttrPeriod, shiftMttrPeriod, isValidMttrPeriod, selectMttrDayScope, selectMttrScope, parseMttrMaxHours, filterMttrPeopleByGap, type MttrDataset, type MttrPersonDay } from './mttr.ts';

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

test('same-calendar-day scope changes weighted means and people without mutating history', () => {
  const d = peopleDataset();
  const personDays = d.personDays!.filter(day => day.assignee === 'Alex');
  d.sameDay = { days: personDays.map(({ assignee, ...day }) => day), personDays };
  const before = JSON.stringify(d), filtered = selectMttrDayScope(d, true)!;
  assert.equal(selectMttrDayScope(d, false), d);
  assert.equal(filtered.totalJobs, 2);
  assert.equal(compareMttr(filtered, baseline, current).reductionRate, 50);
  assert.equal(compareMttr(d, baseline, current).reductionRate, 41.25);
  assert.deepEqual(analyzeMttrPeople(filtered, baseline, current).map(p => [p.assignee, p.rank]), [['Alex', 1]]);
  assert.equal(compareMttr(filtered, baseline, current, '').reductionRate, null);
  assert.equal(JSON.stringify(d), before);
});

test('same-day scope distinguishes missing old aggregates from a valid empty subset', () => {
  const d = peopleDataset();
  assert.equal(selectMttrDayScope(d, true), null);
  assert.equal(selectMttrDayScope(null, true), null);
  d.sameDay = { days: [], personDays: [] };
  const filtered = selectMttrDayScope(d, true)!;
  assert.equal(filtered.totalJobs, 0);
  assert.equal(filtered.latestDate, '');
  assert.equal(compareMttr(filtered, baseline, current).status, 'no_baseline_tickets');
  assert.deepEqual(analyzeMttrPeople(filtered, baseline, current), []);
  assert.equal(selectMttrDayScope({ ...d, formatVersion: 2 }, true), null);
});

test('duration threshold excludes equality, keeps exact fractional boundaries and counts groups by weight', () => {
  const d = peopleDataset();
  d.durationGroups = [
    { date: '2026-10-01', assignee: 'Alex', durationSeconds: 1800, count: 2, sameDay: true },
    { date: '2026-10-01', assignee: 'Alex', durationSeconds: 3600, count: 7, sameDay: true },
    { date: '2026-10-04', assignee: 'Alex', durationSeconds: 900, count: 1, sameDay: true },
    { date: '2026-10-04', assignee: 'Alex', durationSeconds: 120, count: 1, sameDay: false },
  ];
  const filtered = selectMttrScope(d, false, 1)!;
  assert.equal(filtered.totalJobs, 4);
  assert.equal(compareMttr(filtered, baseline, current).baseline.meanSeconds, 1800);
  assert.equal(compareMttr(filtered, baseline, current).current.meanSeconds, 510);
  const combined = selectMttrScope(d, true, 1)!;
  assert.equal(combined.totalJobs, 3);
  assert.equal(analyzeMttrPeople(combined, baseline, current)[0].comparison.reductionRate, 50);
  assert.equal(selectMttrScope(d, false, .5)!.totalJobs, 2);
  assert.equal(selectMttrScope(d, false, 1 / 30)!.totalJobs, 0, 'exact 120 seconds is excluded');
  assert.equal(d.durationGroups.length, 4);
});

test('duration threshold validity and old snapshots never silently substitute full statistics', () => {
  const d = peopleDataset();
  assert.equal(parseMttrMaxHours(false, ''), undefined);
  assert.equal(parseMttrMaxHours(true, '0.5'), .5);
  assert.equal(parseMttrMaxHours(true, ' 8 '), 8);
  for (const input of ['', '0', '-1', 'NaN', 'Infinity', '0x10', '1e309']) assert.equal(parseMttrMaxHours(true, input), null);
  for (const threshold of [null, 0, -1, Infinity, NaN, 8]) assert.equal(selectMttrScope(d, false, threshold), null);
  assert.equal(selectMttrScope(d, false), d);
  d.durationGroups = [];
  assert.equal(selectMttrScope(d, false, 8)!.totalJobs, 0, 'known empty groups are available');
});

function gapDataset(personDays: MttrPersonDay[]): MttrDataset {
  return { ...dataset(personDays), formatVersion: 3, personDays,
    totalJobs: personDays.reduce((sum, day) => sum + day.count, 0),
    totalTickets: personDays.reduce((sum, day) => sum + day.count, 0) };
}
const gapDay = (assignee: string, date: string, count: number, meanHours: number): MttrPersonDay =>
  ({ assignee, date, count, totalSeconds: count * meanHours * 3600 });

test('personal gap excludes equality symmetrically, including zero-baseline means, without mutating data', () => {
  const d = gapDataset([
    gapDay('Slower', '2026-10-01', 1, 1), gapDay('Slower', '2026-10-04', 1, 9),
    gapDay('Faster', '2026-10-01', 1, 12), gapDay('Faster', '2026-10-04', 1, 4),
    gapDay('Zero', '2026-10-01', 1, 0), gapDay('Zero', '2026-10-04', 1, 8),
    gapDay('Stable', '2026-10-01', 1, 3), gapDay('Stable', '2026-10-04', 1, 4),
  ]), before = JSON.stringify(d);
  const filtered = filterMttrPeopleByGap(d, baseline, current, 8);
  assert.equal(filtered.status, 'available');
  assert.deepEqual(filtered.excluded.map(p => [p.assignee, p.gapSeconds / 3600]), [['Faster', 8], ['Slower', 8], ['Zero', 8]]);
  assert.deepEqual(analyzeMttrPeople(filtered.dataset, baseline, current).map(p => p.assignee), ['Stable']);
  assert.equal(filtered.excluded.find(p => p.assignee === 'Zero')!.baseline.meanSeconds, 0);
  assert.equal(filtered.dataset!.totalJobs, 2);
  assert.equal(JSON.stringify(d), before);
  assert.equal(filterMttrPeopleByGap(d, baseline, current).dataset, d);
  assert.equal(filterMttrPeopleByGap(d, baseline, current, 8.01).dataset, d);
});

test('gap-filtered overall mean remains Job-weighted; missing periods and unassigned Jobs stay disclosed', () => {
  const d = gapDataset([
    gapDay('Exclude', '2026-10-01', 1, 1), gapDay('Exclude', '2026-10-04', 1, 9),
    gapDay('Stable', '2026-10-01', 3, 3), gapDay('Stable', '2026-10-04', 1, 4),
    gapDay('New', '2026-10-04', 2, 10), gapDay('Gone', '2026-10-01', 1, 10),
    gapDay('', '2026-10-01', 2, 5), gapDay('', '2026-10-04', 2, 15),
    gapDay('Outside', '2026-09-01', 2, 100),
  ]);
  const filtered = filterMttrPeopleByGap(d, baseline, current, 8);
  assert.equal(filtered.unassessedAssignees, 2);
  assert.deepEqual(filtered.unassignedJobs, { baseline: 2, current: 2 });
  assert.equal(filtered.dataset!.totalJobs, 13);
  const result = compareMttr(filtered.dataset, baseline, current);
  assert.equal(result.baseline.count, 6);
  assert.equal(result.current.count, 5);
  assert.equal(result.baseline.meanSeconds, 29 * 3600 / 6);
  assert.equal(result.current.meanSeconds, 54 * 3600 / 5);
  assert.equal(compareMttr(filtered.dataset, baseline, current, 'Exclude').status, 'no_baseline_tickets');
  const rows = analyzeMttrPeople(filtered.dataset, baseline, current);
  assert.equal(rows.find(p => p.assignee === 'New')!.rank, null);
  assert.equal(rows.find(p => p.assignee === '')!.rank, null);
  assert.equal(filtered.dataset!.earliestDate, '2026-09-01');
});

test('personal gaps are computed after Job filters and from the selected periods, with no global-mean threshold', () => {
  const personDays = [
    gapDay('A', '2026-10-01', 1, 4), gapDay('A', '2026-10-04', 2, 6),
    gapDay('A', '2026-10-07', 1, 20),
  ];
  const d = gapDataset(personDays);
  d.durationGroups = [
    { date: '2026-10-01', assignee: 'A', durationSeconds: 4 * 3600, count: 1, sameDay: true },
    { date: '2026-10-04', assignee: 'A', durationSeconds: 2 * 3600, count: 1, sameDay: true },
    { date: '2026-10-04', assignee: 'A', durationSeconds: 10 * 3600, count: 1, sameDay: false },
    { date: '2026-10-07', assignee: 'A', durationSeconds: 20 * 3600, count: 1, sameDay: true },
  ];
  assert.equal(filterMttrPeopleByGap(d, baseline, current, 3).excluded.length, 0, '4h versus 6h is below 3h');
  const prior = selectMttrScope(d, true, 8)!;
  assert.equal(filterMttrPeopleByGap(prior, baseline, current, 2).excluded.length, 1, '4h versus 2h meets 2h');
  const otherCurrent = { from: '2026-10-07', to: '2026-10-07' };
  const changed = filterMttrPeopleByGap(d, baseline, otherCurrent, 3);
  assert.equal(changed.excluded[0].current.meanSeconds, 20 * 3600);
  assert.equal(changed.excluded[0].gapSeconds, 16 * 3600);
  assert.equal(changed.dataset!.personDays!.length, 0, 'cohort exclusion applies to all report dates once');
  assert.deepEqual(changed.dataset!.days, []);
  assert.equal(changed.dataset!.earliestDate, '');
  assert.equal(changed.dataset!.latestDate, '');
});

test('gap filtering reports invalid conditions and missing person data instead of substituting full data', () => {
  const d = gapDataset([]);
  for (const value of [null, 0, -1, NaN, Infinity]) {
    const result = filterMttrPeopleByGap(d, baseline, current, value);
    assert.equal(result.status, 'invalid_threshold');
    assert.equal(result.dataset, null);
  }
  assert.equal(filterMttrPeopleByGap(d, { from: '', to: '' }, current, 1).status, 'invalid_range');
  assert.equal(filterMttrPeopleByGap(null, baseline, current, 1).status, 'no_dataset');
  const legacy = { ...d, formatVersion: 2 as const };
  assert.equal(filterMttrPeopleByGap(legacy, baseline, current, 1).status, 'person_data_unavailable');
  const missing = { ...d }; delete missing.personDays;
  assert.equal(filterMttrPeopleByGap(missing, baseline, current, 1).dataset, null);
  const empty = filterMttrPeopleByGap(d, baseline, current, 1);
  assert.equal(empty.status, 'available');
  assert.equal(empty.dataset, d);
  assert.deepEqual(empty.excluded, []);
});
