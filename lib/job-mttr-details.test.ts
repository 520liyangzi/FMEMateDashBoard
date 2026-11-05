import test from 'node:test'
import assert from 'node:assert/strict'
import {getJobDurationMaxSeconds,applyOfflineJobDurationFilter,filterJobProxyDetails, getOfflineJobProxyDetailPage, loadJobProxyDetailPage, loadAllJobProxyDetails, type JobProxyDetailRow} from './job-mttr-details.ts'

import {compareJobProxyMttr, getJobDetailFocus, rankJobProxyMttr, selectJobProxyDays, type JobProxyMttrDataset} from './alarm-mttr.ts'

const rows: JobProxyDetailRow[] = [
  {jobId:'007',assignee:'Wang',date:'2026-10-21',seconds:3600},
  {jobId:'unmatched',assignee:'',date:'2026-10-23',seconds:300},
  {jobId:'B',assignee:'Li',date:'2026-10-22',seconds:75.5},
  {jobId:'A',assignee:'Wang',date:'2026-10-22',seconds:225.5},
]
test('offline page totals cover all selected Jobs independent of paging, including open date bounds and exclusion of legacy unassigned Jobs', () => {
  assert.deepEqual(getOfflineJobProxyDetailPage(rows,{from:'2026-10-21',to:'2026-10-22',assignees:['Wang','Li']},1,1),
    {rows:[rows[2]],total:3,totalSeconds:3901})
  assert.deepEqual(filterJobProxyDetails(rows,{from:'2026-10-22'}).map(row=>row.jobId),['A','B'])
  assert.deepEqual(filterJobProxyDetails(rows,{to:'2026-10-21'}),[rows[0]])
  assert.deepEqual(filterJobProxyDetails(rows,{assignees:['']}),[])
  assert.deepEqual(filterJobProxyDetails(rows,{assignees:[]}),[])
  assert.deepEqual(filterJobProxyDetails(rows,{assignees:null}).map(row=>row.jobId),['A','B','007'])
})
test('live page sends inclusive bounds, owners, and pagination; abort or invalid ranges never expand into an unfiltered request', async () => {
  let calls=0
  const api=async (url:string, options?:RequestInit) => {
    calls++
    assert.equal(url,'/api/mttr/alarms/job-details')
    assert.equal(options?.method,'POST')
    assert.deepEqual(JSON.parse(String(options?.body)),{start:'2026-10-22',end:'2026-10-22',assignees:['Wang','Li'],offset:1,limit:1})
    return {rows:[rows[2]],total:2,totalSeconds:301,offset:1,limit:1,revision:'a'}
  }
  const page=await loadJobProxyDetailPage(api,{from:'2026-10-22',to:'2026-10-22',assignees:['Wang','','Li','Wang','  ']},1,1)
  assert.equal(page.totalSeconds,301)
  assert.equal(page.revision,'a')
  for (const bounds of [{from:'2026-02-30'},{to:''},{from:'2026-10-23',to:'2026-10-22'}]) {
    await assert.rejects(loadJobProxyDetailPage(api,bounds),/Invalid Job detail dates/)
  }
  await assert.rejects(loadJobProxyDetailPage(api,{},0,1,AbortSignal.abort()),{name:'AbortError'})
  assert.equal(calls,1)
})

test('a stale endpoint cannot quietly return unmatched Jobs in a named-only All export',async()=>{
  const api=async()=>({rows:[rows[1]],total:1,totalSeconds:300})
  await assert.rejects(loadAllJobProxyDetails(api,{assignees:null}),/incomplete or changed/)
  const oldSnapshot=[rows[1],{...rows[1],jobId:'blank-name',assignee:'  '}]
  assert.deepEqual(getOfflineJobProxyDetailPage(oldSnapshot,{}),{rows:[],total:0,totalSeconds:0})
})

const many:JobProxyDetailRow[]=Array.from({length:5002},(_,i)=>({jobId:String(i).padStart(6,'0'),date:'2026-10-21',assignee:'Li',seconds:i%2?1.5:2}))
const grand = 5002*1.75
const live = (offset:number,limit:number) => ({rows:many.slice(offset,offset+limit),total:many.length,totalSeconds:grand,revision:'r1',offset,limit})
test('full export includes all pages and checks the active dashboard revision even on the first page',async()=>{
  const offsets:number[]=[]
  const api = async (_:string,options?:RequestInit) => {
    const {offset,limit}=JSON.parse(String(options?.body)); offsets.push(offset)
    return live(offset,limit)
  }
  const result=await loadAllJobProxyDetails(api,{},undefined,'r1')
  assert.deepEqual(offsets,[0,5000])
  assert.equal(result.length,5002)
  assert.equal(result.at(-1)?.jobId,'005001')
  await assert.rejects(loadAllJobProxyDetails(api,{},undefined,'stale'),/incomplete or changed/)
})
test('short, duplicate, wrong-duration or revised pages and endpoint failures never produce a partial export',async()=>{
  for(const issue of ['short','duplicate','seconds','revision','exception']) {
    const api = async (_:string,options?:RequestInit) => {
      const {offset,limit}=JSON.parse(String(options?.body)), page=live(offset,limit)
      if(offset===0) return page
      if(issue==='exception') throw Error('network interrupted')
      if(issue==='short') page.rows.pop()
      if(issue==='duplicate') page.rows[0]={...page.rows[0],jobId:many[4999].jobId}
      if(issue==='seconds') page.rows[1]={...page.rows[1],seconds:99}
      if(issue==='revision') page.revision='r2'
      return page
    }
    await assert.rejects(loadAllJobProxyDetails(api,{}),issue==='exception'?/network interrupted/:/incomplete or changed/,issue)
  }
})

test('new Job rows expose the canonical AL person; old snapshots remain explicitly historical and never manufacture AL',async()=>{
  const liveRow={...rows[0],assignee:'Li Hua',alPerson:'Li Hua'};
  const fetchOne=async()=>({rows:[liveRow],total:1,totalSeconds:liveRow.seconds});
  assert.deepEqual(await loadAllJobProxyDetails(fetchOne),[liveRow]);
  assert.equal(filterJobProxyDetails([rows[0]])[0].alPerson,undefined);
  const inconsistent=async()=>({rows:[{...liveRow,alPerson:'Another'}],total:1,totalSeconds:liveRow.seconds});
  await assert.rejects(loadAllJobProxyDetails(inconsistent),/incomplete or changed/);
});

test('completed Job maximum: offline threshold is inclusive and drives membership, ranking, period and focused summary consistently',()=>{
 const d1='2026-10-01',d2='2026-10-02',baseline={from:d1,to:d1},current={from:d2,to:d2};
 const winners:JobProxyDetailRow[]=[
   {jobId:'J0',assignee:'A',date:d1,seconds:2034,alarmCount:3},{jobId:'J1',assignee:'A',date:d1,seconds:3660,alarmCount:2},
   {jobId:'J2',assignee:'B',date:d1,seconds:4000,alarmCount:1},{jobId:'J3',assignee:'A',date:d2,seconds:1017,alarmCount:1},
   {jobId:'J4',assignee:'B',date:d2,seconds:1700,alarmCount:1},
 ];
 const data:JobProxyMttrDataset={formatVersion:5,source:'alarm-jobs',allowlist:['1'],revision:'abc',alPolicy:{mode:'all',names:[]},
   alDiagnostics:{missingALJobs:2,filteredOutJobs:3},days:[{date:d1,count:3,totalSeconds:9694},{date:d2,count:2,totalSeconds:2717}],
   personDays:[{date:d1,assignee:'A',count:2,totalSeconds:5694},{date:d1,assignee:'B',count:1,totalSeconds:4000},
     {date:d2,assignee:'A',count:1,totalSeconds:1017},{date:d2,assignee:'B',count:1,totalSeconds:1700}],
   totalJobs:5,totalAlarms:8,storedRows:20,earliestDate:d1,latestDate:d2,lastImport:null,lastJobImport:null,
   mappedJobs:15,unassignedJobs:2,needsAlarmReimport:true,legacyUnlinkedRows:1};
 const cap=0.565, clipped=applyOfflineJobDurationFilter(data,winners,cap)!;
 assert.deepEqual(clipped.durationFilter,{maxDurationHours:cap,excludedJobs:2});
 assert.equal(clipped.totalJobs,3);assert.equal(clipped.totalAlarms,5);assert.deepEqual(clipped.alDiagnostics,data.alDiagnostics);
 assert.equal(clipped.revision,'abc');assert.deepEqual(clipped.assignees,['A','B']);
 assert.deepEqual(selectJobProxyDays(clipped),[{date:d1,count:1,totalSeconds:2034},{date:d2,count:2,totalSeconds:2717}]);
 assert.equal(compareJobProxyMttr(clipped,baseline,current).current.meanSeconds,1358.5);
 assert.deepEqual(rankJobProxyMttr(clipped,baseline,current).map(r=>[r.assignee,r.rank,r.comparison.reductionRate]),[['A',1,50],['B',null,null]]);
 assert.deepEqual(getJobDetailFocus(clipped,baseline,current,null,'B').comparison.status,'no_baseline_jobs');
 assert.deepEqual(getOfflineJobProxyDetailPage(winners,{maxDurationHours:cap,from:d1,to:d1}).rows.map(j=>j.jobId),['J0']);
 assert.deepEqual(data.days[0],{date:d1,count:3,totalSeconds:9694});assert.equal(data.durationFilter,undefined);
 assert.equal(applyOfflineJobDurationFilter(data,undefined,null),data);
 const empty=applyOfflineJobDurationFilter(data,winners,0.01)!;
 assert.equal(empty.totalJobs,0);assert.equal(empty.earliestDate,null);assert.equal(empty.durationFilter?.excludedJobs,5);
 assert.equal(compareJobProxyMttr(empty,baseline,current).status,'no_jobs_both_periods');
 for(const incomplete of [undefined,winners.slice(1),[...winners,winners[0]],winners.map(r=>r.jobId==='J2'?{...r,seconds:4001}:r)])
   assert.throws(()=>applyOfflineJobDurationFilter(data,incomplete,cap),/Export a new offline report/);
 assert.throws(()=>applyOfflineJobDurationFilter(clipped,winners,2),/complete original Job details/);
 assert.throws(()=>applyOfflineJobDurationFilter(data,winners,Infinity),/positive finite/);
 // Old detail files without multiplicities can still be recomputed where the source numbers
 // determine the exact retained count; never estimate a subtotal from a global average.
 const noCounts=winners.map(({alarmCount,...rest})=>rest);
 assert.equal(applyOfflineJobDurationFilter({...data,totalAlarms:5},noCounts,cap)?.totalAlarms,3);
 assert.throws(()=>applyOfflineJobDurationFilter(data,noCounts,cap),/Export a new offline report/);
});

test('live detail paging passes cap to backend and rejects an unclipped response; disabled cap leaves original request and winners intact',async()=>{
 const cap=0.565,equal={...rows[0],seconds:2034},tooLong={...rows[0],seconds:2034.000001};
 const serve=(row:JobProxyDetailRow)=>async(_url:string,req?:RequestInit)=>{
   assert.equal(JSON.parse(String(req?.body)).maxDurationHours,cap);
   return {rows:[row],total:1,totalSeconds:row.seconds,revision:'v'};
 };
 assert.deepEqual(await loadAllJobProxyDetails(serve(equal),{maxDurationHours:cap},undefined,'v'),[equal]);
 await assert.rejects(loadAllJobProxyDetails(serve(tooLong),{maxDurationHours:cap}),/incomplete or changed/);
 assert.deepEqual(filterJobProxyDetails([tooLong],{maxDurationHours:null}),[tooLong]);
 for(const bad of [0,-1,NaN,Infinity,'1' as unknown as number]){
   assert.throws(()=>filterJobProxyDetails(rows,{maxDurationHours:bad}),/positive finite/);
   await assert.rejects(loadAllJobProxyDetails(async()=>assert.fail('must not request invalid cap'),{maxDurationHours:bad}),/positive finite/);
 }
});

test('exact decimal thresholds retain equality to source microseconds on both sides of binary rounding',()=>{
 for(const [hours,seconds] of [[0.011,39.6],[0.565,2034],[2.75e-7,0.00099],[2.77777778e-10,0.000001],[1e-12,0]]) {
   assert.equal(getJobDurationMaxSeconds(hours),seconds);
   const exact={...rows[0],seconds},above={...rows[0],jobId:'higher',seconds:seconds+0.000001};
   const selected=filterJobProxyDetails(seconds>0?[exact,above]:[above],{maxDurationHours:hours});
   assert.deepEqual(selected,seconds>0?[exact]:[]);
 }
 assert.equal(getJobDurationMaxSeconds(null),null);
});
