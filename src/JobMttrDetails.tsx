import {useEffect,useMemo,useState} from 'react';
import {ChevronLeft,ChevronRight,Download} from 'lucide-react';
import {
  filterJobProxyDetails,loadJobProxyDetailPage,
  type JobProxyDetailPage,type JobProxyDetailRow,
} from '../lib/job-mttr-details';
import {getJobProxyAxis,type JobProxyMttrDataset,type JobProxyMttrComparison} from '../lib/alarm-mttr';
import type {MttrAggregate} from '../lib/mttr';
import type {AlarmApi} from './alarm-upload';

type Translate=(zh:string,en:string)=>string;
type Props={
  t:Translate; data:JobProxyMttrDataset|null; report:JobProxyMttrComparison;
  assignees:string[]|null; api:AlarmApi; offline:boolean; offlineRows?:JobProxyDetailRow[];
  formatDuration:(seconds:number|null)=>string; onExport?:()=>void|Promise<void>;
};
const PAGE_SIZE=20;
const count=(n:number)=>n.toLocaleString('en-US');
type PeriodProps=Omit<Props,'report'|'onExport'> & {title:string;period:MttrAggregate};
type LoadResult={request:object;page?:JobProxyDetailPage;error?:string};

function DetailPeriod({t,data,assignees,api,offline,offlineRows,formatDuration,title,period}:PeriodProps){
  const [page,setPage]=useState(0),[attempt,setAttempt]=useState(0);
  const lastPage=Math.max(0,Math.ceil(period.count/PAGE_SIZE)-1),index=Math.min(page,lastPage);
  const offset=index*PAGE_SIZE;
  const filter=useMemo(()=>({from:period.from,to:period.to,assignees}),[period.from,period.to,assignees]);
  const request=useMemo(()=>({filter,offset,data,attempt}),[filter,offset,data,attempt]);
  const [loaded,setLoaded]=useState<LoadResult|null>(null);
  const canShow=period.days>0&&period.count>0;
  useEffect(()=>{
    if(offline||!canShow)return;
    const controller=new AbortController();
    loadJobProxyDetailPage(api,request.filter,request.offset,PAGE_SIZE,controller.signal).then(
      result=>{if(!controller.signal.aborted)setLoaded({request,page:result})},
      e=>{if(!controller.signal.aborted)setLoaded({request,error:e instanceof Error?e.message:String(e)})}
    );
    return ()=>controller.abort();
  },[api,request,offline,canShow]);
  // Filter the snapshot once per selection; browsing another page then only slices 20 rows.
  const snapshot=useMemo(()=>{
    if(!offline||!offlineRows||!canShow)return null;
    try{const rows=filterJobProxyDetails(offlineRows,filter);
      return {rows,total:rows.length,totalSeconds:rows.reduce((sum,r)=>sum+r.seconds,0)};
    }catch{return null}
  },[offline,offlineRows,filter,canShow]);
  const response:JobProxyDetailPage|null=offline?(snapshot?{...snapshot,rows:snapshot.rows.slice(offset,offset+PAGE_SIZE)}:null)
    :loaded?.request===request?loaded.page:null;
  const error=!offline&&loaded?.request===request?loaded.error:'';
  const missingRows=offline&&!offlineRows;
  const mismatch=offline&&offlineRows&&!snapshot||response&&(!offline&&data?.revision!==undefined&&response.revision!==data.revision||response.total!==period.count||
    Math.abs(response.totalSeconds-period.totalSeconds)>Math.max(1e-5,1e-10*period.totalSeconds)||
    response.rows.length!==Math.min(PAGE_SIZE,period.count-offset));
  const pageInfo=response&&!mismatch?t(
    `第 ${index+1} / ${lastPage+1} 页 · 第 ${count(offset+1)}–${count(offset+response.rows.length)} 条，共 ${count(period.count)} 条`,
    `Page ${index+1} of ${lastPage+1} · Rows ${count(offset+1)}–${count(offset+response.rows.length)} of ${count(period.count)}`
  ):'';

  return <article className="job-detail-period" aria-label={title}>
    <header className="job-detail-period-head"><h4>{title}</h4><span>{period.from||'—'} — {period.to||'—'}</span></header>
    <p className="job-detail-kpis"><span>{t('有效工单','Eligible Jobs')} <b>{count(period.count)}</b></span><span>{t('平均 MTTR','Mean MTTR')} <b>{formatDuration(period.meanSeconds)}</b></span></p>
    {period.days===0?<p className="job-detail-state">{t('请选择有效的起止日期。','Select a valid date range.')}</p>
    :!canShow?<p className="job-detail-state">{assignees?.length===0?t('尚未选择人员。','No assignees selected.'):t('此期间和人员范围内无有效工单。','No eligible Jobs in this period and scope.')}</p>
    :missingRows?<p className="job-detail-state">{t('此旧版离线报表仅保存了汇总。请从本地服务重新导出离线报表，以查看工单明细。','This older snapshot contains only totals. Export a new offline report from the local service to include individual Jobs.')}</p>
    :error?<div className="job-detail-state" role="alert">{t('工单明细加载失败。','Could not load Job details.')} {error} <button className="text-button screen-only" type="button" onClick={()=>setAttempt(n=>n+1)}>{t('重试','Retry')}</button></div>
    :mismatch?<p className="job-detail-state" role="alert">{offline?t('快照中的明细与汇总不一致，请重新导出。','Snapshot details do not match the totals. Export a new snapshot.'):t('数据已更新。请刷新报表，重新查看汇总与明细。','Data has changed. Refresh the report to see the latest totals and details.')}</p>
    :!response?<p className="job-detail-state" role="status">{t('正在加载工单…','Loading Jobs…')}</p>
    :<>
      <div className="job-detail-rows"><table aria-label={title}><thead><tr><th scope="col">Job ID</th><th scope="col">{getJobProxyAxis(data)==='AG'?t('历史人员','Historical assignee'):t('AL 人员','AL person')}</th><th scope="col">{t('最长告警日期','Longest alarm date')}</th><th scope="col">MTTR <small>({t('时:分:秒','h:mm:ss')})</small></th></tr></thead>
        <tbody>{response.rows.map(r=><tr key={r.jobId}><th scope="row">{r.jobId}</th><td>{getJobProxyAxis(data)==='AG'?r.assignee:(r.alPerson??r.assignee)}</td><td>{r.date}</td><td>{formatDuration(r.seconds)}</td></tr>)}</tbody></table></div>
      <div className="job-detail-pages"><small aria-live="polite">{pageInfo}</small><div className="screen-only">
        <button type="button" aria-label={`${title} · ${t('上一页','Previous page')}`} className="btn" disabled={index===0} onClick={()=>setPage(index-1)}><ChevronLeft size={15}/></button>
        <button type="button" aria-label={`${title} · ${t('下一页','Next page')}`} className="btn" disabled={index>=lastPage} onClick={()=>setPage(index+1)}><ChevronRight size={15}/></button></div></div>
    </>}
  </article>;
}

export default function JobMttrDetails({onExport,report,...common}:Props){
  const {t,data,assignees}=common;
  const [exporting,setExporting]=useState(false);
  const scopeKey=JSON.stringify([assignees,data?.revision,data?.allowlist,data?.lastImport?.importedAt,data?.lastJobImport?.importedAt]);
  const include=(label:string,period:MttrAggregate)=><DetailPeriod
    key={JSON.stringify([label,period.from,period.to,scopeKey])} {...common} title={label} period={period}/>;
  return <section className="job-detail-section" aria-label={t('工单明细','Job details')}>
    <header className="job-detail-heading"><div><h3>{t('工单明细','Job details')}</h3><p className="alarm-note">{t('每行是一个计入平均值的工单，日期取自其最长有效告警的 K 列。','Each row is one Job used in the mean. Its date comes from column K of its longest eligible alarm.')}</p></div>
      {onExport&&(!common.offline||common.offlineRows)&&<button className="btn screen-only" type="button" disabled={exporting||!report.baseline.count&&!report.current.count} onClick={async()=>{setExporting(true);try{await onExport()}finally{setExporting(false)}}}><Download size={15}/>{exporting?t('正在导出…','Exporting…'):t('导出完整明细','Export all detail rows')}</button>}
    </header>
    <p className="job-detail-print-note">{t('明细仅打印当前页；完整筛选结果可导出 Excel。','Only the displayed page of each table is printed. Export Excel for all matching Jobs.')}</p>
    <div className="job-detail-grid">{include(t('基准期工单','Baseline Jobs'),report.baseline)}{include(t('对比期工单','Comparison Jobs'),report.current)}</div>
  </section>;
}
