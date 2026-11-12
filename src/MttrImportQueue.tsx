import {useEffect,useRef,useState} from 'react';
import {FileSpreadsheet,Upload} from 'lucide-react';
import type {JobProxyMttrDataset} from '../lib/alarm-mttr';
import type {AlarmApi,AlarmProgress} from './alarm-upload';
import {createMttrFileBatch,type ImportSource} from './mttr-file-batch';

type QueueRow={status:'pending'|'upload'|'parse'|'saved'|'failed'|'cancelled';progress?:AlarmProgress;receipt?:{added:number;repeated:number};error?:string};
type Props={
  source:ImportSource;api:AlarmApi;allowlist:string;disabled:boolean;canImport:boolean;
  t:(zh:string,en:string)=>string;begin:()=>boolean;finish:()=>void;onDatasetChange:(data:JobProxyMttrDataset)=>void;
};

export default function MttrImportQueue({source,api,allowlist,disabled,canImport,t,begin,finish,onDatasetChange}:Props){
  const [batch,setBatch]=useState<ReturnType<typeof createMttrFileBatch>|null>(null);
  const [rows,setRows]=useState<QueueRow[]>([]);
  const [run,setRun]=useState<'ready'|'running'|'stopping'|'stopped'|'failed'|'done'>('ready');
  const [error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),abort=useRef<AbortController|null>(null);
  const alarm=source==='alarm',saved=batch?.completed??0,total=batch?.files.length??0;
  const pick=alarm?t('选择告警文件','Choose alarm files'):t('选择 Job 人员文件','Choose Job ownership files');
  useEffect(()=>()=>{abort.current?.abort();void batch?.discard().catch(()=>{})},[batch]);

  async function select(files:File[]){
    if(!files.length||!begin())return;
    try{
      await batch?.discard();
      setBatch(createMttrFileBatch(api,files,source));
      setRows(files.map(()=>({status:'pending'})));setError('');setRun('ready');
    }catch(e){setError(e instanceof Error?e.message:String(e))}
    finally{finish()}
  }
  function update(index:number,row:QueueRow){
    setRows(prior=>prior.map((old,i)=>i===index?row:old));
  }
  async function upload(){
    if(!batch||!canImport||batch.completed===batch.files.length||!begin())return;
    const controller=new AbortController();abort.current=controller;
    setRun('running');setError('');
    try{
      await batch.run(controller.signal,event=>{
        const i=event.index;
        switch(event.type){
          case 'start':update(i,{status:'upload'});break;
          case 'progress':update(i,{status:event.progress.phase,progress:event.progress});break;
          case 'saved':{
            const data=event.dataset;
            const receipt=alarm?{added:data.lastImport!.addedRows,repeated:data.lastImport!.duplicateRows}:
              {added:data.lastJobImport!.mappedJobs-(data.lastJobImport!.existingJobs??0),repeated:data.lastJobImport!.duplicateRows+(data.lastJobImport!.existingJobs??0)};
            update(i,{status:'saved',receipt});onDatasetChange(data);break;
          }
          case 'failed':update(i,{status:'failed',error:event.error instanceof Error?event.error.message:String(event.error)});break;
          case 'cancelled':update(i,{status:'cancelled'});break;
        }
      },allowlist);
      setRun('done');
    }catch{setRun(controller.signal.aborted?'stopped':'failed')}
    finally{abort.current=null;finish()}
  }
  function label(row:QueueRow){
    switch(row.status){
      case 'saved':return t(`已导入 · 新增 ${row.receipt!.added}，重复 ${row.receipt!.repeated}`,`Imported · ${row.receipt!.added} new, ${row.receipt!.repeated} repeated`);
      case 'failed':return t('导入失败','Import failed');
      case 'cancelled':return t('已停止，可继续导入','Stopped; ready to retry');
      case 'parse':return t('正在解析…','Processing…');
      case 'upload':return row.progress?t(`正在上传 ${Math.round(100*row.progress.loaded/row.progress.total)}%`,`Uploading ${Math.round(100*row.progress.loaded/row.progress.total)}%`):t('准备上传…','Starting upload…');
      default:return t('待导入','Pending');
    }
  }
  return <>
    <input type="file" hidden multiple accept=".xlsx,.csv" aria-label={alarm?t('告警文件（可多选）','Alarm files (multiple)'):t('Job 人员文件（可多选）','Job ownership files (multiple)')} ref={input} disabled={disabled} onChange={e=>{const files=Array.from(e.currentTarget.files??[]);e.currentTarget.value='';void select(files)}}/>
    <div className="job-batch-pick"><button type="button" className="btn" disabled={disabled} onClick={()=>input.current?.click()}><FileSpreadsheet size={15}/>{batch?t('重新选择文件','Replace file selection'):pick}</button>{total>0&&<small>{t(`已选择 ${total} 个文件`,`${total} selected`)}</small>}</div>
    {batch&&<><ol className="job-batch-queue" aria-label={alarm?t('告警文件导入顺序','Alarm file import order'):t('Job 文件导入顺序','Job file import order')}>{batch.files.map((file,i)=>{
      const row=rows[i];
      return <li key={i} data-status={row.status}><div><strong>{file.name}</strong><small>{label(row)}</small></div>{row.error&&<p className="job-batch-error" role="alert">{row.error}</p>}{row.progress?.phase==='upload'&&<progress aria-label={t(`${file.name} 上传进度`,`${file.name} upload progress`)} max={row.progress.total} value={row.progress.loaded}/>}</li>;
    })}</ol><p className="job-batch-result" role="status">{run==='ready'?t('等待开始导入。','Ready to import.'):run==='stopping'?t('正在停止，已提交解析的文件会先处理完毕。','Stopping after the file currently being processed.'):run==='done'?t(`全部 ${total} 个文件已导入。`,`All ${total} files imported.`):run==='running'?t(`已导入 ${saved} / ${total} 个文件。`,`Imported ${saved} of ${total} files.`):t(`已保存 ${saved} 个文件，还有 ${total-saved} 个未完成。可继续导入或重新选择修正后的文件。`,`${saved} files saved, ${total-saved} remaining. Retry or select the corrected files.`)}</p></>}
    {error&&<p role="alert" className="job-batch-error">{error}</p>}
    <div className="alarm-actions job-batch-actions"><button type="button" className="btn primary" disabled={disabled||!canImport||saved===total} onClick={upload}><Upload size={15}/>{run==='failed'||run==='stopped'?t('继续导入未完成文件','Retry remaining files'):alarm?t('导入所选告警文件','Import selected alarm files'):t('导入所选 Job 文件','Import selected Job files')}</button>
    {(run==='running'||run==='stopping')&&<button type="button" className="btn" disabled={run==='stopping'} onClick={()=>{setRun('stopping');abort.current?.abort()}}>{t('停止导入','Stop import')}</button>}</div>
  </>;
}
