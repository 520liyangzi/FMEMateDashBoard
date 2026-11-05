import {createAlarmUploader, type AlarmApi, type AlarmProgress} from './alarm-upload.ts';
import type {JobProxyMttrDataset} from '../lib/alarm-mttr.ts';

export type JobOwnerBatchEvent = {index:number; file:File} & (
  {type:'start'} | {type:'progress'; progress:AlarmProgress} |
  {type:'saved'; dataset:JobProxyMttrDataset} | {type:'failed'|'cancelled'; error:unknown}
);

function checkReceipt(dataset:JobProxyMttrDataset,file:File){
  const info=dataset?.lastJobImport;
  const count=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
  if(dataset?.formatVersion!==5||dataset.source!=='alarm-jobs'||!info||
      info.filename!==file.name.replaceAll('\\','/').split('/').pop()||
      !Array.isArray(dataset.allowlist)||!Array.isArray(dataset.days)||!Array.isArray(dataset.personDays)||
      ![dataset.mappedJobs,dataset.totalJobs,dataset.totalAlarms,dataset.storedRows,dataset.unassignedJobs,
        dataset.legacyUnlinkedRows,info.mappedJobs,info.sourceRows,info.validRows,info.duplicateRows,
        info.missingJobIds,info.missingAssignees].every(count)||
      info.mappedJobs<1||info.mappedJobs>dataset.mappedJobs) {
    throw new Error('服务器未返回此文件的有效导入回执，请重试 / The server did not confirm this Job file import. Please retry.');
  }
}

/** Preserve order: later committed mappings can override earlier Jobs. Retry from the first unsaved file. */
export function createJobOwnerBatch(api:AlarmApi,selection:readonly File[]){
  const files=Object.freeze([...selection]), uploader=createAlarmUploader(api,'job');
  let next=0, busy=false;
  const busyError=()=>new Error('请等待当前操作完成 / A Job import operation is already running.');
  async function run(signal:AbortSignal,onEvent:(event:JobOwnerBatchEvent)=>void):Promise<void>{
    if(busy)throw busyError();
    busy=true;
    try{
      while(next<files.length){
        const index=next,file=files[index];
        let dataset:JobProxyMttrDataset;
        try{
          if(signal.aborted)throw new DOMException('上传已取消 / Upload cancelled','AbortError');
          onEvent({type:'start',index,file});
          dataset=await uploader.upload(file,'',progress=>onEvent({type:'progress',index,file,progress}),signal);
          checkReceipt(dataset,file);
        }catch(error){
          onEvent({type:signal.aborted?'cancelled':'failed',index,file,error});
          throw error;
        }
        // An in-flight parse may commit after Cancel. Its receipt confirms this file was saved.
        ++next;
        onEvent({type:'saved',index,file,dataset});
      }
    }finally{busy=false;}
  }
  async function discard(){
    if(busy)throw busyError();
    busy=true;
    try{await uploader.discard();}finally{busy=false;}
  }
  return {files,get completed(){return next;},run,discard};
}
export type JobOwnerBatch = ReturnType<typeof createJobOwnerBatch>;
