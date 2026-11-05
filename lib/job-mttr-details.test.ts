import test from 'node:test'
import assert from 'node:assert/strict'
import {filterJobProxyDetails, getOfflineJobProxyDetailPage, loadJobProxyDetailPage, loadAllJobProxyDetails, type JobProxyDetailRow} from './job-mttr-details.ts'

const rows: JobProxyDetailRow[] = [
  {jobId:'007',assignee:'Wang',date:'2026-10-21',seconds:3600},
  {jobId:'unmatched',assignee:'',date:'2026-10-23',seconds:300},
  {jobId:'B',assignee:'Li',date:'2026-10-22',seconds:75.5},
  {jobId:'A',assignee:'Wang',date:'2026-10-22',seconds:225.5},
]
test('offline page totals cover all selected Jobs independent of paging, including open date bounds and unassigned scope', () => {
  assert.deepEqual(getOfflineJobProxyDetailPage(rows,{from:'2026-10-21',to:'2026-10-22',assignees:['Wang','Li']},1,1),
    {rows:[rows[2]],total:3,totalSeconds:3901})
  assert.deepEqual(filterJobProxyDetails(rows,{from:'2026-10-22'}).map(row=>row.jobId),['unmatched','A','B'])
  assert.deepEqual(filterJobProxyDetails(rows,{to:'2026-10-21'}),[rows[0]])
  assert.deepEqual(filterJobProxyDetails(rows,{assignees:['']}),[rows[1]])
  assert.deepEqual(filterJobProxyDetails(rows,{assignees:[]}),[])
  assert.deepEqual(filterJobProxyDetails(rows,{assignees:null}).map(row=>row.jobId),['unmatched','A','B','007'])
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
  const page=await loadJobProxyDetailPage(api,{from:'2026-10-22',to:'2026-10-22',assignees:['Wang','Li']},1,1)
  assert.equal(page.totalSeconds,301)
  assert.equal(page.revision,'a')
  for (const bounds of [{from:'2026-02-30'},{to:''},{from:'2026-10-23',to:'2026-10-22'}]) {
    await assert.rejects(loadJobProxyDetailPage(api,bounds),/Invalid Job detail dates/)
  }
  await assert.rejects(loadJobProxyDetailPage(api,{},0,1,AbortSignal.abort()),{name:'AbortError'})
  assert.equal(calls,1)
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
