import {isValidMttrPeriod, type MttrAggregate, type MttrPeriod} from './mttr.ts';

/** A row represents an alarm occurrence, not a unique alarm code or Job ID. */
export interface AlarmMttrImportInfo {
  filename: string;
  sheetName: string;
  importedAt: string;
  dateColumn: 'K';
  durationUnit: 'hh:mm:ss';
  sourceRows: number;
  missingJobIds: number;
  missingAlarmIds: number;
  invalidDates: number;
  zeroDurations: number;
  invalidDurations: number;
  validRows: number;
  matchedRows: number;
  addedRows: number;
  duplicateRows: number;
}

export interface AlarmMttrDataset {
  formatVersion: 4;
  source: 'alarms';
  allowlist: string[];
  /** Aggregates based on the currently saved allowlist, after import validation. */
  days: {date:string; count:number; totalSeconds:number}[];
  totalAlarms: number;
  storedRows: number;
  earliestDate: string|null;
  latestDate: string|null;
  lastImport: AlarmMttrImportInfo|null;
}

export type AlarmMttrStatus = 'available'|'invalid_range'|'no_dataset'|'no_baseline_alarms'|'no_current_alarms'|'zero_baseline';
export interface AlarmMttrComparison {
  baseline: MttrAggregate;
  current: MttrAggregate;
  reductionRate: number|null;
  savedSeconds: number|null;
  status: AlarmMttrStatus;
  overlap: boolean;
  unequalDays: boolean;
}

/** Reuse for report exports. Dates refer to the source calendar day of occurrence (column K). */
export function aggregateAlarmMttr(dataset:AlarmMttrDataset|null|undefined, period:MttrPeriod):MttrAggregate {
  const out:MttrAggregate={...period,days:0,count:0,totalSeconds:0,meanSeconds:null};
  if (!isValidMttrPeriod(period)) return out;
  out.days=(Date.parse(period.to+'T00:00:00Z')-Date.parse(period.from+'T00:00:00Z'))/86_400_000+1;
  // Never allow an old Job-based snapshot to be interpreted as alarm durations.
  if (dataset?.source!=='alarms'||dataset.formatVersion!==4||!Array.isArray(dataset.days)) return out;
  for (const day of dataset.days) {
    if (day.date<period.from||day.date>period.to||!Number.isSafeInteger(day.count)||day.count<1||
        !Number.isFinite(day.totalSeconds)||day.totalSeconds<=0) continue;
    out.count+=day.count;
    out.totalSeconds+=day.totalSeconds;
  }
  if (out.count>0) out.meanSeconds=out.totalSeconds/out.count;
  return out;
}

/** Positive reduction means shorter mean Duration. Each eligible alarm row carries equal weight. */
export function compareAlarmMttr(dataset:AlarmMttrDataset|null|undefined, baselinePeriod:MttrPeriod, currentPeriod:MttrPeriod):AlarmMttrComparison {
  const baseline=aggregateAlarmMttr(dataset,baselinePeriod);
  const current=aggregateAlarmMttr(dataset,currentPeriod);
  const valid=isValidMttrPeriod(baselinePeriod)&&isValidMttrPeriod(currentPeriod);
  const status:AlarmMttrStatus=!valid?'invalid_range':
    dataset?.source!=='alarms'||dataset.formatVersion!==4||(!dataset.lastImport&&!dataset.storedRows)?'no_dataset':
    baseline.meanSeconds===null?'no_baseline_alarms':current.meanSeconds===null?'no_current_alarms':
    baseline.meanSeconds===0?'zero_baseline':'available';
  const savedSeconds=status==='available'?baseline.meanSeconds!-current.meanSeconds!:null;
  return {
    baseline,current,status,savedSeconds,reductionRate:savedSeconds===null?null:savedSeconds/baseline.meanSeconds!*100,
    overlap:valid&&baselinePeriod.from<=currentPeriod.to&&currentPeriod.from<=baselinePeriod.to,
    unequalDays:valid&&baseline.days!==current.days,
  };
}

/** Current reporting contract. The server reduces eligible alarm occurrences to one maximum per Job
 * before emitting daily counts/sums. V4 alarm-row means cannot be used in place of these groups. */
export type JobProxyDay = { date: string; count: number; totalSeconds: number };
/** The server applies this policy to matched Job-column-AL people before producing all report aggregates. */
export type JobAlPolicy = {mode:'all'|'include'|'exclude'; names:string[]};
export const DEFAULT_JOB_AL_POLICY:JobAlPolicy={mode:'all',names:[]};

/** Prepare a pasted list for the policy API. Keep the first display spelling.
 * The server performs authoritative Unicode casefold matching against whole AL values. */
export function parseJobAlNames(input:string|readonly string[]):string[]{
  const tokens=typeof input==='string'?input.split(/[,，、;；\r\n]+/u):input;
  const seen=new Set<string>(),names:string[]=[];
  for(const token of tokens){
    const display=token.normalize('NFKC').trim().replace(/\s+/gu,' ');
    // Common Unicode folds that differ from JavaScript's lowercase mapping.
    const key=display.toLowerCase().replace(/ß/gu,'ss').replace(/ς/gu,'σ');
    if(display&&!seen.has(key)){seen.add(key);names.push(display);}
  }
  return names;
}

export interface JobProxyMappingImportInfo {
  filename:string; sheetName:string; importedAt:string; sourceRows:number; missingJobIds:number;
  missingAssignees:number; validRows:number; duplicateRows:number; mappedJobs:number;
}
/** A report-time cap on the final winning alarm per Job. Exclusions follow the saved AL policy
 * and cover all dates/people before period or report-owner selection. Absent means no cap. */
export type JobDurationFilter = {maxDurationHours:number;excludedJobs:number};
export interface JobProxyMttrDataset {
  formatVersion:5; source:'alarm-jobs'; allowlist:string[]; revision?:string; durationFilter?:JobDurationFilter;
  /** Absent on historical AG reports: their aggregates must not be relabelled as AL. */
  alPolicy?:JobAlPolicy; alDiagnostics?:{missingALJobs:number; filteredOutJobs:number};
  /** Optional server hint. Older V5 snapshots may include the whole mapping catalogue here. */
  assignees?:string[];
  days:JobProxyDay[];
  /** Older V5 snapshots may include an unassigned bucket; it is never part of the reporting cohort. */
  personDays:(JobProxyDay & {assignee:string})[];
  totalJobs:number; totalAlarms:number; storedRows:number;
  earliestDate:string|null; latestDate:string|null; lastImport:AlarmMttrImportInfo|null;
  lastJobImport:JobProxyMappingImportInfo|null; mappedJobs:number; unassignedJobs:number;
  legacyUnlinkedRows:number; needsAlarmReimport:boolean;
}
/** null/undefined = all qualifying named owners; [] = no selection. */
export type JobProxyScope=readonly string[]|null|undefined;
export type JobProxyMttrStatus='available'|'invalid_range'|'no_dataset'|'alarm_reimport_required'|'no_jobs_both_periods'|'no_baseline_jobs'|'no_current_jobs'|'zero_baseline';
export interface JobProxyMttrComparison extends Omit<AlarmMttrComparison,'status'> {status:JobProxyMttrStatus}
export interface JobProxyMttrPerson {assignee:string;rank:number|null;comparison:JobProxyMttrComparison}
type ProxyInput=JobProxyMttrDataset|null|undefined;
const isProxy=(d:ProxyInput):d is JobProxyMttrDataset=>d?.formatVersion===5&&d.source==='alarm-jobs';
export function getJobAlPolicy(data:ProxyInput):JobAlPolicy|null{
  return isProxy(data)?data.alPolicy??null:null;
}
export function isLegacyJobProxyDataset(data:ProxyInput):boolean{
  return isProxy(data)&&!data.alPolicy;
}
/** Label the already-aggregated data. No client-side AL matching or fallback from AL to AG. */
export function getJobProxyAxis(data:ProxyInput):'AL'|'AG'{
  return isLegacyJobProxyDataset(data)?'AG':'AL';
}
const usableGroup=(day:JobProxyDay)=>Number.isSafeInteger(day.count)&&day.count>0&&Number.isFinite(day.totalSeconds)&&day.totalSeconds>0;
const asc=(a:string,b:string)=>a<b?-1:a>b?1:0;
const blocked=(d:JobProxyMttrDataset)=>d.needsAlarmReimport&&d.totalJobs===0&&!(d.durationFilter?.excludedJobs);

const namedOwner=(name:string)=>typeof name==='string'&&name.trim().length>0;

function inComparisonPeriods(baseline?:MttrPeriod,current?:MttrPeriod):(date:string)=>boolean{
  if(baseline===undefined&&current===undefined)return ()=>true;
  const ranges=[baseline,current].filter((r):r is MttrPeriod=>!!r&&isValidMttrPeriod(r));
  return date=>ranges.some(r=>date>=r.from&&date<=r.to);
}

/** Owners with an eligible winning Job in either supplied period (or in all history when neither is supplied). */
export function getJobProxyAssignees(data:ProxyInput,baseline?:MttrPeriod,current?:MttrPeriod):string[]{
  if(!isProxy(data)||blocked(data))return [];
  const included=inComparisonPeriods(baseline,current),names=new Set<string>();
  for(const d of data.personDays)if(namedOwner(d.assignee)&&usableGroup(d)&&included(d.date))names.add(d.assignee);
  return [...names].sort(asc);
}

function withinCohort(assignees:JobProxyScope,eligibleNames:readonly string[]):string[]|null{
  if(assignees==null)return null;
  const eligible=new Set(eligibleNames);
  return [...new Set(assignees)].filter(name=>eligible.has(name));
}

/** The distinction between All and an empty selection survives a date or allowlist change. */
export function resolveJobProxyScope(data:ProxyInput,assignees:JobProxyScope,baseline?:MttrPeriod,current?:MttrPeriod):string[]|null{
  if(assignees==null)return null;
  return withinCohort(assignees,getJobProxyAssignees(data,baseline,current));
}

/** Old V5 day totals included ownerless Jobs. Build every report, including All, from named owner groups. */
export function selectJobProxyDays(data:ProxyInput,assignees?:JobProxyScope):JobProxyDay[]{
  if(!isProxy(data)||blocked(data))return [];
  const selected=assignees==null?null:new Set(assignees),daily=new Map<string,JobProxyDay>();
  if(selected?.size===0)return [];
  for(const d of data.personDays){
    if(!namedOwner(d.assignee)||(selected&&!selected.has(d.assignee))||!usableGroup(d))continue;
    const sum=daily.get(d.date)??{date:d.date,count:0,totalSeconds:0};
    sum.count+=d.count;sum.totalSeconds+=d.totalSeconds;daily.set(d.date,sum);
  }
  return [...daily.values()].sort((a,b)=>asc(a.date,b.date));
}

function proxyAggregate(rows:JobProxyDay[],range:MttrPeriod):MttrAggregate{
  const out:MttrAggregate={...range,days:0,count:0,totalSeconds:0,meanSeconds:null};
  if(!isValidMttrPeriod(range))return out;
  out.days=(Date.parse(range.to+'T00:00:00Z')-Date.parse(range.from+'T00:00:00Z'))/86_400_000+1;
  for(const d of rows)if(d.date>=range.from&&d.date<=range.to&&usableGroup(d)){
    out.count+=d.count;out.totalSeconds+=d.totalSeconds;
  }
  if(out.count)out.meanSeconds=out.totalSeconds/out.count;
  return out;
}
function compareProxyDays(data:ProxyInput,rows:JobProxyDay[],base:MttrPeriod,cur:MttrPeriod):JobProxyMttrComparison{
  const baseline=proxyAggregate(rows,base),current=proxyAggregate(rows,cur);
  const valid=baseline.days>0&&current.days>0;
  let status:JobProxyMttrStatus='available';
  if(!valid)status='invalid_range';
  else if(!isProxy(data))status='no_dataset';
  else if(blocked(data))status='alarm_reimport_required';
  else if(!data.totalJobs&&!data.storedRows&&!data.lastImport)status='no_dataset';
  else if(!baseline.count&&!current.count)status='no_jobs_both_periods';
  else if(!baseline.count)status='no_baseline_jobs';
  else if(!current.count)status='no_current_jobs';
  else if(baseline.meanSeconds===0)status='zero_baseline';
  const savedSeconds=status==='available'?baseline.meanSeconds!-current.meanSeconds!:null;
  return {baseline,current,status,savedSeconds,reductionRate:savedSeconds===null?null:savedSeconds/baseline.meanSeconds!*100,
    overlap:valid&&base.from<=cur.to&&cur.from<=base.to,unequalDays:valid&&baseline.days!==current.days};
}
/** Inclusive periods. A Job belongs to the K date of its winning alarm and is counted only once in each period. */
export function compareJobProxyMttr(data:ProxyInput,baseline:MttrPeriod,current:MttrPeriod,assignees?:JobProxyScope):JobProxyMttrComparison{
  return compareProxyDays(data,selectJobProxyDays(data,assignees),baseline,current);
}
export interface JobDetailFocus {
  availablePeople:string[]; person:string|null; assignees:string[]|null;
  comparison:JobProxyMttrComparison; reset:boolean;
}

/** Focus only the drill-down. It may narrow, but never widen, the visible report population. */
export function getJobDetailFocus(data:ProxyInput,baseline:MttrPeriod,current:MttrPeriod,reportOwners:JobProxyScope,requestedPerson:string|null):JobDetailFocus{
  const names=getJobProxyAssignees(data,baseline,current);
  const reportScope=withinCohort(reportOwners,names), selected=reportScope===null?null:new Set(reportScope);
  // Historical snapshots saved AG assignees; those names cannot become AL focus candidates.
  const availablePeople=getJobAlPolicy(data)===null?[]:selected?names.filter(n=>selected.has(n)):names;
  const person=requestedPerson!==null&&availablePeople.includes(requestedPerson)?requestedPerson:null;
  const assignees=person===null?reportScope:[person];
  return {availablePeople,person,assignees,comparison:compareJobProxyMttr(data,baseline,current,assignees),reset:person!==requestedPerson};
}

/** Rank signed reductions before rounding for display, and keep one-period-only people visible as unranked.
 * Absent or stale names cannot create rows; an observed owner needs samples in both periods to earn a rank. */
export function rankJobProxyMttr(data:ProxyInput,baseline:MttrPeriod,current:MttrPeriod,assignees?:JobProxyScope):JobProxyMttrPerson[]{
  if(!isProxy(data)||blocked(data))return [];
  const selected=assignees==null?null:new Set(assignees),grouped=new Map<string,JobProxyDay[]>();
  const included=inComparisonPeriods(baseline,current);
  for(const d of data.personDays){
    if(!namedOwner(d.assignee)||(selected&&!selected.has(d.assignee))||!usableGroup(d)||!included(d.date))continue;
    const bucket=grouped.get(d.assignee);if(bucket)bucket.push(d);else grouped.set(d.assignee,[d]);
  }
  const rows:JobProxyMttrPerson[]=[...grouped].map(([assignee,days])=>({assignee,rank:null,comparison:compareProxyDays(data,days,baseline,current)}));
  rows.sort((a,b)=>{
    const x=a.comparison.reductionRate,y=b.comparison.reductionRate;
    if(x!==y)return x===null?1:y===null?-1:y-x;
    return asc(a.assignee,b.assignee);
  });
  let previous:number|null=null,rank=0;
  rows.forEach((row,i)=>{const rate=row.comparison.reductionRate;if(rate===null)return;if(rate!==previous)rank=i+1;row.rank=rank;previous=rate;});
  return rows;
}
