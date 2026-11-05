import type {JobProxyMttrDataset,JobProxyDay} from './alarm-mttr.ts';
// A row is a unique Job after its longest eligible alarm has been selected.
export type JobProxyDetailRow = {
  jobId: string; assignee: string; date: string; seconds: number;
  alarmId?: string; alarmCount?: number;
  /** Present for new AL reports; older snapshots only have their historical assignee. */
  alPerson?: string;
}
export type JobProxyDetailFilter = {from?: string; to?: string; assignees?: readonly string[] | null; maxDurationHours?: number | null}
export type JobProxyDetailPage = {rows: JobProxyDetailRow[]; total: number; totalSeconds: number; revision?: string}
type DetailApi = (url: string, options?: RequestInit) => Promise<unknown>
const MAX_PAGE = 5000
const inconsistent = () => new Error('工单明细不完整或在读取时发生变化，请重试。 / Job details are incomplete or changed during loading. Please retry.')

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value + 'T')
}

function checkJobDurationLimit(hours: number|null|undefined):void {
  if (hours!=null && (typeof hours!=='number' || !Number.isFinite(hours) || hours<=0))
    throw new Error('工单时长上限必须是大于零的小时数 / The Job duration limit must be a positive finite number of hours.')
}
/** Durations in the alarm ledger have microsecond precision. Treat decimal hours exactly
 * like the server's Decimal conversion. Floor to the last included microsecond, then parse
 * decimal seconds once. Neither binary hours*3600 nor seconds/3600 preserves all ties. */
export function getJobDurationMaxSeconds(hours:number|null|undefined):number|null {
  checkJobDurationLimit(hours)
  if(hours==null)return null
  const [mantissa,exp='0']=String(hours).toLowerCase().split('e')
  const [whole,fraction='']=mantissa.split('.')
  const power=Number(exp)-fraction.length
  const coefficient=BigInt(whole+fraction)*3600000000n
  const micros=power>=0 ? coefficient*10n**BigInt(power) : coefficient/10n**BigInt(-power)
  return Number(String(micros)+'e-6')
}
const withinDuration=(seconds:number,maxSeconds:number|null)=>maxSeconds==null || seconds<=maxSeconds

function prepareFilter({from, to, assignees,maxDurationHours}: JobProxyDetailFilter) {
  const maxSeconds=getJobDurationMaxSeconds(maxDurationHours)
  if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to)) || (from && to && from > to)) {
    throw new Error('工单明细日期无效 / Invalid Job detail dates')
  }
  if (assignees != null && (!Array.isArray(assignees) || !assignees.every(name => typeof name === 'string'))) {
    throw new Error('工单负责人筛选无效 / Invalid assignee filter')
  }
  const owners = assignees == null ? null : new Set(assignees.filter(name => name.trim().length > 0))
  const matches = (row: JobProxyDetailRow) => row.assignee.trim().length > 0 && withinDuration(row.seconds,maxSeconds) && (!from || row.date >= from) &&
    (!to || row.date <= to) && (!owners || owners.has(row.assignee))
  return {matches, assignees:owners ? [...owners] : assignees}
}

function checkPagination(offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
    throw new Error('工单明细分页无效 / Invalid Job detail page')
}

function isRow(row: unknown): row is JobProxyDetailRow {
  if (row == null || typeof row !== 'object') return false
  const value = row as Partial<JobProxyDetailRow>
  return typeof value.jobId === 'string' && value.jobId.length > 0 && typeof value.assignee === 'string' &&
    isDate(value.date) && typeof value.seconds === 'number' && Number.isFinite(value.seconds) && value.seconds > 0 &&
    (value.alPerson === undefined || (value.alPerson === value.assignee && value.alPerson.trim().length > 0)) &&
    (value.alarmId === undefined || typeof value.alarmId === 'string') &&
    (value.alarmCount === undefined || (Number.isSafeInteger(value.alarmCount) && value.alarmCount > 0))
}

// SQLite BINARY compares UTF-8 byte sequences. Code point order matches that
// ordering, including the unusual case of supplementary characters in Job IDs.
function compareId(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length) {
    const x = a.codePointAt(i)!, y = b.codePointAt(i)!
    if (x !== y) return x - y
    i += x > 0xffff ? 2 : 1
  }
  return a.length - b.length
}
const order = (a: JobProxyDetailRow, b: JobProxyDetailRow) => a.date === b.date ?
  compareId(a.jobId,b.jobId) : a.date > b.date ? -1 : 1
const sameSeconds = (a: number, b: number) => Math.abs(a - b) <= 1e-6 + 1e-12 * Math.max(Math.abs(a), Math.abs(b))

export function filterJobProxyDetails(rows: readonly JobProxyDetailRow[], filter: JobProxyDetailFilter = {}): JobProxyDetailRow[] {
  const {matches} = prepareFilter(filter)
  const seen = new Set<string>()
  return rows.filter(row => {
    if (!isRow(row) || seen.has(row.jobId)) throw inconsistent()
    seen.add(row.jobId)
    return matches(row)
  }).sort(order)
}

export function getOfflineJobProxyDetailPage(rows: readonly JobProxyDetailRow[], filter: JobProxyDetailFilter = {}, offset = 0, limit = 100): JobProxyDetailPage {
  checkPagination(offset, limit)
  const selected = filterJobProxyDetails(rows, filter)
  return {rows:selected.slice(offset,offset+limit), total:selected.length, totalSeconds:selected.reduce((sum,row) => sum+row.seconds, 0)}
}

export async function loadJobProxyDetailPage(api: DetailApi, filter: JobProxyDetailFilter = {}, offset = 0, limit = 100, signal?: AbortSignal): Promise<JobProxyDetailPage> {
  checkPagination(offset, limit)
  const {matches,assignees} = prepareFilter(filter)
  signal?.throwIfAborted()
  const response = await api('/api/mttr/alarms/job-details', {
    method:'POST', headers:{'Content-Type':'application/json'}, signal,
    body:JSON.stringify({start:filter.from, end:filter.to, assignees, maxDurationHours:filter.maxDurationHours??undefined, offset, limit}),
  })
  signal?.throwIfAborted()
  if (response == null || typeof response !== 'object') throw inconsistent()
  const {rows, total, totalSeconds, revision, offset: serverOffset, limit: serverLimit} = response as JobProxyDetailPage & {offset?:number; limit?:number}
  if (!Array.isArray(rows) || !Number.isSafeInteger(total) || total < 0 || !Number.isFinite(totalSeconds) || totalSeconds < 0 ||
      (revision !== undefined && typeof revision !== 'string') ||
      (serverOffset !== undefined && serverOffset !== offset) || (serverLimit !== undefined && serverLimit !== limit) ||
      rows.length !== Math.max(0,Math.min(limit,total-offset))) throw inconsistent()
  const seen = new Set<string>()
  let subtotal = 0
  for (let i=0; i<rows.length; i++) {
    const row = rows[i]
    if (!isRow(row) || !matches(row) || seen.has(row.jobId) || (i && order(rows[i-1],row) >= 0)) throw inconsistent()
    seen.add(row.jobId)
    subtotal += row.seconds
  }
  if ((total === rows.length && !sameSeconds(subtotal,totalSeconds)) || (subtotal > totalSeconds && !sameSeconds(subtotal,totalSeconds))) throw inconsistent()
  return {rows,total,totalSeconds,...(revision === undefined ? {} : {revision})}
}

export async function loadAllJobProxyDetails(api: DetailApi, filter: JobProxyDetailFilter = {}, signal?: AbortSignal, expectedRevision?: string): Promise<JobProxyDetailRow[]> {
  const first = await loadJobProxyDetailPage(api,filter,0,MAX_PAGE,signal)
  if (expectedRevision !== undefined && first.revision !== expectedRevision) throw inconsistent()
  const rows = [...first.rows]
  const seen = new Set(rows.map(row => row.jobId))
  while (rows.length < first.total) {
    const page = await loadJobProxyDetailPage(api,filter,rows.length,MAX_PAGE,signal)
    if (page.total !== first.total || !sameSeconds(page.totalSeconds, first.totalSeconds) || page.revision !== first.revision ||
        order(rows[rows.length-1],page.rows[0]) >= 0) throw inconsistent()
    for (const row of page.rows) {
      if (seen.has(row.jobId)) throw inconsistent()
      seen.add(row.jobId)
      rows.push(row)
    }
  }
  if (!sameSeconds(rows.reduce((sum,row) => sum+row.seconds, 0),first.totalSeconds)) throw inconsistent()
  return rows
}

const oldSnapshot = () => new Error('离线报表缺少完整的原始工单明细，请从本地服务重新导出离线报表。 / The offline report lacks complete original Job details. Export a new offline report from the local server.')
/** Rebuild the same per-Job cohort as the online query. Never filter daily means or substitute
 * a shorter alarm of the same Job. The input snapshot and winners must both be uncapped. */
export function applyOfflineJobDurationFilter(
  data:JobProxyMttrDataset|null, rows:readonly JobProxyDetailRow[]|null|undefined, maxDurationHours:number|null,
):JobProxyMttrDataset|null {
  const maxSeconds=getJobDurationMaxSeconds(maxDurationHours)
  if (!data)return null
  if (data.durationFilter)throw oldSnapshot() // Reapplication must begin with the original population.
  if (maxDurationHours==null)return data
  if (!Array.isArray(rows) || data.source!=='alarm-jobs' || data.formatVersion!==5)throw oldSnapshot()

  // Old V5 summaries may contain unassigned Jobs; only the named per-person aggregates
  // define the denominator, as on the screen. A date/owner/total check prevents partial or
  // out-of-date details from becoming a plausible but incorrect offline report.
  type Slice = JobProxyDay & {assignee:string}
  type Buckets = Map<string,Map<string,Slice>>
  const base:Buckets=new Map(),actual:Buckets=new Map(),kept:Buckets=new Map()
  const add=(map:Buckets,date:string,owner:string,count:number,seconds:number)=>{
    let people=map.get(date);if(!people){people=new Map();map.set(date,people)}
    const value=people.get(owner)
    if(value){value.count+=count;value.totalSeconds+=seconds}
    else people.set(owner,{date,assignee:owner,count,totalSeconds:seconds})
  }
  for(const d of data.personDays){
    if(d.assignee.trim() && d.count>0) add(base,d.date,d.assignee,d.count,d.totalSeconds)
  }
  let retained=0,removed=0,keptAlarmCount=0,removedAlarmCount=0,unknownKept=0,unknownRemoved=0
  const seen=new Set<string>()
  for(const d of rows){
    if(!isRow(d)||seen.has(d.jobId))throw oldSnapshot()
    seen.add(d.jobId)
    if(!d.assignee.trim())continue
    const source=base.get(d.date)?.get(d.assignee)
    if(!source||source.count<1)throw oldSnapshot()
    add(actual,d.date,d.assignee,1,d.seconds)
    if(withinDuration(d.seconds,maxSeconds)){
      add(kept,d.date,d.assignee,1,d.seconds);retained++
      if(d.alarmCount===undefined)unknownKept++;else keptAlarmCount+=d.alarmCount
    } else {
      removed++;if(d.alarmCount===undefined)unknownRemoved++;else removedAlarmCount+=d.alarmCount
    }
  }
  for(const people of base.values())for(const source of people.values()){
    const got=actual.get(source.date)?.get(source.assignee)
    if(!got||got.count!==source.count||!sameSeconds(got.totalSeconds,source.totalSeconds))throw oldSnapshot()
  }
  // Older detail rows sometimes omitted per-Job alarm multiplicities. Recover the exact
  // number only if determined by the remaining metadata; never pass an invented total as fact.
  const wholePopulation=retained+removed===data.totalJobs
  if(data.alPolicy && !wholePopulation)throw oldSnapshot()
  const minimumAlarms=keptAlarmCount+removedAlarmCount+unknownKept+unknownRemoved
  if(wholePopulation && (data.totalAlarms<minimumAlarms || (!unknownKept && !unknownRemoved && data.totalAlarms!==minimumAlarms)))throw oldSnapshot()
  if(unknownKept){
    if(wholePopulation && !unknownRemoved)keptAlarmCount=data.totalAlarms-removedAlarmCount
    else if(wholePopulation && data.totalAlarms===minimumAlarms)keptAlarmCount+=unknownKept
    else throw oldSnapshot()
  }
  const personDays=[...kept.values()].flatMap(m=>[...m.values()]).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:compareId(a.assignee,b.assignee))
  const days:JobProxyDay[]=[]
  for(const p of personDays){
    const last=days.at(-1)
    if(last?.date===p.date){last.count+=p.count;last.totalSeconds+=p.totalSeconds}
    else days.push({date:p.date,count:p.count,totalSeconds:p.totalSeconds})
  }
  return {...data,days,personDays,totalJobs:retained,totalAlarms:keptAlarmCount,
    assignees:[...new Set(personDays.map(d=>d.assignee))].sort(compareId),earliestDate:days[0]?.date??null,latestDate:days.at(-1)?.date??null,
    durationFilter:{maxDurationHours,excludedJobs:removed}}
}
