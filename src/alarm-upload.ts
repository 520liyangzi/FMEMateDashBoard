import type {AlarmMttrDataset} from '../lib/alarm-mttr.ts';

export type AlarmApi = (url:string, options?:RequestInit)=>Promise<any>;
export type AlarmProgress = {phase:'upload'|'parse'; loaded:number; total:number};
const endpoint='/api/mttr/alarms/uploads';
const json=(body:unknown):RequestInit=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const cancelled=()=>new DOMException('上传已取消 / Upload cancelled','AbortError');

/** Stream the File a slice at a time; keep the session on a transient transfer/parse failure. */
export function createAlarmUploader(api:AlarmApi){
  let staged:{id:string;file:File;offset:number;chunk:number}|null=null;
  let running=false;
  async function discard(){
    const saved=staged;if(!saved)return;
    try{await api(`${endpoint}/${encodeURIComponent(saved.id)}`,{method:'DELETE'})}
    catch(error){if(![404,410].includes(Number((error as {status?:number})?.status)))throw error}
    if(staged===saved)staged=null;
  }
  async function upload(file:File,allowlist:string,progress:(value:AlarmProgress)=>void,signal:AbortSignal):Promise<AlarmMttrDataset>{
    if(running)throw new Error('请等待当前导入完成 / An import is already running.');
    if(!file.size)throw new Error('文件为空 / Empty file.');
    const check=()=>{if(signal.aborted)throw cancelled()};
    running=true;
    try{
      check();if(staged&&staged.file!==file)await discard();check();
      if(!staged){
        const data=await api(endpoint,json({alarm:{name:file.name,size:file.size}}));
        if(!data.uploadId||!Number.isSafeInteger(data.chunkSize)||data.chunkSize<=0||data.chunkSize>64*1024*1024)throw new Error('分块上传响应无效 / Invalid upload response.');
        staged={id:data.uploadId,file,offset:0,chunk:data.chunkSize};
      }
      const s=staged,url=`${endpoint}/${encodeURIComponent(s.id)}`;
      progress({phase:'upload',loaded:s.offset,total:file.size});
      while(s.offset<file.size){
        check();const end=Math.min(file.size,s.offset+s.chunk),body=file.slice(s.offset,end);
        // The server acknowledges the same offset idempotently if its response was lost.
        let receipt;for(let attempt=0;;attempt++){
          try{receipt=await api(`${url}/alarm?offset=${s.offset}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body,signal});break}
          catch(error){check();if(attempt===0&&error instanceof TypeError)continue;throw error}
        }
        if(receipt.received!==end||receipt.total!==file.size)throw new Error('分块进度不匹配 / Chunk receipt mismatch.');
        s.offset=end;progress({phase:'upload',loaded:end,total:file.size});
      }
      check();progress({phase:'parse',loaded:file.size,total:file.size});
      const result=await api(`${url}/import`,json({allowlist}));staged=null;return result;
    }catch(error){
      if(signal.aborted){await discard().catch(()=>{});throw cancelled()}
      if([404,410].includes(Number((error as {status?:number})?.status)))staged=null;
      throw error;
    }finally{running=false}
  }
  return {upload,discard};
}
