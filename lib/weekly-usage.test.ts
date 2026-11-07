import assert from 'node:assert/strict';
import test from 'node:test';
import type { LogRecord } from './analytics.ts';
import { analyzeWeeklyUsage, importedWorkweeks, workweekOf } from './weekly-usage.ts';

const row = (taskId: string, clientId: string, date: string, scene = 'Ticket'): LogRecord =>
  ({ taskId, clientId, date, time: date + 'T12:00:00', scene, question: 'Check', answer: '' });
const logs = [
  row('prior', 'Previous', '2026-10-30'),
  row('1', 'A', '2026-11-02'), row('2', 'A', '2026-11-02'),
  row('3', 'A', '2026-11-03'), row('4', 'A', '2026-11-06', 'MML'),
  row('5', 'B', '2026-11-04'), row('6', 'B', '2026-11-05', ''),
  row('shared', ' Browser ', '2026-11-04'), row('blank', ' ', '2026-11-06'),
  row('sat', 'Weekend', '2026-11-07'), row('sun', 'A', '2026-11-08'),
  row('prior', 'Duplicate', '2026-11-03'),
];

test('reporting weeks run Monday to Friday, including across year boundaries', () => {
  const expected = { from: '2026-11-02', to: '2026-11-06' };
  for (const day of ['02','03','04','05','06','07','08']) assert.deepEqual(workweekOf('2026-11-' + day), expected);
  assert.deepEqual(workweekOf('2027-01-01'), { from: '2026-12-28', to: '2027-01-01' });
  assert.deepEqual(importedWorkweeks(logs), [expected, { from: '2026-10-26', to: '2026-10-30' }]);
  assert.equal(workweekOf('2026-02-30'), null);
});

test('the mean uses distinct account weekdays over weekday-active accounts in the selected scene', () => {
  const selected = workweekOf('2026-11-05');
  const all = analyzeWeeklyUsage(logs, selected, '');
  assert.deepEqual(all.users.map(u => [u.clientId, u.activeDays]), [['A', 3], ['B', 2]]);
  assert.equal(all.mean, 2.5);
  assert.equal(all.userDays, 5);
  assert.equal(all.observedDays, 5);
  assert.equal(analyzeWeeklyUsage(logs, selected, 'Ticket').mean, 1.5);
  assert.equal(analyzeWeeklyUsage(logs, selected, 'MML').mean, 1);
  assert.equal(analyzeWeeklyUsage(logs, selected, '\u0000').users[0].clientId, 'B');
});

test('incomplete weeks show observed usage, and empty or weekend-only cohorts have no mean', () => {
  const selected = workweekOf('2026-11-02');
  const partial = analyzeWeeklyUsage([logs[1]], selected, '');
  assert.equal(partial.mean, 1);
  assert.equal(partial.observedDays, 1);
  for (const result of [
    analyzeWeeklyUsage(logs, workweekOf('2026-11-09'), ''),
    analyzeWeeklyUsage(logs, selected, 'Unknown'),
    analyzeWeeklyUsage(logs.slice(9, 11), selected, ''),
    analyzeWeeklyUsage(logs, null, ''),
  ]) {
    assert.equal(result.mean, null);
    assert.equal(result.users.length, 0);
  }
});
