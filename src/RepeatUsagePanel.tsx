import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Info, Repeat2, Search, Users } from 'lucide-react';
import type { RepeatUsageAnalysis } from '../lib/retention.ts';
import './repeat-usage.css';

type Language = 'zh' | 'en';
export type RepeatUsagePanelProps = { lang: Language; repeatUsage: RepeatUsageAnalysis };

/** A period-level repeat-use share, with observed frequency for each identifiable account. */
export default function RepeatUsagePanel({ lang, repeatUsage }: RepeatUsagePanelProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const count = (value: number) => value.toLocaleString('en-US');
  const available = repeatUsage.status === 'available' && repeatUsage.rate !== null && Number.isFinite(repeatUsage.rate);
  const invalid = repeatUsage.status === 'invalid_range';
  const statusText = () => {
    switch (repeatUsage.status) {
      case 'available': return t('在至少两个不同日期观察到使用', 'Observed on at least two distinct dates');
      case 'single_day_range': return t('请至少选择两个自然日', 'Select at least two calendar days');
      case 'insufficient_logs': return t('当前日志覆盖不足两个日期', 'Logs cover fewer than two dates');
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
    <div className="repeat-usage-heading"><div><span className="repeat-usage-kicker">CONSISTENT USE</span><h2><Repeat2 size={17}/>{t('周期复用率', 'Period repeat-use rate')}</h2><p>{t('看所选时间内，有多少账号在不止一天使用过。', 'How many accounts used the app on more than one day in the selected period.')}</p></div><span className="repeat-usage-scope">{t('可识别账号 · 不含 browser', 'Identifiable accounts · browser excluded')}</span></div>
    <div className="repeat-usage-summary">
      <div className="repeat-usage-rate-block"><div className="repeat-usage-range"><CalendarDays size={14}/><span>{repeatUsage.range.from || '—'} — {repeatUsage.range.to || '—'}</span><b>{invalid ? '—' : count(repeatUsage.range.days)} {t('天', repeatUsage.range.days === 1 ? 'day' : 'days')}</b></div><div className="repeat-usage-rate"><strong className={available ? '' : 'repeat-usage-unavailable'}>{rate}</strong><span>{available ? t(`${count(repeatUsage.repeatUsers)} / ${count(repeatUsage.totalUsers)} 个账号跨日复用`, `${count(repeatUsage.repeatUsers)} / ${count(repeatUsage.totalUsers)} accounts used on multiple days`) : statusText()}</span></div><div className={`repeat-usage-progress${available ? '' : ' repeat-usage-progress-unknown'}`} aria-hidden="true"><span style={{ width: available ? `${Math.max(0, Math.min(100, repeatUsage.rate!))}%` : '0%' }}/></div></div>
      <div className="repeat-usage-counts"><div><Repeat2 size={16}/><span>{t('使用至少两天的账号', 'Accounts active on at least two days')}</span><strong>{invalid ? '—' : count(repeatUsage.repeatUsers)}</strong></div><div><Users size={16}/><span>{t('期间可识别活跃账号', 'Identifiable active accounts in period')}</span><strong>{invalid ? '—' : count(repeatUsage.totalUsers)}</strong></div></div>
    </div>
    <p className="repeat-usage-formula">{t('计算：在至少两个不同自然日使用的可识别账号数 ÷ 期间全部可识别活跃账号数 × 100%。同一天使用多次仍算一天。', 'Calculation: identifiable accounts active on at least two distinct calendar days ÷ all identifiable active accounts in the period × 100%. Multiple interactions on one date still count as one active day.')}</p>
    <div className="repeat-usage-method"><Info size={14}/><p>{t('按当前日期和 Scene 筛选，仅反映已导入日志中的使用。未出现日志不等于未使用；当天未结束、导入未完整或账号较晚加入时，比例可能偏低，需结合人数与活跃天数判断。', 'Uses the current date and Scene filters and reflects imported logs only. No log does not prove no usage. An ongoing day, incomplete imports or accounts joining later can lower the share; assess it alongside account counts and active days.')}{!invalid && <span>{t(`按全部 Scene 检查日志覆盖：所选 ${count(repeatUsage.range.days)} 天中，有 ${count(repeatUsage.observedDays)} 天记录过日志，另 ${count(repeatUsage.daysWithoutLogs)} 天未见日志，不能直接认定为无使用。`, `Log coverage across all Scenes: logs are present on ${count(repeatUsage.observedDays)} of the ${count(repeatUsage.range.days)} selected days; ${count(repeatUsage.daysWithoutLogs)} days have no logs, which does not establish inactivity.`)}</span>}</p></div>
    <div className="repeat-usage-users-head"><div><h3>{t('用户使用频率', 'Usage frequency by account')}</h3><p>{t('活跃天数按日期去重；最长连续使用按相邻自然日计算。', 'Active days are distinct dates; the longest streak uses consecutive calendar days.')}</p></div><label className="repeat-usage-search"><Search size={14}/><input type="search" aria-label={t('搜索使用频率账号', 'Search usage-frequency accounts')} placeholder={t('搜索 Client Id', 'Search Client ID')} value={query} onChange={event => setQuery(event.target.value)}/></label></div>
    {shown.length > 0 ? <><p className="repeat-usage-page-note">{query.trim()&&<span>{t(`账号搜索：${query.trim()}。 `, `Account search: ${query.trim()}. `)}</span>}{t(`显示第 ${start + 1}–${Math.min(start + 10, users.length)} 个账号，共 ${count(users.length)} 个；完整明细可导出 Excel。`, `Showing accounts ${start + 1}–${Math.min(start + 10, users.length)} of ${count(users.length)}. Export Excel for the complete details.`)}</p><div className="repeat-usage-table-wrap"><table className="repeat-usage-table"><thead><tr><th>Client Id</th><th>{t('活跃天数', 'Active days')}</th><th>{t('已观察活跃天数占比', 'Observed active-day share')}</th><th>{t('最长连续使用', 'Longest usage streak')}</th><th>{t('首次 / 最近使用日', 'First / latest active date')}</th></tr></thead><tbody>{shown.map(user => <tr key={user.clientId}><td><strong>{user.clientId}</strong></td><td><b>{count(user.activeDays)}</b><small>{t(`所选 ${count(repeatUsage.range.days)} 天`, `${count(repeatUsage.range.days)} selected days`)}</small></td><td><b>{Number.isFinite(user.activeDayShare) ? `${user.activeDayShare.toFixed(1)}%` : '—'}</b></td><td>{count(user.longestStreak)} {t('天', user.longestStreak === 1 ? 'day' : 'days')}</td><td><span>{user.firstDate}</span><small>{user.lastDate}</small></td></tr>)}</tbody></table></div><div className="repeat-usage-pagination"><span>{t(`第 ${currentPage} / ${pages} 页`, `Page ${currentPage} / ${pages}`)}</span><div><button type="button" className="icon-button" disabled={currentPage <= 1} onClick={() => setPage(current => Math.max(1, current - 1))} aria-label={t('使用频率上一页', 'Previous usage-frequency page')}><ChevronLeft size={15}/></button><button type="button" className="icon-button" disabled={currentPage >= pages} onClick={() => setPage(current => Math.min(pages, current + 1))} aria-label={t('使用频率下一页', 'Next usage-frequency page')}><ChevronRight size={15}/></button></div></div></> : <p className="repeat-usage-empty">{query ? t('没有匹配的账号。', 'No matching accounts.') : t('当前范围暂无可识别账号。', 'There are no identifiable accounts in this range.')}</p>}
    <p className="repeat-usage-frequency-note">{t('已观察活跃天数占比 = 账号活跃天数 ÷ 所选自然日数；它表示使用频率，不是次日留存率。连续天数只描述日志记录，不代表已形成使用习惯。', 'Observed active-day share = an account’s active days ÷ selected calendar days. It describes usage frequency, rather than next-day retention. A recorded streak does not establish a lasting usage habit.')}</p>
  </section>;
}
