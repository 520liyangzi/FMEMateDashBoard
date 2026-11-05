import {useEffect,useMemo,useRef,useState} from 'react';
import {Clock3,FileSpreadsheet,Search,Upload} from 'lucide-react';
import {compareJobProxyMttr,type JobDetailFocus,getJobProxyAssignees,getJobAlPolicy,getJobProxyAxis,rankJobProxyMttr,selectJobProxyDays,type JobProxyMttrDataset,type JobAlPolicy} from '../lib/alarm-mttr';
import {isValidMttrPeriod,previousMttrPeriod,type MttrPeriod} from '../lib/mttr';
import {createAlarmUploader,type AlarmApi,type AlarmProgress} from './alarm-upload';
import JobMttrDetails from './JobMttrDetails';
import MttrCalculationRules from './MttrCalculationRules';
import JobAlPolicyPanel from './JobAlPolicyPanel';
import type {JobProxyDetailRow} from '../lib/job-mttr-details';
import {createJobOwnerBatch} from './job-owner-batch';
import './alarm-mttr.css';

type Translate=(zh:string,en:string)=>string;
export type AlarmMttrPanelProps={
  lang:'zh'|'en';dataset:JobProxyMttrDataset|null;baseline:MttrPeriod;current:MttrPeriod;
  onBaselineChange:(range:MttrPeriod)=>void;onCurrentChange:(range:MttrPeriod)=>void;
  selectedAssignees:string[]|null;onSelectedAssigneesChange:(values:string[]|null)=>void;
  onUseToday?:()=>void;readOnly:boolean;legacyPresent?:boolean;api:AlarmApi;
  onDatasetChange:(data:JobProxyMttrDataset)=>void;
  baseDataset?:JobProxyMttrDataset|null;maxDurationHours?:number;onMaxDurationHoursChange:(hours:number|undefined)=>void;
  durationFilterPending?:boolean;durationFilterError?:string;onRetryDurationFilter?:()=>void;
  detailFocus:JobDetailFocus;onDetailPersonChange:(person:string|null)=>void;
  offlineJobRows?:JobProxyDetailRow[];onExportJobDetails?:()=>void|Promise<void>;
};
const count=(n:number)=>n.toLocaleString('en-US');
const tokens=(text:string)=>[...new Set(text.split(/[,，]/).map(x=>x.trim()).filter(Boolean))];
function duration(seconds:number|null){
  if(seconds===null||!Number.isFinite(seconds))return '—';const whole=Math.round(seconds);
  return `${Math.floor(whole/3600)}:${String(Math.floor(whole/60)%60).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}`;
}
function before(date:string,days:number){const dt=new Date(`${date}T00:00:00Z`);dt.setUTCDate(dt.getUTCDate()-days);return dt.toISOString().slice(0,10)}
function scopeLabel(selected:string[]|null,t:Translate,legacy:boolean){
  if(selected==null)return legacy?t('全部历史人员','All historical assignees'):t('全部入选 AL 人员','All eligible AL people');
  if(!selected.length)return t('未选择人员','No assignees selected');
  return selected.join(t('、',', '));
}
function AssigneeScope({t,names,selected,onChange,emptyNote,validDates,legacy}:{legacy:boolean;t:Translate;names:string[];selected:string[]|null;onChange:(v:string[]|null)=>void;emptyNote:string;validDates:boolean}){
  const [query,setQuery]=useState(''),[limit,setLimit]=useState(40);
  const [paste,setPaste]=useState(''),[outcome,setOutcome]=useState<{options:string[];matched:string[];ignored:string[]}|null>(null);
  const pastedNames=useMemo(()=>[...new Set(paste.split(/[,，、;；\r\n]+/).map(n=>n.trim()).filter(Boolean))],[paste]);
  const applyList=()=>{
    const known=new Set(names),matched=pastedNames.filter(name=>known.has(name)),ignored=pastedNames.filter(name=>!known.has(name));
    onChange(matched);setOutcome({options:names,matched,ignored});
  };
  const feedback=outcome?.options===names&&selected!==null&&outcome.matched.length===selected.length&&outcome.matched.every((n,i)=>n===selected[i])?outcome:null;
  const selectedSet=useMemo(()=>new Set(selected??[]),[selected]);
  const matches=names.filter(name=>name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const choose=(values:string[]|null)=>{setOutcome(null);onChange(values)};
  const add=(additions:string[])=>choose([...new Set([...(selected??[]),...additions])]);
  const all=scopeLabel(null,t,legacy);
  return <div className="job-scope-editor screen-only"><details>
    <summary>{legacy?t('选择历史统计人员','Select historical assignees'):t('选择本次报表的 AL 人员','Select AL people for this report')} <span>{selected==null?all:t(`已选 ${selected.length} 人`,`${selected.length} selected`)}</span></summary>
    <p className="alarm-note">{legacy?t('仅列出所选两期匹配到有效工单的历史人员。','Only historical assignees with matching Jobs in either period are listed.'):t('仅列出通过项目 AL 名单筛选，且在所选两期内匹配到有效工单的 AL 人员。可以查看一人或多人；此处选择只影响本次报表。','Choose one or more AL people whose Jobs pass the project list and fall in either period. This selection changes only the current report.')}</p>
    <div className="alarm-actions job-scope-actions"><button type="button" className="btn" onClick={()=>choose(null)}>{all}</button><button type="button" className="btn" onClick={()=>choose([])}>{t('清空选择','Clear selection')}</button></div>
    <details className="job-paste-list"><summary>{t('粘贴人员名单','Paste a list of names')}</summary>
      <label>{t('用逗号或换行分隔姓名。仅保留与下方可选人员完全匹配的姓名。','Separate names with commas or line breaks. Only exact matches in the list below are selected.')}<textarea value={paste} rows={3} aria-label={t('人员名单','List of assignee names')} onChange={e=>{setPaste(e.target.value);setOutcome(null)}}/></label>
      <button type="button" disabled={!pastedNames.length||!validDates} className="btn" onClick={applyList}>{t('按名单筛选','Use this list')}</button>
      {feedback&&<p className={feedback.ignored.length?'alarm-warning':'alarm-note'} role="status">{t(`已选中 ${feedback.matched.length} 人。`,`${feedback.matched.length} selected.`)}{feedback.ignored.length>0&&<> {t(`以下 ${feedback.ignored.length} 个姓名在两期内没有匹配到有效工单，已忽略：`,`No eligible Jobs matched these ${feedback.ignored.length} names in either period: `)}{feedback.ignored.join(t('、',', '))}</>}</p>}
    </details>
    <label className="job-name-search"><Search size={15}/><input type="search" aria-label={legacy?t('搜索历史人员','Search historical assignees'):t('搜索 AL 人员','Search AL people')} value={query} placeholder={t('输入姓名搜索','Search by name')} onChange={e=>{setQuery(e.target.value);setLimit(40)}}/></label>
    <div className="job-scope-hits"><small>{t(`${count(matches.length)} 项匹配`,`${count(matches.length)} matches`)}</small>{query.trim()&&matches.length>0&&<button type="button" className="text-button" onClick={()=>add(matches)}>{t('选中所有匹配项','Add all matches')}</button>}</div>
    <div className="job-name-options">{matches.slice(0,limit).map(name=><label key={name}><input type="checkbox" checked={selectedSet.has(name)} onChange={e=>e.target.checked?add([name]):choose((selected??[]).filter(n=>n!==name))}/>{name}</label>)}{!matches.length&&<span>{names.length?t('没有符合搜索词的人员。','No names match your search.'):emptyNote}</span>}</div>
    {matches.length>limit&&<button type="button" className="text-button" onClick={()=>setLimit(n=>n+40)}>{t('显示更多人员','Show more assignees')}</button>}
  </details></div>;
}
type DurationLimitProps={
  t:Translate;hours?:number;onChange:(h:number|undefined)=>void;
  pending:boolean;error:string;retry?:()=>void;excluded?:number;canApply:boolean;
};
function JobDurationLimit({t,hours,onChange,pending,error,retry,excluded,canApply}:DurationLimitProps){
  const [editing,setEditing]=useState(hours!==undefined),[draft,setDraft]=useState(hours===undefined?'':String(hours));
  const input=useRef<HTMLInputElement|null>(null);
  useEffect(()=>{setEditing(hours!==undefined);if(hours!==undefined)setDraft(String(hours))},[hours]);
  const parsed=draft.trim()===''?NaN:Number(draft);
  const valid=Number.isFinite(parsed)&&parsed>0&&Number.isFinite(parsed*3600);
  const changed=editing&&(!valid||parsed!==hours);
  const summary=hours===undefined?t('无时长上限','No duration limit'):t(`工单 MTTR ≤ ${hours} 小时`,`Job MTTR ≤ ${hours} hours`);
  return <section className="job-duration-limit" aria-label={t('工单时长筛选','Job duration filter')}>
    <h3>{t('工单时长筛选','Job duration filter')}</h3>
    <p className="alarm-note">{t('先取每个工单所有有效告警的最长时长。整单超过上限才排除，等于上限仍计入；不会改用较短的告警。','First take the longest eligible alarm for each Job. Exclude the whole Job only if it exceeds the limit; equality counts. A shorter alarm never replaces the longest one.')}</p>
    <form className="job-duration-form screen-only" noValidate onSubmit={e=>{e.preventDefault();if(canApply&&editing&&valid&&changed)onChange(parsed)}}>
      <label className="job-duration-switch"><input type="checkbox" checked={editing} disabled={!canApply&&!editing} onChange={e=>{
        const checked=e.target.checked;setEditing(checked);
        if(checked)requestAnimationFrame(()=>input.current?.focus());else onChange(undefined);
      }}/>{t('启用 MTTR 时长上限','Enable a Job MTTR limit')}</label>
      {editing&&<><label className="job-duration-hours">{t('上限（小时）','Maximum hours')}<input ref={input} type="number" step="any" min="0" inputMode="decimal" placeholder="8" value={draft} disabled={!canApply} aria-invalid={!valid}
        aria-describedby="job-duration-draft" onChange={e=>setDraft(e.currentTarget.value)}/></label>
        <button className="btn" type="submit" disabled={!canApply||!valid||!changed}>{t('应用上限','Apply limit')}</button></>}
    </form>
    {editing&&<small id="job-duration-draft" className="job-duration-draft screen-only">{!valid?t('请输入大于 0 的小时数（例如 0.5）。输入未应用，当前报表条件见下方。','Enter a positive number of hours, such as 0.5. This entry has not been applied; the report condition is shown below.'):
      changed?t('新上限尚未应用，报表仍使用下方条件。','The new limit has not been applied. The report still uses the condition below.'):''}</small>}
    <p className="job-duration-applied"><b>{pending||error?t('请求的时长条件','Requested duration filter'):t('当前报表条件','Applied duration filter')}:</b> {summary}
      {!pending&&!error&&hours!==undefined&&excluded!==undefined&&<> · {t(`在所有日期符合名单的工单中，已排除 ${count(excluded)} 个超时工单。`,`Excluded ${count(excluded)} over-limit Jobs across all dates after personnel filtering.`)}</>}</p>
    {!canApply&&<p className="alarm-note">{t('此离线快照缺少逐单数据，无法按时长重新计算。请在本地服务中重新导出离线报表。','This snapshot has no individual Job rows, so it cannot recalculate a duration limit. Export a new offline report from the local service.')}</p>}
    {pending?<p className="job-duration-state" role="status">{t('正在按时长条件重新计算…','Recalculating with the duration filter…')}</p>:
      error&&<div className="job-duration-state" role="alert">{error} {retry&&<button className="text-button screen-only" type="button" onClick={retry}>{t('重试','Retry')}</button>}</div>}
  </section>;
}

type JobQueueRow={status:'pending'|'upload'|'parse'|'saved'|'failed'|'cancelled';progress?:AlarmProgress;mapped?:number;error?:string};
function ImportEditor({dataset,t,api,onDatasetChange}:{dataset:JobProxyMttrDataset|null;t:Translate;api:AlarmApi;onDatasetChange:(v:JobProxyMttrDataset)=>void}){
  const listKey=(dataset?.allowlist??[]).join(',');const [list,setList]=useState(listKey);
  useEffect(()=>{setList(listKey)},[listKey]);
  const [alarm,setAlarm]=useState<File|null>(null),[busy,setBusy]=useState<''|'alarm'|'job'|'list'|'replace'|'al'>('');
  const [progress,setProgress]=useState<AlarmProgress|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [batch,setBatch]=useState<ReturnType<typeof createJobOwnerBatch>|null>(null),[rows,setRows]=useState<JobQueueRow[]>([]);
  const [jobRun,setJobRun]=useState<'ready'|'running'|'stopping'|'stopped'|'failed'|'done'>('ready');
  const alarmInput=useRef<HTMLInputElement|null>(null),jobInput=useRef<HTMLInputElement|null>(null);
  const abort=useRef<AbortController|null>(null),active=useRef(false);
  const uploader=useMemo(()=>createAlarmUploader(api),[api]);
  const [open,setOpen]=useState(!dataset?.storedRows||!!dataset?.needsAlarmReimport);
  const allowed=tokens(list),unsaved=allowed.join(',')!==listKey;
  useEffect(()=>()=>abort.current?.abort(),[]);
  function clearStatus(){setError('');setMessage('')}
  async function replaceJobs(files:File[]){
    if(active.current||!files.length)return;
    active.current=true;setBusy('replace');clearStatus();
    try{
      // Release any incomplete upload for the previous selection; committed mappings are untouched.
      if(batch)await batch.discard();
      setBatch(createJobOwnerBatch(api,files));setRows(files.map(()=>({status:'pending'})));setJobRun('ready');
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{active.current=false;setBusy('')}
  }
  async function saveAlPolicy(policy:JobAlPolicy){
    if(active.current)throw new Error(t('请等待当前操作完成。','Wait for the current operation to finish.'));
    active.current=true;setBusy('al');
    try{
      const updated:JobProxyMttrDataset=await api('/api/mttr/alarms/al-policy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});
      const received=getJobAlPolicy(updated);
      if(updated?.source!=='alarm-jobs'||updated.formatVersion!==5||!received||received.mode!==policy.mode||!Array.isArray(received.names)||!received.names.every(n=>typeof n==='string')||!Array.isArray(updated.personDays)||!Array.isArray(updated.days)||!Array.isArray(updated.allowlist))throw new Error(t('服务器未确认名单设置，请刷新后重试。','The server did not confirm the list settings. Refresh and retry.'));
      onDatasetChange(updated);return received;
    }finally{active.current=false;setBusy('')}
  }
  function updateRow(index:number,row:JobQueueRow){setRows(prior=>prior.map((old,i)=>i===index?row:old))}
  async function importJobs(){
    if(active.current||!batch||batch.completed===batch.files.length)return;
    active.current=true;setBusy('job');setJobRun('running');clearStatus();
    const controller=new AbortController();abort.current=controller;let fileFailureReported=false;
    try{
      await batch.run(controller.signal,event=>{
        switch(event.type){
          case 'start':updateRow(event.index,{status:'upload'});break;
          case 'progress':updateRow(event.index,{status:event.progress.phase,progress:event.progress});break;
          case 'saved':
            onDatasetChange(event.dataset);
            updateRow(event.index,{status:'saved',mapped:event.dataset.lastJobImport!.mappedJobs});break;
          case 'failed':fileFailureReported=true;updateRow(event.index,{status:'failed',error:event.error instanceof Error?event.error.message:String(event.error)});break;
          case 'cancelled':updateRow(event.index,{status:'cancelled'});break;
        }
      });
      setJobRun('done');
    }catch(e){
      setJobRun(controller.signal.aborted?'stopped':'failed');
      if(!controller.signal.aborted&&!fileFailureReported)setError(e instanceof Error?e.message:String(e));
    }finally{abort.current=null;active.current=false;setBusy('')}
  }
  async function submit(action:'alarm'|'list'){
    if(active.current||action==='alarm'&&(!alarm||!allowed.length))return;
    active.current=true;setBusy(action);setProgress(null);clearStatus();
    try{
      let updated:JobProxyMttrDataset;
      if(action==='list')updated=await api('/api/mttr/alarms/allowlist',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({allowlist:list})});
      else{const controller=new AbortController();abort.current=controller;updated=await uploader.upload(alarm!,list,setProgress,controller.signal);
        setAlarm(null);if(alarmInput.current)alarmInput.current.value='';}
      setList(updated.allowlist.join(','));onDatasetChange(updated);
      setMessage(t(`统计已更新：共 ${count(updated.totalJobs)} 个符合当前 AL 名单的有效工单。`,`Updated: ${count(updated.totalJobs)} eligible Jobs under the current AL list.`));
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{abort.current=null;setProgress(null);setBusy('');active.current=false}
  }
  const pickLabel=t('Job 人员文件（可多选）','Job ownership files (multiple)');
  const rowLabel=(r:JobQueueRow):string=>{
    switch(r.status){
      case 'saved':return t(`已导入 · ${count(r.mapped??0)} 个工单归属`,`Imported · ${count(r.mapped??0)} Job mappings`);
      case 'failed':return t('导入失败','Failed');
      case 'cancelled':return t('已停止，可继续导入','Stopped; ready to retry');
      case 'parse':return t('正在解析并更新归属…','Processing ownership…');
      case 'upload':return r.progress?t(`正在上传 ${Math.round(100*r.progress.loaded/r.progress.total)}%`,`Uploading ${Math.round(100*r.progress.loaded/r.progress.total)}%`):t('准备上传…','Starting upload…');
      default:return t('待导入','Pending');
    }
  };
  const saved=batch?.completed??0,total=batch?.files.length??0,remaining=total-saved;
  return <><details className="alarm-editor" open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary><FileSpreadsheet size={15}/>{t('导入告警与 Job 人员表','Import alarm and Job files')}</summary>
    <p className="alarm-note">{t('告警文件与 Job 人员文件可独立更新。每个文件默认读取第一张工作表，第 1 行为表头。','Alarm and Job ownership files can be updated independently. For each file, the first sheet is read with row 1 as its header.')}</p>
    <div className="job-import-sources"><section><h3>{t('告警及白名单','Alarms and allowlist')}</h3>
      <label className="alarm-label">{t('告警 ID 白名单（逗号分隔）','Alarm ID allowlist (comma-separated)')}<input type="text" value={list} disabled={!!busy} placeholder="26540,26564,26568" onChange={e=>setList(e.target.value)}/></label>
      <button type="button" className="btn" disabled={!!busy||!unsaved} onClick={()=>submit('list')}>{t('保存白名单并重新统计','Save allowlist and recalculate')}</button>
      <label className="alarm-label alarm-file-line">{t('告警文件','Alarm file')}<input type="file" ref={alarmInput} accept=".xlsx,.csv" disabled={!!busy} onChange={e=>{setAlarm(e.target.files?.[0]??null);clearStatus()}}/></label><p className="alarm-note">{t('B：告警 ID；I：Duration（时:分:秒）；K：发生时间；AE：Job ID。','B: alarm ID; I: duration (h:mm:ss); K: occurrence time; AE: Job ID.')}</p>
      <button type="button" className="btn primary" disabled={!!busy||!alarm||!allowed.length} onClick={()=>submit('alarm')}><Upload size={15}/>{t('按此白名单导入告警','Import alarms with this allowlist')}</button>
    </section><section><h3>{t('Job 人员归属','Job ownership')}</h3>
      <p className="alarm-note">{t('C：Job ID；AL：统计人员姓名。每行的 C 和 AL 均须非空。支持一次选择多个 .xlsx 或 .csv，按下方顺序导入。同一 Job 在多个文件中有不同的 AL 姓名时，以最后成功导入的文件为准。','C: Job ID; AL: reporting person. Both must be nonblank. Select one or more .xlsx or .csv files. Files import in the order shown below. For a Job listed under different AL names across files, the last successfully imported file sets its AL name.')}</p>
      <input type="file" hidden multiple accept=".xlsx,.csv" aria-label={pickLabel} ref={jobInput} disabled={!!busy} onChange={e=>{const files=Array.from(e.currentTarget.files??[]);e.currentTarget.value='';void replaceJobs(files)}}/>
      <div className="job-batch-pick"><button type="button" className="btn" disabled={!!busy} onClick={()=>jobInput.current?.click()}><FileSpreadsheet size={15}/>{batch?t('重新选择文件','Replace file selection'):t('选择 Job 人员文件','Choose Job ownership files')}</button>{!!total&&<small>{t(`已选择 ${count(total)} 个文件`,`${count(total)} selected`)}</small>}</div>
      {batch&&<><ol className="job-batch-queue" aria-label={t('Job 文件导入顺序','Job file import order')}>{batch.files.map((f,i)=>{
        const row=rows[i]??{status:'pending' as const};
        return <li key={i} data-status={row.status}><div><strong>{f.name}</strong><small>{rowLabel(row)}</small></div>{row.error&&<p className="job-batch-error" role="alert">{row.error}</p>}{row.progress?.phase==='upload'&&<progress aria-label={t(`${f.name} 上传进度`,`${f.name} upload progress`)} max={row.progress.total} value={row.progress.loaded}/>}</li>;
      })}</ol>
      <p className="job-batch-result" role="status">{jobRun==='ready'?t('等待开始导入。','Ready to import.'):jobRun==='stopping'?t('正在停止。已提交解析的文件会先处理完毕。','Stopping. A file already submitted for processing will finish first.'):jobRun==='done'?t(`全部 ${count(total)} 个文件已导入。`,`All ${count(total)} files imported.`):jobRun==='running'?t(`已导入 ${count(saved)} / ${count(total)} 个文件。`,`Imported ${count(saved)} of ${count(total)} files.`):t(`已保留 ${count(saved)} 个已导入文件的结果；还有 ${count(remaining)} 个未完成。可继续导入，或重新选择修正后的文件及后续文件。`,`${count(saved)} successful imports retained; ${count(remaining)} files remain. Retry, or select the corrected file and the remaining files.`)}</p></>}
      <div className="alarm-actions job-batch-actions"><button type="button" className="btn primary" disabled={!!busy||!remaining} onClick={importJobs}><Upload size={15}/>{jobRun==='failed'||jobRun==='stopped'?t('继续导入未完成文件','Retry remaining files'):t('导入所选 Job 文件','Import selected Job files')}</button>
      {busy==='job'&&<button type="button" className="btn" disabled={jobRun==='stopping'} onClick={()=>{setJobRun('stopping');abort.current?.abort()}}>{t('停止导入','Stop import')}</button>}</div>
      {dataset?.lastJobImport&&<p className="alarm-note">{t('最近导入','Last import')}: {dataset.lastJobImport.filename}{!('personColumn' in dataset.lastJobImport)&&t('（历史导入，未记录 AL）',' (historical import, no AL captured)')}</p>}
    </section></div>
    {busy==='alarm'&&<div className="alarm-status" role="status">{progress?.phase==='parse'?t('正在解析并重新统计…','Parsing and recalculating…'):t('正在上传…','Uploading…')}{progress?.phase==='upload'&&<> {Math.round(100*progress.loaded/progress.total)}% <progress aria-label={t('上传进度','Upload progress')} className="alarm-import-progress" max={progress.total} value={progress.loaded}/> <button type="button" className="btn" onClick={()=>abort.current?.abort()}>{t('取消上传','Cancel upload')}</button></>}</div>}
    {busy==='list'&&<div className="alarm-status" role="status">{t('正在重新统计…','Recalculating…')}</div>}{error&&<div className="alarm-status error-text" role="alert">{error}</div>}{message&&!busy&&<div className="alarm-status" role="status">{message}</div>}
  </details><JobAlPolicyPanel data={dataset} t={t} disabled={!!busy} saving={busy==='al'} onSave={saveAlPolicy}/></>;
}

export default function AlarmMttrPanel({lang,dataset:input,baseline,current,onBaselineChange,onCurrentChange,selectedAssignees=null,onSelectedAssigneesChange,onUseToday,readOnly,legacyPresent,api,onDatasetChange,offlineJobRows,onExportJobDetails,detailFocus,onDetailPersonChange,baseDataset,maxDurationHours,onMaxDurationHoursChange,durationFilterPending=false,durationFilterError='',onRetryDurationFilter}:AlarmMttrPanelProps){
  const t:Translate=(zh,en)=>lang==='zh'?zh:en;
  const data=input?.formatVersion===5&&input.source==='alarm-jobs'?input:null;
  const source=baseDataset===undefined?data:baseDataset;
  const capMismatch=(data?.durationFilter?.maxDurationHours??undefined)!==maxDurationHours;
  const filterError=durationFilterError||(!durationFilterPending&&capMismatch?t('未能确认所请求的时长条件，请重试或关闭上限。','The requested limit could not be confirmed. Retry or turn off the limit.'):'');
  const hideResults=durationFilterPending||!!filterError;
  const legacy=getJobProxyAxis(source)==='AG';
  const person=legacy?t('历史人员','Historical assignee'):t('AL 人员','AL person');
  const validDates=isValidMttrPeriod(baseline)&&isValidMttrPeriod(current);
  const names=useMemo(()=>getJobProxyAssignees(data,baseline,current),[data,baseline,current]);
  // Older snapshots included unassigned Jobs in their all-date totals.
  const matchedDays=useMemo(()=>selectJobProxyDays(data),[data]);
  const matchedCount=useMemo(()=>matchedDays.reduce((sum,day)=>sum+day.count,0),[matchedDays]);
  const legacyAlarmCount=useMemo(()=>data?.personDays.some(d=>!d.assignee.trim()&&d.count>0),[data]);
  const emptyNote=!validDates?t('请先选择有效的基准期和对比期。','Choose valid baseline and comparison dates first.')
    :data?.needsAlarmReimport&&!matchedCount&&!data.durationFilter?.excludedJobs?t('请重新导入原告警表，恢复已有工单关联。','Re-import the original alarm files to restore Job links.')
    :!data?.storedRows?t('尚无已导入的告警数据。','No alarms have been imported.')
    :!data.mappedJobs&&!legacy?t('请导入 Job 表，用 C 列 Job ID 关联 AL 列姓名。如果之前已导入旧版 Job 表，只需重传 Job 表。','Import the Job file with Job ID in C and person in AL. If you previously imported Job files without AL, re-import just those files.')
    :legacy?t('所选两期内没有匹配到历史人员和有效工单。','Neither period has an eligible Job with a historical assignee.')
    :maxDurationHours!==undefined?t('所选两期没有同时符合名单和时长上限的工单。','No Jobs in either period match both the personnel and duration filters.')
    :t('应用 AL 名单及所选日期后，没有匹配到有效工单。','No eligible Jobs match the applied AL list and selected periods.');
  const report=useMemo(()=>compareJobProxyMttr(data,baseline,current,selectedAssignees),[data,baseline,current,selectedAssignees]);
  function openPersonJobs(name:string){
    onDetailPersonChange(name);
    requestAnimationFrame(()=>{
      const section=document.getElementById('job-mttr-details');
      section?.focus({preventScroll:true});section?.scrollIntoView({block:'start'});
    });
  }
  const ranking=useMemo(()=>rankJobProxyMttr(data,baseline,current,selectedAssignees),[data,baseline,current,selectedAssignees]);
  const latest=matchedDays.at(-1)?.date,alarms=source?.lastImport,jobs=source?.lastJobImport;
  const listKey=data?.allowlist.join(', ')||t('未配置','None');
  const unavailable=(status:string)=>{
    if(status==='alarm_reimport_required')return t('需重新导入原告警表。','Re-import the original alarm files.');
    if(status==='invalid_range')return t('日期区间无效。','Invalid date range.');
    if(status==='no_dataset')return readOnly?t('此快照无工单数据。','No Job data in this snapshot.'):t('请先导入告警表。','Import alarm data first.');
    if(!names.length)return emptyNote;
    if(selectedAssignees?.length===0)return t('尚未选择统计人员。','No assignees selected.');
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
  const rate=report.reductionRate, scope=scopeLabel(selectedAssignees,t,legacy);
  const counters=(pairs:([string,number])[])=><dl className="alarm-counter-grid">{pairs.map(([key,value])=><div key={key}><dt>{key}</dt><dd>{count(value)}</dd></div>)}</dl>;
  return <section className="card alarm-mttr" aria-label={t('工单 MTTR','Job MTTR')}>
    <h2 className="alarm-intro"><Clock3 size={20}/>{t('工单 MTTR（按最长告警时长）','Job MTTR (longest alarm per Job)')}</h2>
    <p className="alarm-sub">{t('一个 Job 计一次，使用该工单最长的有效告警 Duration 估算处理时长。','Each Job counts once. Its longest eligible alarm duration is used to estimate its resolution time.')}</p>
    {source?.needsAlarmReimport&&<p className="alarm-warning job-coverage-warning" role="status">{t(`有 ${count(source.legacyUnlinkedRows)} 条旧版告警记录缺少可关联的 Job ID，未参与本页统计。重新导入原告警文件后可恢复关联。`,`${count(source.legacyUnlinkedRows)} legacy alarm records have no recoverable Job ID and are excluded. Re-import the original alarm files to restore their links.`)}</p>}
    {legacyPresent&&!source?.storedRows&&<p className="alarm-note">{t('以往按 TT/Job 时间计算的汇总无法换算，请导入原告警文件。','Old TT/Job time summaries cannot be converted. Import the original alarm files.')}</p>}
    {readOnly?<JobAlPolicyPanel data={source} t={t}/>:<ImportEditor t={t} dataset={source} api={api} onDatasetChange={onDatasetChange}/>}
    <div className="alarm-periods">{periodEditor(t('基准期','Baseline period'),baseline,onBaselineChange)}{periodEditor(t('对比期','Comparison period'),current,onCurrentChange)}</div>
    <div className="alarm-presets screen-only">{[3,7].map(n=><button type="button" className="btn" key={n} disabled={!latest||hideResults} onClick={()=>quick(n)}>{t(`最新 ${n} 天 vs 前 ${n} 天`,`Latest ${n} days vs prior ${n}`)}</button>)}{onUseToday&&<button type="button" className="btn" onClick={onUseToday}>{t('按今天对比近 7 天','Last 7 days through today')}</button>}</div>
    <JobDurationLimit t={t} hours={maxDurationHours} onChange={onMaxDurationHoursChange} pending={durationFilterPending} error={filterError} retry={onRetryDurationFilter}
      excluded={data?.durationFilter?.excludedJobs} canApply={!readOnly||Array.isArray(offlineJobRows)}/>
    {!hideResults&&<><AssigneeScope key={legacy?'historical':'al'} legacy={legacy} t={t} names={names} emptyNote={emptyNote} validDates={validDates} selected={selectedAssignees} onChange={onSelectedAssigneesChange}/>
    <p className="job-scope-label"><b>{t('统计对象','Reporting scope')}:</b> {scope}</p>
    <p className="alarm-note">{legacy?t('此处展示快照原有的人员统计，不能从中推算 AL 名单或 AL 人员排名。','This snapshot shows the original assignee metrics. It cannot be used to infer AL list membership or AL rankings.'):t('每个工单按 Job 表 AL 列人员归属，均值、提升率、排名与明细均使用相同的名单和报表范围。','Each Job belongs to the person in column AL. Means, improvement rates, rankings and Job details all use the same list and reporting scope.')}</p>
    <div className="alarm-metrics">{periodCard(t('基准期 MTTR','Baseline MTTR'),report.baseline)}{periodCard(t('对比期 MTTR','Comparison MTTR'),report.current)}<article className={rate===null||rate===0?'':rate>0?'alarm-positive':'alarm-negative'}><h3>{t('MTTR 提升率','MTTR improvement')}</h3><strong>{rate===null?'—':`${rate.toFixed(1)}%`}</strong><small>{rate===null?unavailable(report.status):rate>0?t('对比期平均时长缩短。','Shorter mean duration.'):rate<0?t('对比期平均时长延长。','Longer mean duration.'):t('两期均值相同。','No change in mean duration.')}</small></article></div>
    {report.overlap&&<p className="alarm-warning">{t('两个区间有重叠，归属日相同的工单会分别计入两期。','The periods overlap; Jobs on shared dates count in both.')}</p>}
    <MttrCalculationRules t={t} report={report} scope={scope} legacy={legacy} formatDuration={duration} maxDurationHours={maxDurationHours}/>
    <p className="alarm-note alarm-meta">{t('当前白名单','Applied allowlist')}: {listKey} · {maxDurationHours!==undefined?t('所有日期符合时长及人员条件的工单','Jobs after duration and personnel filters, all dates'):legacy?t('全部日期已匹配工单','Matched Jobs across all dates'):t('所有日期名单筛选后工单','Jobs after AL filtering, all dates')}: {count(matchedCount)}{!legacyAlarmCount&&<> · {t('匹配工单对应告警','Eligible alarms on matched Jobs')}: {count(data?.totalAlarms??0)}</>}{legacy&&<> · {t('全部日期未匹配工单（已排除）','Unmatched Jobs across all dates (excluded)')}: {count(data?.unassignedJobs??0)}</>}{latest&&<> · {matchedDays[0]?.date} — {latest}</>}</p>
    <section className="job-rank" aria-label={legacy?t('历史人员 MTTR 提升率排行','MTTR improvement by historical assignee'):t('AL 人员 MTTR 提升率排行','MTTR improvement by AL person')}><h3>{legacy?t('历史人员 MTTR 提升率排行','MTTR improvement by historical assignee'):t('AL 人员 MTTR 提升率排行','MTTR improvement by AL person')}</h3>
      <p className="alarm-note">{t('按当前人员范围，依提升率从高到低排列。仅一期有工单的人员列在最后，不计算提升率。','Ranked within the selected scope, highest improvement first. People with Jobs in only one period appear last without an improvement rate.')}{!legacy&&' '+t('点击姓名可查看该人员的两期工单。','Select a name to see that person’s Jobs in both periods.')}</p>
      {ranking.length>0?<div className="job-rank-table"><table><thead><tr>{[t('排名','Rank'),person,t('基准期工单数','Baseline Jobs'),t('基准期 MTTR','Baseline MTTR'),t('对比期工单数','Comparison Jobs'),t('对比期 MTTR','Comparison MTTR'),t('提升率','Improvement')].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{ranking.map(r=><tr key={r.assignee}><td>{r.rank??'—'}</td><th scope="row">{legacy?r.assignee:<button type="button" className="job-rank-person" aria-label={t(`查看 ${r.assignee} 的工单明细`,`View Job details for ${r.assignee}`)} onClick={()=>openPersonJobs(r.assignee)}>{r.assignee}</button>}</th><td>{count(r.comparison.baseline.count)}</td><td>{duration(r.comparison.baseline.meanSeconds)}</td><td>{count(r.comparison.current.count)}</td><td>{duration(r.comparison.current.meanSeconds)}</td><td className={r.comparison.reductionRate>0?'positive':''}>{r.comparison.reductionRate===null?<><span>—</span><small>{unavailable(r.comparison.status)}</small></>:`${r.comparison.reductionRate.toFixed(1)}%`}</td></tr>)}</tbody></table></div>:<p className="job-rank-empty">{!names.length||!validDates?emptyNote:t('请选择统计人员，或切换为全部。','Select people for this report, or choose all.')}</p>}
    </section>
    <JobMttrDetails maxDurationHours={maxDurationHours} t={t} data={data} report={detailFocus.comparison} focusPerson={detailFocus.person} availablePeople={detailFocus.availablePeople} onFocusPersonChange={onDetailPersonChange} api={api} offline={readOnly} offlineRows={offlineJobRows} assignees={detailFocus.assignees} formatDuration={duration} onExport={onExportJobDetails}/></>}
    {alarms&&<details className="alarm-summary"><summary>{t('告警导入明细','Alarm import details')} · {alarms.filename}</summary><p>{alarms.sheetName} · {alarms.importedAt}</p>{counters([[t('读取行数','Source rows'),alarms.sourceRows],[t('缺少 Job ID','Missing Job ID'),alarms.missingJobIds],[t('缺少告警 ID','Missing alarm ID'),alarms.missingAlarmIds],[t('发生时间无效','Invalid occurrence time'),alarms.invalidDates],[t('未清除（零时长）','Uncleared (zero)'),alarms.zeroDurations],[t('时长无效','Invalid duration'),alarms.invalidDurations],[t('可用于白名单筛选','Valid before allowlist'),alarms.validRows],[t('命中导入时白名单','Matched at import'),alarms.matchedRows],[t('新增保存行','New stored rows'),alarms.addedRows],[t('重复行','Duplicate rows'),alarms.duplicateRows]])}</details>}
    {jobs&&<details className="alarm-summary"><summary>{t('人员归属导入明细','Ownership import details')} · {jobs.filename}</summary><p>{jobs.sheetName} · {jobs.importedAt}</p>{counters([[t('读取行数','Source rows'),jobs.sourceRows],[t('缺少 Job ID','Missing Job ID'),jobs.missingJobIds],[t('导入时姓名为空','Missing name at import'),jobs.missingAssignees],[t('重复 Job ID','Repeated Job IDs'),jobs.duplicateRows],[t('本次导入工单','Jobs in this import'),jobs.mappedJobs]])}</details>}
  </section>;
}
