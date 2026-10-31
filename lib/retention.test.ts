import assert from 'node:assert/strict';
import test from 'node:test';
import type { LogRecord } from './analytics.ts';
import { analyzeRepeatUsage, analyzeRetention, DEFAULT_REPEAT_DAYS, normalizeRepeatDays } from './retention.ts';

const row = (taskId: string, clientId: string, date: string, scene = 'Diagnosis'): LogRecord => ({ taskId, clientId, date, time: `${date}T10:00:00`, scene, question: 'Query', answer: '' });
const prior = '2026-10-28', current = '2026-10-29';

test('all nine prior users returning gives 100%; new users do not inflate retention', () => {
  const records = Array.from({ length: 9 }, (_, i) => row(`a${i}`, `C${i}`, prior));
  records.push(...Array.from({ length: 9 }, (_, i) => row(`b${i}`, `C${i}`, current)), row('new', 'NEW', current));
  const result = analyzeRetention(records, current, current);
  assert.equal(result.latest.rate, 100);
  assert.equal(result.latest.previousUsers, 9);
  assert.equal(result.latest.retainedUsers, 9);
  assert.equal(result.latest.status, 'available');
  assert.ok(!result.latest.previousClientIds.includes('NEW'));
  assert.deepEqual(result.latest.notObservedClientIds, []);
});

test('partial retention intersects unique IDs rather than counting interactions', () => {
  const records = [row('a', 'C1', prior), row('b', 'C2', prior), row('c', 'C3', prior), row('d', 'C1', current), row('e', 'C1', current), row('f', 'NEW', current)];
  const latest = analyzeRetention(records, current, current).latest;
  assert.ok(Math.abs(latest.rate! - 100 / 3) < 1e-12);
  assert.deepEqual(latest.retainedClientIds, ['C1']);
  assert.deepEqual(latest.notObservedClientIds, ['C2', 'C3']);
});

test('Task Id deduplication keeps first globally; browser and blank IDs never enter a cohort', () => {
  const records = [row('a', ' C1 ', prior), row('a', 'FAKE', current), row('b', ' BROWSER ', prior), row('c', 'browser', prior), row('d', '', prior), row('e', ' ', current), row('f', 'C1', current), row('g', 'Browser', current)];
  const latest = analyzeRetention(records, current, current).latest;
  assert.equal(latest.rate, 100);
  assert.deepEqual(latest.previousClientIds, ['C1']);
  assert.deepEqual(latest.retainedClientIds, ['C1']);
  assert.equal(latest.previousBrowserUses, 2);
  assert.equal(latest.currentBrowserUses, 1);
});

test('calendar gaps never substitute the previous nonempty day', () => {
  const result = analyzeRetention([row('a', 'C1', '2026-10-27'), row('b', 'C1', current)], current, current);
  assert.equal(result.latest.previousDate, prior);
  assert.equal(result.latest.status, 'missing_previous_logs');
  assert.equal(result.latest.rate, null);
});

test('observed current logs with no returning users give zero; absent current logs remain unknown', () => {
  const observed = analyzeRetention([row('a', 'C1', prior), row('b', 'NEW', current)], current, current).latest;
  assert.equal(observed.status, 'available');
  assert.equal(observed.rate, 0);
  const missing = analyzeRetention([row('a', 'C1', prior)], current, current).latest;
  assert.equal(missing.status, 'missing_current_logs');
  assert.equal(missing.rate, null);
  assert.equal(missing.previousUsers, 1);
  assert.deepEqual(missing.notObservedClientIds, ['C1']);
});

test('browser-only or blank-only prior logs have no identifiable previous cohort', () => {
  for (const id of ['browser', '   ']) {
    const latest = analyzeRetention([row('a', id, prior), row('b', 'C1', current)], current, current).latest;
    assert.equal(latest.status, 'no_previous_users');
    assert.equal(latest.previousUsers, 0);
    assert.equal(latest.rate, null);
  }
});

test('scene filters apply to both cohorts while all-scene logs establish calendar coverage', () => {
  const records = [row('a', 'C1', prior, 'Diagnosis'), row('b', 'C2', prior, 'MML'), row('c', 'C1', current, 'MML')];
  const diagnosis = analyzeRetention(records, current, current, 'Diagnosis').latest;
  assert.equal(diagnosis.status, 'available');
  assert.equal(diagnosis.previousUsers, 1);
  assert.equal(diagnosis.rate, 0, 'current-day logs in another scene make an observed zero valid');
  const mml = analyzeRetention(records, current, current, 'MML').latest;
  assert.equal(mml.previousUsers, 1);
  assert.equal(mml.rate, 0, 'changing scene between days is not same-scene retention');
  const nonexistent = analyzeRetention(records, current, current, 'Knowledge').latest;
  assert.equal(nonexistent.status, 'no_previous_users');
  assert.equal(nonexistent.rate, null);
  assert.equal(analyzeRetention(records, current, current).latest.rate, 50);
});

test('MML empty answers count as activity and the prior cohort can lie outside the selected range', () => {
  const records = [row('a', 'C1', prior, 'MML'), row('b', 'C1', current, 'MML')];
  const result = analyzeRetention(records, current, current);
  assert.equal(result.latest.rate, 100);
  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].previousDate, prior);
  assert.equal(result.latest.date, current);
});

test('invalid dates and inverted ranges return invalid_range without guessing a system date', () => {
  for (const [from, to] of [['2026-02-30', current], [current, prior], ['', ''], [prior, '10/29/2026']]) {
    const result = analyzeRetention([], from, to);
    assert.equal(result.latest.status, 'invalid_range');
    assert.equal(result.latest.date, to);
    assert.equal(result.latest.rate, null);
    assert.deepEqual(result.daily, []);
    assert.equal(result.omittedDays, 0);
    assert.deepEqual(result.range, { from, to });
  }
});

test('huge valid ranges retain the latest 3660 calendar days and explicitly count omissions', () => {
  const result = analyzeRetention([], '1900-01-01', '9999-12-31');
  assert.equal(result.daily.length, 3660);
  assert.equal(result.omittedDays, 2_958_464 - 3660);
  assert.equal(result.daily.at(-1)!.date, '9999-12-31');
  assert.equal(result.latest.date, '9999-12-31');
  assert.equal(result.latest.status, 'missing_previous_logs');
  assert.equal(result.latest.rate, null);
});

test('leap-day and year-boundary cohorts use exact calendar arithmetic', () => {
  const leap = analyzeRetention([row('a', 'C1', '2024-02-29'), row('b', 'C1', '2024-03-01')], '2024-03-01', '2024-03-01');
  assert.equal(leap.latest.previousDate, '2024-02-29');
  assert.equal(leap.latest.rate, 100);
  const year = analyzeRetention([row('a', 'C1', '2025-12-31'), row('b', 'C1', '2026-01-01')], '2026-01-01', '2026-01-01');
  assert.equal(year.latest.previousDate, '2025-12-31');
  assert.equal(year.latest.rate, 100);
});

test('scene selectors distinguish all scenes, a literal all scene, and empty scenes', () => {
  const records = [row('a', 'C1', prior, ''), row('b', 'C1', current, ''), row('c', 'C2', prior, 'all'), row('d', 'NEW', current, 'all')];
  assert.equal(analyzeRetention(records, current, current).latest.rate, 50);
  assert.equal(analyzeRetention(records, current, current, '\u0000').latest.rate, 100);
  assert.equal(analyzeRetention(records, current, current, 'all').latest.rate, 0);
  assert.equal(analyzeRepeatUsage(records, prior, current, undefined, 2).repeatUsers, 1);
  assert.equal(analyzeRepeatUsage(records, prior, current, '\u0000', 2).rate, 100);
  assert.equal(analyzeRepeatUsage(records, prior, current, 'all', 2).rate, 0);
});

test('multi-day repeat usage is six of ten identifiable users, not an interaction share', () => {
  const records = Array.from({ length: 10 }, (_, i) => row(`a${i}`, `C${i}`, prior));
  records.push(...Array.from({ length: 6 }, (_, i) => row(`b${i}`, `C${i}`, current)), row('extra', 'C0', current));
  const result = analyzeRepeatUsage(records, prior, current, undefined, 2);
  assert.equal(result.status, 'available');
  assert.equal(result.totalUsers, 10);
  assert.equal(result.repeatUsers, 6);
  assert.equal(result.rate, 60);
  assert.equal(result.observedDays, 2);
  assert.equal(result.daysWithoutLogs, 0);
  assert.equal(result.users.find(user => user.clientId === 'C0')!.activeDays, 2);
});

test('repeat usage distinguishes single-day, insufficient logs, invalid ranges, and observed zero', () => {
  const records = [row('a', 'C1', prior), row('b', 'C2', current)];
  const single = analyzeRepeatUsage(records, current, current);
  assert.equal(single.status, 'single_day_range');
  assert.equal(single.rate, null);
  assert.equal(single.totalUsers, 1);
  const insufficient = analyzeRepeatUsage([records[0]], prior, current, undefined, 2);
  assert.equal(insufficient.status, 'insufficient_logs');
  assert.equal(insufficient.rate, null);
  assert.equal(insufficient.daysWithoutLogs, 1);
  const zero = analyzeRepeatUsage(records, prior, current, undefined, 2);
  assert.equal(zero.status, 'available');
  assert.equal(zero.rate, 0);
  for (const [from, to] of [[current, prior], ['2026-02-30', current], ['', current]]) {
    const invalid = analyzeRepeatUsage(records, from, to);
    assert.equal(invalid.status, 'invalid_range');
    assert.equal(invalid.rate, null);
    assert.equal(invalid.range.days, 0);
  }
});

test('repeat frequency and exact consecutive streaks preserve gaps, deduplication and ID exclusions', () => {
  const records = [row('a', ' C1 ', '2026-10-27'), row('a', 'C1', prior), row('b', 'C1', current), row('c', 'C2', '2026-10-27'), row('d', 'C2', prior), row('e', 'C2', current), row('f', ' browser ', prior), row('g', '', current), row('h', ' C2 ', current)];
  const result = analyzeRepeatUsage(records, '2026-10-27', current);
  assert.equal(result.totalUsers, 2);
  assert.deepEqual(result.users.map(user => user.clientId), ['C2', 'C1']);
  assert.equal(result.users[0].longestStreak, 3);
  assert.equal(result.users[0].activeDayShare, 100);
  assert.equal(result.users[1].activeDays, 2);
  assert.equal(result.users[1].longestStreak, 1, 'the missing middle date cannot be bridged');
  assert.ok(Math.abs(result.users[1].activeDayShare - 200 / 3) < 1e-12);
  assert.equal(result.users[1].firstDate, '2026-10-27');
  assert.equal(result.users[1].lastDate, current);
});

test('repeat usage uses all-scene coverage and selected-scene identifiable activity, including MML', () => {
  const records = [row('a', 'C1', prior, 'MML'), row('b', 'C1', current, 'MML'), row('c', 'C2', prior, 'Diagnosis'), row('d', 'browser', current, 'Diagnosis')];
  assert.equal(analyzeRepeatUsage(records, prior, current, 'MML', 2).rate, 100);
  const diagnosis = analyzeRepeatUsage(records, prior, current, 'Diagnosis', 2);
  assert.equal(diagnosis.observedDays, 2);
  assert.equal(diagnosis.rate, 0);
  assert.equal(diagnosis.totalUsers, 1);
  const empty = analyzeRepeatUsage(records, prior, current, 'Knowledge', 2);
  assert.equal(empty.status, 'no_identifiable_users');
  assert.equal(empty.rate, null);
  assert.equal(empty.observedDays, 2);
  const browserOnly = analyzeRepeatUsage([row('a', 'browser', prior), row('b', 'browser', current)], prior, current, undefined, 2);
  assert.equal(browserOnly.status, 'no_identifiable_users');
});

test('repeat usage bounds work by observed dates instead of enumerating a huge selected range', () => {
  const result = analyzeRepeatUsage([row('a', 'C1', prior), row('b', 'C1', current)], '1900-01-01', '9999-12-31', undefined, 2);
  assert.equal(result.range.days, 2_958_464);
  assert.equal(result.observedDays, 2);
  assert.equal(result.daysWithoutLogs, 2_958_462);
  assert.equal(result.rate, 100);
  assert.equal(result.users[0].activeDays, 2);
  assert.equal(result.users[0].longestStreak, 2);
});


test('repeat threshold defaults to three distinct dates, without counting repeated daily interactions', () => {
  const records = [
    row('a', 'C1', '2026-10-27'), row('b', 'C1', prior), row('c', 'C1', current),
    row('d', 'C2', prior), row('e', 'C2', current), row('f', 'C2', current),
    row('g', 'C3', current), row('h', 'browser', '2026-10-27'),
  ];
  const result = analyzeRepeatUsage(records, '2026-10-27', current);
  assert.equal(DEFAULT_REPEAT_DAYS, 3);
  assert.equal(result.minimumActiveDays, 3);
  assert.equal(result.status, 'available');
  assert.equal(result.totalUsers, 3);
  assert.equal(result.repeatUsers, 1);
  assert.ok(Math.abs(result.rate! - 100 / 3) < 1e-12);
  const twoDays = analyzeRepeatUsage(records, '2026-10-27', current, undefined, 2);
  assert.equal(twoDays.minimumActiveDays, 2);
  assert.equal(twoDays.repeatUsers, 2);
  assert.ok(Math.abs(twoDays.rate! - 200 / 3) < 1e-12);
});

test('five-day threshold uses distinct nonconsecutive dates and does not alter frequency evidence', () => {
  const dates = ['2026-10-20', '2026-10-22', '2026-10-24', '2026-10-26', '2026-10-28'];
  const records = dates.flatMap((date, i) => [row(`a${i}`, 'C1', date), ...(i < 4 ? [row(`b${i}`, 'C2', date)] : [])]);
  const result = analyzeRepeatUsage(records, dates[0], current, undefined, 5);
  assert.equal(result.minimumActiveDays, 5);
  assert.equal(result.status, 'available');
  assert.equal(result.repeatUsers, 1);
  assert.equal(result.totalUsers, 2);
  assert.equal(result.rate, 50);
  assert.equal(result.users[0].activeDays, 5);
  assert.equal(result.users[0].longestStreak, 1);
  assert.equal(result.daysWithoutLogs, 5);
});

test('threshold beyond the period or observed coverage is unavailable rather than zero', () => {
  const records = [row('a', 'C1', prior), row('b', 'C1', current)];
  const short = analyzeRepeatUsage(records, prior, current);
  assert.equal(short.status, 'insufficient_period');
  assert.equal(short.minimumActiveDays, 3);
  assert.equal(short.rate, null);
  assert.equal(short.repeatUsers, 0);
  const missing = analyzeRepeatUsage(records, '2026-10-27', current);
  assert.equal(missing.status, 'insufficient_logs');
  assert.equal(missing.rate, null);
  const zero = analyzeRepeatUsage([...records, row('c', 'browser', '2026-10-27')], '2026-10-27', current);
  assert.equal(zero.status, 'available', 'all-scene browser activity can establish observed coverage without entering either account count');
  assert.equal(zero.observedDays, 3);
  assert.equal(zero.totalUsers, 1);
  assert.equal(zero.repeatUsers, 0);
  assert.equal(zero.rate, 0);
});

test('repeat thresholds accept only supported safe whole numbers and default safely everywhere', () => {
  for (const value of [2, 3, 5, 3660]) assert.equal(normalizeRepeatDays(value), value);
  for (const value of [undefined, null, '', '5', true, 0, 1, -3, 2.5, NaN, Infinity, 3661, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeRepeatDays(value), 3);
  }
  for (const value of [0, 1, 2.5, NaN, Infinity, 3661]) {
    const result = analyzeRepeatUsage([], '', '', undefined, value);
    assert.equal(result.status, 'invalid_range');
    assert.equal(result.minimumActiveDays, 3, 'invalid dates still retain the effective threshold');
  }
});

test('N-day window counts a return on any follow-up day once, excludes new users and baseline repeats',()=>{
 const records=[row('a','A','2026-10-21'),row('b','B','2026-10-21'),row('c','C','2026-10-21'),row('aa','A','2026-10-21'),row('r1','A','2026-10-22'),row('r2','A','2026-10-23'),row('r3','B','2026-10-28'),row('new','NEW','2026-10-28'),row('outside','C','2026-10-29')];
 for(let d=22;d<=28;d++)records.push(row(`coverage${d}`,'browser',`2026-10-${d}`));
 const result=analyzeRetention(records,'2026-10-28','2026-10-28','',7).latest;
 assert.equal(result.previousDate,'2026-10-21');assert.equal(result.windowStart,'2026-10-22');assert.equal(result.windowDays,7);assert.equal(result.observedWindowDays,7);assert.equal(result.previousUsers,3);assert.equal(result.retainedUsers,2);assert.equal(result.rate,2/3*100);assert.deepEqual(result.retainedClientIds,['A','B']);assert.deepEqual(result.notObservedClientIds,['C']);
 const incomplete=analyzeRetention(records.filter(r=>r.date!=='2026-10-25'),'2026-10-28','2026-10-28','',7).latest;
 assert.equal(incomplete.rate,null);assert.equal(incomplete.status,'missing_current_logs');assert.equal(incomplete.observedWindowDays,6);
});

test('rolling counted unions expire accounts correctly and match independent cohorts',()=>{
 const records:LogRecord[]=[];
 for(let day=1;day<=15;day++){records.push(row(`coverage${day}`,'browser',`2026-10-${String(day).padStart(2,'0')}`));for(let id=0;id<5;id++)if((day+id)%(id+2)===0)records.push(row(`${day}-${id}`,`U${id}`,`2026-10-${String(day).padStart(2,'0')}`));}
 const result=analyzeRetention(records,'2026-10-04','2026-10-15','',3);
 for(const d of result.daily){const baseline=new Set(records.filter(r=>r.date===d.previousDate&&r.clientId!=='browser').map(r=>r.clientId));const returned=new Set(records.filter(r=>r.date>d.previousDate&&r.date<=d.date).map(r=>r.clientId));const expected=[...baseline].filter(id=>returned.has(id)).length;assert.equal(d.retainedUsers,expected);assert.equal(d.rate,baseline.size?expected/baseline.size*100:null);}
});

test('consecutive reuse distinguishes spaced dates, respects boundaries and keeps the denominator',()=>{
 const records=[row('a1','A','2026-10-21'),row('a2','A','2026-10-23'),row('a3','A','2026-10-25'),row('b1','B','2026-10-21','MML'),row('b2','B','2026-10-22','MML'),row('b3','B','2026-10-23','MML'),row('c','C','2026-10-25')];
 const any=analyzeRepeatUsage(records,'2026-10-21','2026-10-25','',3,'any'),consecutive=analyzeRepeatUsage(records,'2026-10-21','2026-10-25','',3,'consecutive');
 assert.equal(any.repeatUsers,2);assert.equal(consecutive.repeatUsers,1);assert.equal(consecutive.totalUsers,3);assert.equal(consecutive.rate,1/3*100);assert.equal(consecutive.mode,'consecutive');
 assert.equal(analyzeRepeatUsage(records,'2026-10-22','2026-10-25','',3,'consecutive').repeatUsers,0);
 assert.equal(analyzeRepeatUsage(records,'2026-10-21','2026-10-25','MML',3,'consecutive').rate,100);
});
