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
  assert.equal(report.topQuestions.length, 20);
  assert.equal(report.customQuestions.length, 10);
  assert.equal(report.customAuthors.length, 10);
  assert.equal(report.daily.length, 31);
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
  assert.ok(JSON.stringify(report).length < 25000);
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
