import { useMemo } from 'react';
import type { LogRecord } from '../lib/analytics';
import { analyzeWeeklyUsage, importedWorkweeks, type Workweek } from '../lib/weekly-usage';
import './weekly-usage.css';

type Props = {
  lang: 'zh' | 'en';
  records: LogRecord[];
  scene: string;
  week: Workweek | null;
  selectedMonday: string;
  onSelect: (monday: string) => void;
};

export default function WeeklyUsagePanel({ lang, records, scene, week, selectedMonday, onSelect }: Props) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const options = useMemo(() => importedWorkweeks(records), [records]);
  const stats = useMemo(() => analyzeWeeklyUsage(records, week, scene), [records, week, scene]);
  const period = (w: Workweek) => w.from + ' – ' + w.to;
  const formatMean = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  // A captured or manually selected week may have no logs after changing datasets.
  const showSelected = week && selectedMonday && !options.some(w => w.from === selectedMonday);

  return <section className="card weekly-usage" aria-labelledby="weekly-usage-heading">
    <div className="weekly-usage-heading">
      <div>
        <h2 id="weekly-usage-heading">{t('人均每周使用天数', 'Average weekly usage days per active user')}</h2>
        <p>{t('每周按周一至周五统计，同一账号同一天使用多次只计一天。', 'Monday to Friday. Each account counts once per day it uses the app.')}</p>
      </div>
      <label className="screen-only">{t('统计工作周', 'Reporting week')}
        <select value={selectedMonday} onChange={e => onSelect(e.currentTarget.value)}>
          <option value="">{t('页面结束日所在周', 'Week of the page end date')}</option>
          {showSelected && <option value={selectedMonday}>{period(week)}</option>}
          {options.map(w => <option key={w.from} value={w.from}>{period(w)}</option>)}
        </select>
      </label>
    </div>
    <div className="weekly-usage-result">
      <div>
        <p>{week ? period(week) : t('请选择日期', 'Choose a date')}</p>
        <strong>{stats.mean === null ? '—' : formatMean.format(stats.mean)}</strong>
        <span>{t('天 / 人', 'days per user')}</span>
      </div>
      <div>
        <p>{stats.users.length
          ? t(`${stats.userDays} 个用户使用日 ÷ ${stats.users.length} 名工作日活跃用户`, `${stats.userDays} active user-days ÷ ${stats.users.length} weekday-active users`)
          : t('所选工作周和场景暂无可识别活跃用户。', 'No identifiable active users in this workweek and scene.')}</p>
        {week && <p>{t(`全部场景中，有日志的工作日为 ${stats.observedDays} / 5 天。`, `Imported logs across all scenes cover ${stats.observedDays} of the 5 weekdays.`)}</p>}
      </div>
    </div>
  </section>;
}
