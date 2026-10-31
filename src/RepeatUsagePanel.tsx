import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Info, Repeat2, Search, Users } from 'lucide-react';
import type { RepeatUsageAnalysis, RepeatMode } from '../lib/retention.ts';
import './repeat-usage.css';

type Language = 'zh' | 'en';
export type RepeatUsagePanelProps = { lang: Language; repeatUsage: RepeatUsageAnalysis; onMinimumActiveDaysChange?: (days: number) => void; onModeChange?: (mode:RepeatMode)=>void };

export type RepeatUsageThresholdProps = { lang: Language; minimumActiveDays: number; onChange: (days: number) => void; mode?:RepeatMode; onModeChange?:(mode:RepeatMode)=>void };

/** Shared threshold control for the overview and detailed repeat-use panel. */
export function RepeatUsageThreshold({ lang, minimumActiveDays, onChange, mode='any', onModeChange }: RepeatUsageThresholdProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [draft, setDraft] = useState(String(minimumActiveDays));
  useEffect(() => { setDraft(String(minimumActiveDays)); }, [minimumActiveDays]);
  const commit = () => {
    const days = Number(draft);
    if (!draft.trim() || !Number.isSafeInteger(days) || days < 2 || days > 3660) {
      setDraft(String(minimumActiveDays));
      return;
    }
    setDraft(String(days));
    if (days !== minimumActiveDays) onChange(days);
  };
  return <div className="repeat-usage-threshold-control"><span>{t('复用门槛：至少', 'Repeat-use threshold: at least')}</span><input type="number" min={2} max={3660} step={1} inputMode="numeric" aria-label={t('周期复用最少活跃日期数', 'Minimum active dates for period repeat usage')} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/><b className="repeat-usage-threshold-print">{minimumActiveDays}</b><span>{mode==='consecutive'?t('个连续自然日','consecutive calendar days'):t('个不同日期','distinct dates')}</span>{onModeChange&&<select aria-label={t('周期复用连续性','Period repeat-use continuity')} value={mode} onChange={e=>onModeChange(e.target.value as RepeatMode)}><option value="any">{t('不要求连续','Any dates')}</option><option value="consecutive">{t('要求连续','Consecutive dates')}</option></select>}<small>{t('2–3660 天 · 默认 3 天', '2–3660 days · default 3')}</small></div>;
}

/** A period-level repeat-use share, with observed frequency for each identifiable account. */
export default function RepeatUsagePanel({ lang, repeatUsage, onMinimumActiveDaysChange, onModeChange }: RepeatUsagePanelProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const minimumDays = repeatUsage.minimumActiveDays;
  const zhDays=repeatUsage.mode==='consecutive'?`连续 ${minimumDays} 个自然日`:`任意 ${minimumDays} 个不同日期`;
  const enDays=repeatUsage.mode==='consecutive'?`${minimumDays} consecutive calendar days`:`${minimumDays} distinct dates`;
  const continuity=t(repeatUsage.mode==='consecutive'?'必须是相邻自然日，中断后重新计算。':'日期无需连续。',repeatUsage.mode==='consecutive'?'Dates must be consecutive; a gap resets the streak.':'Dates need not be consecutive.');
  const count = (value: number) => value.toLocaleString('en-US');
  const available = repeatUsage.status === 'available' && repeatUsage.rate !== null && Number.isFinite(repeatUsage.rate);
  const invalid = repeatUsage.status === 'invalid_range';
  const statusText = () => {
    switch (repeatUsage.status) {
      case 'available': return t(`在至少 ${zhDays}观察到使用`, `Observed on at least ${enDays}`);
      case 'single_day_range':
      case 'insufficient_period': return t(`所选期间不足 ${minimumDays} 天，请扩大日期范围或调低门槛`, `The period is shorter than ${minimumDays} days. Extend the range or lower the threshold.`);
      case 'insufficient_logs': return t(`当前日志覆盖不足 ${minimumDays} 个日期，暂不可计算`, `Logs cover fewer than ${minimumDays} dates; the rate is unavailable.`);
      case 'no_identifiable_users': return t('当前范围暂无可识别活跃账号', 'No identifiable active accounts in this range');
      default: return t('请选择有效日期范围', 'Choose a valid date range');
    }
  };
  const users = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? repeatUsage.users.filter(user => user.clientId.toLowerCase().includes(needle)) : repeatUsage.users;
  }, [query, repeatUsage.users]);
  useEffect(() => { setPage(1); }, [query, repeatUsage]);
  const pages = Math.max(1, Math.ceil(users.length / 10));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * 10;
  const shown = users.slice(start, start + 10);
  const rate = available ? `${repeatUsage.rate!.toFixed(1)}%` : '—';

  return <section className="repeat-usage-panel card" aria-label={t('周期复用率', 'Period repeat-use rate')}>
    <div className="repeat-usage-heading"><div><span className="repeat-usage-kicker">CONSISTENT USE</span><h2><Repeat2 size={17}/>{t('周期复用率', 'Period repeat-use rate')}</h2><p>{t(`看所选期间，有多少账号至少在${zhDays}使用过。${continuity}`, `How many accounts used the app on at least ${enDays} in the period. ${continuity}`)}</p></div><span className="repeat-usage-scope">{t('可识别账号 · 不含 browser', 'Identifiable accounts · browser excluded')}</span></div>
    <div className="repeat-usage-threshold-row">{onMinimumActiveDaysChange ? <RepeatUsageThreshold lang={lang} minimumActiveDays={minimumDays} onChange={onMinimumActiveDaysChange} mode={repeatUsage.mode} onModeChange={onModeChange}/> : <p className="repeat-usage-threshold-value">{t(`复用门槛：至少${zhDays}`, `Repeat-use threshold: at least ${enDays}`)}</p>}</div>
    <div className="repeat-usage-summary">
      <div className="repeat-usage-rate-block"><div className="repeat-usage-range"><CalendarDays size={14}/><span>{repeatUsage.range.from || '—'} — {repeatUsage.range.to || '—'}</span><b>{invalid ? '—' : count(repeatUsage.range.days)} {t('天', repeatUsage.range.days === 1 ? 'day' : 'days')}</b></div><div className="repeat-usage-rate"><strong className={available ? '' : 'repeat-usage-unavailable'}>{rate}</strong><span>{available ? t(`${count(repeatUsage.repeatUsers)} / ${count(repeatUsage.totalUsers)} 个账号达到 ${minimumDays} 天门槛`, `${count(repeatUsage.repeatUsers)} / ${count(repeatUsage.totalUsers)} accounts meet the ${minimumDays}-day threshold`) : statusText()}</span></div><div className={`repeat-usage-progress${available ? '' : ' repeat-usage-progress-unknown'}`} aria-hidden="true"><span style={{ width: available ? `${Math.max(0, Math.min(100, repeatUsage.rate!))}%` : '0%' }}/></div></div>
      <div className="repeat-usage-counts"><div><Repeat2 size={16}/><span>{t(`使用至少${zhDays}的账号`, `Accounts active on at least ${enDays}`)}</span><strong>{invalid ? '—' : count(repeatUsage.repeatUsers)}</strong></div><div><Users size={16}/><span>{t('期间可识别活跃账号', 'Identifiable active accounts in period')}</span><strong>{invalid ? '—' : count(repeatUsage.totalUsers)}</strong></div></div>
    </div>
    <p className="repeat-usage-formula">{t(`计算：在至少${zhDays}使用的可识别账号数 ÷ 期间全部可识别活跃账号数 × 100%。同一天使用多次仍算一天。${continuity}`, `Calculation: identifiable accounts active on at least ${enDays} ÷ all identifiable active accounts in the period × 100%. Multiple interactions on one date still count as one active day. ${continuity}`)}</p>
    <div className="repeat-usage-method"><Info size={14}/><p>{t('按当前日期和 Scene 筛选，仅反映已导入日志中的使用。未出现日志不等于未使用；当天未结束、导入未完整或账号较晚加入时，比例可能偏低，需结合人数与活跃天数判断。', 'Uses the current date and Scene filters and reflects imported logs only. No log does not prove no usage. An ongoing day, incomplete imports or accounts joining later can lower the share; assess it alongside account counts and active days.')}{!invalid && <span>{t(`按全部 Scene 检查日志覆盖：所选 ${count(repeatUsage.range.days)} 天中，有 ${count(repeatUsage.observedDays)} 天记录过日志，另 ${count(repeatUsage.daysWithoutLogs)} 天未见日志，不能直接认定为无使用。`, `Log coverage across all Scenes: logs are present on ${count(repeatUsage.observedDays)} of the ${count(repeatUsage.range.days)} selected days; ${count(repeatUsage.daysWithoutLogs)} days have no logs, which does not establish inactivity.`)}</span>}</p></div>
    <div className="repeat-usage-users-head"><div><h3>{t('用户使用频率', 'Usage frequency by account')}</h3><p>{t('活跃天数按日期去重；最长连续使用按相邻自然日计算。', 'Active days are distinct dates; the longest streak uses consecutive calendar days.')}</p></div><label className="repeat-usage-search"><Search size={14}/><input type="search" aria-label={t('搜索使用频率账号', 'Search usage-frequency accounts')} placeholder={t('搜索 Client Id', 'Search Client ID')} value={query} onChange={event => setQuery(event.target.value)}/></label></div>
    {shown.length > 0 ? <><p className="repeat-usage-page-note">{query.trim()&&<span>{t(`账号搜索：${query.trim()}。 `, `Account search: ${query.trim()}. `)}</span>}{t(`显示第 ${start + 1}–${Math.min(start + 10, users.length)} 个账号，共 ${count(users.length)} 个；完整明细可导出 Excel。`, `Showing accounts ${start + 1}–${Math.min(start + 10, users.length)} of ${count(users.length)}. Export Excel for the complete details.`)}</p><div className="repeat-usage-table-wrap"><table className="repeat-usage-table"><thead><tr><th>Client Id</th><th>{t('活跃天数', 'Active days')}</th><th>{t('已观察活跃天数占比', 'Observed active-day share')}</th><th>{t('最长连续使用', 'Longest usage streak')}</th><th>{t('首次 / 最近使用日', 'First / latest active date')}</th></tr></thead><tbody>{shown.map(user => <tr key={user.clientId}><td><strong>{user.clientId}</strong></td><td><b>{count(user.activeDays)}</b><small>{t(`所选 ${count(repeatUsage.range.days)} 天`, `${count(repeatUsage.range.days)} selected days`)}</small></td><td><b>{Number.isFinite(user.activeDayShare) ? `${user.activeDayShare.toFixed(1)}%` : '—'}</b></td><td>{count(user.longestStreak)} {t('天', user.longestStreak === 1 ? 'day' : 'days')}</td><td><span>{user.firstDate}</span><small>{user.lastDate}</small></td></tr>)}</tbody></table></div><div className="repeat-usage-pagination"><span>{t(`第 ${currentPage} / ${pages} 页`, `Page ${currentPage} / ${pages}`)}</span><div><button type="button" className="icon-button" disabled={currentPage <= 1} onClick={() => setPage(current => Math.max(1, current - 1))} aria-label={t('使用频率上一页', 'Previous usage-frequency page')}><ChevronLeft size={15}/></button><button type="button" className="icon-button" disabled={currentPage >= pages} onClick={() => setPage(current => Math.min(pages, current + 1))} aria-label={t('使用频率下一页', 'Next usage-frequency page')}><ChevronRight size={15}/></button></div></div></> : <p className="repeat-usage-empty">{query ? t('没有匹配的账号。', 'No matching accounts.') : t('当前范围暂无可识别账号。', 'There are no identifiable accounts in this range.')}</p>}
    <p className="repeat-usage-frequency-note">{t('已观察活跃天数占比 = 账号活跃天数 ÷ 所选自然日数；它表示使用频率，不是窗口留存率。连续天数只描述日志记录，不代表已形成使用习惯。', 'Observed active-day share = an account’s active days ÷ selected calendar days. It describes usage frequency, rather than window retention. A recorded streak does not establish a lasting usage habit.')}</p>
  </section>;
}
