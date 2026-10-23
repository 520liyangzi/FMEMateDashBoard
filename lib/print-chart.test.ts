import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrintTrend, formatPrintCount, PRINT_CHART } from './print-chart.ts';

test('print geometry is deterministic, sorted, deduplicated and independent of input mutation', () => {
  const rows = [{ date: '2026-10-23', primary: 4 }, { date: '2026-10-21', primary: 2 }, { date: '2026-10-23', primary: 6 }];
  const original = JSON.stringify(rows);
  const chart = buildPrintTrend(rows);
  assert.deepEqual(chart.points.map(point => point.date), ['2026-10-21', '2026-10-23']);
  assert.equal(chart.points[1].primary, 6);
  assert.equal(chart.points[0].x, PRINT_CHART.left);
  assert.equal(chart.points[1].x, PRINT_CHART.right);
  assert.equal(JSON.stringify(rows), original);
  assert.deepEqual(buildPrintTrend(rows), chart);
});

test('sparse dates use elapsed date distance and have bounded, nonoverlapping axis ticks', () => {
  const chart = buildPrintTrend([{ date: '2026-01-01', primary: 4 }, { date: '2026-01-02', primary: 5 }, { date: '2026-04-11', primary: 6 }]);
  assert.ok(Math.abs((chart.points[1].x - PRINT_CHART.left) / (PRINT_CHART.right - PRINT_CHART.left) - 0.01) < 1e-12);
  assert.equal(chart.xTicks.length, 8);
  assert.equal(chart.xTicks[0].date, '2026-01-01');
  assert.equal(chart.xTicks.at(-1)!.date, '2026-04-11');
  assert.ok(chart.xTicks.every((tick, index) => !index || tick.x - chart.xTicks[index - 1].x > 100));
});

test('a single day and all-zero secondary counts remain visible with integer axes', () => {
  const chart = buildPrintTrend([{ date: '2026-10-23', primary: 0, secondary: 0 }]);
  assert.equal(chart.points[0].x, (PRINT_CHART.left + PRINT_CHART.right) / 2);
  assert.equal(chart.points[0].primaryY, PRINT_CHART.bottom);
  assert.equal(chart.points[0].secondaryY, PRINT_CHART.bottom);
  assert.deepEqual(chart.yTicks.map(tick => tick.value), [0, 1]);
  assert.equal(chart.xTicks.length, 1);
  assert.equal(chart.secondarySegments.length, 1);
});

test('fourteen-day ISO labels keep clear gaps and centered endpoints inside the viewBox', () => {
  const chart = buildPrintTrend([{ date: '2026-10-10', primary: 60 }, { date: '2026-10-23', primary: 85 }]);
  assert.equal(chart.xTicks[0].date, '2026-10-10');
  assert.equal(chart.xTicks.at(-1)!.date, '2026-10-23');
  assert.ok(chart.xTicks.length <= 8);
  assert.ok(chart.xTicks.every(tick => tick.x >= 50 && tick.x <= PRINT_CHART.width - 50));
  assert.ok(chart.xTicks.every((tick, index) => !index || tick.x - chart.xTicks[index - 1].x >= 100));
});

test('invalid and extreme inputs never create nonfinite coordinates or fractional count ticks', () => {
  const chart = buildPrintTrend([
    { date: '2026-02-30', primary: 1 }, { date: 'bad', primary: 1 },
    { date: '2026-10-20', primary: NaN }, { date: '2026-10-21', primary: -1 },
    { date: '2026-10-22', primary: 1e308 },
    { date: '2026-10-23', primary: Number.MAX_SAFE_INTEGER, secondary: Infinity },
  ]);
  assert.equal(chart.points.length, 1);
  assert.equal(chart.points[0].secondaryY, undefined);
  assert.ok(chart.ceiling >= Number.MAX_SAFE_INTEGER);
  const numbers = [...chart.points.flatMap(point => [point.x, point.primaryY]), ...chart.yTicks.flatMap(tick => [tick.value, tick.y])];
  assert.ok(numbers.every(Number.isFinite));
  assert.ok(chart.yTicks.every(tick => Number.isInteger(tick.value) && tick.value >= 0));
  assert.equal(buildPrintTrend([]).points.length, 0);
  assert.equal(buildPrintTrend([]).xTicks.length, 0);
});

test('missing secondary evidence is a gap, not an invented zero or connecting segment', () => {
  const chart = buildPrintTrend([{ date: '2026-10-21', primary: 4, secondary: 1 }, { date: '2026-10-22', primary: 5 }, { date: '2026-10-23', primary: 6, secondary: 0 }]);
  assert.deepEqual(chart.secondarySegments.map(segment => segment.length), [1, 1]);
  assert.equal(formatPrintCount(3), '3');
  assert.equal(formatPrintCount(12000), '12K');
});
