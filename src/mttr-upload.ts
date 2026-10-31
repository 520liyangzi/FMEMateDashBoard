import type {MttrDataset,MttrPairMappings} from '../lib/mttr.ts';

export type MttrUploadProgress={phase:'upload'|'parse';source?:'tt'|'job';loaded:number;total:number};
export type MttrUploadApi=(url:string,options?:RequestInit)=>Promise<any>;
type Source='tt'|'job';
type Session={id:string;tt:File;job:File;chunkSize:number;uploaded:Record<Source,number>};
const cancelled=()=>new DOMException('上传已取消，已保存的数据未改变 / Upload cancelled. Saved data is unchanged.','AbortError');

/** Keep uploaded bytes for mapping retries; only binary chunks cross the request body limit. */
export function createMttrUploader(api:MttrUploadApi){
  let session:Session|null=null,running=false,parsing=false,controller:AbortController|null=null;
  const statusOf=(error:unknown)=>error&&typeof error==='object'&&'status' in error?Number(error.status):0;
  async function discard(id:string){
    for(let attempt=0;;attempt++){
      try{await api(`/api/mttr/uploads/${encodeURIComponent(id)}`,{method:'DELETE'});break;}
      catch(error){if(statusOf(error)===404||statusOf(error)===410)break;if(statusOf(error)===409&&attempt<3){await new Promise(resolve=>setTimeout(resolve,[100,300,600][attempt]));continue;}throw error;}
    }
    if(session?.id===id)session=null;
  }
  async function cancel(){
    if(parsing)throw new Error('服务端已开始解析，请等待结果 / Server parsing has started. Please wait for the result.');
    controller?.abort();const current=session;if(current)await discard(current.id);
  }
  async function importPair(ttFile:File,jobFile:File,mappings:MttrPairMappings={},onProgress?:(progress:MttrUploadProgress)=>void,signal?:AbortSignal):Promise<MttrDataset>{
    if(running)throw new Error('已有导入任务正在处理 / Another import is in progress.');
    if(!ttFile.size||!jobFile.size)throw new Error('TT 和 Job 文件不能为空 / TT and Job files must not be empty.');
    if(signal?.aborted)throw cancelled();
    running=true;controller=new AbortController();const activeController=controller;
    const abort=()=>{if(!parsing)activeController.abort();};signal?.addEventListener('abort',abort,{once:true});
    const checkAbort=()=>{if(activeController.signal.aborted)throw cancelled();};
    const total=ttFile.size+jobFile.size;
    let current:Session|null=null;
    try{
      if(session&&(session.tt!==ttFile||session.job!==jobFile))await discard(session.id);
      checkAbort();
      if(!session){
        const created=await api('/api/mttr/uploads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tt:{name:ttFile.name,size:ttFile.size},job:{name:jobFile.name,size:jobFile.size}})});
        if(typeof created.uploadId!=='string'||!created.uploadId||!Number.isSafeInteger(created.chunkSize)||created.chunkSize<1||created.chunkSize>64*1024*1024||!Number.isSafeInteger(created.maxFileBytes)||created.maxFileBytes<1)throw new Error('分块上传响应无效 / Invalid chunk upload response.');
        session={id:created.uploadId,tt:ttFile,job:jobFile,chunkSize:created.chunkSize,uploaded:{tt:0,job:0}};
        if(ttFile.size>created.maxFileBytes||jobFile.size>created.maxFileBytes){await discard(session.id);throw new Error(`单个文件超过服务端上限 ${created.maxFileBytes} 字节 / A file exceeds the server limit of ${created.maxFileBytes} bytes.`);}
      }
      current=session;
      for(const source of ['tt','job'] as const){
        const file=current[source];
        onProgress?.({phase:'upload',source,loaded:current.uploaded.tt+current.uploaded.job,total});checkAbort();
        while(current.uploaded[source]<file.size){
          const offset=current.uploaded[source],end=Math.min(file.size,offset+current.chunkSize),chunk=file.slice(offset,end);
          let response:any;
          for(let attempt=0;;attempt++){
            checkAbort();
            try{response=await api(`/api/mttr/uploads/${encodeURIComponent(current.id)}/${source}?offset=${offset}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:chunk,signal:activeController.signal});break;}
            catch(error){checkAbort();if(attempt===0&&error instanceof TypeError)continue;throw error;}
          }
          if(response.received!==end||response.total!==file.size)throw new Error('分块接收进度不一致，请重试导入 / Chunk receipt mismatch. Retry the import.');
          current.uploaded[source]=end;
          onProgress?.({phase:'upload',source,loaded:current.uploaded.tt+current.uploaded.job,total});checkAbort();
        }
      }
      checkAbort();parsing=true;
      onProgress?.({phase:'parse',loaded:total,total});
      // Parsing may commit atomically on the server. Do not imply cancellation by aborting this request.
      const dataset=await api(`/api/mttr/uploads/${encodeURIComponent(current.id)}/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ttMapping:mappings.tt,jobMapping:mappings.job,updateExistingJobs:mappings.updateExistingJobs})});
      if(session?.id===current.id)session=null;
      return dataset as MttrDataset;
    }catch(error){
      if(activeController.signal.aborted){const id=current?.id||session?.id;if(id&&session?.id===id)try{await discard(id);}catch{}throw cancelled();}
      if((statusOf(error)===404||statusOf(error)===410)&&current){
        if(session?.id===current.id)session=null;
        throw Object.assign(new Error('上传会话已失效，请再次点击导入，系统将重新上传 / The upload session expired. Click Import again to upload the files anew.'),{status:statusOf(error),cause:error});
      }
      // Mapping and parse failures retain the staged file pair for a retry without reupload.
      throw error;
    }finally{signal?.removeEventListener('abort',abort);parsing=false;running=false;if(controller===activeController)controller=null;}
  }
  return {importPair,cancel};
}
