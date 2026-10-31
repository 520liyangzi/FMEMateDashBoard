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
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[importProgress,setImportProgress]=useState('');
  const [errorDetails,setErrorDetails]=useState<unknown|null>(null);
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
  async function importFiles(files:File[]){
    if(!files.length)return;
    if(dataset&&dataset.formatVersion!==2&&!window.confirm(t('旧版仅保留汇总，没有工单 ID；本次成功导入将用新文件重建工单库。请先上传覆盖全部历史的文件；导入失败不会改动旧数据。是否继续？','The legacy dataset contains aggregates without ticket IDs. A successful import will rebuild the ticket store from the new file. Upload a file covering all historical tickets first; a failed import will leave the old dataset unchanged. Continue?')))return;
    setError('');setErrorDetails(null);setBusy(true);let completed=0;
    try{
      for(const file of files){
        setImportProgress(t(`正在处理 ${completed+1}/${files.length}：${file.name}`,`Processing ${completed+1}/${files.length}: ${file.name}`));
        try{await onImport(file);completed++;}
        catch(e){
          const detail=e instanceof Error?e.message:String(e);
          setErrorDetails(e&&typeof e==='object'&&'details' in e?e.details:null);
          setError(t(`文件「${file.name}」导入失败：${detail}。已成功导入 ${completed} 个文件，其数据已保留；后续文件尚未处理，请修正后重新导入。`,`Import failed for “${file.name}”: ${detail}. ${completed} file(s) were imported successfully and their data is retained. Later files were not processed; correct the issue and retry.`));
          setImportProgress('');return;
        }
      }
      setImportProgress(t(`已完成 ${completed} 个文件；按 B 列工单 ID 累积去重，下方显示最新一次导入明细。`,`Completed ${completed} file(s). Tickets accumulate with column B ID deduplication; details below describe the latest import.`));
    }finally{setBusy(false);}
  }
  async function clear(){if(!window.confirm(t('确定清除当前 MTTR 工单数据？已导入的用户日志不受影响。','Clear the current MTTR ticket dataset? Imported app logs will remain available.')))return;setError('');setErrorDetails(null);setImportProgress('');setBusy(true);try{await onClear();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
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
    {!readOnly&&<div className="mttr-import-controls"><input hidden ref={fileInput} type="file" multiple accept=".xlsx,.csv,.xls" onChange={e=>{const files=Array.from(e.currentTarget.files||[]);e.currentTarget.value='';if(files.length)void importFiles(files);}}/><button className="btn primary" disabled={busy} onClick={()=>fileInput.current?.click()}><Upload size={15}/>{busy?t('正在处理工单…','Processing tickets…'):t('导入工单 Excel','Import ticket Excel')}</button>{dataset&&<button className="text-button mttr-clear" disabled={busy} onClick={()=>void clear()}><Trash2 size={14}/>{t('清除工单数据','Clear ticket dataset')}</button>}<span>{t('支持多文件 · 按 B 列工单 ID 累积去重','Multiple files supported · accumulate unique column B ticket IDs')}</span></div>}
    {importProgress&&<div className="mttr-import-progress" role="status" aria-live="polite">{importProgress}</div>}
    {error&&<div className="mttr-error" role="alert">{error}</div>}
    {errorDetails!==null&&<details className="mttr-error-details"><summary>{t('查看列诊断','View column diagnostics')}</summary><p>{t('核对所读工作表、表头及 U / S / F / J 列样例值，可定位筛选或时间格式问题。','Check the worksheet, headers and sample values in U / S / F / J to identify filtering or timestamp issues.')}</p><pre>{JSON.stringify(errorDetails,null,2)}</pre></details>}
    {!dataset&&<div className="mttr-empty"><FileSpreadsheet size={26}/><div><strong>{t('导入工单表，开始计算成效','Import ticket data to measure progress')}</strong><p>{t('支持多选 .xlsx 和 UTF-8 CSV。读取第一个工作表，从物理第 2 行开始；按 B 列工单 ID 累积去重，只汇总符合条件的有效工单，原始明细不发送到页面。','Select one or more .xlsx or UTF-8 CSV files. The first worksheet is read from physical row 2, with unique ticket IDs from column B accumulated across imports. Only eligible valid tickets are aggregated; raw details are not sent to the page.')}</p></div></div>}
    {dataset&&<>
      {dataset.formatVersion!==2&&<div className="mttr-warning"><Info size={14}/>{t('当前为旧版汇总数据，尚未记录工单 ID。下一次成功导入将重建工单库，请先上传覆盖全部历史的文件。','This legacy dataset has no ticket IDs. The next successful import will rebuild the ticket store; upload a file covering all historical tickets first.')}</div>}
      <div className="mttr-dataset"><FileSpreadsheet size={17}/><div><strong>{t('最新导入：','Latest import: ')}{dataset.filename}</strong>{dataset.sheetName&&<span>{t('读取工作表：','Worksheet: ')}{dataset.sheetName}</span>}<span>{t(`累计关闭日期：${dataset.earliestDate||'—'} 至 ${dataset.latestDate||'—'}`,`Accumulated close dates: ${dataset.earliestDate||'—'} to ${dataset.latestDate||'—'}`)}</span><span>{t('导入时间：','Imported: ')}{dataset.importedAt?new Date(dataset.importedAt).toLocaleString(lang==='zh'?'zh-CN':'en-GB'):'—'}</span></div><dl><div><dt>{dataset.formatVersion===2?t('累计唯一工单','Accumulated unique tickets'):t('旧版有效工单','Legacy valid tickets')}</dt><dd>{count(dataset.totalTickets??dataset.validRows)}</dd></div><div><dt>{t('本次新增','Added this import')}</dt><dd>{dataset.addedRows===undefined?'—':count(dataset.addedRows)}</dd></div><div><dt>{t('本次重复跳过','Duplicates skipped')}</dt><dd>{dataset.duplicateRows===undefined?'—':count(dataset.duplicateRows)}</dd></div></dl></div>
      <div className="mttr-import-diagnostics" aria-label={t('最新导入明细','Latest import details')}><strong>{t('最新文件处理明细（非累计）','Latest file diagnostics (not cumulative)')}</strong><dl><div><dt>{t('第 2 行起非空数据行','Nonempty rows from row 2')}</dt><dd>{count(dataset.sourceRows)}</dd></div><div><dt>{t('U 列分类匹配','Column U category match')}</dt><dd>{dataset.diagnostics?count(dataset.diagnostics.categoryMatches):'—'}</dd></div><div><dt>{t('S 列 CLOSE 匹配','Column S CLOSE match')}</dt><dd>{dataset.diagnostics?count(dataset.diagnostics.statusMatches):'—'}</dd></div><div><dt>{t('分类 / 状态同时匹配','Category / status both match')}</dt><dd>{count(dataset.matchedRows)}</dd></div><div><dt>{t('有效候选行','Valid candidate rows')}</dt><dd>{count(dataset.validRows)}</dd></div><div><dt>{t('缺少 B 列 ID','Missing column B ID')}</dt><dd>{dataset.missingIds===undefined?'—':count(dataset.missingIds)}</dd></div><div><dt>{t('时间缺失 / 无效','Missing / invalid timestamps')}</dt><dd>{count(dataset.invalidDates)}</dd></div><div><dt>{t('关闭早于创建','Closed before created')}</dt><dd>{count(dataset.negativeDurations)}</dd></div><div><dt>{t('分类 / 状态不匹配','Category / status excluded')}</dt><dd>{count(dataset.excludedRows)}</dd></div></dl><p>{t('重复数包含本文件内以及之前已保存的相同工单 ID。首次有效记录保留，后续相同 ID 不更新时长。','Duplicates include IDs repeated within this file or already saved. The first valid record is retained; later rows with the same ID do not update its resolution time.')}</p></div>
    </>}
    <div className="mttr-period-controls"><div className="mttr-period-editor"><label><CalendarDays size={14}/>{t('基准期','Baseline period')}</label><div>{dateInput('baseline','from')}<span>—</span>{dateInput('baseline','to')}</div></div><div className="mttr-period-editor"><label><CalendarDays size={14}/>{t('对比期','Comparison period')}</label><div>{dateInput('current','from')}<span>—</span>{dateInput('current','to')}</div></div></div>
    <div className="mttr-shortcuts"><div><button disabled={busy||!dataset} onClick={()=>recent(3)}>{t('最近 3 天 vs 前 3 天','Latest 3 days vs prior 3')}</button><button disabled={busy||!dataset} onClick={completeWeek}>{t('最近完整周 vs 前一周','Latest full week vs prior week')}</button><button disabled={busy} onClick={()=>applyCurrent(current)}>{t('基准期设为前一等长周期','Use preceding equal-length baseline')}</button></div><div><button disabled={busy} aria-label={t('MTTR 两期向前切换','Move both MTTR periods earlier')} onClick={()=>shift(-1)}><ChevronLeft size={14}/>{t('前一周期','Earlier')}</button><button disabled={busy} aria-label={t('MTTR 两期向后切换','Move both MTTR periods later')} onClick={()=>shift(1)}>{t('后一周期','Later')}<ChevronRight size={14}/></button></div></div>
    <p className="mttr-shortcut-note">{t('快捷日期以已导入工单的最新关闭日为锚点；完整周为周一至周日，日期完整不代表工单导入完整。','Date shortcuts use the latest imported close date. Full weeks run Monday–Sunday; full calendar periods do not confirm complete ticket coverage.')}</p>
    <div className="mttr-results"><article className="mttr-period-result"><span>{t('基准期 MTTR','Baseline MTTR')}</span><p>{baseline.from||'—'} — {baseline.to||'—'}</p><strong>{hours(result.baseline.meanSeconds)}<small>{t('小时','hours')}</small></strong><div>{t(`${count(result.baseline.count)} 个有效关闭工单`,`${count(result.baseline.count)} valid closed tickets`)}</div></article><article className="mttr-period-result"><span>{t('对比期 MTTR','Comparison MTTR')}</span><p>{current.from||'—'} — {current.to||'—'}</p><strong>{hours(result.current.meanSeconds)}<small>{t('小时','hours')}</small></strong><div>{t(`${count(result.current.count)} 个有效关闭工单`,`${count(result.current.count)} valid closed tickets`)}</div></article><article className={'mttr-rate-result '+(!valid?'mttr-neutral':slower?'mttr-slower':result.reductionRate!>0?'mttr-faster':'mttr-neutral')}><span>{t('MTTR 减少率','MTTR reduction rate')}</span><strong>{valid?(result.reductionRate!>0?<ArrowDownRight size={23}/>:slower?<ArrowUpRight size={23}/>:null):null}{valid?`${result.reductionRate!.toFixed(1)}%`:'—'}</strong><div>{statusText()}</div>{result.savedSeconds!==null&&<p>{t(`平均每单${result.savedSeconds<0?'增加':'减少'} ${hours(Math.abs(result.savedSeconds))} 小时`,`Mean time ${result.savedSeconds<0?'increased':'reduced'} by ${hours(Math.abs(result.savedSeconds))} hours per ticket`)}</p>}</article></div>
    {result.overlap&&<div className="mttr-warning"><Info size={14}/>{t('两个期间存在重叠，重叠日期的工单会同时计入两期。建议选择不重叠期间进行比较。','The periods overlap. Tickets on shared dates enter both averages; non-overlapping periods are recommended for comparison.')}</div>}
    {result.unequalDays&&<div className="mttr-warning"><Info size={14}/>{t('两期自然日数不同。平均时长仍按工单数加权计算，请结合工单数量和覆盖范围解读。','The periods have different calendar lengths. Means remain weighted by ticket count; consider both sample size and coverage.')}</div>}
    <p className="mttr-formula">{t('MTTR = 期间内有效工单总处理时长 ÷ 有效工单数。减少率 =（基准期 MTTR − 对比期 MTTR）÷ 基准期 MTTR × 100%；正数表示时长缩短，负数表示时长增加。','MTTR = total resolution time of valid tickets in the period ÷ valid ticket count. Reduction rate = (baseline MTTR − comparison MTTR) ÷ baseline MTTR × 100%. Positive means shorter; negative means longer.')}</p>
    <details className="mttr-method" open><summary>{t('计算口径与数据质量','Methodology and data quality')}</summary><div><p>{t('从第一个工作表的物理第 2 行开始读取，第 1 行固定跳过。B 列为工单 ID；只保留 U 列为 Radio-OSP / Radio-ISP 且 S 列 tt_status_description 为 CLOSE 的记录。J 列关闭时间 − F 列创建时间，包含夜间、周末和跨期时间；按关闭日期归属期间。不取每日平均值的平均。','The first worksheet is read starting at physical row 2; row 1 is always skipped. Column B contains the ticket ID. Only rows with Radio-OSP / Radio-ISP in column U and CLOSE in column S (tt_status_description) are retained. Resolution time is column J (closed) minus column F (created), including nights, weekends and time before the period. Tickets are grouped by close date. Daily means are not averaged.')}</p>{dataset&&<p>{t(`排除情况：分类 / 状态不匹配 ${count(dataset.excludedRows)} 行；匹配记录中时间缺失或无效 ${count(dataset.invalidDates)} 行，关闭早于创建 ${count(dataset.negativeDurations)} 行。0 时长工单保留。`,`Exclusions: ${count(dataset.excludedRows)} category / status mismatches; among matching rows, ${count(dataset.invalidDates)} missing or invalid timestamps and ${count(dataset.negativeDurations)} closes before creation. Zero-duration tickets are retained.`)}</p>}<p>{t('工单按 B 列 ID 跨文件、跨上传累积去重：首次通过分类、状态、ID 和时间校验的记录保留；之后相同 ID 一律跳过，不覆盖原始时长。缺少 ID 的记录不计入。时间按工单表原值计算，不转换时区。没有工单或基准均值为 0 时，不把不可计算的减少率写成 0%。','Tickets accumulate with column B ID deduplication within and across uploads. The first record passing category, status, ID and timestamp validation is retained; later records with that ID are skipped without changing its original duration. Missing IDs are excluded. Timestamps use the workbook’s original values without timezone conversion. No tickets or a zero baseline mean make the reduction rate unavailable rather than 0%.')}</p><p className="mttr-caveat">{t('这是已导入工单的整体效率观察，未关联 FMEMate 使用记录，不能单独证明效率变化由 FMEMate 带来。工单复杂度、数量、筛选范围和数据完整性均可能影响结果。','This measures overall efficiency in imported tickets. Tickets are not linked to FMEMate usage, so the comparison alone cannot attribute a change to FMEMate. Ticket complexity, volume, selection and data completeness may affect the result.')}</p></div></details>
  </section>;
}
