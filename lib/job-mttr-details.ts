// A row is a unique Job after its longest eligible alarm has been selected.
export type JobProxyDetailRow = {
  jobId: string; assignee: string; date: string; seconds: number;
  alarmId?: string; alarmCount?: number;
}
export type JobProxyDetailFilter = {from?: string; to?: string; assignees?: readonly string[] | null}
export type JobProxyDetailPage = {rows: JobProxyDetailRow[]; total: number; totalSeconds: number; revision?: string}
type DetailApi = (url: string, options?: RequestInit) => Promise<unknown>
const MAX_PAGE = 5000
const inconsistent = () => new Error('工单明细不完整或在读取时发生变化，请重试。 / Job details are incomplete or changed during loading. Please retry.')

function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value + 'T')
}

function prepareFilter({from, to, assignees}: JobProxyDetailFilter) {
  if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to)) || (from && to && from > to)) {
    throw new Error('工单明细日期无效 / Invalid Job detail dates')
  }
  if (assignees != null && (!Array.isArray(assignees) || !assignees.every(name => typeof name === 'string'))) {
    throw new Error('工单负责人筛选无效 / Invalid assignee filter')
  }
  const owners = assignees == null ? null : new Set(assignees.filter(name => name.trim().length > 0))
  const matches = (row: JobProxyDetailRow) => row.assignee.trim().length > 0 && (!from || row.date >= from) &&
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
    body:JSON.stringify({start:filter.from, end:filter.to, assignees, offset, limit}),
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
