import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {createMttrUploader,type MttrUploadProgress} from './mttr-upload.ts';
const files=()=>({tt:new File(['abcdefgh'],'tt.csv') as unknown as globalThis.File,job:new File(['12345'],'job.csv') as unknown as globalThis.File});
function server(){
  const calls:{url:string;options?:RequestInit}[]=[],sessions=new Map<string,{tt:number;job:number;ttSize:number;jobSize:number}>();let next=0,failImport:any=null,loseChunk=false;
  const api=async(url:string,options?:RequestInit)=>{
    calls.push({url,options});
    if(url==='/api/mttr/uploads'){const body=JSON.parse(options?.body as string),id=String(++next);sessions.set(id,{tt:0,job:0,ttSize:body.tt.size,jobSize:body.job.size});return {uploadId:id,chunkSize:3,maxFileBytes:1000};}
    const match=url.match(/^\/api\/mttr\/uploads\/(\d+)(?:\/(tt|job|import))?(?:\?offset=(\d+))?$/);assert.ok(match,url);const [,id,kind,off]=match,current=sessions.get(id)!;
    if(options?.method==='DELETE'){sessions.delete(id);return {ok:true};}
    if(!current)throw Object.assign(new Error('Session not found'),{status:404});
    if(kind==='import'){if(failImport)throw failImport;assert.equal(current.tt,current.ttSize);assert.equal(current.job,current.jobSize);sessions.delete(id);return {formatVersion:3,totalJobs:2};}
    assert.ok(kind==='tt'||kind==='job');assert.ok(options?.body instanceof Blob);const length=(options.body as Blob).size;assert.ok(length<=3);const offset=Number(off);assert.ok(offset<=current[kind]);current[kind]=Math.max(current[kind],offset+length);
    if(loseChunk){loseChunk=false;throw new TypeError('Network response lost');}
    return {received:offset+length,total:kind==='tt'?current.ttSize:current.jobSize};
  };
  return {api,calls,sessions,setFailure:(value:any)=>{failImport=value;},loseNextChunk:()=>{loseChunk=true;}};
}
test('uploads binary slices within chunk limit and distinguishes completed upload from parsing',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files(),progress:MttrUploadProgress[]=[];
  const result=await uploader.importPair(pair.tt,pair.job,{},p=>progress.push(p));assert.equal(result.totalJobs,2);
  assert.equal(mock.calls.filter(c=>c.options?.headers&&Object.values(c.options.headers).includes('application/octet-stream')).length,5);
  assert.equal(progress.at(-1)?.phase,'parse');assert.equal(progress.at(-1)?.loaded,13);assert.equal(progress.filter(p=>p.phase==='upload').at(-1)?.loaded,13);
  assert.ok(progress.every(p=>p.total===13&&p.loaded<=p.total));assert.ok(!mock.calls.some(c=>c.options?.body instanceof FormData));
});
test('mapping failure preserves server details and retries import using the same uploaded bytes',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files(),error=Object.assign(new Error('Map Job columns'),{details:{requiresMapping:true,source:'job'}});mock.setFailure(error);
  await assert.rejects(uploader.importPair(pair.tt,pair.job),e=>e===error);const count=mock.calls.length;mock.setFailure(null);
  await uploader.importPair(pair.tt,pair.job,{tt:{ttId:'B',category:'U'}});
  assert.equal(mock.calls.length,count+1);assert.equal(mock.calls.at(-1)?.url,'/api/mttr/uploads/1/import');assert.deepEqual(JSON.parse(mock.calls.at(-1)?.options?.body as string),{ttMapping:{ttId:'B',category:'U'}});
});
test('a different file pair cleans the previous staging session before creating another',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files();mock.setFailure(new Error('Needs mapping'));await assert.rejects(uploader.importPair(pair.tt,pair.job));mock.setFailure(null);
  const second=files();await uploader.importPair(second.tt,second.job);assert.ok(mock.calls.some(c=>c.url==='/api/mttr/uploads/1'&&c.options?.method==='DELETE'));assert.equal(mock.sessions.size,0);
});
test('a lost chunk response retries the same offset without duplicating bytes',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files();mock.loseNextChunk();await uploader.importPair(pair.tt,pair.job);
  const first=mock.calls.filter(c=>c.url==='/api/mttr/uploads/1/tt?offset=0');assert.equal(first.length,2);assert.equal(mock.sessions.size,0);
});
test('aborting during upload cleans staging and never starts the parsing request',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files(),controller=new AbortController();
  await assert.rejects(uploader.importPair(pair.tt,pair.job,{},p=>{if(p.phase==='upload'&&p.loaded===3)controller.abort();},controller.signal),{name:'AbortError'});
  assert.equal(mock.sessions.size,0);assert.ok(!mock.calls.some(c=>c.url.endsWith('/import')));assert.ok(mock.calls.some(c=>c.options?.method==='DELETE'));
});
test('cancel removes a retained mapping session',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files();mock.setFailure(new Error('Mapping needed'));await assert.rejects(uploader.importPair(pair.tt,pair.job));assert.equal(mock.sessions.size,1);await uploader.cancel();assert.equal(mock.sessions.size,0);
});

test('expired retained sessions can be reuploaded on the next retry with unchanged file objects',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files();mock.setFailure(new Error('Needs mapping'));await assert.rejects(uploader.importPair(pair.tt,pair.job));mock.sessions.clear();mock.setFailure(null);
  await assert.rejects(uploader.importPair(pair.tt,pair.job),/session expired/i);const result=await uploader.importPair(pair.tt,pair.job);assert.equal(result.totalJobs,2);assert.equal(mock.calls.filter(c=>c.url==='/api/mttr/uploads').length,2);
});
test('failed staging cleanup retains the session ID for a subsequent successful cancellation',async()=>{
  const mock=server();let failDelete=true;const api=async(url:string,options?:RequestInit)=>{if(options?.method==='DELETE'&&failDelete)throw Object.assign(new Error('Cleanup failed'),{status:500});return mock.api(url,options);};
  const uploader=createMttrUploader(api),pair=files();mock.setFailure(new Error('Needs mapping'));await assert.rejects(uploader.importPair(pair.tt,pair.job));await assert.rejects(uploader.cancel(),/Cleanup failed/);assert.equal(mock.sessions.size,1);failDelete=false;await uploader.cancel();assert.equal(mock.sessions.size,0);
});
test('once parsing begins an external abort does not falsely report that an atomic import was cancelled',async()=>{
  const mock=server(),uploader=createMttrUploader(mock.api),pair=files(),controller=new AbortController();
  const result=await uploader.importPair(pair.tt,pair.job,{},p=>{if(p.phase==='parse')controller.abort();},controller.signal);assert.equal(result.totalJobs,2);assert.ok(!mock.calls.some(c=>c.options?.method==='DELETE'));
});
