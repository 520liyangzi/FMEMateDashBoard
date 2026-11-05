import {useEffect,useMemo,useRef,useState} from 'react';
import {Clock3,FileSpreadsheet,Upload} from 'lucide-react';
import {compareAlarmMttr,type AlarmMttrDataset} from '../lib/alarm-mttr';
import {previousMttrPeriod,type MttrPeriod} from '../lib/mttr';
import {createAlarmUploader,type AlarmApi,type AlarmProgress} from './alarm-upload';
import './alarm-mttr.css';

export type AlarmMttrPanelProps={
  lang:'zh'|'en';dataset:AlarmMttrDataset|null;baseline:MttrPeriod;current:MttrPeriod;
  onBaselineChange:(range:MttrPeriod)=>void;onCurrentChange:(range:MttrPeriod)=>void;
  onUseToday?:()=>void;readOnly:boolean;legacyPresent?:boolean;api:AlarmApi;
  onDatasetChange:(data:AlarmMttrDataset)=>void;
};
const count=(n:number)=>n.toLocaleString('en-US');
const tokens=(text:string)=>[...new Set(text.split(/[,，]/).map(x=>x.trim()).filter(Boolean))];
function duration(seconds:number|null){
  if(seconds===null||!Number.isFinite(seconds))return '—';
  const whole=Math.round(seconds);
  return `${Math.floor(whole/3600)}:${String(Math.floor(whole/60)%60).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}`;
}
function before(date:string,days:number){const dt=new Date(`${date}T00:00:00Z`);dt.setUTCDate(dt.getUTCDate()-days);return dt.toISOString().slice(0,10)}

export default function AlarmMttrPanel({lang,dataset,baseline,current,onBaselineChange,onCurrentChange,onUseToday,readOnly,legacyPresent,api,onDatasetChange}:AlarmMttrPanelProps){
  const t=(zh:string,en:string)=>lang==='zh'?zh:en;
  const listKey=(dataset?.allowlist??[]).join(',');
  const [list,setList]=useState(listKey),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState<''|'import'|'list'>('');
  const [progress,setProgress]=useState<AlarmProgress|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  const fileField=useRef<HTMLInputElement>(null),abort=useRef<AbortController|null>(null),active=useRef(false);
  const uploader=useMemo(()=>createAlarmUploader(api),[api]);
  useEffect(()=>{setList(listKey)},[listKey]);
  const [showImport,setShowImport]=useState(!dataset?.storedRows);
  const allowed=tokens(list),unsaved=allowed.join(',')!==listKey;
  const report=useMemo(()=>compareAlarmMttr(dataset,baseline,current),[dataset,baseline,current]);
  const latest=dataset?.latestDate,receipt=dataset?.lastImport;
  const overallSeconds=useMemo(()=>dataset?.totalAlarms&&Array.isArray(dataset.days)?dataset.days.reduce((s,d)=>s+d.totalSeconds,0)/dataset.totalAlarms:null,[dataset]);
  const status=()=>{
    if(!dataset?.storedRows)return readOnly?t('此离线报表没有告警数据。','This offline report contains no alarm data.'):t('导入一份告警表后即可对比。','Import an alarm file to compare two periods.');
    if(!dataset?.allowlist.length)return t('尚未配置告警 ID 白名单。','No alarm IDs are on the allowlist.');
    if(report.status==='invalid_range')return t('请选择两个完整的日期区间，开始日期不能晚于结束日期。','Select two complete periods, with the start on or before the end.');
    if(!dataset.totalAlarms)return t('没有符合当前白名单的有效告警。','No eligible alarms match the current allowlist.');
    if(report.status==='no_baseline_alarms')return t('基准期没有有效告警。','No eligible alarms in the baseline period.');
    if(report.status==='no_current_alarms')return t('对比期没有有效告警。','No eligible alarms in the comparison period.');
    if(report.status==='zero_baseline')return t('基准期均值为零，无法计算变化率。','The baseline mean is zero; the rate is unavailable.');
    if(report.reductionRate===null)return '—';
    return report.reductionRate===0?t('两期平均时长相同。','The period means are equal.'):report.reductionRate>0?t('对比期平均时长缩短。','The comparison period had a shorter mean duration.'):t('对比期平均时长延长。','The comparison period had a longer mean duration.');
  };
  function quick(days:number){if(!latest)return;const period={from:before(latest,days-1),to:latest};const prior=previousMttrPeriod(period);if(prior){onBaselineChange(prior);onCurrentChange(period)}}
  async function submit(action:'import'|'list'){
    if(readOnly||active.current||action==='import'&&(!file||!allowed.length))return;
    active.current=true;setBusy(action);setProgress(null);setError('');setMessage('');
    try{
      let updated:AlarmMttrDataset;
      if(action==='import'){
        const controller=new AbortController();abort.current=controller;
        updated=await uploader.upload(file!,list,setProgress,controller.signal);
        setFile(null);if(fileField.current)fileField.current.value='';
      }else updated=await api('/api/mttr/alarms/allowlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allowlist:list})});
      setList(updated.allowlist.join(','));onDatasetChange(updated);
      setMessage(action==='import'?t(`导入完成。当前白名单共匹配 ${count(updated.totalAlarms)} 条已保存告警。`,`Import complete. ${count(updated.totalAlarms)} saved alarms match the current allowlist.`):t(`白名单已保存并重新统计，匹配 ${count(updated.totalAlarms)} 条告警。`,`Allowlist saved. ${count(updated.totalAlarms)} saved alarms now match.`));
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{abort.current=null;setProgress(null);setBusy('');active.current=false}
  }
  const periodEditor=(key:'baseline'|'current',value:MttrPeriod,change:(p:MttrPeriod)=>void)=>{
    const title=key==='baseline'?t('基准期','Baseline period'):t('对比期','Comparison period');
    return <fieldset><legend>{title}</legend><div>{(['from','to'] as const).map(side=>{
      const label=side==='from'?t('开始日期','Start date'):t('结束日期','End date');
      return <label key={side}>{label}<input type="date" aria-label={`${title} · ${label}`} value={value[side]} onInput={e=>change({...value,[side]:e.currentTarget.value})} onChange={e=>change({...value,[side]:e.currentTarget.value})}/></label>;
    })}</div></fieldset>;
  };
  const periodCard=(title:string,value:typeof report.baseline)=><article><h3>{title}</h3><small>{value.from||'—'} — {value.to||'—'}</small><strong>{duration(value.meanSeconds)}</strong><small>{t('时:分:秒','h:mm:ss')} · {t(`${count(value.count)} 条有效告警`,`${count(value.count)} eligible alarms`)}</small></article>;
  return <section className="card alarm-mttr" aria-label={t('告警 MTTR','Alarm MTTR')}>
    <h2 className="alarm-intro"><Clock3 size={20}/>{t('告警平均处理时长（MTTR）','Mean alarm duration (MTTR)')}</h2>
    <p className="alarm-sub">{t('按 K 列告警发生日期对比两段时间，起止当天都计入。','Compare two periods by alarm occurrence date (column K), including both boundary dates.')}</p>
    {legacyPresent&&!dataset?.storedRows&&<p className="alarm-warning">{t('此处使用告警口径；旧 TT / Job 数据不参与计算。','This metric uses alarm records. Previous TT / Job data is excluded.')}</p>}
    <div className="alarm-periods">{periodEditor('baseline',baseline,onBaselineChange)}{periodEditor('current',current,onCurrentChange)}</div>
    <div className="alarm-presets screen-only">{[3,7].map(n=><button type="button" className="btn" key={n} disabled={!latest} onClick={()=>quick(n)}>{t(`最新 ${n} 天 vs 前 ${n} 天`,`Latest ${n} days vs prior ${n}`)}</button>)}{onUseToday&&<button type="button" className="btn" onClick={onUseToday}>{t('按今天对比近 7 天','Last 7 days through today')}</button>}</div>
    <div className="alarm-metrics">{periodCard(t('基准期 MTTR','Baseline MTTR'),report.baseline)}{periodCard(t('对比期 MTTR','Comparison MTTR'),report.current)}<article className={report.reductionRate===null||report.reductionRate===0?'':report.reductionRate>0?'alarm-positive':'alarm-negative'}><h3>{t('平均时长减少率','Reduction in mean duration')}</h3><strong>{report.reductionRate===null?'—':`${report.reductionRate.toFixed(1)}%`}</strong><small>{status()}</small></article></div>
    {report.overlap&&<p className="alarm-warning">{t('两个区间有重叠，重叠日期的告警会分别计入两期。','The periods overlap; alarms on shared dates are included in both.')}</p>}
    <p className="alarm-policy">{t('每期 MTTR = 有效告警的 Duration 总和 ÷ 有效告警条数；减少率 =（基准期均值 − 对比期均值）÷ 基准期均值 × 100%。','Period MTTR = total duration of eligible alarms ÷ eligible alarm count. Reduction = (baseline mean − comparison mean) ÷ baseline mean × 100%.')}</p>
    <p className="alarm-note">{t('有效告警：B 列告警 ID 在白名单内、AE 列 Job ID 非空、I 列 Duration 大于零，并有有效的 K 列发生日期。零时长视为未清除。','Eligible alarms have an allowlisted ID (B), a Job ID (AE), a positive duration (I), and a valid occurrence date (K). Zero duration means uncleared.')}</p>
    <p className="alarm-note alarm-meta">{t('当前白名单','Applied allowlist')}: {listKey||t('未配置','None')} · {t('统计日期','Covered dates')}: {dataset?.earliestDate??'—'} — {latest??'—'} · {t('全部有效告警','Eligible alarms across all dates')}: {count(dataset?.totalAlarms??0)} · {t('整体均值','Overall mean')}: {duration(overallSeconds)}</p>
    {!readOnly&&<details className="alarm-editor" open={showImport} onToggle={e=>setShowImport(e.currentTarget.open)}>
      <summary><FileSpreadsheet size={15} style={{verticalAlign:'middle',marginRight:5}}/>{t('导入告警表与配置白名单','Import alarm file and configure allowlist')}</summary>
      <label className="alarm-label">{t('告警 ID 白名单（逗号分隔）','Alarm ID allowlist (comma-separated)')}<input type="text" value={list} disabled={!!busy} placeholder="26540,26564,26568" onChange={e=>setList(e.target.value)}/></label>
      <div className="alarm-actions"><button type="button" className="btn" disabled={!!busy||!unsaved} onClick={()=>submit('list')}>{t('保存白名单并重新统计','Save allowlist and recalculate')}</button><small>{t('修改后可直接重新统计已保存的告警，无需重传。','Recalculate saved alarm rows without uploading the file again.')}</small></div>
      <label className="alarm-label alarm-file-line">{t('告警文件（第 1 行为表头）','Alarm file (headers in row 1)')}<input type="file" ref={fileField} accept=".xlsx,.csv" disabled={!!busy} onChange={e=>{setFile(e.target.files?.[0]??null);setError('');setMessage('')}}/></label>
      <p className="alarm-note">{t('I 列格式为 时:分:秒；例如 0:05:10 表示 5 分 10 秒。','Column I uses h:mm:ss. For example, 0:05:10 means 5 minutes and 10 seconds.')}</p>
      <div className="alarm-actions" style={{marginTop:12}}><button type="button" className="btn primary" disabled={!!busy||!file||!allowed.length} onClick={()=>submit('import')}><Upload size={15}/>{t('按此白名单导入','Import with this allowlist')}</button>{busy==='import'&&progress?.phase==='upload'&&<button className="btn" type="button" onClick={()=>abort.current?.abort()}>{t('取消上传','Cancel upload')}</button>}</div>
      {busy==='import'&&<div className="alarm-status" role="status">{progress?.phase==='parse'?t('文件已上传，正在解析并统计…','Upload complete. Parsing and calculating…'):t('正在上传…','Uploading…')}{progress?.phase==='upload'&&<> {Math.round(100*progress.loaded/progress.total)}% <progress aria-label={t('上传进度','Upload progress')} className="alarm-import-progress" max={progress.total} value={progress.loaded}/></>}</div>}
      {busy==='list'&&<div className="alarm-status" role="status">{t('正在重新统计…','Recalculating…')}</div>}
      {error&&<div className="alarm-status error-text" role="alert">{error}</div>}{message&&!busy&&<div className="alarm-status" role="status">{message}</div>}
    </details>}
    {receipt&&<details className="alarm-summary"><summary>{t('最近一次导入明细','Latest import details')} · {receipt.filename}</summary><p>{receipt.sheetName} · {receipt.importedAt}</p><dl className="alarm-counter-grid">{([
      [t('读取行数','Source rows'),receipt.sourceRows],[t('缺少 Job ID','Missing Job ID'),receipt.missingJobIds],[t('缺少告警 ID','Missing alarm ID'),receipt.missingAlarmIds],[t('发生时间无效','Invalid occurrence time'),receipt.invalidDates],[t('未清除（零时长）','Uncleared (zero)'),receipt.zeroDurations],[t('时长无效','Invalid duration'),receipt.invalidDurations],[t('可用于白名单筛选','Valid before allowlist'),receipt.validRows],[t('命中导入时白名单','Matched at import'),receipt.matchedRows],[t('新增保存行','New stored rows'),receipt.addedRows],[t('重复行','Duplicate rows'),receipt.duplicateRows],
    ] as const).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{count(value)}</dd></div>)}</dl></details>}
  </section>;
}
