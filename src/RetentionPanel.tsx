import { ArrowRight, CalendarDays, Info, Repeat2, Users } from 'lucide-react';
import type { RetentionAnalysis, RetentionDay } from '../lib/retention.ts';
import './retention.css';

type Language = 'zh' | 'en';
export type RetentionPanelProps = { lang: Language; retention: RetentionAnalysis; compact?: boolean };

/** Repeat use is measured against the previous calendar day's identifiable cohort. */
export default function RetentionPanel({ lang, retention, compact = false }: RetentionPanelProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const latest = retention.latest;
  const available = (day: RetentionDay) => day.status === 'available' && day.rate !== null && Number.isFinite(day.rate);
  const percentage = (day: RetentionDay) => available(day) ? `${day.rate!.toFixed(1)}%` : '—';
  const count = (value: number) => value.toLocaleString('en-US');
  const previousKnown = (day: RetentionDay) => day.status !== 'invalid_range' && day.status !== 'missing_previous_logs';
  const statusText = (day: RetentionDay) => {
    switch (day.status) {
      case 'available': return t('基于已导入日志', 'Based on imported logs');
      case 'missing_previous_logs': return t('前一日暂无日志，待补全', 'Previous-day logs unavailable');
      case 'missing_current_logs': return t('比较日暂无日志，待补全', 'Comparison-day logs unavailable');
      case 'no_previous_users': return t('前一日无可识别用户', 'No identifiable previous-day users');
      default: return t('请选择有效日期范围', 'Choose a valid date range');
    }
  };
  const daily = [...retention.daily].sort((a, b) => b.date.localeCompare(a.date));
  const shownDays = daily.slice(0, 14);
  const hasRate = available(latest);
  const browserUses = latest.previousBrowserUses + latest.currentBrowserUses;
  const cohortList = (ids: string[]) => ids.length
    ? <><ul>{ids.slice(0, 100).map(id => <li key={id}>{id}</li>)}</ul>{ids.length > 100 && <p className="retention-cohort-limit">{t(`显示前 100 个账号，共 ${count(ids.length)} 个。`, `Showing the first 100 of ${count(ids.length)} accounts.`)}</p>}</>
    : <p className="retention-cohort-empty">{t('暂无账号', 'No accounts')}</p>;

  return <section className={`retention-panel card${compact ? ' retention-panel-compact' : ''}`} aria-label={t('次日留存率', 'Next-day retention')}>
    <div className="retention-heading"><div><span className="retention-kicker">REPEAT USE</span><h2><Repeat2 size={17}/>{t('次日留存率', 'Next-day retention')}</h2><p>{t('看前一天用过的人，第二天有多少继续使用。', 'How many of the previous day’s users use the app again the next day.')}</p></div><span className="retention-scope-label">{t('可识别账号 · 不含 browser', 'Identifiable accounts · browser excluded')}</span></div>
    <div className="retention-latest">
      <div className="retention-result"><span className="retention-date-pair"><CalendarDays size={14}/><span>{latest.previousDate || '—'}</span><ArrowRight size={12}/><strong>{latest.date || '—'}</strong></span><div className="retention-rate"><strong className={!hasRate ? 'retention-unavailable' : ''}>{percentage(latest)}</strong><span>{hasRate ? t(`${count(latest.retainedUsers)} / ${count(latest.previousUsers)} 个账号再次使用`, `${count(latest.retainedUsers)} / ${count(latest.previousUsers)} accounts used again`) : statusText(latest)}</span></div><div className={`retention-progress${hasRate ? '' : ' retention-progress-unknown'}`} aria-hidden="true"><span style={{ width: hasRate ? `${Math.max(0, Math.min(100, latest.rate!))}%` : '0%' }}/></div></div>
      <div className="retention-counts"><div><Users size={16}/><span>{t('前一日可识别用户', 'Previous-day identifiable users')}</span><strong>{previousKnown(latest) ? count(latest.previousUsers) : '—'}</strong></div><div><Repeat2 size={16}/><span>{t('其中次日再次使用', 'Of these, observed again next day')}</span><strong>{hasRate ? count(latest.retainedUsers) : '—'}</strong></div></div>
    </div>
    <p className="retention-formula">{t('计算：两天都使用的可识别账号数 ÷ 前一日可识别账号数 × 100%。', 'Calculation: identifiable accounts active on both days ÷ identifiable accounts active on the previous day × 100%.')}</p>
    <div className="retention-method-note"><Info size={14}/><p>{t('比较日取筛选结束日，按相邻自然日计算，不是所选区间的平均值；新增用户不计入分子。请在两天日志完整后再判断，当天未结束或日志未完整导入时仅供观察。', 'The comparison day is the filter end date, using consecutive calendar days rather than a period average. New users are excluded from the numerator. Compare after both days’ logs are complete; ongoing days and incomplete imports are provisional.')}{browserUses > 0 && <span>{t(`这两天另有 ${count(latest.previousBrowserUses)} / ${count(latest.currentBrowserUses)} 次 browser 使用记录，实际人数与再次使用情况无法确定。`, `The two days also contain ${count(latest.previousBrowserUses)} / ${count(latest.currentBrowserUses)} browser interactions; their actual people count and repeat use cannot be determined.`)}</span>}</p></div>
    {!compact && <>
      <p className="retention-detail-scope">{t('按当前 Scene 同时筛选两天；前一日可从当前日期范围之外读取。该指标反映持续使用，不代表付费、成交或群成员转化。', 'The current Scene filter applies to both days; the previous day may be outside the selected date range. This measures repeat use, rather than payment, sales or LINE group conversion.')}</p>
      {hasRate && <details className="retention-cohorts"><summary>{t('查看比较日的账号明细', 'View comparison-day account details')}<span>{t('仅反映日志中观察到的账号', 'Observed accounts only')}</span></summary><div className="retention-cohort-grid"><section><h3>{t('次日再次使用', 'Observed again next day')}<b>{count(latest.retainedClientIds.length)}</b></h3>{cohortList(latest.retainedClientIds)}</section><section><h3>{t('次日未观察到再次使用', 'Not observed again next day')}<b>{count(latest.notObservedClientIds.length)}</b></h3>{cohortList(latest.notObservedClientIds)}<p className="retention-cohort-caveat">{t('日志未观察到，不直接认定为用户流失。', 'An absent observation does not establish that a user has churned.')}</p></section></div></details>}
      <div className="retention-history-head"><h3>{t('每日留存观察', 'Daily repeat-use observations')}</h3><p>{daily.length > 14 ? t('显示最近 14 个比较日；已计算的每日结果可导出 Excel。', 'Showing the latest 14 comparison days. Export Excel for the calculated daily results.') : t('每行均与前一个自然日比较，不跳过没有日志的日期。', 'Each row compares with the previous calendar day, without skipping dates that have no logs.')}</p></div>
      {shownDays.length > 0 ? <div className="retention-table-wrap"><table className="retention-daily-table"><thead><tr><th>{t('比较日 / 前一日', 'Comparison / previous day')}</th><th>{t('前一日用户', 'Previous-day users')}</th><th>{t('次日再次使用', 'Observed again')}</th><th>{t('次日留存率', 'Next-day retention')}</th><th>{t('数据口径', 'Data status')}</th></tr></thead><tbody>{shownDays.map(day => <tr key={day.date}><td><strong>{day.date}</strong><small>{t('对比', 'vs.')} {day.previousDate}</small></td><td>{previousKnown(day) ? count(day.previousUsers) : '—'}</td><td>{available(day) ? count(day.retainedUsers) : '—'}</td><td className={available(day) ? 'retention-table-rate' : 'retention-table-unknown'}>{percentage(day)}</td><td>{statusText(day)}</td></tr>)}</tbody></table></div> : <p className="retention-no-days">{t('当前范围暂无可计算的日期。', 'There are no comparison dates in this range.')}</p>}
      {retention.omittedDays > 0 && <p className="retention-limit-note">{t(`为保持报表可用，当前计算仅保留最近 ${count(daily.length)} 个比较日；另有 ${count(retention.omittedDays)} 天未包含。请缩小日期范围。`, `To keep the report responsive, calculations retain the latest ${count(daily.length)} comparison days; ${count(retention.omittedDays)} earlier days are omitted. Narrow the date range for those dates.`)}</p>}
    </>}
  </section>;
}
