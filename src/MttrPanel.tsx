import {useRef,useState} from 'react';
import {ArrowDownRight,ArrowUpRight,CalendarDays,ChevronLeft,ChevronRight,Clock3,FileSpreadsheet,Info,Trash2,Upload} from 'lucide-react';
import {compareMttr,previousMttrPeriod,shiftMttrPeriod,type MttrDataset,type MttrPeriod} from '../lib/mttr';
import './mttr.css';

type Language='zh'|'en';
export type MttrPanelProps={
  lang:Language;dataset:MttrDataset|null;baseline:MttrPeriod;current:MttrPeriod;
  onBaselineChange:(period:MttrPeriod)=>void;onCurrentChange:(period:MttrPeriod)=>void;
  onImport:(file:File)=>Promise<void>;onClear:()=>Promise<void>;readOnly:boolean;
};
const dayMs=86400000;
function dayOffset(date:string,offset:number){const ms=Date.parse(date+'T00:00:00Z');if(!Number.isFinite(ms))return '';const next=new Date(ms+offset*dayMs);return next.toISOString().slice(0,10);}

export default function MttrPanel({lang,dataset,baseline,current,onBaselineChange,onCurrentChange,onImport,onClear,readOnly}:MttrPanelProps){
  const t=(zh:string,en:string)=>lang==='zh'?zh:en;
  const fileInput=useRef<HTMLInputElement>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const result=compareMttr(dataset,baseline,current);
  const count=(n:number)=>n.toLocaleString('en-US');
  const hours=(n:number|null)=>n===null?'—':(n/3600).toLocaleString('en-US',{maximumFractionDigits:2,minimumFractionDigits:2});
  const valid=result.reductionRate!==null;
  const slower=valid&&result.reductionRate!<0;
  const statusText=()=>{
    switch(result.status){
      case 'available':return result.reductionRate!>0?t('平均处理时长缩短','Average resolution time reduced'):slower?t('平均处理时长增加','Average resolution time increased'):t('两期平均时长相同','No change in average resolution time');
      case 'no_dataset':return t('请先导入工单系统 Excel','Import a ticket-system Excel file to begin');
      case 'invalid_range':return t('请选择两段有效日期，开始日不能晚于结束日','Select two valid periods with start dates on or before their end dates');
      case 'no_baseline_tickets':return t('基准期没有符合条件的有效工单','No eligible valid tickets in the baseline period');
      case 'no_current_tickets':return t('对比期没有符合条件的有效工单','No eligible valid tickets in the comparison period');
      case 'zero_baseline':return t('基准期平均时长为 0，无法计算减少率','The baseline mean is zero, so a reduction rate cannot be calculated');
      default:return t('当前无法计算','Calculation unavailable');
    }
  };
  async function importFile(file:File){
    if(dataset&&!window.confirm(t('新文件将替换当前工单数据，不会累加。是否继续？','The new file will replace the current ticket dataset, rather than append to it. Continue?')))return;
    setError('');setBusy(true);try{await onImport(file);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  }
  async function clear(){if(!window.confirm(t('确定清除当前 MTTR 工单数据？已导入的用户日志不受影响。','Clear the current MTTR ticket dataset? Imported app logs will remain available.')))return;setError('');setBusy(true);try{await onClear();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  function applyCurrent(period:MttrPeriod){const previous=previousMttrPeriod(period);if(!previous){setError(t('日期超出支持范围，请重新选择','The dates are outside the supported range. Choose another period.'));return;}setError('');onCurrentChange(period);onBaselineChange(previous);}
  function recent(days:number){if(!dataset?.latestDate)return;applyCurrent({from:dayOffset(dataset.latestDate,1-days),to:dataset.latestDate});}
  function completeWeek(){
    if(!dataset?.latestDate)return;
    const weekday=new Date(dataset.latestDate+'T00:00:00Z').getUTCDay();
    const sunday=dayOffset(dataset.latestDate,-weekday);
    applyCurrent({from:dayOffset(sunday,-6),to:sunday});
  }
  function shift(direction:-1|1){const b=shiftMttrPeriod(baseline,direction),c=shiftMttrPeriod(current,direction);if(!b||!c){setError(t('请先选择有效日期范围','Choose valid date ranges first'));return;}setError('');onBaselineChange(b);onCurrentChange(c);}
  const dateInput=(kind:'baseline'|'current',edge:'from'|'to')=>{
    const period=kind==='baseline'?baseline:current,change=kind==='baseline'?onBaselineChange:onCurrentChange;
    const label=kind==='baseline'?(edge==='from'?t('MTTR 基准期开始日期','MTTR baseline start date'):t('MTTR 基准期结束日期','MTTR baseline end date')):(edge==='from'?t('MTTR 对比期开始日期','MTTR comparison start date'):t('MTTR 对比期结束日期','MTTR comparison end date'));
    return <input type="date" aria-label={label} value={period[edge]} disabled={busy} onInput={e=>change({...period,[edge]:e.currentTarget.value})} onChange={e=>change({...period,[edge]:e.currentTarget.value})}/>;
  };
  return <section className="mttr-panel card" aria-label={t('MTTR 成效对比','MTTR effectiveness comparison')}>
    <div className="mttr-heading"><div><span className="mttr-kicker">RESOLUTION EFFICIENCY</span><h2><Clock3 size={18}/>{t('MTTR 成效对比','MTTR effectiveness comparison')}</h2><p>{t('对比两段期间的整体平均处理时长，观察工单处理效率变化。','Compare overall average resolution time across two periods to observe changes in ticket handling.')}</p></div><span className="mttr-scope">Radio-OSP / Radio-ISP · CLOSE</span></div>
    {!readOnly&&<div className="mttr-import-controls"><input hidden ref={fileInput} type="file" accept=".xlsx,.csv,.xls" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)void importFile(file);}}/><button className="btn primary" disabled={busy} onClick={()=>fileInput.current?.click()}><Upload size={15}/>{busy?t('正在处理工单…','Processing tickets…'):t('导入工单 Excel','Import ticket Excel')}</button>{dataset&&<button className="text-button mttr-clear" disabled={busy} onClick={()=>void clear()}><Trash2 size={14}/>{t('清除工单数据','Clear ticket dataset')}</button>}<span>{t('每次导入替换当前工单数据 · 不累加','Each import replaces the current ticket dataset')}</span></div>}
    {error&&<div className="mttr-error" role="alert">{error}</div>}
    {!dataset&&<div className="mttr-empty"><FileSpreadsheet size={26}/><div><strong>{t('导入工单表，开始计算成效','Import ticket data to measure progress')}</strong><p>{t('支持 .xlsx 和 UTF-8 CSV。读取第一个工作表，仅汇总符合条件的有效工单；原始工单明细不会发送到页面。','Supports .xlsx and UTF-8 CSV. The first worksheet is read and eligible valid tickets are aggregated; raw ticket details are not sent to the page.')}</p></div></div>}
    {dataset&&<div className="mttr-dataset"><FileSpreadsheet size={17}/><div><strong>{dataset.filename}</strong><span>{t(`关闭日期覆盖：${dataset.earliestDate||'—'} 至 ${dataset.latestDate||'—'}`,`Imported close dates: ${dataset.earliestDate||'—'} to ${dataset.latestDate||'—'}`)}</span><span>{t('导入时间：','Imported: ')}{dataset.importedAt?new Date(dataset.importedAt).toLocaleString(lang==='zh'?'zh-CN':'en-GB'):'—'}</span></div><dl><div><dt>{t('源数据行','Source rows')}</dt><dd>{count(dataset.sourceRows)}</dd></div><div><dt>{t('符合分类 / 状态','Category / status match')}</dt><dd>{count(dataset.matchedRows)}</dd></div><div><dt>{t('有效工单','Valid tickets')}</dt><dd>{count(dataset.validRows)}</dd></div></dl></div>}
    <div className="mttr-period-controls"><div className="mttr-period-editor"><label><CalendarDays size={14}/>{t('基准期','Baseline period')}</label><div>{dateInput('baseline','from')}<span>—</span>{dateInput('baseline','to')}</div></div><div className="mttr-period-editor"><label><CalendarDays size={14}/>{t('对比期','Comparison period')}</label><div>{dateInput('current','from')}<span>—</span>{dateInput('current','to')}</div></div></div>
    <div className="mttr-shortcuts"><div><button disabled={busy||!dataset} onClick={()=>recent(3)}>{t('最近 3 天 vs 前 3 天','Latest 3 days vs prior 3')}</button><button disabled={busy||!dataset} onClick={completeWeek}>{t('最近完整周 vs 前一周','Latest full week vs prior week')}</button><button disabled={busy} onClick={()=>applyCurrent(current)}>{t('基准期设为前一等长周期','Use preceding equal-length baseline')}</button></div><div><button disabled={busy} aria-label={t('MTTR 两期向前切换','Move both MTTR periods earlier')} onClick={()=>shift(-1)}><ChevronLeft size={14}/>{t('前一周期','Earlier')}</button><button disabled={busy} aria-label={t('MTTR 两期向后切换','Move both MTTR periods later')} onClick={()=>shift(1)}>{t('后一周期','Later')}<ChevronRight size={14}/></button></div></div>
    <p className="mttr-shortcut-note">{t('快捷日期以已导入工单的最新关闭日为锚点；完整周为周一至周日，日期完整不代表工单导入完整。','Date shortcuts use the latest imported close date. Full weeks run Monday–Sunday; full calendar periods do not confirm complete ticket coverage.')}</p>
    <div className="mttr-results"><article className="mttr-period-result"><span>{t('基准期 MTTR','Baseline MTTR')}</span><p>{baseline.from||'—'} — {baseline.to||'—'}</p><strong>{hours(result.baseline.meanSeconds)}<small>{t('小时','hours')}</small></strong><div>{t(`${count(result.baseline.count)} 个有效关闭工单`,`${count(result.baseline.count)} valid closed tickets`)}</div></article><article className="mttr-period-result"><span>{t('对比期 MTTR','Comparison MTTR')}</span><p>{current.from||'—'} — {current.to||'—'}</p><strong>{hours(result.current.meanSeconds)}<small>{t('小时','hours')}</small></strong><div>{t(`${count(result.current.count)} 个有效关闭工单`,`${count(result.current.count)} valid closed tickets`)}</div></article><article className={'mttr-rate-result '+(!valid?'mttr-neutral':slower?'mttr-slower':result.reductionRate!>0?'mttr-faster':'mttr-neutral')}><span>{t('MTTR 减少率','MTTR reduction rate')}</span><strong>{valid?(result.reductionRate!>0?<ArrowDownRight size={23}/>:slower?<ArrowUpRight size={23}/>:null):null}{valid?`${result.reductionRate!.toFixed(1)}%`:'—'}</strong><div>{statusText()}</div>{result.savedSeconds!==null&&<p>{t(`平均每单${result.savedSeconds<0?'增加':'减少'} ${hours(Math.abs(result.savedSeconds))} 小时`,`Mean time ${result.savedSeconds<0?'increased':'reduced'} by ${hours(Math.abs(result.savedSeconds))} hours per ticket`)}</p>}</article></div>
    {result.overlap&&<div className="mttr-warning"><Info size={14}/>{t('两个期间存在重叠，重叠日期的工单会同时计入两期。建议选择不重叠期间进行比较。','The periods overlap. Tickets on shared dates enter both averages; non-overlapping periods are recommended for comparison.')}</div>}
    {result.unequalDays&&<div className="mttr-warning"><Info size={14}/>{t('两期自然日数不同。平均时长仍按工单数加权计算，请结合工单数量和覆盖范围解读。','The periods have different calendar lengths. Means remain weighted by ticket count; consider both sample size and coverage.')}</div>}
    <p className="mttr-formula">{t('MTTR = 期间内有效工单总处理时长 ÷ 有效工单数。减少率 =（基准期 MTTR − 对比期 MTTR）÷ 基准期 MTTR × 100%；正数表示时长缩短，负数表示时长增加。','MTTR = total resolution time of valid tickets in the period ÷ valid ticket count. Reduction rate = (baseline MTTR − comparison MTTR) ÷ baseline MTTR × 100%. Positive means shorter; negative means longer.')}</p>
    <details className="mttr-method" open><summary>{t('计算口径与数据质量','Methodology and data quality')}</summary><div><p>{t('只保留 U 列为 Radio-OSP / Radio-ISP 且 S 列 tt_status_description 为 CLOSE 的记录。J 列关闭时间 − F 列创建时间，包含夜间、周末和跨期时间；按关闭日期归属期间。不取每日平均值的平均。','Only rows with Radio-OSP / Radio-ISP in column U and CLOSE in column S (tt_status_description) are retained. Resolution time is column J (closed) minus column F (created), including nights, weekends and time before the period. Tickets are grouped by close date. Daily means are not averaged.')}</p>{dataset&&<p>{t(`排除情况：分类 / 状态不匹配 ${count(dataset.excludedRows)} 行；匹配记录中时间缺失或无效 ${count(dataset.invalidDates)} 行，关闭早于创建 ${count(dataset.negativeDurations)} 行。0 时长工单保留。`,`Exclusions: ${count(dataset.excludedRows)} category / status mismatches; among matching rows, ${count(dataset.invalidDates)} missing or invalid timestamps and ${count(dataset.negativeDurations)} closes before creation. Zero-duration tickets are retained.`)}</p>}<p>{t('每次导入视为一份完整数据集并替换旧数据；同一文件内按行计数。时间按工单表原值计算，不转换时区。没有工单或基准均值为 0 时，不把不可计算的减少率写成 0%。','Each import replaces the prior dataset and rows within the file are counted individually. Timestamps use the workbook’s original values without timezone conversion. No tickets or a zero baseline mean make the reduction rate unavailable rather than 0%.')}</p><p className="mttr-caveat">{t('这是已导入工单的整体效率观察，未关联 FMEMate 使用记录，不能单独证明效率变化由 FMEMate 带来。工单复杂度、数量、筛选范围和数据完整性均可能影响结果。','This measures overall efficiency in imported tickets. Tickets are not linked to FMEMate usage, so the comparison alone cannot attribute a change to FMEMate. Ticket complexity, volume, selection and data completeness may affect the result.')}</p></div></details>
  </section>;
}
