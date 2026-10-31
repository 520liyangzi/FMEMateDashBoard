import assert from 'node:assert/strict';
import test from 'node:test';
import type { LogRecord } from './analytics.ts';
import { buildAiFacts, type AiFactsInput } from './ai-reporting.ts';

const row = (taskId: string, clientId: string, date: string, question = 'Check temperature', answer = 'OK', scene = 'Diagnosis'): LogRecord => ({
  taskId, clientId, date, question, answer, scene, time: `${date}T16:57:00`,
});
const facts = (partial: Partial<AiFactsInput> = {}) => buildAiFacts({
  records: [], presets: ['Which cell is faulty?'], groups: [], feedback: [], failureNotes: {},
  from: '2026-10-22', to: '2026-10-23', scene: '', demo: false, ...partial,
});

test('AI facts preserve canonical browser, MML, presets and unique-person rules', () => {
  const report = facts({ records: [
    row('old', 'yangzi', '2026-10-21'),
    row('1', 'browser', '2026-10-22', 'which CELL is faulty'),
    row('2', ' BROWSER ', '2026-10-22', 'Run command', '', ' mml '),
    row('3', 'yangzi', '2026-10-22', 'My own question', 'Sorry, unavailable'),
    row('4', 'yangzi', '2026-10-23', 'which cell is faulty？'),
    row('5', 'browser', '2026-10-23', 'My own question'),
  ], failureNotes: { '3': 'Upstream gateway unavailable', unrelated: 'do not include' } });
  assert.equal(report.totals.uses, 5);
  assert.equal(report.totals.users, 1);
  assert.equal(report.totals.browserUses, 3);
  assert.equal(report.totals.custom, 2);
  assert.equal(report.totals.customUsers, 1);
  assert.equal(report.totals.mmlEmpty, 1);
  assert.equal(report.totals.returningUsers, 1);
  assert.deepEqual(report.daily.map(day => day.users), [1, 1]);
  assert.deepEqual(report.topUsers.map(user => user.clientId), ['yangzi']);
  assert.deepEqual(report.customAuthors, [{ clientId: 'yangzi', customQuestions: 1 }]);
  assert.equal(report.topQuestions.find(question => question.isPreset)!.uses, 2);
  assert.equal(report.customQuestions[0].uses, 2);
  assert.equal(report.failures.total, 1);
  assert.equal(report.failures.withSavedReason, 1);
  assert.equal(report.failures.examples[0].reason, 'Upstream gateway unavailable');
  assert.equal(report.previous.hasUsageBaseline, true);
  assert.equal(report.changes.uses, 400);
  assert.match(report.methodology.join(' '), /Actual people behind browser are unknown/);
  assert.ok(!JSON.stringify(report).includes('unrelated'));
});

test('group comparison matches explicit snapshot dates and never invents missing daily growth', () => {
  const report = facts({ groups: [
    { date: '2026-10-18', count: 70 }, { date: '2026-10-22', count: 80 },
    { date: '2026-10-23', count: 85 }, { date: '2026-10-23', count: 90 },
    { date: '2026-10-24', count: 100 },
  ] });
  assert.deepEqual(report.community.baseline, { date: '2026-10-18', count: 70 });
  assert.deepEqual(report.community.latest, { date: '2026-10-23', count: 90 });
  assert.equal(report.community.comparison.netChange, 20);
  assert.equal(report.community.comparison.fromDate, '2026-10-18');
  assert.equal(report.community.comparison.coverage, 'prior-snapshot-to-latest-in-period');
  assert.equal(report.community.records.length, 2, 'same-day entries replace the total rather than add members');
  assert.equal(report.community.comparison.growthPercent, 20 / 70 * 100);

  const noPrior = facts({ groups: [{ date: '2026-10-22', count: 0 }, { date: '2026-10-23', count: 5 }] });
  assert.equal(noPrior.community.comparison.netChange, 5);
  assert.equal(noPrior.community.comparison.growthPercent, null);
  assert.equal(noPrior.community.comparison.coverage, 'first-to-last-recorded-in-period');
  const sameDay = facts({ from: '2026-10-23', groups: [{ date: '2026-10-23', count: 25 }] });
  assert.equal(sameDay.community.comparison.netChange, null);
  assert.equal(sameDay.community.comparison.growthPercent, null);
  assert.equal(sameDay.community.comparison.coverage, 'one-date-only');
  const noneInRange = facts({ groups: [{ date: '2026-10-21', count: 20 }] });
  assert.equal(noneInRange.community.latest, null);
  assert.equal(noneInRange.community.comparison.netChange, null);
});

test('AI evidence is bounded, reports omissions, keeps complete totals and never embeds screenshot bytes', () => {
  const records = Array.from({ length: 80 }, (_, i) => row(String(i), `client-${i}`, `2026-10-${String(i % 23 + 1).padStart(2, '0')}`, `Question ${i}`, `Sorry ${i}`));
  const feedback = Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, date: '2026-10-23', author: `author-${i}`, text: i ? 'Useful feedback' : '', imageUrl: 'data:image/png;base64,DO-NOT-SEND-IMAGE' }));
  const report = facts({ records, from: '2026-01-01', to: '2026-10-23', feedback });
  assert.equal(report.totals.uses, 80);
  assert.equal(report.failures.total, 80);
  assert.equal(report.failures.examples.length, 10);
  assert.equal(report.topUsers.length, 10);
  assert.equal(report.repeatUsage.topUsers.length, 10);
  assert.equal(report.repeatUsage.totalUsers, 80);
  assert.equal(report.repeatUsage.coverage.omitted, 70);
  assert.equal(report.topQuestions.length, 20);
  assert.equal(report.customQuestions.length, 10);
  assert.equal(report.customAuthors.length, 10);
  assert.equal(report.daily.length, 31);
  assert.equal(report.retention.daily.length, 31);
  assert.equal(report.retention.latest.date, '2026-10-23');
  assert.ok(report.retention.coverage.omittedDays > 0);
  assert.equal(report.evidence.coverage.retentionDaily.included, 31);
  assert.equal(report.evidence.coverage.failureExamples.omitted, 70);
  assert.equal(report.evidence.coverage.topQuestions.available, 80);
  assert.equal(report.community.feedbackCount, 20);
  assert.equal(report.community.feedback.length, 10);
  assert.equal(report.community.screenshotCount, 20);
  assert.equal(report.community.feedback.find(entry => entry.author === 'author-0')!.text, '');
  assert.ok(report.community.feedback.every(entry => entry.hasScreenshot));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('DO-NOT-SEND-IMAGE'));
  assert.ok(!serialized.includes('imageUrl'));
});

test('long untrusted text is visibly truncated without broken surrogate pairs', () => {
  const report = facts({ records: [row('t'.repeat(1000), 'u'.repeat(1000), '2026-10-23', '😀'.repeat(2000), 'Sorry ' + 'a'.repeat(10000), 's'.repeat(1000))],
    failureNotes: { ['t'.repeat(1000)]: 'r'.repeat(10000) },
    feedback: [{ id: 'f1', date: '2026-10-23', author: 'a'.repeat(1000), text: '😀'.repeat(10000), imageUrl: '/uploads/screenshot.png' }],
  });
  assert.ok(report.evidence.truncatedStrings >= 8);
  assert.ok(report.evidence.truncatedFields.includes('failures.examples[0].reason'));
  assert.match(report.topQuestions[0].question, /\[truncated\]$/);
  assert.ok(!/[\uD800-\uDFFF]/u.test(report.topQuestions[0].question), 'no lone surrogate code points');
  assert.ok(!/[\uD800-\uDFFF]/u.test(report.community.feedback[0].text), 'no lone surrogate code points');
  assert.ok(JSON.stringify(report).length < 30000);
});

test('empty data and absent baselines produce explicit nulls, never nonfinite numbers', () => {
  for (const report of [facts(), facts({ records: [row('one', 'browser', '2026-10-23')] }), facts({ groups: [{ date: 'bad-date', count: NaN }, { date: '2026-10-23', count: Infinity }] })]) {
    const visit = (value: unknown) => {
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(report);
    assert.equal(report.previous.hasUsageBaseline, false);
    assert.equal(report.changes.failureRate, null);
    assert.equal(report.community.comparison.netChange, null);
  }
  assert.equal(facts({ records: [row('one', 'browser', '2026-10-23')] }).changes.uses, null);
});

test('scene filtering applies to usage while community evidence keeps date scope', () => {
  const report = facts({ scene: '\u0000', records: [row('1', 'yangzi', '2026-10-23', 'q', '', ''), row('2', 'yangzi', '2026-10-23')],
    groups: [{ date: '2026-10-22', count: 10 }, { date: '2026-10-23', count: 11 }],
    feedback: [{ id: 'f', date: '2026-10-23', author: 'a', text: 'A saved observation' }, { id: 'old', date: '2026-10-21', author: 'a', text: 'out of scope' }],
  });
  assert.equal(report.totals.uses, 1);
  assert.equal(report.community.feedbackCount, 1);
  assert.equal(report.community.comparison.netChange, 1);
  assert.equal(report.range.scene, '\u0000');
});

test('AI retention facts describe the prior-day cohort rather than period or new users', () => {
  const report = facts({ records: [
    row('1', 'alice', '2026-10-22'), row('2', 'bob', '2026-10-22'), row('3', 'browser', '2026-10-22'),
    row('4', 'alice', '2026-10-23'), row('5', 'newcomer', '2026-10-23'), row('6', ' BROWSER ', '2026-10-23'),
  ] });
  assert.equal(report.totals.users, 3, 'period users include the current-day newcomer');
  assert.equal(report.retention.latest.date, '2026-10-23');
  assert.equal(report.retention.latest.previousDate, '2026-10-22');
  assert.equal(report.retention.latest.previousUsers, 2);
  assert.equal(report.retention.latest.retainedUsers, 1);
  assert.equal(report.retention.latest.rate, 50);
  assert.equal(report.retention.latest.previousBrowserUses, 1);
  assert.equal(report.retention.latest.currentBrowserUses, 1);
  assert.equal(report.retention.latest.status, 'available');
  assert.ok(!Object.values(report.retention.latest).some(Array.isArray), 'no full cohort ID lists enter the writing prompt');
  assert.ok(!JSON.stringify(report.retention).includes('ClientIds'));
  assert.match(report.retention.coverage.limitations, /not confirmed complete/);
  assert.match(report.methodology.join(' '), /not a first-use or registration cohort/);
});

test('AI retention leaves missing strict prior-day evidence unavailable and respects scene cohorts', () => {
  const gap = facts({ records: [row('1', 'alice', '2026-10-21'), row('2', 'alice', '2026-10-23')] });
  assert.equal(gap.retention.latest.previousDate, '2026-10-22');
  assert.equal(gap.retention.latest.rate, null);
  assert.equal(gap.retention.latest.status, 'missing_previous_logs');
  const missingRangeEnd = facts({ to: '2026-10-24', records: [row('1', 'alice', '2026-10-22'), row('2', 'alice', '2026-10-23')] });
  assert.equal(missingRangeEnd.retention.latest.date, '2026-10-24', 'latest means the selected end rather than the last observed usage date');
  assert.equal(missingRangeEnd.retention.latest.status, 'missing_current_logs');
  assert.equal(missingRangeEnd.retention.latest.rate, null);
  const sceneFiltered = facts({ scene: 'Diagnosis', records: [
    row('1', 'alice', '2026-10-22'), row('2', 'alice', '2026-10-23', 'Check temperature', '', 'MML'),
  ] });
  assert.equal(sceneFiltered.retention.latest.previousUsers, 1);
  assert.equal(sceneFiltered.retention.latest.retainedUsers, 0);
  assert.equal(sceneFiltered.retention.latest.rate, 0, 'an observed day with usage in another scene is not missing logs');
  assert.equal(sceneFiltered.retention.latest.status, 'available');
  const emptyAndNamed = [
    row('e1', 'empty-user', '2026-10-22', 'q', '', ''), row('e2', 'empty-user', '2026-10-23', 'q', '', ''),
    row('a1', 'old-all-user', '2026-10-22', 'q', '', 'all'), row('a2', 'new-all-user', '2026-10-23', 'q', '', 'all'),
  ];
  assert.equal(facts({ scene: '\u0000', records: emptyAndNamed }).retention.latest.rate, 100);
  assert.equal(facts({ scene: 'all', records: emptyAndNamed }).retention.latest.rate, 0);
});

test('period repeat facts distinguish six of ten repeated users from prior-day and historical users', () => {
  const records = Array.from({ length: 10 }, (_, i) => row(`current-${i}`, `user-${i}`, '2026-10-23'));
  records.push(...Array.from({ length: 6 }, (_, i) => row(`prior-${i}`, `user-${i}`, '2026-10-22')));
  records.push(row('first-day', 'user-0', '2026-10-21'));
  records.push(...['21', '22', '23'].map(date => row(`browser-${date}`, 'browser', `2026-10-${date}`)));
  const report = facts({ from: '2026-10-21', records, minimumActiveDays: 2 });
  assert.equal(report.repeatUsage.status, 'available');
  assert.deepEqual(report.repeatUsage.range, { from: '2026-10-21', to: '2026-10-23', days: 3 });
  assert.equal(report.repeatUsage.totalUsers, 10);
  assert.equal(report.repeatUsage.repeatUsers, 6);
  assert.equal(report.repeatUsage.rate, 60);
  assert.equal(report.totals.returningUsers, 0, 'historical returning users differ from cross-day repeat users');
  assert.equal(report.retention.latest.rate, 100, 'all six prior-day users returned, although period repeat usage is 60%');
  const longest = report.repeatUsage.topUsers[0];
  assert.equal(longest.clientId, 'user-0');
  assert.equal(longest.activeDays, 3);
  assert.equal(longest.activeDayShare, 100);
  assert.equal(longest.longestStreak, 3);
  assert.equal(report.repeatUsage.observedDays, 3);
  assert.equal(report.repeatUsage.daysWithoutLogs, 0);
  assert.ok(!report.repeatUsage.topUsers.some(user => user.clientId === 'browser'));
});

test('period repeat facts keep unknown log days and unavailable short-range rates explicit', () => {
  const report = facts({ from: '2026-10-20', minimumActiveDays: 2, records: [row('1', 'alice', '2026-10-21'), row('2', 'alice', '2026-10-23')] });
  assert.equal(report.repeatUsage.rate, 100);
  assert.equal(report.repeatUsage.observedDays, 2);
  assert.equal(report.repeatUsage.daysWithoutLogs, 2);
  assert.equal(report.repeatUsage.topUsers[0].activeDayShare, 50);
  assert.equal(report.repeatUsage.topUsers[0].longestStreak, 1, 'unobserved dates do not join two streaks');
  assert.match(report.repeatUsage.coverage.limitations, /not confirmed inactivity/);
  const single = facts({ from: '2026-10-23', records: [row('one', 'alice', '2026-10-23')] });
  assert.equal(single.repeatUsage.status, 'single_day_range');
  assert.equal(single.repeatUsage.rate, null);
  const oneObservedDay = facts({ minimumActiveDays: 2, records: [row('one', 'alice', '2026-10-23')] });
  assert.equal(oneObservedDay.repeatUsage.status, 'insufficient_logs');
  assert.equal(oneObservedDay.repeatUsage.rate, null);
});


test('AI repeat facts use the default three-day threshold and a selected five-day threshold', () => {
  const records = Array.from({ length: 5 }, (_, i) => row(`alice-${i}`, 'alice', `2026-10-${20 + i}`));
  records.push(...Array.from({ length: 3 }, (_, i) => row(`bob-${i}`, 'bob', `2026-10-${20 + i}`)));
  records.push(row('carol', 'carol', '2026-10-24'));
  records.push(...Array.from({ length: 5 }, (_, i) => row(`browser-${i}`, 'browser', `2026-10-${20 + i}`)));
  const defaults = facts({ from: '2026-10-20', to: '2026-10-24', records });
  assert.equal(defaults.repeatUsage.minimumActiveDays, 3);
  assert.equal(defaults.repeatUsage.repeatUsers, 2);
  assert.equal(defaults.repeatUsage.totalUsers, 3);
  assert.equal(defaults.repeatUsage.rate, 2 / 3 * 100);
  assert.match(defaults.repeatUsage.coverage.definition, /at least 3 distinct calendar dates/);
  const selected = facts({ from: '2026-10-20', to: '2026-10-24', minimumActiveDays: 5, records });
  assert.equal(selected.repeatUsage.minimumActiveDays, 5);
  assert.equal(selected.repeatUsage.repeatUsers, 1);
  assert.equal(selected.repeatUsage.rate, 1 / 3 * 100);
  assert.match(selected.repeatUsage.coverage.definition, /at least 5 distinct calendar dates/);
  assert.match(selected.methodology.join(' '), /selected minimumActiveDays threshold of 5/);
  const tooShort = facts({ from: '2026-10-20', to: '2026-10-23', minimumActiveDays: 5, records });
  assert.equal(tooShort.repeatUsage.status, 'insufficient_period');
  assert.equal(tooShort.repeatUsage.rate, null);
  const sparse = facts({ from: '2026-10-20', to: '2026-10-24', minimumActiveDays: 5, records: records.filter(record => record.date !== '2026-10-24') });
  assert.equal(sparse.repeatUsage.status, 'insufficient_logs');
  assert.equal(sparse.repeatUsage.rate, null);
});

test('MTTR facts use independent weighted close-date periods and include no raw ticket or filename data', () => {
  const report = facts({
    scene: 'MML',
    mttrBaseline: { from: '2026-09-01', to: '2026-09-07' },
    mttrCurrent: { from: '2026-09-08', to: '2026-09-14' },
    mttr: {
      filename: 'PRIVATE-TICKET-NAME.xlsx', importedAt: '2026-10-31T09:00:00Z', formatVersion: 3, totalJobs: 8,
      sourceRows: 12, matchedRows: 10, validRows: 8, invalidDates: 1, negativeDurations: 1, excludedRows: 2,
      earliestDate: '2026-09-01', latestDate: '2026-09-14', days: [
        { date: '2026-09-01', count: 1, totalSeconds: 3600 },
        { date: '2026-09-07', count: 3, totalSeconds: 25200 },
        { date: '2026-09-14', count: 4, totalSeconds: 14400 },
      ],
    },
  });
  const mttr = report.effectiveness.mttr;
  assert.equal(mttr.status, 'available');
  assert.equal(mttr.baseline.meanSeconds, 7200, 'whole-ticket weighted mean, not mean of daily means');
  assert.equal(mttr.current.meanSeconds, 3600);
  assert.equal(mttr.reductionRate, 50);
  assert.equal(mttr.savedSeconds, 3600);
  assert.equal(mttr.baseline.count, 4);
  assert.equal(mttr.current.count, 4);
  assert.equal(mttr.dataQuality!.invalidDates, 1);
  assert.equal(mttr.dataQuality!.negativeDurations, 1);
  assert.equal(report.range.from, '2026-10-22', 'MTTR dates are independent of app dates');
  assert.ok(!JSON.stringify(report).includes('PRIVATE-TICKET-NAME'));
  assert.match(mttr.definition, /without filtering TT status/);
  assert.match(mttr.limitations, /does not establish FMEMate causation/);
});

test('MTTR absent data and zero baseline remain unavailable in AI evidence', () => {
  const none = facts().effectiveness.mttr;
  assert.equal(none.status, 'no_dataset');
  assert.equal(none.reductionRate, null);
  assert.equal(none.dataQuality, null);
  const zero = facts({ mttrBaseline: { from: '2026-10-01', to: '2026-10-01' }, mttrCurrent: { from: '2026-10-02', to: '2026-10-03' }, mttr: {
    filename: '', importedAt: '', formatVersion: 3, totalJobs: 2, sourceRows: 2, matchedRows: 2, validRows: 2, invalidDates: 0, negativeDurations: 0, excludedRows: 0,
    earliestDate: '2026-10-01', latestDate: '2026-10-02', days: [{ date: '2026-10-01', count: 1, totalSeconds: 0 }, { date: '2026-10-02', count: 1, totalSeconds: 3600 }],
  } }).effectiveness.mttr;
  assert.equal(zero.status, 'zero_baseline');
  assert.equal(zero.reductionRate, null);
  assert.equal(zero.unequalDays, true);
});

test('MTTR v2 facts distinguish accumulated unique tickets from latest-file counts and legacy provenance', () => {
  const data = {
    filename: 'private-file.xlsx', importedAt: '2026-10-31T09:00:00Z',
    formatVersion: 2 as const, totalTickets: 1000, addedRows: 2, duplicateRows: 7, missingIds: 1,
    sourceRows: 15, matchedRows: 12, validRows: 9, invalidDates: 1, negativeDurations: 1, excludedRows: 3,
    earliestDate: '2026-10-01', latestDate: '2026-10-31',
    days: [{ date: '2026-10-22', count: 1000, totalSeconds: 3600000 }],
  };
  const mttr = facts({ mttr: data }).effectiveness.mttr;
  assert.equal(mttr.dataQuality!.totalTickets, 1000);
  assert.equal(mttr.dataQuality!.sourceRows, 15);
  assert.equal(mttr.dataQuality!.addedRows, 2);
  assert.equal(mttr.dataQuality!.duplicateRows, 7);
  assert.equal(mttr.dataQuality!.missingIds, 1);
  assert.equal(mttr.dataQuality!.deduplication, 'selected-ticket-id-trimmed-case-sensitive-first-valid-wins');
  assert.match(mttr.dataQuality!.countsScope, /latest imported file only/);
  assert.match(mttr.limitations, /Reimport both TT and JOB tables/);
  assert.ok(!mttr.limitations.includes('replaces the previous dataset'));
  const { formatVersion, totalTickets, addedRows, duplicateRows, missingIds, ...legacy } = data;
  const old = facts({ mttr: legacy }).effectiveness.mttr;
  assert.equal(old.dataQuality!.totalTickets, null, 'never infer unique totals from legacy row counts');
  assert.equal(old.dataQuality!.deduplication, 'legacy-unverified-reimport-required');
  assert.match(old.limitations, /Reimport both TT and JOB tables/);
});

test('MTTR facts preserve selected column mapping and bounded header labels without assuming fixed positions', () => {
  const report = facts({ mttr: {
    filename: 'private-source.csv', importedAt: '2026-10-31T09:00:00Z', formatVersion: 2,
    totalTickets: 2, sourceRows: 2, matchedRows: 2, validRows: 2, invalidDates: 0, negativeDurations: 0, excludedRows: 0,
    earliestDate: '2026-10-22', latestDate: '2026-10-23',
    columnMapping: { B: 'D', F: 'A', J: 'Q', S: 'L', U: 'C' },
    headerColumns: { B: 'Ticket number', F: 'creation_date', J: 'actual_close_time', S: 'ticket_status', U: 'classification' + 'x'.repeat(500) },
    days: [{ date: '2026-10-22', count: 1, totalSeconds: 3600 }, { date: '2026-10-23', count: 1, totalSeconds: 1800 }],
  } });
  const data = report.effectiveness.mttr;
  assert.deepEqual(data.dataQuality!.columnMapping, { B: 'D', F: 'A', J: 'Q', S: 'L', U: 'C' });
  assert.equal(data.dataQuality!.headerColumns!.J, 'actual_close_time');
  assert.match(data.dataQuality!.headerColumns!.U, /\[truncated\]/);
  assert.equal(report.evidence.truncatedStrings, 1);
  assert.match(data.definition, /LEGACY SINGLE-TABLE DATA/);
  assert.equal(data.businessRule, 'legacy-single-table-reimport-TT-and-JOB-required');
  const noMapping = facts().effectiveness.mttr;
  assert.equal(noMapping.dataQuality, null);
});

test('v3 MTTR AI facts keep global overall/ranking separate from person scope with bounded evidence', () => {
  const personDays = [
    { assignee: 'A', date: '2026-10-21', count: 2, totalSeconds: 72000 },
    { assignee: 'A', date: '2026-10-22', count: 2, totalSeconds: 14400 },
    { assignee: 'B', date: '2026-10-21', count: 1, totalSeconds: 360000 },
    { assignee: 'B', date: '2026-10-22', count: 1, totalSeconds: 180000 },
    { assignee: '', date: '2026-10-21', count: 1, totalSeconds: 36000 },
    { assignee: '', date: '2026-10-22', count: 1, totalSeconds: 360 },
    { assignee: 'Missing current', date: '2026-10-21', count: 1, totalSeconds: 36000 },
    { assignee: 'Zero baseline', date: '2026-10-21', count: 1, totalSeconds: 0 },
    { assignee: 'Zero baseline', date: '2026-10-22', count: 1, totalSeconds: 36000 },
    ...Array.from({ length: 25 }, (_, i) => [
      { assignee: `Person-${i}`, date: '2026-10-21', count: 1, totalSeconds: 36000 },
      { assignee: `Person-${i}`, date: '2026-10-22', count: 1, totalSeconds: 18000 },
    ]).flat(),
  ];
  const days = ['2026-10-21', '2026-10-22'].map(date => ({ date,
    count: personDays.filter(row => row.date === date).reduce((n, row) => n + row.count, 0),
    totalSeconds: personDays.filter(row => row.date === date).reduce((n, row) => n + row.totalSeconds, 0),
  }));
  const mttr = { formatVersion: 3 as const, filename: 'PRIVATE-JOIN.csv', importedAt: '2026-10-31T09:00:00Z',
    sourceRows: 100, matchedRows: 70, validRows: 61, invalidDates: 0, negativeDurations: 0, excludedRows: 30,
    totalJobs: 61, totalTickets: 61, storedJobs: 70, storedTtIds: 15, earliestDate: '2026-10-21', latestDate: '2026-10-22', days, personDays,
    mappings: { tt: { ttId: 'B', category: 'U' }, job: { jobId: 'A', ttId: 'C', created: 'G', finished: 'I', assignee: 'AG', status: 'AR' } },
    sourceHeaders: { tt: { ttId: 'tt_id', category: 'category' }, job: { jobId: 'jb_id', ttId: 'tt_id', created: 'create_date', finished: 'finish_date', assignee: 'assignee', status: 'jb_status' } },
  };
  const base = { mttr, mttrBaseline: { from: '2026-10-21', to: '2026-10-21' }, mttrCurrent: { from: '2026-10-22', to: '2026-10-22' } };
  const overall = facts(base).effectiveness.mttr;
  const selected = facts({ ...base, mttrAssignee: 'B' }).effectiveness.mttr;
  assert.equal(selected.businessRule, 'TT-category-filter-joined-to-completed-JOB-by-TT-ID');
  assert.equal(selected.reductionRate, 50);
  assert.deepEqual(selected.selectedScope, { type: 'assignee', assignee: 'B', requestedLegacyAssigneeUnavailable: false });
  assert.deepEqual(selected.overall, overall.overall, 'selected person never changes overall denominator');
  assert.deepEqual(selected.people, overall.people, 'ranking is global regardless of selected person');
  assert.equal(selected.people.ranking[0].assignee, 'A');
  assert.equal(selected.people.ranking[0].comparison.reductionRate, 80);
  assert.equal(selected.people.ranking[0].comparison.baseline.count, 2);
  assert.equal(selected.people.ranking[0].comparison.baseline.meanSeconds, 36000);
  assert.equal(selected.people.ranking.length, 20);
  assert.equal(selected.people.rankingCoverage.omitted, 7);
  assert.equal(selected.people.unrankedCount, 3);
  assert.ok(selected.people.unrankedExamples.every(row => row.rank === null));
  assert.ok(selected.people.unrankedExamples.some(row => row.assignee === ''));
  assert.match(selected.people.definition, /highest percentage does not necessarily have the largest absolute/);
  assert.equal(selected.dataQuality!.totalJobs, 61);
  assert.equal(selected.dataQuality!.totalTickets, 61);
  assert.equal(selected.dataQuality!.storedJobs, 70);
  assert.equal(selected.dataQuality!.storedTtIds, 15);
  assert.match(selected.dataQuality!.countsScope, /totalTickets is a compatibility alias equal to totalJobs/);
  assert.equal(selected.dataQuality!.mappings!.job!.finished, 'I');
  assert.equal(selected.dataQuality!.sourceHeaders!.job!.finished, 'finish_date');
  assert.match(selected.definition, /without filtering TT status/);
  assert.match(selected.definition, /multiple Jobs for one TT are separate observations/);
  assert.ok(!JSON.stringify(selected).includes('PRIVATE-JOIN'));
  const unassigned = facts({ ...base, mttrAssignee: '' }).effectiveness.mttr;
  assert.equal(unassigned.selectedScope.type, 'assignee');
  assert.equal(unassigned.selectedScope.assignee, '');
  assert.equal(unassigned.baseline.count, 1);
  const legacy = facts({ ...base, mttr: { ...mttr, formatVersion: 2 }, mttrAssignee: 'B' }).effectiveness.mttr;
  assert.equal(legacy.people.available, false);
  assert.equal(legacy.reductionRate, null);
  assert.equal(legacy.baseline.meanSeconds, null);
  assert.equal(legacy.current.meanSeconds, null);
  assert.equal(legacy.overall.reductionRate, null);
  assert.equal(legacy.overall.baseline.count, 0);
  assert.equal(legacy.dataQuality!.totalJobs, 61, 'legacy metadata is preserved without presenting old-rule calculations');
  assert.equal(legacy.people.ranking.length, 0);
  assert.equal(legacy.selectedScope.requestedLegacyAssigneeUnavailable, true);
});

test('MTTR AI evidence reports explicit repair counts and defaults missing policy to keep without inventing date causes', () => {
  const mttr = { formatVersion: 3 as const, filename: '', importedAt: '', totalJobs: 2, totalTickets: 2,
    sourceRows: 2, matchedRows: 2, validRows: 2, invalidDates: 0, negativeDurations: 0, excludedRows: 0,
    earliestDate: '2026-10-31', latestDate: '2026-12-14',
    days: [{ date: '2026-10-31', count: 1, totalSeconds: 7200 }, { date: '2026-12-14', count: 1, totalSeconds: 3600 }],
  };
  const input = { mttr, mttrBaseline: { from: '2026-10-31', to: '2026-10-31' }, mttrCurrent: { from: '2026-12-14', to: '2026-12-14' } };
  const original = facts(input).effectiveness.mttr;
  assert.equal(original.dataQuality!.duplicatePolicy, 'keep');
  assert.equal(original.dataQuality!.updatedJobs, 0);
  assert.equal(original.current.to, '2026-12-14', 'future-looking imported dates are not silently hidden');
  assert.equal(original.reductionRate, 50);
  const repaired = facts({ ...input, mttr: { ...mttr, duplicatePolicy: 'update', updatedJobs: 1 } }).effectiveness.mttr;
  assert.equal(repaired.dataQuality!.duplicatePolicy, 'update');
  assert.equal(repaired.dataQuality!.updatedJobs, 1);
  assert.equal(repaired.dataQuality!.totalJobs, 2, 'updated records are not new Jobs');
  assert.match(repaired.definition, /Within each file, the first valid occurrence wins/);
  assert.match(repaired.definition, /only an explicit update policy replaces an existing Job/);
  assert.match(repaired.limitations, /not why their prior dates differed/);
});
