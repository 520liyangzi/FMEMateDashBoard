import {CalendarDays} from 'lucide-react';

export type TrendRange = {from:string;to:string};

export default function TrendDateRange({lang,range,custom,onChange,onReset,onPreset,error,excludeWeekends,onExcludeWeekendsChange}: {
  lang:'zh'|'en';range:TrendRange;custom:boolean;onChange:(range:TrendRange)=>void;
  onReset:()=>void;onPreset:(days:number)=>void;error:string;
  excludeWeekends:boolean;onExcludeWeekendsChange:(exclude:boolean)=>void;
}) {
  const t=(zh:string,en:string)=>lang==='zh'?zh:en;
  return <section className="card trend-date-range screen-only" aria-label={t('趋势时间范围','Trend date range')}>
    <div><h2><CalendarDays size={17}/>{t('趋势时间范围','Trend date range')}</h2>
      <p>{t('共用于使用趋势和日活图，包含起止当天；自定义只影响这两张图，场景仍跟随页面筛选。','Shared by usage and DAU charts, including both dates. Custom dates affect only these charts; the page scene filter still applies.')}</p></div>
    <div className="trend-date-inputs">
      <label>{t('从','From')}<input type="date" aria-label={t('趋势开始日期','Trend start date')} value={range.from} min="1900-01-01" max="9999-12-31" onInput={e=>onChange({...range,from:e.currentTarget.value})} onChange={e=>onChange({...range,from:e.target.value})} aria-invalid={!!error}/></label>
      <label>{t('到','To')}<input type="date" aria-label={t('趋势结束日期','Trend end date')} value={range.to} min="1900-01-01" max="9999-12-31" onInput={e=>onChange({...range,to:e.currentTarget.value})} onChange={e=>onChange({...range,to:e.target.value})} aria-invalid={!!error}/></label>
      <button className="btn" onClick={()=>onPreset(7)}>{t('最近 7 天','Last 7 days')}</button>
      <button className="btn" onClick={()=>onPreset(30)}>{t('最近 30 天','Last 30 days')}</button>
      <button className="btn" onClick={()=>onPreset(0)}>{t('全部日志日期','All log dates')}</button>
      <button className={'btn '+(!custom?'primary':'')} onClick={onReset}>{t('跟随页面日期','Use page dates')}</button>
    </div>
    <label className="trend-weekend-option"><input type="checkbox" checked={excludeWeekends} onChange={e=>onExcludeWeekendsChange(e.target.checked)}/>{t('排除周末（周六、周日）','Exclude weekends (Saturday and Sunday)')}</label>
    <p className="small-note">{custom?t('自定义范围 · 快捷范围以最新日志日期为结束日。','Custom range · shortcuts end on the latest log date.'):t('当前跟随页面日期 · 修改上方日期时，两张图同步更新。','Following page dates · changing the page dates updates both charts.')}</p>
    {error&&<p className="error-text" role="alert">{error}</p>}
  </section>;
}
