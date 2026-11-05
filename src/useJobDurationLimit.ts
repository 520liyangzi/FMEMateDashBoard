import {useEffect,useMemo,useState} from 'react';
import type {JobProxyMttrDataset} from '../lib/alarm-mttr';
import {applyOfflineJobDurationFilter,type JobProxyDetailRow} from '../lib/job-mttr-details';

type Result={base:JobProxyMttrDataset;hours:number;attempt:number;data?:JobProxyMttrDataset;error?:string};
const key='pulse-alarm-job-max-duration-hours';
function validHours(value:unknown):number|undefined {
  if(typeof value!=='number'&&typeof value!=='string')return undefined;
  const n=Number(value);
  return n>0&&Number.isFinite(n*3600)?n:undefined;
}

/** The source is always uncapped. An older response must never appear under a new limit or import. */
export default function useJobDurationLimit(
  base:JobProxyMttrDataset|null,
  offline:{jobMttrRows?:JobProxyDetailRow[];jobMaxDurationHours?:number}|undefined,
  api:(url:string,options?:RequestInit)=>Promise<any>
){
  const [hours,setHours]=useState<number|undefined>(()=>{
    try{return validHours(offline?(Array.isArray(offline.jobMttrRows)?offline.jobMaxDurationHours:undefined):localStorage.getItem(key))}catch{return undefined}
  });
  useEffect(()=>{if(!offline)try{if(hours===undefined)localStorage.removeItem(key);else localStorage.setItem(key,String(hours))}catch{}},[hours,offline]);
  const [attempt,setAttempt]=useState(0),[result,setResult]=useState<Result|null>(null);
  const local=useMemo(()=>{
    if(!offline||hours===undefined)return null;
    try{return {data:applyOfflineJobDurationFilter(base,offline.jobMttrRows,hours)}}
    catch(e){return {error:String(e instanceof Error?e.message:e)}}
  },[base,offline,hours]);
  useEffect(()=>{
    if(offline||!base||hours===undefined)return;
    let active=true;
    const ctrl=new AbortController();
    api('/api/mttr/alarms?maxDurationHours='+encodeURIComponent(String(hours)),{signal:ctrl.signal,cache:'no-store'})
      .then((data:JobProxyMttrDataset)=>{
        if(!active)return;
        if(data?.durationFilter?.maxDurationHours!==hours || data?.revision!==base.revision)
          throw new Error('数据或服务版本已变更，请刷新网页。 / Data or service version changed. Refresh this page.');
        setResult({base,hours,attempt,data});
      }).catch(e=>{if(active)setResult({base,hours,attempt,error:e.message||String(e)})});
    return ()=>{active=false;ctrl.abort()};
  },[base,offline,hours,api,attempt]);
  const match=result&&result.base===base&&result.hours===hours&&result.attempt===attempt?result:null;
  const data=hours===undefined?base:(offline?local?.data:match?.data)??null;
  const error=(offline?local?.error:match?.error)??'';
  return {hours,setHours,data,error,pending:!!base&&hours!==undefined&&!data&&!error,retry:()=>setAttempt(v=>v+1)};
}
