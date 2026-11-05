import {useEffect,useMemo,useRef,useState} from 'react';
import {Clock3,FileSpreadsheet,Search,Upload} from 'lucide-react';
import {compareJobProxyMttr,getJobProxyAssignees,rankJobProxyMttr,type JobProxyMttrDataset} from '../lib/alarm-mttr';
import {previousMttrPeriod,type MttrPeriod} from '../lib/mttr';
import {createAlarmUploader,type AlarmApi,type AlarmProgress} from './alarm-upload';
import JobMttrDetails from './JobMttrDetails';
import type {JobProxyDetailRow} from '../lib/job-mttr-details';
import './alarm-mttr.css';

type Translate=(zh:string,en:string)=>string;
export type AlarmMttrPanelProps={
  lang:'zh'|'en';dataset:JobProxyMttrDataset|null;baseline:MttrPeriod;current:MttrPeriod;
  onBaselineChange:(range:MttrPeriod)=>void;onCurrentChange:(range:MttrPeriod)=>void;
  selectedAssignees:string[]|null;onSelectedAssigneesChange:(values:string[]|null)=>void;
  onUseToday?:()=>void;readOnly:boolean;legacyPresent?:boolean;api:AlarmApi;
  onDatasetChange:(data:JobProxyMttrDataset)=>void;
  offlineJobRows?:JobProxyDetailRow[];onExportJobDetails?:()=>void|Promise<void>;
};
const count=(n:number)=>n.toLocaleString('en-US');
const tokens=(text:string)=>[...new Set(text.split(/[,，]/).map(x=>x.trim()).filter(Boolean))];
function duration(seconds:number|null){
  if(seconds===null||!Number.isFinite(seconds))return '—';const whole=Math.round(seconds);
  return `${Math.floor(whole/3600)}:${String(Math.floor(whole/60)%60).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}`;
}
function before(date:string,days:number){const dt=new Date(`${date}T00:00:00Z`);dt.setUTCDate(dt.getUTCDate()-days);return dt.toISOString().slice(0,10)}
function scopeLabel(selected:string[]|null,t:Translate){
  if(selected==null)return t('全部工单（含未分配）','All Jobs (including unassigned)');
  if(!selected.length)return t('未选择人员','No assignees selected');
  return selected.map(name=>name||t('未分配','Unassigned')).join('、');
}
function AssigneeScope({t,names,hasUnassigned,selected,onChange}:{t:Translate;names:string[];hasUnassigned:boolean;selected:string[]|null;onChange:(v:string[]|null)=>void}){
  const [query,setQuery]=useState(''),[limit,setLimit]=useState(40);
  const [paste,setPaste]=useState(''),[missing,setMissing]=useState<string[]>([]),[applied,setApplied]=useState<string[]|null>(null);
  const pastedNames=useMemo(()=>[...new Set(paste.split(/[,，、;；\r\n]+/).map(n=>n.trim()).filter(Boolean))],[paste]);
  const applyList=()=>{
    const list=pastedNames,known=new Set(names);
    const unmatched=list.filter(name=>!known.has(name));setMissing(unmatched);setApplied(null);
    if(list.length&&!unmatched.length){onChange(list);setApplied(list)}
  };
  const selectedSet=useMemo(()=>new Set(selected??[]),[selected]);
  const options=useMemo(()=>Array.from(new Set([...names,...(hasUnassigned?['']:[]),...(selected??[])])),[names,hasUnassigned,selected]);
  const label=(name:string)=>name||t('未分配','Unassigned');
  const matches=options.filter(name=>label(name).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const add=(additions:string[])=>onChange([...new Set([...(selected??[]),...additions])]);
  return <div className="job-scope-editor screen-only"><details>
    <summary>{t('选择统计人员','Select assignees')} <span>{selected==null?t('全部','All'):t(`已选 ${selected.length} 项`,`${selected.length} selected`)}</span></summary>
    <p className="alarm-note">{t('勾选姓名可查看个人或组合；选择“全部工单”可恢复整体统计。','Check a name for one person, or several names for a team. Choose All Jobs to restore the overall comparison.')}</p>
    <div className="alarm-actions job-scope-actions"><button type="button" className="btn" onClick={()=>onChange(null)}>{t('全部工单','All Jobs')}</button><button type="button" className="btn" onClick={()=>onChange([])}>{t('清空选择','Clear selection')}</button></div>
    <details className="job-paste-list"><summary>{t('粘贴人员名单','Paste a list of names')}</summary>
      <label>{t('姓名用逗号或换行分隔，须与人员表中的姓名一致。','Use exact names from the ownership file, separated by commas or line breaks.')}<textarea value={paste} rows={3} aria-label={t('人员名单','List of assignee names')} onChange={e=>{setPaste(e.target.value);setMissing([]);setApplied(null)}}/></label>
      <button type="button" disabled={!pastedNames.length} className="btn" onClick={applyList}>{t('按名单筛选','Use this list')}</button>
      {missing.length>0&&<p className="alarm-warning" role="alert">{t('未匹配以下姓名，原选择已保留：','The selection is unchanged. Names not found: ')}{missing.join(', ')}</p>}
      {applied&&applied===selected&&<p className="alarm-note" role="status">{t(`已按名单选择 ${applied.length} 人。`,`Applied list of ${applied.length} assignees.`)}</p>}
    </details>
    <label className="job-name-search"><Search size={15}/><input type="search" aria-label={t('搜索处理人','Search assignees')} value={query} placeholder={t('输入姓名搜索','Search by name')} onChange={e=>{setQuery(e.target.value);setLimit(40)}}/></label>
    <div className="job-scope-hits"><small>{t(`${count(matches.length)} 项匹配`,`${count(matches.length)} matches`)}</small>{query.trim()&&matches.length>0&&<button type="button" className="text-button" onClick={()=>add(matches)}>{t('选中所有匹配项','Add all matches')}</button>}</div>
    <div className="job-name-options">{matches.slice(0,limit).map(name=><label key={name}><input type="checkbox" checked={selectedSet.has(name)} onChange={e=>e.target.checked?add([name]):onChange((selected??[]).filter(n=>n!==name))}/>{label(name)}</label>)}{!matches.length&&<span>{t('暂无匹配人员','No matching assignees')}</span>}</div>
    {matches.length>limit&&<button type="button" className="text-button" onClick={()=>setLimit(n=>n+40)}>{t('显示更多人员','Show more assignees')}</button>}
  </details></div>;
}
function ImportEditor({dataset,t,api,onDatasetChange}:{dataset:JobProxyMttrDataset|null;t:Translate;api:AlarmApi;onDatasetChange:(v:JobProxyMttrDataset)=>void}){
  const listKey=(dataset?.allowlist??[]).join(',');const [list,setList]=useState(listKey);
  useEffect(()=>{setList(listKey)},[listKey]);
  const [files,setFiles]=useState<{alarm:File|null;job:File|null}>({alarm:null,job:null}),[busy,setBusy]=useState<''|'alarm'|'job'|'list'>('');
  const [progress,setProgress]=useState<AlarmProgress|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  const inputs=useRef<{alarm:HTMLInputElement|null;job:HTMLInputElement|null}>({alarm:null,job:null}),abort=useRef<AbortController|null>(null),active=useRef(false);
  const uploaders=useMemo(()=>({alarm:createAlarmUploader(api),job:createAlarmUploader(api,'job')}),[api]);
  const [open,setOpen]=useState(!dataset?.storedRows||!!dataset?.needsAlarmReimport);
  const allowed=tokens(list),unsaved=allowed.join(',')!==listKey;
  async function submit(action:'alarm'|'job'|'list'){
    if(active.current||action!=='list'&&!files[action]||action==='alarm'&&!allowed.length)return;
    active.current=true;setBusy(action);setProgress(null);setError('');setMessage('');
    try{
      let updated:JobProxyMttrDataset;
      if(action==='list')updated=await api('/api/mttr/alarms/allowlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allowlist:list})});
      else{const controller=new AbortController();abort.current=controller;updated=await uploaders[action].upload(files[action]!,list,setProgress,controller.signal);
        setFiles(f=>({...f,[action]:null}));if(inputs.current[action])inputs.current[action]!.value='';}
      if(action!=='job')setList(updated.allowlist.join(','));onDatasetChange(updated);
      setMessage(action==='job'?t(`人员归属已更新；目前有 ${count(updated.mappedJobs)} 个 Job 有人员映射。`,`Assignee mapping updated; ${count(updated.mappedJobs)} Jobs now have an owner mapping.`):t(`统计已更新：共 ${count(updated.totalJobs)} 个有效工单。`,`Updated: ${count(updated.totalJobs)} eligible Jobs.`));
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{abort.current=null;setProgress(null);setBusy('');active.current=false}
  }
  const fileField=(kind:'alarm'|'job',label:string)=><label className="alarm-label alarm-file-line">{label}<input type="file" ref={el=>{inputs.current[kind]=el}} accept=".xlsx,.csv" disabled={!!busy} onChange={e=>{const f=e.target.files?.[0]??null;setFiles(old=>({...old,[kind]:f}));setError('');setMessage('')}}/></label>;
  return <details className="alarm-editor" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><FileSpreadsheet size={15}/>{t('导入告警与 Job 人员表','Import alarm and Job files')}</summary>
    <p className="alarm-note">{t('两个文件可分开上传、独立更新。默认读取第一个工作表，第 1 行为表头。','Upload either file first and update each independently. The first sheet is read with row 1 as its header.')}</p>
    <div className="job-import-sources"><section><h3>{t('告警及白名单','Alarms and allowlist')}</h3>
      <label className="alarm-label">{t('告警 ID 白名单（逗号分隔）','Alarm ID allowlist (comma-separated)')}<input type="text" value={list} disabled={!!busy} placeholder="26540,26564,26568" onChange={e=>setList(e.target.value)}/></label>
      <button type="button" className="btn" disabled={!!busy||!unsaved} onClick={()=>submit('list')}>{t('保存白名单并重新统计','Save allowlist and recalculate')}</button>
      {fileField('alarm',t('告警文件','Alarm file'))}<p className="alarm-note">{t('B：告警 ID；I：Duration（时:分:秒）；K：发生时间；AE：Job ID。','B: alarm ID; I: duration (h:mm:ss); K: occurrence time; AE: Job ID.')}</p>
      <button type="button" className="btn primary" disabled={!!busy||!files.alarm||!allowed.length} onClick={()=>submit('alarm')}><Upload size={15}/>{t('按此白名单导入告警','Import alarms with this allowlist')}</button>
    </section><section><h3>{t('Job 人员归属','Job ownership')}</h3>
      {fileField('job',t('Job 人员文件','Job ownership file'))}<p className="alarm-note">{t('C：Job ID；AG：jb_assign_to（处理人）。导入后按 Job ID 关联已保存的告警。','C: Job ID; AG: jb_assign_to (assignee). After import, saved alarms are matched by Job ID.')}</p>
      <button type="button" className="btn primary" disabled={!!busy||!files.job} onClick={()=>submit('job')}><Upload size={15}/>{t('导入 Job 人员表','Import Job ownership')}</button>
      {dataset?.lastJobImport&&<p className="alarm-note">{t('最近导入','Last import')}: {dataset.lastJobImport.filename}</p>}
    </section></div>
    {(busy==='alarm'||busy==='job')&&<div className="alarm-status" role="status">{progress?.phase==='parse'?t('正在解析并重新统计…','Parsing and recalculating…'):t('正在上传…','Uploading…')}{progress?.phase==='upload'&&<> {Math.round(100*progress.loaded/progress.total)}% <progress aria-label={t('上传进度','Upload progress')} className="alarm-import-progress" max={progress.total} value={progress.loaded}/> <button type="button" className="btn" onClick={()=>abort.current?.abort()}>{t('取消上传','Cancel upload')}</button></>}</div>}
    {busy==='list'&&<div className="alarm-status" role="status">{t('正在重新统计…','Recalculating…')}</div>}{error&&<div className="alarm-status error-text" role="alert">{error}</div>}{message&&!busy&&<div className="alarm-status" role="status">{message}</div>}
  </details>;
}

export default function AlarmMttrPanel({lang,dataset:input,baseline,current,onBaselineChange,onCurrentChange,selectedAssignees=null,onSelectedAssigneesChange,onUseToday,readOnly,legacyPresent,api,onDatasetChange,offlineJobRows,onExportJobDetails}:AlarmMttrPanelProps){
  const t:Translate=(zh,en)=>lang==='zh'?zh:en;
  const data=input?.formatVersion===5&&input.source==='alarm-jobs'?input:null;
  const names=useMemo(()=>getJobProxyAssignees(data),[data]);
  const report=useMemo(()=>compareJobProxyMttr(data,baseline,current,selectedAssignees),[data,baseline,current,selectedAssignees]);
  const ranking=useMemo(()=>rankJobProxyMttr(data,baseline,current,selectedAssignees),[data,baseline,current,selectedAssignees]);
  const latest=data?.latestDate,alarms=data?.lastImport,jobs=data?.lastJobImport;
  const listKey=data?.allowlist.join(', ')||t('未配置','None');
  const unavailable=(status:string)=>{
    if(selectedAssignees?.length===0)return t('尚未选择统计人员。','No assignees selected.');
    if(status==='alarm_reimport_required')return t('需重新导入原告警表。','Re-import the original alarm files.');
    if(status==='invalid_range')return t('日期区间无效。','Invalid date range.');
    if(status==='no_dataset')return readOnly?t('此快照无工单数据。','No Job data in this snapshot.'):t('请先导入告警表。','Import alarm data first.');
    if(status==='no_baseline_jobs')return t('基准期无有效工单。','No eligible Jobs in baseline.');
    if(status==='no_current_jobs')return t('对比期无有效工单。','No eligible Jobs in comparison.');
    if(status==='no_jobs_both_periods')return t('两个时段均无有效工单。','Neither period has eligible Jobs.');
    if(status==='zero_baseline')return t('基准均值为零。','Baseline mean is zero.');
    return t('数据不足。','Insufficient data.');
  };
  function quick(days:number){if(!latest)return;const period={from:before(latest,days-1),to:latest};const prior=previousMttrPeriod(period);if(prior){onBaselineChange(prior);onCurrentChange(period)}}
  const periodEditor=(title:string,value:MttrPeriod,change:(p:MttrPeriod)=>void)=><fieldset><legend>{title}</legend><div>{(['from','to'] as const).map(side=>{
    const label=side==='from'?t('开始日期','Start date'):t('结束日期','End date');return <label key={side}>{label}<input type="date" aria-label={`${title} · ${label}`} value={value[side]} onInput={e=>change({...value,[side]:e.currentTarget.value})} onChange={e=>change({...value,[side]:e.currentTarget.value})}/></label>;
  })}</div></fieldset>;
  const periodCard=(title:string,p:typeof report.baseline)=><article><h3>{title}</h3><small>{p.from||'—'} — {p.to||'—'}</small><strong>{duration(p.meanSeconds)}</strong><small>{t('时:分:秒','h:mm:ss')} · {t(`${count(p.count)} 个有效工单`,`${count(p.count)} eligible Jobs`)}</small></article>;
  const rate=report.reductionRate, scope=scopeLabel(selectedAssignees,t);
  const counters=(pairs:([string,number])[])=><dl className="alarm-counter-grid">{pairs.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{count(value)}</dd></div>)}</dl>;
  return <section className="card alarm-mttr" aria-label={t('工单 MTTR','Job MTTR')}>
    <h2 className="alarm-intro"><Clock3 size={20}/>{t('工单 MTTR（按最长告警时长）','Job MTTR (longest alarm per Job)')}</h2>
    <p className="alarm-sub">{t('一个 Job 计一次，使用该工单最长的有效告警 Duration 估算处理时长。','Each Job counts once. Its longest eligible alarm duration is used to estimate its resolution time.')}</p>
    {data?.needsAlarmReimport&&<p className="alarm-warning job-coverage-warning" role="status">{t(`有 ${count(data.legacyUnlinkedRows)} 条旧版告警记录缺少可关联的 Job ID，未参与本页统计。重新导入原告警文件后可恢复关联。`,`${count(data.legacyUnlinkedRows)} legacy alarm records have no recoverable Job ID and are excluded. Re-import the original alarm files to restore their links.`)}</p>}
    {legacyPresent&&!data?.storedRows&&<p className="alarm-note">{t('以往按 TT/Job 时间计算的汇总无法换算，请导入原告警文件。','Old TT/Job time summaries cannot be converted. Import the original alarm files.')}</p>}
    {!readOnly&&<ImportEditor t={t} dataset={data} api={api} onDatasetChange={onDatasetChange}/>}
    <div className="alarm-periods">{periodEditor(t('基准期','Baseline period'),baseline,onBaselineChange)}{periodEditor(t('对比期','Comparison period'),current,onCurrentChange)}</div>
    <div className="alarm-presets screen-only">{[3,7].map(n=><button type="button" className="btn" key={n} disabled={!latest} onClick={()=>quick(n)}>{t(`最新 ${n} 天 vs 前 ${n} 天`,`Latest ${n} days vs prior ${n}`)}</button>)}{onUseToday&&<button type="button" className="btn" onClick={onUseToday}>{t('按今天对比近 7 天','Last 7 days through today')}</button>}</div>
    <AssigneeScope t={t} names={names} hasUnassigned={!!data?.unassignedJobs} selected={selectedAssignees} onChange={onSelectedAssigneesChange}/>
    <p className="job-scope-label"><b>{t('统计对象','Reporting scope')}:</b> {scope}</p>
    <div className="alarm-metrics">{periodCard(t('基准期 MTTR','Baseline MTTR'),report.baseline)}{periodCard(t('对比期 MTTR','Comparison MTTR'),report.current)}<article className={rate===null||rate===0?'':rate>0?'alarm-positive':'alarm-negative'}><h3>{t('MTTR 提升率','MTTR improvement')}</h3><strong>{rate===null?'—':`${rate.toFixed(1)}%`}</strong><small>{rate===null?unavailable(report.status):rate>0?t('对比期平均时长缩短。','Shorter mean duration.'):rate<0?t('对比期平均时长延长。','Longer mean duration.'):t('两期均值相同。','No change in mean duration.')}</small></article></div>
    {report.overlap&&<p className="alarm-warning">{t('两个区间有重叠，归属日相同的工单会分别计入两期。','The periods overlap; Jobs on shared dates count in both.')}</p>}
    <p className="alarm-policy">{t('每个工单全量取一次最大值，再按该条告警的 K 列发生日期归期（并列取最早发生的）。所选人员的 MTTR = 这些工单的最大时长总和 ÷ 工单数。提升率 =（基准期均值 − 对比期均值）÷ 基准期均值。','Take the maximum duration across all eligible alarms for each Job, then assign it to the occurrence date in K of that alarm (earliest occurrence if tied). For the selected people, MTTR is the sum of these Job durations divided by the number of Jobs. Improvement is (baseline mean − comparison mean) ÷ baseline mean.')}</p>
    <p className="alarm-note">{t('有效告警须满足：B 列告警 ID 命中白名单，AE 列 Job ID 非空，I 列 Duration 大于 0，K 列发生时间有效。0:00:00 代表尚未清除，不参与比较。','Eligible alarms require an allowlisted alarm ID (B), a nonblank Job ID (AE), a positive duration (I), and a valid occurrence date (K). Zero-duration alarms are uncleared and excluded.')}</p>
    <p className="alarm-note alarm-meta">{t('当前白名单','Applied allowlist')}: {listKey} · {t('全部日期有效工单','Eligible Jobs across all dates')}: {count(data?.totalJobs??0)} · {t('对应有效告警','Eligible alarms')}: {count(data?.totalAlarms??0)} · {t('未分配工单','Unassigned Jobs')}: {count(data?.unassignedJobs??0)}{latest&&<> · {data?.earliestDate} — {latest}</>}</p>
    <section className="job-rank" aria-label={t('人员 MTTR 提升率排行','MTTR improvement by assignee')}><h3>{t('人员 MTTR 提升率排行','MTTR improvement by assignee')}</h3>
      <p className="alarm-note">{t('按当前人员范围，依提升率从高到低排列。缺少任一期样本的人员列在最后；没有匹配到处理人的工单保留在整体统计，不列入人员排名。','Ranked within the selected scope, highest improvement first. People missing a period appear last. Jobs without an assignee are included in overall totals but have no personal rank.')}</p>
      {ranking.length>0?<div className="job-rank-table"><table><thead><tr>{[t('排名','Rank'),t('处理人','Assignee'),t('基准期工单数','Baseline Jobs'),t('基准期 MTTR','Baseline MTTR'),t('对比期工单数','Comparison Jobs'),t('对比期 MTTR','Comparison MTTR'),t('提升率','Improvement')].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{ranking.map(r=><tr key={r.assignee}><td>{r.rank??'—'}</td><th scope="row">{r.assignee}</th><td>{count(r.comparison.baseline.count)}</td><td>{duration(r.comparison.baseline.meanSeconds)}</td><td>{count(r.comparison.current.count)}</td><td>{duration(r.comparison.current.meanSeconds)}</td><td className={r.comparison.reductionRate>0?'positive':''}>{r.comparison.reductionRate===null?<><span>—</span><small>{unavailable(r.comparison.status)}</small></>:`${r.comparison.reductionRate.toFixed(1)}%`}</td></tr>)}</tbody></table></div>:<p className="job-rank-empty">{selectedAssignees?.length===0?t('请选择人员或全部工单。','Select assignees or All Jobs.'):!data?.mappedJobs?t('尚无人员归属，请导入 Job 人员表。','No assignee mappings are available. Import the Job ownership file.'):t('所选日期及人员范围内没有具名工单。','No assigned Jobs in this scope and date range.')}</p>}
    </section>
    <JobMttrDetails t={t} data={data} report={report} api={api} offline={readOnly} offlineRows={offlineJobRows} assignees={selectedAssignees} formatDuration={duration} onExport={onExportJobDetails}/>
    {alarms&&<details className="alarm-summary"><summary>{t('告警导入明细','Alarm import details')} · {alarms.filename}</summary><p>{alarms.sheetName} · {alarms.importedAt}</p>{counters([[t('读取行数','Source rows'),alarms.sourceRows],[t('缺少 Job ID','Missing Job ID'),alarms.missingJobIds],[t('缺少告警 ID','Missing alarm ID'),alarms.missingAlarmIds],[t('发生时间无效','Invalid occurrence time'),alarms.invalidDates],[t('未清除（零时长）','Uncleared (zero)'),alarms.zeroDurations],[t('时长无效','Invalid duration'),alarms.invalidDurations],[t('可用于白名单筛选','Valid before allowlist'),alarms.validRows],[t('命中导入时白名单','Matched at import'),alarms.matchedRows],[t('新增保存行','New stored rows'),alarms.addedRows],[t('重复行','Duplicate rows'),alarms.duplicateRows]])}</details>}
    {jobs&&<details className="alarm-summary"><summary>{t('人员归属导入明细','Ownership import details')} · {jobs.filename}</summary><p>{jobs.sheetName} · {jobs.importedAt}</p>{counters([[t('读取行数','Source rows'),jobs.sourceRows],[t('缺少 Job ID','Missing Job ID'),jobs.missingJobIds],[t('人员为空','Blank assignee'),jobs.missingAssignees],[t('重复 Job ID','Repeated Job IDs'),jobs.duplicateRows],[t('本次导入工单','Jobs in this import'),jobs.mappedJobs]])}</details>}
  </section>;
}
