import assert from 'node:assert/strict';
import test from 'node:test';
import {aggregateAlarmMttr,compareAlarmMttr,type AlarmMttrDataset} from './alarm-mttr.ts';

const baseline={from:'2026-10-01',to:'2026-10-02'};
const current={from:'2026-10-03',to:'2026-10-03'};
const dataset:AlarmMttrDataset={
  formatVersion:4,source:'alarms',allowlist:['26540','26564'],storedRows:6,totalAlarms:5,
  earliestDate:'2026-10-01',latestDate:'2026-10-03',lastImport:null,
  days:[{date:'2026-10-01',count:1,totalSeconds:3600},{date:'2026-10-02',count:3,totalSeconds:3600},{date:'2026-10-03',count:1,totalSeconds:900}],
};

test('mean and reduction weight each eligible alarm occurrence equally across both inclusive endpoints',()=>{
  const c=compareAlarmMttr(dataset,baseline,current);
  assert.deepEqual(c.baseline,{...baseline,days:2,count:4,totalSeconds:7200,meanSeconds:1800});
  assert.equal(c.current.meanSeconds,900);
  assert.equal(c.reductionRate,50);
  assert.equal(c.savedSeconds,900);
  assert.equal(c.overlap,false);
  assert.equal(c.unequalDays,true);
  assert.equal(compareAlarmMttr(dataset,current,baseline).reductionRate,-100);
});

test('overlapping ranges each count the shared occurrences; identical periods have zero reduction',()=>{
  const c=compareAlarmMttr(dataset,baseline,{from:baseline.to,to:current.to});
  assert.equal(c.overlap,true);
  assert.equal(c.unequalDays,false);
  assert.equal(c.current.count,4);
  assert.equal(c.current.meanSeconds,1125);
  assert.equal(compareAlarmMttr(dataset,current,current).reductionRate,0);
});

test('missing data, reversed dates and impossible dates do not yield reduction rates',()=>{
  const noMatches={from:'2026-11-01',to:'2026-11-02'};
  for(const [c,status] of [
    [compareAlarmMttr(dataset,noMatches,current),'no_baseline_alarms'],
    [compareAlarmMttr(dataset,baseline,noMatches),'no_current_alarms'],
    [compareAlarmMttr(null,baseline,current),'no_dataset'],
    [compareAlarmMttr({...dataset,storedRows:0,totalAlarms:0,days:[]},baseline,current),'no_dataset'],
    [compareAlarmMttr(dataset,{from:baseline.to,to:baseline.from},current),'invalid_range'],
    [compareAlarmMttr(dataset,baseline,{from:'2026-02-30',to:'2026-03-01'}),'invalid_range'],
  ] as const){
    assert.equal(c.status,status);assert.equal(c.reductionRate,null);
  }
});

test('unusable zero-duration day groups do not contribute alarms or a zero-hour observation',()=>{
  const c=compareAlarmMttr({...dataset,days:[{date:baseline.from,count:2,totalSeconds:0},dataset.days[2]]},baseline,current);
  assert.equal(c.status,'no_baseline_alarms');
  assert.equal(c.baseline.count,0);
  assert.equal(c.baseline.meanSeconds,null);
  assert.equal(c.reductionRate,null);
  assert.equal(aggregateAlarmMttr(dataset,{from:'2026-10-02',to:'2026-10-02'}).meanSeconds,1200);
});

test('legacy Job aggregates cannot enter alarm comparisons through an old offline snapshot',()=>{
  const legacy={formatVersion:3,days:dataset.days} as unknown as AlarmMttrDataset;
  assert.equal(compareAlarmMttr(legacy,baseline,current).status,'no_dataset');
  assert.equal(aggregateAlarmMttr(legacy,baseline).count,0);
});

import {DEFAULT_JOB_AL_POLICY,getJobDetailFocus,getJobAlPolicy,getJobProxyAxis,isLegacyJobProxyDataset,parseJobAlNames,compareJobProxyMttr,rankJobProxyMttr,getJobProxyAssignees,resolveJobProxyScope,selectJobProxyDays,type JobProxyMttrDataset} from './alarm-mttr.ts';
const groups:JobProxyMttrDataset['personDays']=[
  {assignee:'A',date:'2026-10-01',count:1,totalSeconds:310},{assignee:'A',date:'2026-10-02',count:2,totalSeconds:1490},
  {assignee:'A',date:'2026-10-03',count:1,totalSeconds:300},
  {assignee:'B',date:'2026-10-01',count:1,totalSeconds:1200},{assignee:'B',date:'2026-10-03',count:3,totalSeconds:1800},
  {assignee:'C',date:'2026-10-02',count:1,totalSeconds:600},{assignee:'C',date:'2026-10-03',count:1,totalSeconds:900},
  {assignee:'',date:'2026-10-02',count:1,totalSeconds:160},{assignee:'',date:'2026-10-03',count:1,totalSeconds:190},
  {assignee:'Arrived',date:'2026-10-03',count:1,totalSeconds:1800},{assignee:'Left',date:'2026-10-02',count:1,totalSeconds:120},
  {assignee:'Historic',date:'2026-09-30',count:1,totalSeconds:10},
];
const jobs:JobProxyMttrDataset={
  formatVersion:5,source:'alarm-jobs',allowlist:['26540'],storedRows:24,totalAlarms:21,totalJobs:15,personDays:groups,
  days:[{date:'2026-09-30',count:1,totalSeconds:10},{date:'2026-10-01',count:2,totalSeconds:1510},
    {date:'2026-10-02',count:5,totalSeconds:2370},{date:'2026-10-03',count:7,totalSeconds:4990}],
  earliestDate:'2026-09-30',latestDate:'2026-10-03',lastImport:null,lastJobImport:null,mappedJobs:13,unassignedJobs:2,
  needsAlarmReimport:false,legacyUnlinkedRows:0,
};

test('a selected team combines each Job once rather than averaging person means, individual rates or alarm rows',()=>{
  const team=compareJobProxyMttr(jobs,baseline,current,['A','B','A']);
  assert.equal(team.baseline.count,4);assert.equal(team.baseline.meanSeconds,750);
  assert.equal(team.current.count,4);assert.equal(team.current.meanSeconds,525);
  assert.equal(team.reductionRate,30);
  assert.equal(compareJobProxyMttr(jobs,baseline,current,['A']).reductionRate,50);
  assert.equal(compareJobProxyMttr(jobs,baseline,current,['B']).reductionRate,50);
  assert.deepEqual(selectJobProxyDays(jobs,['A','B']).map(d=>[d.date,d.count,d.totalSeconds]),[
    ['2026-10-01',2,1510],['2026-10-02',2,1490],['2026-10-03',4,2100],
  ]);
});

test('All counts only named Jobs even for older V5 data; empty or blank-only scope never widens',()=>{
  assert.deepEqual(getJobProxyAssignees(jobs),['A','Arrived','B','C','Historic','Left']);
  const all=compareJobProxyMttr(jobs,baseline,current,null);
  assert.equal(all.baseline.count,6);assert.equal(all.baseline.totalSeconds,3720);
  assert.equal(all.current.count,6);assert.equal(all.current.totalSeconds,4800);
  assert.equal(compareJobProxyMttr(jobs,baseline,current,['']).baseline.meanSeconds,null);
  assert.equal(compareJobProxyMttr(jobs,baseline,current,[]).status,'no_jobs_both_periods');
  assert.deepEqual(rankJobProxyMttr(jobs,baseline,current,[]),[]);
});

test('personal rank compares signed reduction, shares ties, and keeps only in-scope people with explicit missing-period reasons',()=>{
  const rank=rankJobProxyMttr(jobs,baseline,current);
  assert.deepEqual(rank.map(r=>[r.assignee,r.rank,r.comparison.reductionRate,r.comparison.status]),[
    ['A',1,50,'available'],['B',1,50,'available'],['C',3,-50,'available'],
    ['Arrived',null,null,'no_baseline_jobs'],['Left',null,null,'no_current_jobs'],
  ]);
  const subset=rankJobProxyMttr(jobs,baseline,current,['C','Historic','']);
  assert.deepEqual(subset.map(r=>[r.assignee,r.rank,r.comparison.status]),[['C',1,'available']]);
});

test('V4 data is not a job proxy; partially recovered data uses only V5 Jobs; wholly unlinked history has no rate',()=>{
  const v4=dataset as unknown as JobProxyMttrDataset;
  assert.equal(compareJobProxyMttr(v4,baseline,current).status,'no_dataset');
  const partial={...jobs,needsAlarmReimport:true,legacyUnlinkedRows:100};
  assert.equal(compareJobProxyMttr(partial,baseline,current,['A','B']).reductionRate,30);
  const unavailable={...partial,totalJobs:0,days:[],personDays:[]};
  assert.equal(compareJobProxyMttr(unavailable,baseline,current).status,'alarm_reimport_required');
  assert.equal(compareJobProxyMttr(unavailable,baseline,current).reductionRate,null);
  assert.deepEqual(rankJobProxyMttr(unavailable,baseline,current),[]);
});

test('comparison supports arbitrary periods including coinciding dates and rejects inverted ranges',()=>{
  const same=compareJobProxyMttr(jobs,baseline,baseline,['A']);
  assert.equal(same.overlap,true);assert.equal(same.reductionRate,0);
  assert.equal(compareJobProxyMttr(jobs,baseline,{from:'2026-10-03',to:'2026-10-02'},['A']).status,'invalid_range');
});


test('period eligibility comes only from named positive Job groups, not the catalogue or the gap between periods',()=>{
  const late={from:'2026-10-10',to:'2026-10-10'};
  const snapshot={...jobs,assignees:['Catalogue only','Old selection'],personDays:[...groups,
    {assignee:'Gap only',date:'2026-10-07',count:1,totalSeconds:18},
    {assignee:'Late',date:'2026-10-10',count:1,totalSeconds:123},
    {assignee:'  ',date:'2026-10-10',count:1,totalSeconds:300},
    {assignee:'Zero jobs',date:'2026-10-01',count:0,totalSeconds:5},
    {assignee:'Zero duration',date:'2026-10-10',count:1,totalSeconds:0},
  ]};
  assert.deepEqual(getJobProxyAssignees(snapshot,baseline,late),['A','B','C','Late','Left']);
  assert.deepEqual(getJobProxyAssignees(snapshot,undefined,late),['Late']);
  assert.ok(getJobProxyAssignees(snapshot).includes('Gap only'));
  const selected=['Late','Historic','Gap only','','A','Late','Catalogue only','  '];
  assert.deepEqual(resolveJobProxyScope(snapshot,selected,baseline,late),['Late','A']);
  assert.deepEqual(resolveJobProxyScope(snapshot,['Catalogue only','Gap only'],baseline,late),[]);
  assert.equal(resolveJobProxyScope(snapshot,null,baseline,late),null);
  assert.deepEqual(rankJobProxyMttr(snapshot,baseline,late,selected).map(r=>[r.assignee,r.rank,r.comparison.status]),
    [['A',null,'no_current_jobs'],['Late',null,'no_baseline_jobs']]);
  assert.equal(compareJobProxyMttr(snapshot,baseline,late).current.count,1);
});

test('pasted AL lists preserve first spelling and distinct whole names while normalizing Unicode and whitespace',()=>{
  assert.deepEqual(parseJobAlNames(' Ａda　 Wong， ADA Wong; Ada\n李  华、李 华；Straße,STRASSE,  '),['Ada Wong','Ada','李 华','Straße']);
  // Arrays from a saved policy already contain whole names: never split stored punctuation.
  assert.deepEqual(parseJobAlNames(['  Chen, Lan','Chen, Lan','Chen']),['Chen, Lan','Chen']);
});

test('AL aggregates use the cohort returned by the server; historical AG data is never identified as an AL report',()=>{
  const al={...jobs,alPolicy:{mode:'include' as const,names:['a']},alDiagnostics:{missingALJobs:2,filteredOutJobs:7},
    personDays:groups.filter(d=>d.assignee==='A')};
  assert.deepEqual(getJobAlPolicy(al),{mode:'include',names:['a']});assert.equal(getJobProxyAxis(al),'AL');
  assert.equal(isLegacyJobProxyDataset(al),false);assert.deepEqual(getJobProxyAssignees(al,baseline,current),['A']);
  assert.equal(compareJobProxyMttr(al,baseline,current).reductionRate,50);
  assert.equal(getJobAlPolicy(jobs),null);assert.equal(getJobProxyAxis(jobs),'AG');assert.equal(isLegacyJobProxyDataset(jobs),true);
  assert.equal(getJobAlPolicy(null),null);assert.equal(getJobProxyAxis(null),'AL');assert.equal(isLegacyJobProxyDataset(null),false);
  assert.deepEqual(DEFAULT_JOB_AL_POLICY,{mode:'all',names:[]});
});


test('detail focus compares one AL person inside a team and following the team retains its Job-weighted rate',()=>{
  const al={...jobs,alPolicy:DEFAULT_JOB_AL_POLICY};
  const report=['B','A','B','Historic'];
  const follow=getJobDetailFocus(al,baseline,current,report,null);
  assert.deepEqual(follow.availablePeople,['A','B']);assert.deepEqual(follow.assignees,['B','A']);
  assert.equal(follow.person,null);assert.equal(follow.reset,false);assert.equal(follow.comparison.reductionRate,30);
  const a=getJobDetailFocus(al,baseline,current,report,'A');
  assert.equal(a.person,'A');assert.deepEqual(a.assignees,['A']);assert.equal(a.reset,false);
  assert.equal(a.comparison.baseline.count,3);assert.equal(a.comparison.current.count,1);
  assert.equal(a.comparison.reductionRate,50);
  assert.deepEqual(report,['B','A','B','Historic']);
  const moved=getJobDetailFocus(al,baseline,current,['B'],'A');
  assert.equal(moved.reset,true);assert.equal(moved.person,null);assert.deepEqual(moved.assignees,['B']);
  assert.deepEqual(moved.comparison,compareJobProxyMttr(al,baseline,current,['B']));
});

test('one-sided people remain inspectable without a rate; empty selections and changed dates cannot widen detail scope',()=>{
  const al={...jobs,alPolicy:DEFAULT_JOB_AL_POLICY};
  const arrived=getJobDetailFocus(al,baseline,current,null,'Arrived');
  assert.equal(arrived.person,'Arrived');assert.equal(arrived.comparison.status,'no_baseline_jobs');
  assert.equal(arrived.comparison.current.count,1);assert.equal(arrived.comparison.reductionRate,null);
  for(const owners of [[],['Historic','Catalogue only']]){
    const none=getJobDetailFocus(al,baseline,current,owners,'Arrived');
    assert.deepEqual(none.availablePeople,[]);assert.deepEqual(none.assignees,[]);
    assert.equal(none.reset,true);assert.equal(none.comparison.status,'no_jobs_both_periods');
  }
  const nowAbsent=getJobDetailFocus(al,baseline,baseline,null,'Arrived');
  assert.equal(nowAbsent.reset,true);assert.equal(nowAbsent.person,null);assert.equal(nowAbsent.assignees,null);
  assert.deepEqual(nowAbsent.comparison,compareJobProxyMttr(al,baseline,baseline));
});

test('saved AL snapshots use only their stored cohort, while legacy AG rows never masquerade as focused AL people',()=>{
  const filtered={...jobs,personDays:groups.filter(d=>d.assignee==='A'),alPolicy:{mode:'include' as const,names:['a','Absent']}};
  const stale=getJobDetailFocus(filtered,baseline,current,null,'Absent');
  assert.deepEqual(stale.availablePeople,['A']);assert.equal(stale.person,null);assert.equal(stale.reset,true);
  assert.equal(stale.assignees,null);assert.equal(stale.comparison.reductionRate,50);
  const legacy=getJobDetailFocus(jobs,baseline,current,['B','A'],'A');
  assert.deepEqual(legacy.availablePeople,[]);assert.deepEqual(legacy.assignees,['B','A']);
  assert.equal(legacy.person,null);assert.equal(legacy.reset,true);assert.equal(legacy.comparison.reductionRate,30);
});
