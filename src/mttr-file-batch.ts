import {createAlarmUploader, type AlarmApi, type AlarmProgress} from './alarm-upload.ts';
import type {JobProxyMttrDataset} from '../lib/alarm-mttr.ts';

export type MttrFileBatchEvent = {index:number; file:File} & (
  {type:'start'} | {type:'progress'; progress:AlarmProgress} |
  {type:'saved'; dataset:JobProxyMttrDataset} | {type:'failed'|'cancelled'; error:unknown}
);

export type ImportSource = 'alarm'|'job';
const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;

function checkReceipt(dataset:JobProxyMttrDataset,file:File,source:ImportSource){
  const policy=dataset?.alPolicy;
  const filename=file.name.replaceAll('\\','/').split('/').pop();
  const info=source==='alarm'?dataset?.lastImport:dataset?.lastJobImport;
  let valid=false;
  if(info&&info.filename===filename&&[info.sourceRows,info.validRows,info.duplicateRows,info.missingJobIds].every(count)){
    if('mappedJobs' in info){
      valid=source==='job'&&count(info.mappedJobs)&&count(info.missingAssignees)&&info.mappedJobs>0&&info.mappedJobs<=dataset.mappedJobs;
    }else{
      valid=source==='alarm'&&count(info.addedRows)&&info.validRows>0&&info.addedRows+info.duplicateRows===info.validRows;
    }
  }
  if(!valid||dataset?.formatVersion!==5||dataset.source!=='alarm-jobs'||
      !policy||!['all','include','exclude'].includes(policy.mode)||!Array.isArray(policy.names)||
      !policy.names.every(n=>typeof n==='string')||!Array.isArray(dataset.allowlist)||
      !Array.isArray(dataset.days)||!Array.isArray(dataset.personDays)||
      ![dataset.mappedJobs,dataset.totalJobs,dataset.totalAlarms,dataset.storedRows,dataset.unassignedJobs,dataset.legacyUnlinkedRows].every(count)){
    throw new Error('服务器未确认此文件的导入结果，请重试 / The server did not confirm this file import. Please retry.');
  }
}

/** Commit files in selection order. Resume at the first unconfirmed file. */
export function createMttrFileBatch(api:AlarmApi,selection:readonly File[],source:ImportSource='job'){
  const files=Object.freeze([...selection]), uploader=createAlarmUploader(api,source);
  let next=0, busy=false;
  const busyError=()=>new Error('请等待当前操作完成 / An import operation is already running.');
  async function run(signal:AbortSignal,onEvent:(event:MttrFileBatchEvent)=>void,allowlist=''):Promise<void>{
    if(busy)throw busyError();
    busy=true;
    try{
      while(next<files.length){
        const index=next,file=files[index];
        let dataset:JobProxyMttrDataset;
        try{
          if(signal.aborted)throw new DOMException('上传已取消 / Upload cancelled','AbortError');
          onEvent({type:'start',index,file});
          dataset=await uploader.upload(file,allowlist,progress=>onEvent({type:'progress',index,file,progress}),signal);
          checkReceipt(dataset,file,source);
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
