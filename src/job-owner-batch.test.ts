import test from 'node:test';
import assert from 'node:assert/strict';
import {createJobOwnerBatch, type JobOwnerBatchEvent} from './job-owner-batch.ts';

const base='/api/mttr/alarms/job-uploads';
const excel=(name:string,contents:string)=>new File([contents],name);
const fresh=()=>new AbortController();
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(ok=>{resolve=ok});return {resolve,promise};}
type Step={type:'chunk'|'import'; name:string; signal?:AbortSignal|null; offset:number};

// Exercise the real single-file uploader against a small chunk endpoint.
function fakeApi(hook?:(s:Step)=>void|Promise<void>){
  const names:string[]=[],commits:string[]=[],discards:string[]=[];
  const sessions=new Map<string,{name:string;size:number;bytes:string}>();
  async function api(url:string,options?:RequestInit){
    if(url===base){
      const {job}=JSON.parse(String(options?.body));
      const id=String(names.length);
      names.push(job.name);sessions.set(id,{...job,bytes:''});return {uploadId:id,chunkSize:2};
    }
    const [id,action]=url.slice(base.length+1).split('/');
    const session=sessions.get(id)!;
    if(options?.method==='DELETE'){discards.push(session.name);sessions.delete(id);return {};}
    if(action==='import'){
      assert.equal(session.bytes.length,session.size);
      await hook?.({type:'import',name:session.name,signal:options?.signal,offset:session.size});
      commits.push(session.bytes);sessions.delete(id);
      return {formatVersion:5,source:'alarm-jobs',alPolicy:{mode:'all',names:[]},allowlist:[],days:[],personDays:[],totalJobs:0,totalAlarms:0,storedRows:0,
        unassignedJobs:0,legacyUnlinkedRows:0,mappedJobs:commits.length,lastJobImport:{filename:session.name,
          mappedJobs:1,sourceRows:1,validRows:1,missingJobIds:0,missingAssignees:0,duplicateRows:0}};
    }
    const offset=Number(new URL('https://example.invalid/'+action).searchParams.get('offset'));
    assert.equal(offset,session.bytes.length);
    await hook?.({type:'chunk',name:session.name,signal:options?.signal,offset});
    const part=await (options!.body as Blob).text();assert.ok(part.length<=2);
    session.bytes+=part;return {received:session.bytes.length,total:session.size};
  }
  return {api,names,commits,discards};
}

test('preserves the original selection and commits duplicate filenames as separate ordered files',async()=>{
  const http=fakeApi();
  const files=[excel('later.xlsx','one'),excel('earlier.csv','two'),excel('earlier.csv','three')];
  const batch=createJobOwnerBatch(http.api,files);files.reverse();
  const events:JobOwnerBatchEvent[]=[];
  await batch.run(fresh().signal,e=>events.push(e));
  assert.deepEqual(http.names,['later.xlsx','earlier.csv','earlier.csv']);
  assert.deepEqual(http.commits,['one','two','three']);assert.equal(batch.completed,3);
  assert.deepEqual(events.filter(e=>e.type!=='progress').map(e=>[e.type,e.index]),
    [['start',0],['saved',0],['start',1],['saved',1],['start',2],['saved',2]]);
  assert.deepEqual(events.flatMap(e=>e.type==='saved'?[e.dataset.mappedJobs]:[]),[1,2,3]);
  await batch.run(fresh().signal,()=>assert.fail('already completed'));
});

test('a failed parse retains the committed prefix; retry reuses its staged file, then processes only later files',async()=>{
  let fail=true;
  const http=fakeApi(s=>{if(fail&&s.type==='import'&&s.name==='b.csv')throw Error('bad workbook');});
  const batch=createJobOwnerBatch(http.api,['a','b','c'].map(n=>excel(n+'.csv',n)));
  const events:JobOwnerBatchEvent[]=[];
  await assert.rejects(batch.run(fresh().signal,e=>events.push(e)),/bad workbook/);
  assert.deepEqual(http.names,['a.csv','b.csv']);assert.deepEqual(http.commits,['a']);assert.equal(batch.completed,1);
  assert.equal(events.at(-1)?.type,'failed');assert.equal(events.at(-1)?.index,1);
  fail=false;events.length=0;
  await batch.run(fresh().signal,e=>events.push(e));
  assert.deepEqual(http.names,['a.csv','b.csv','c.csv']);assert.deepEqual(http.commits,['a','b','c']);
  assert.deepEqual(events.filter(e=>e.type==='start').map(e=>e.index),[1,2]);
});

test('an HTTP success without a receipt for the expected file does not advance the batch or publish a dataset',async()=>{
  for(const invalid of [null,{}, {formatVersion:5,source:'alarm-jobs',mappedJobs:1,lastJobImport:{filename:'other.csv'}}]){
    const http=fakeApi(),events:JobOwnerBatchEvent[]=[];
    const api=async (url:string,options?:RequestInit)=>url.endsWith('/import')?invalid:http.api(url,options);
    const batch=createJobOwnerBatch(api,['a','b'].map(n=>excel(n+'.csv',n)));
    await assert.rejects(batch.run(fresh().signal,e=>events.push(e)),/did not confirm/);
    assert.equal(batch.completed,0);assert.equal(events.some(e=>e.type==='saved'),false);
    assert.equal(events.at(-1)?.type,'failed');assert.deepEqual(http.names,['a.csv']);
  }
});

test('a live ownership upload requires an AL receipt; a complete historical AG-only dataset cannot acknowledge it',async()=>{
  const http=fakeApi(),events:JobOwnerBatchEvent[]=[];
  const api=async(url:string,options?:RequestInit)=>{
    const result=await http.api(url,options);
    if(url.endsWith('/import')){delete result.alPolicy;}
    return result;
  };
  const batch=createJobOwnerBatch(api,[excel('owners.csv','x')]);
  await assert.rejects(batch.run(fresh().signal,e=>events.push(e)),/did not confirm/);
  assert.equal(batch.completed,0);assert.ok(!events.some(e=>e.type==='saved'));
});

test('abort an in-flight file, reject concurrent attempts, and start only its remaining files on retry',async()=>{
  const started=deferred();let block=true;
  const http=fakeApi(async s=>{
    if(block&&s.type==='chunk'&&s.name==='b.csv'){
      started.resolve();
      await new Promise<never>((_,reject)=>s.signal!.addEventListener('abort',()=>reject(new DOMException('cancel','AbortError')),{once:true}));
    }
  });
  const batch=createJobOwnerBatch(http.api,['a','b','c'].map(n=>excel(n+'.csv',n)));
  const ctl=fresh(),events:JobOwnerBatchEvent[]=[];
  const run=batch.run(ctl.signal,e=>events.push(e));await started.promise;
  await assert.rejects(batch.run(fresh().signal,()=>{}),/already running/);
  await assert.rejects(batch.discard(),/already running/);
  ctl.abort();await assert.rejects(run,{name:'AbortError'});
  assert.equal(batch.completed,1);assert.equal(events.at(-1)?.type,'cancelled');
  assert.deepEqual(http.discards,['b.csv']);assert.deepEqual(http.commits,['a']);
  block=false;await batch.run(fresh().signal,()=>{});
  assert.deepEqual(http.names,['a.csv','b.csv','b.csv','c.csv']);
  assert.deepEqual(http.commits,['a','b','c']);
});

test('cancellation between committed files stops before starting the next upload',async()=>{
  const http=fakeApi(),ctl=fresh(),events:JobOwnerBatchEvent[]=[];
  const batch=createJobOwnerBatch(http.api,['a','b'].map(n=>excel(n+'.csv',n)));
  await assert.rejects(batch.run(ctl.signal,e=>{
    events.push(e);if(e.type==='saved')ctl.abort();
  }),{name:'AbortError'});
  assert.deepEqual(http.names,['a.csv']);assert.equal(batch.completed,1);
  assert.equal(events.at(-1)?.type,'cancelled');assert.equal(events.at(-1)?.index,1);
  await batch.run(fresh().signal,()=>{});assert.deepEqual(http.commits,['a','b']);
});

test('cancellation during a noninterruptible parse records the actual receipt before stopping',async()=>{
  const started=deferred(),finish=deferred();
  const http=fakeApi(async s=>{if(s.type==='import'&&s.name==='a.csv'){started.resolve();await finish.promise;}});
  const ctl=fresh(),events:JobOwnerBatchEvent[]=[];
  const batch=createJobOwnerBatch(http.api,['a','b'].map(n=>excel(n+'.csv',n)));
  const run=batch.run(ctl.signal,e=>events.push(e));await started.promise;ctl.abort();finish.resolve();
  await assert.rejects(run,{name:'AbortError'});
  assert.deepEqual(events.filter(e=>e.type==='saved'||e.type==='cancelled').map(e=>[e.type,e.index]),[['saved',0],['cancelled',1]]);
  assert.equal(batch.completed,1);assert.deepEqual(http.names,['a.csv']);assert.deepEqual(http.commits,['a']);
});
