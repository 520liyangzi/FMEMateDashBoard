import assert from 'node:assert/strict';
import test from 'node:test';
import {jobMttrSheets} from './job-mttr-export.ts';
import type {JobProxyMttrDataset} from '../lib/alarm-mttr.ts';
import type {JobProxyDetailRow} from '../lib/job-mttr-details.ts';

const a='2026-10-05',b='2026-10-12',baseline={from:a,to:a},current={from:b,to:b};
const detail:JobProxyDetailRow[]=[
  {jobId:'0001',assignee:'Mei',date:a,seconds:60},{jobId:'0002',assignee:'Mei',date:a,seconds:120},
  {jobId:'0003',assignee:'Lin',date:a,seconds:900},{jobId:'0004',assignee:'',date:a,seconds:40},
  {jobId:'0005',assignee:'Mei',date:b,seconds:300},{jobId:'0006',assignee:'Lin',date:b,seconds:100800},
  {jobId:'0007',assignee:'Ada',date:b,seconds:90},
];
const data:JobProxyMttrDataset={formatVersion:5,source:'alarm-jobs',allowlist:['26540'],storedRows:11,totalAlarms:11,totalJobs:7,
  days:[{date:a,count:4,totalSeconds:1120},{date:b,count:3,totalSeconds:101190}],
  personDays:[{date:a,assignee:'Mei',count:2,totalSeconds:180},{date:a,assignee:'Lin',count:1,totalSeconds:900},{date:a,assignee:'',count:1,totalSeconds:40},
    {date:b,assignee:'Mei',count:1,totalSeconds:300},{date:b,assignee:'Lin',count:1,totalSeconds:100800},{date:b,assignee:'Ada',count:1,totalSeconds:90}],
  earliestDate:a,latestDate:b,lastImport:null,lastJobImport:null,mappedJobs:6,unassignedJobs:1,needsAlarmReimport:false,legacyUnlinkedRows:0};
const owners=['Mei','Lin'];
test('detail sheets match weighted group means in the period comparison and identify each winning Job exactly once',()=>{
  const sheets=jobMttrSheets(data,baseline,current,owners,'en',[...detail,detail[0]]);
  const summary=sheets.find(s=>s.name==='Job MTTR comparison')!.rows,base=sheets.find(s=>s.name==='Baseline Job details')!.rows,cur=sheets.find(s=>s.name==='Comparison Job details')!.rows;
  const header=(r:typeof summary[number])=>[r['Eligible Jobs'],r['Mean MTTR (seconds)'],r['Owner selection'],r.From,r.To];
  assert.deepEqual(header(base[0]),[3,360,'Mei, Lin',a,a]);
  assert.deepEqual(header(cur[0]),[2,50550,'Mei, Lin',b,b]);
  assert.deepEqual(summary.map(header),[header(base[0]),header(cur[0])]);
  assert.deepEqual(base.slice(1).map(r=>r['Job ID']).sort(),['0001','0002','0003']);
  assert.deepEqual(cur.slice(1).map(r=>r['Job ID']).sort(),['0005','0006']);
  const long=cur.find(r=>r['Job ID']==='0006')!;
  assert.deepEqual([long['Assignee (historical Job AG)'],long['Winning alarm date (K)'],long['Longest eligible duration (seconds)'],long['Longest eligible duration (hh:mm:ss)']],['Lin',b,100800,'28:00:00']);
});
test('empty periods retain scope and dates; even all owners exclude unmapped Jobs in old snapshots',()=>{
 const empty=jobMttrSheets(data,baseline,current,[],'zh',detail);
 const [br,cr]=['基准期工单明细','对比期工单明细'].map(name=>empty.find(s=>s.name===name)!.rows);
 assert.equal(br.length,1);assert.equal(cr.length,1);
 assert.deepEqual([br[0]['有效工单数'],br[0]['平均 MTTR（秒）'],br[0]['人员范围'],br[0].From,cr[0].To],[0,'','无符合条件的所选人员',a,b]);
 const all=jobMttrSheets(data,baseline,current,null,'en',detail).find(s=>s.name==='Baseline Job details')!.rows;
 assert.equal(all[0]['Eligible Jobs'],3);assert.equal(all[0]['Mean MTTR (seconds)'],360);
 assert.equal(all[0]['Excluded Jobs without matched owners (all dates)'],1);
 assert.equal(all[0]['Owner selection'],'All matched owners (historical AG)');assert.equal(all.some(r=>r['Job ID']==='0004'),false);
 const noSource=jobMttrSheets(null,baseline,current,null,'en',[])[1].rows;
 assert.deepEqual([noSource[0]['Eligible Jobs'],noSource[0]['Mean MTTR (seconds)'],noSource[0]['Comparison status']],['','','no_dataset']);
});
test('overlapping periods can each include a shared Job once and incomplete or conflicting winners are rejected',()=>{
 const both={from:a,to:b};
 const sheets=jobMttrSheets(data,both,current,['Mei'],'en',detail.filter(j=>j.assignee==='Mei'));
 assert.deepEqual(sheets[1].rows.slice(1).map(r=>r['Job ID']).sort(),['0001','0002','0005']);
 assert.deepEqual(sheets[2].rows.slice(1).map(r=>r['Job ID']),['0005']);
 assert.throws(()=>jobMttrSheets(data,baseline,current,owners,'en',detail.slice(1)),/details and totals differ/);
 assert.throws(()=>jobMttrSheets(data,baseline,current,owners,'en',[...detail,{...detail[0],seconds:61}]),/details and totals differ/);
});
test('Excel round trip keeps IDs as text, durations numeric, and detail sheets independent',async()=>{
 const x=await import('xlsx');
 const wb=x.utils.book_new();
 for(const sheet of jobMttrSheets(data,baseline,current,owners,'zh',detail)){
   x.utils.book_append_sheet(wb,x.utils.json_to_sheet(sheet.rows),sheet.name);
 }
 const read=x.read(x.write(wb,{type:'buffer',bookType:'xlsx'}),{type:'buffer'});
 for(const [period,ids] of [['基准期工单明细',['0001','0002','0003']],['对比期工单明细',['0005','0006']]] as const){
   const rows=x.utils.sheet_to_json<Record<string,unknown>>(read.Sheets[period]);
   assert.equal(rows[0]['人员范围'],'Mei, Lin');
   assert.deepEqual(rows.slice(1).map(row=>row['Job ID']).sort(),ids);
   assert.equal(typeof rows[1]['最长有效告警时长（秒）'],'number');
 }
});

test('direct export drops out-of-period, catalogue-only and blank names while keeping one-period owners unranked',()=>{
 const oldJob={jobId:'999',assignee:'Old',date:'2025-01-01',seconds:180};
 const mixed={...data,assignees:['Mei','Lin','Ada','Old','Catalogue only'],personDays:[...data.personDays,{date:oldJob.date,assignee:'Old',count:1,totalSeconds:180}]};
 const sheets=jobMttrSheets(mixed,baseline,current,['Ada','Old','Catalogue only',''], 'en',[...detail,oldJob]);
 assert.equal(sheets[1].rows[0]['Owner selection'],'Ada');assert.equal(sheets[1].rows[0]['Eligible Jobs'],0);
 assert.deepEqual(sheets[2].rows.slice(1).map(r=>r['Job ID']),['0007']);
 assert.deepEqual(sheets[3].rows.map(r=>[r['Assignee (historical Job AG)'],r.Rank,r['Reduction (%)']]),[['Ada','','']]);
});

test('AL snapshot uses the persisted list and AL-only scope for detail rows, ranked names and diagnostics',()=>{
 // Source Job C/AG/AL differ. Import contract: assignee carries AL, never the old AG value.
 const jobs=detail.map(r=>({C:r.jobId,AG:'Different AG owner',AL:r.assignee}));
 const rows=detail.filter(r=>r.assignee==='Mei').map(r=>({...r,assignee:jobs.find(j=>j.C===r.jobId)!.AL,alPerson:'Mei'}));
 const snapshot={...data,alPolicy:{mode:'include' as const,names:['Mei','Inactive, named']},alDiagnostics:{missingALJobs:1,filteredOutJobs:3},
  totalJobs:3,unassignedJobs:1,days:[{date:a,count:2,totalSeconds:180},{date:b,count:1,totalSeconds:300}],personDays:data.personDays.filter(p=>p.assignee==='Mei')};
 const sheets=jobMttrSheets(snapshot,baseline,current,['Different AG owner','Mei'],'en',rows);
 const base=sheets[1].rows,cur=sheets[2].rows;
 for(const summary of [sheets[0].rows[0],base[0],cur[0]]){
   assert.deepEqual([summary['Owner selection'],summary['Job personnel column'],summary['Applied AL mode'],JSON.parse(String(summary['Configured AL names (JSON)']))],['Mei','AL','include',['Mei','Inactive, named']]);
   assert.deepEqual([summary['Jobs without a matched AL person (all dates)'],summary['Jobs filtered by AL policy (all dates)']],[1,3]);
 }
 assert.deepEqual(base.slice(1).map(r=>r['Job AL person']),['Mei','Mei']);
 assert.equal(sheets[3].rows[0]['Job AL person'],'Mei');assert.ok(!JSON.stringify(sheets).includes('Different AG owner'));
 const historical=jobMttrSheets(data,baseline,current,null,'en',detail)[0].rows[0];
 assert.equal(historical['Job personnel column'],'AG');assert.equal(historical['Applied AL mode'],undefined);
});
