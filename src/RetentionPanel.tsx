import {useEffect,useState} from 'react';
import { ArrowRight, CalendarDays, Info, Repeat2, Users } from 'lucide-react';
import type { RetentionAnalysis, RetentionDay } from '../lib/retention.ts';
import './retention.css';

type Language = 'zh' | 'en';
export type RetentionPanelProps = { lang: Language; retention: RetentionAnalysis; compact?: boolean; onWindowDaysChange?: (days:number)=>void };

/** Repeat use is measured against the previous calendar day's identifiable cohort. */
export default function RetentionPanel({ lang, retention, compact = false, onWindowDaysChange }: RetentionPanelProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const latest = retention.latest;
  const [draft,setDraft]=useState(String(retention.windowDays));
  useEffect(()=>setDraft(String(retention.windowDays)),[retention.windowDays]);
  const commit=()=>{const n=Number(draft);if(!draft.trim()||!Number.isSafeInteger(n)||n<1||n>3660){setDraft(String(retention.windowDays));return}setDraft(String(n));onWindowDaysChange?.(n)};
  const available = (day: RetentionDay) => day.status === 'available' && day.rate !== null && Number.isFinite(day.rate);
  const percentage = (day: RetentionDay) => available(day) ? `${day.rate!.toFixed(1)}%` : '—';
  const count = (value: number) => value.toLocaleString('en-US');
  const previousKnown = (day: RetentionDay) => day.status !== 'invalid_range' && day.status !== 'missing_previous_logs';
  const statusText = (day: RetentionDay) => {
    switch (day.status) {
      case 'available': return t('基于已导入日志', 'Based on imported logs');
      case 'missing_previous_logs': return t('基准日暂无日志，待补全', 'Baseline-day logs unavailable');
      case 'missing_current_logs': return t('观察区间有日期缺少日志，待补全', 'Some follow-up dates have no logs');
      case 'no_previous_users': return t('基准日无可识别用户', 'No identifiable baseline users');
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

  return <section className={`retention-panel card${compact ? ' retention-panel-compact' : ''}`} aria-label={t('窗口留存率', 'Window retention')}>
    <div className="retention-heading"><div><span className="retention-kicker">REPEAT USE</span><h2><Repeat2 size={17}/>{t('窗口留存率', 'Window retention')}</h2><p>{t('看基准日用过的账号，在后续 N 天内有多少至少再次使用一次。', 'How many baseline-day accounts return at least once within the following N days.')}</p></div><span className="retention-scope-label">{t('可识别账号 · 不含 browser', 'Identifiable accounts · browser excluded')}</span></div>
    {onWindowDaysChange&&<div className="retention-window-control"><label>{t('后续观察天数','Follow-up days')}<input type="number" min={1} max={3660} step={1} aria-label={t('留存观察天数','Retention follow-up days')} value={draft} onChange={e=>setDraft(e.target.value)} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur()}}/></label><span>{t('可输入 1–3660 天，例如 7 天或 30 天。','Enter 1–3660 days, for example 7 or 30.')}</span></div>}
    <p className="retention-window-scope">{t(`基准日：${latest.previousDate||'—'}；后续 ${retention.windowDays} 天：${latest.windowStart||'—'} 至 ${latest.date||'—'}。`,`Baseline: ${latest.previousDate||'—'}; next ${retention.windowDays} days: ${latest.windowStart||'—'} to ${latest.date||'—'}.`)}</p>
    <div className="retention-latest">
      <div className="retention-result"><span className="retention-date-pair"><CalendarDays size={14}/><span>{latest.previousDate || '—'}</span><ArrowRight size={12}/><strong>{latest.date || '—'}</strong></span><div className="retention-rate"><strong className={!hasRate ? 'retention-unavailable' : ''}>{percentage(latest)}</strong><span>{hasRate ? t(`${count(latest.retainedUsers)} / ${count(latest.previousUsers)} 个账号再次使用`, `${count(latest.retainedUsers)} / ${count(latest.previousUsers)} accounts used again`) : statusText(latest)}</span></div><div className={`retention-progress${hasRate ? '' : ' retention-progress-unknown'}`} aria-hidden="true"><span style={{ width: hasRate ? `${Math.max(0, Math.min(100, latest.rate!))}%` : '0%' }}/></div></div>
      <div className="retention-counts"><div><Users size={16}/><span>{t('基准日可识别用户', 'Baseline identifiable users')}</span><strong>{previousKnown(latest) ? count(latest.previousUsers) : '—'}</strong></div><div><Repeat2 size={16}/><span>{t('其中在窗口内再次使用', 'Of these, returned within the window')}</span><strong>{hasRate ? count(latest.retainedUsers) : '—'}</strong></div></div>
    </div>
    <p className="retention-formula">{t('计算：基准日的账号中，在后续 N 天至少使用一次的账号数 ÷ 基准日可识别账号数 × 100%。基准日当天的重复使用不算回访。', 'Calculation: baseline accounts returning at least once within the following N days ÷ baseline identifiable accounts × 100%. Activity on the baseline day itself does not count as a return.')}</p>
    <div className="retention-method-note"><Info size={14}/><p>{t('观察结束日取页面的结束日期，基准日向前推 N 天。只统计基准日已有账号，后续新账号不计入分子。基准日或观察区间任一天完全没有日志时暂不计算；已有日志不代表导入完整，当天未结束时仅供观察。', 'The window ends on the page’s end date; the baseline is N days earlier. New accounts after the baseline are excluded. A missing baseline or any unobserved follow-up date makes the rate unavailable. Present logs do not confirm completeness; ongoing days remain provisional.')}{browserUses > 0 && <span>{t(`基准日 / 观察窗口另有 ${count(latest.previousBrowserUses)} / ${count(latest.currentBrowserUses)} 次 browser 使用记录，实际人数与再次使用情况无法确定。`, `The baseline day / follow-up window also contain ${count(latest.previousBrowserUses)} / ${count(latest.currentBrowserUses)} browser interactions; their actual people count and repeat use cannot be determined.`)}</span>}</p></div>
    {!compact && <>
      <p className="retention-detail-scope">{t('基准日与整个观察窗口使用相同 Scene 筛选；可读取当前开始日期之前的已导入日志。该指标是窗口内回访，不要求每天使用，也不是恰好第 N 天留存。', 'The same Scene filter applies to the baseline and full follow-up window, including imported history before the selected start date. A return on any day qualifies; daily usage or a return exactly on day N is not required.')}</p>
      {hasRate && <details className="retention-cohorts"><summary>{t('查看当前窗口账号明细', 'View current window account details')}<span>{t('仅反映日志中观察到的账号', 'Observed accounts only')}</span></summary><div className="retention-cohort-grid"><section><h3>{t('窗口内再次使用', 'Returned within the window')}<b>{count(latest.retainedClientIds.length)}</b></h3>{cohortList(latest.retainedClientIds)}</section><section><h3>{t('窗口内未观察到再次使用', 'Not observed within the window')}<b>{count(latest.notObservedClientIds.length)}</b></h3>{cohortList(latest.notObservedClientIds)}<p className="retention-cohort-caveat">{t('日志未观察到，不直接认定为用户流失。', 'An absent observation does not establish that a user has churned.')}</p></section></div></details>}
      <div className="retention-history-head"><h3>{t('滚动窗口留存观察', 'Rolling retention windows')}</h3><p>{daily.length > 14 ? t('显示最近 14 个比较日；已计算的每日结果可导出 Excel。', 'Showing the latest 14 comparison days. Export Excel for the calculated daily results.') : t('每行使用相同 N 天窗口，列出观察结束日及对应基准日，不跳过缺日志日期。', 'Each row uses the same N-day window and shows its end and baseline dates, without skipping missing dates.')}</p></div>
      {shownDays.length > 0 ? <div className="retention-table-wrap"><table className="retention-daily-table"><thead><tr><th>{t('观察结束日 / 基准日', 'Window end / baseline')}</th><th>{t('基准日用户', 'Baseline users')}</th><th>{t('窗口内再次使用', 'Observed again')}</th><th>{t('窗口留存率', 'Window retention')}</th><th>{t('数据口径', 'Data status')}</th></tr></thead><tbody>{shownDays.map(day => <tr key={day.date}><td><strong>{day.date}</strong><small>{t('对比', 'vs.')} {day.previousDate}</small></td><td>{previousKnown(day) ? count(day.previousUsers) : '—'}</td><td>{available(day) ? count(day.retainedUsers) : '—'}</td><td className={available(day) ? 'retention-table-rate' : 'retention-table-unknown'}>{percentage(day)}</td><td>{statusText(day)}</td></tr>)}</tbody></table></div> : <p className="retention-no-days">{t('当前范围暂无可计算的日期。', 'There are no comparison dates in this range.')}</p>}
      {retention.omittedDays > 0 && <p className="retention-limit-note">{t(`为保持报表可用，当前计算仅保留最近 ${count(daily.length)} 个比较日；另有 ${count(retention.omittedDays)} 天未包含。请缩小日期范围。`, `To keep the report responsive, calculations retain the latest ${count(daily.length)} comparison days; ${count(retention.omittedDays)} earlier days are omitted. Narrow the date range for those dates.`)}</p>}
    </>}
  </section>;
}
