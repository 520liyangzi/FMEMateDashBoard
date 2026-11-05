import MttrCalculationRules from './MttrCalculationRules';
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
type FocusProps={
  focusPerson:string|null;onFocusPersonChange:(name:string|null)=>void;availablePeople:readonly string[];
};
type Props=FocusProps & {
  t:Translate; data:JobProxyMttrDataset|null; report:JobProxyMttrComparison;
  assignees:string[]|null; api:AlarmApi; offline:boolean; offlineRows?:JobProxyDetailRow[];
  formatDuration:(seconds:number|null)=>string; onExport?:()=>void|Promise<void>;
};
const PAGE_SIZE=20;
const count=(n:number)=>n.toLocaleString('en-US');
type PeriodProps=Omit<Props,keyof FocusProps|'report'|'onExport'> & {title:string;period:MttrAggregate};
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

function PersonControl({t,legacy,availablePeople,focusPerson,onFocusPersonChange}:FocusProps & {t:Translate;legacy:boolean}){
  const [query,setQuery]=useState('');
  useEffect(()=>{setQuery('')},[focusPerson,availablePeople]);
  const needle=query.trim().normalize('NFKC').toLocaleLowerCase();
  const matching=useMemo(()=>availablePeople.filter(p=>p.normalize('NFKC').toLocaleLowerCase().includes(needle)),[availablePeople,needle]);
  const visible=matching.slice(0,200);
  const keepCurrent=focusPerson!==null&&!visible.includes(focusPerson);
  const scope=t('当前报表范围','Current report scope'),disabled=legacy||!availablePeople.length;
  const help=legacy?t('此历史快照未记录 AL 姓名，明细沿用原报表范围。','This historical snapshot has no AL names. Details follow the original report scope.')
    :disabled?t('当前日期和报表范围内没有可选的 AL 人员。','No AL people have eligible Jobs in the current dates and report scope.')
    :t('从当前报表范围内选一人，仅更改下方工单明细。','Choose one person from the current report scope. Only the Job details below change.');
  return <div className="job-focus-controls screen-only">
    <p className="alarm-note" id="job-focus-help">{help}</p>
    <div className="job-focus-fields">
      <label>{t('搜索明细人员','Search detail people')}<input type="search" disabled={disabled} placeholder={t('输入姓名','Type a name')} aria-describedby="job-focus-help" value={query}
        onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{
          if(e.key==='Enter'&&!e.nativeEvent.isComposing&&matching.length===1){e.preventDefault();onFocusPersonChange(matching[0]);setQuery('')}
          if(e.key==='Escape'){e.stopPropagation();setQuery('')}
        }}/></label>
      <label>{legacy?t('历史明细范围','Historical detail scope'):t('明细人员（AL）','Detail person (AL)')}<select id="job-mttr-detail-person" disabled={disabled} value={focusPerson??''} onChange={e=>{onFocusPersonChange(e.target.value||null);setQuery('')}}>
        <option value="">{scope}</option>
        {keepCurrent&&<optgroup label={t('已选中','Currently selected')}><option value={focusPerson!}>{focusPerson}</option></optgroup>}
        {visible.map(person=><option key={person} value={person}>{person}</option>)}
      </select></label>
      <button className="btn" type="button" disabled={focusPerson===null&&!query} onClick={()=>{setQuery('');onFocusPersonChange(null)}}>{t('返回报表范围','Use report scope')}</button>
    </div>
    {!disabled&&(needle||matching.length>visible.length)&&<small className="job-focus-matches" role="status">{!matching.length
      ?t('没有匹配的姓名；当前明细范围未变。','No matching names. The detail scope is unchanged.')
      :matching.length>visible.length?t(`显示前 ${count(visible.length)} 人，共 ${count(matching.length)} 人。输入姓名可缩小范围。`,`Showing ${count(visible.length)} of ${count(matching.length)} people. Type a name to narrow the list.`)
      :matching.length===1?t('匹配到 1 人，可按回车查看。','One match. Press Enter in the search field to view this person.')
      :t(`匹配到 ${count(matching.length)} 人，请在名单中选择。`,`${count(matching.length)} matches. Choose a name from the list.`)}</small>}
  </div>;
}

function FocusSummary({t,scope,report,formatDuration}:{t:Translate;scope:string;report:JobProxyMttrComparison;formatDuration:Props['formatDuration']}){
  const {reductionRate:rate,savedSeconds:delta,baseline,current}=report;
  const rateLabel=rate===null?'—':rate!==0&&Math.abs(rate)<0.05?'≈0.0%':`${rate>0?'+':''}${rate.toFixed(1)}%`;
  const duration=delta===null?'':Math.abs(delta)>0&&Math.abs(delta)<1?t('不足 1 秒','less than 1 second'):formatDuration(Math.abs(delta));
  const hint=rate!==null&&delta!==null
    ?delta>0?t(`平均每单缩短 ${duration}`,`${duration} shorter per Job`):delta<0?t(`平均每单延长 ${duration}`,`${duration} longer per Job`):t('两期平均时长相同','No change in mean duration')
    :report.status==='invalid_range'?t('请检查两期日期。','Check both date ranges.')
    :report.status==='no_dataset'?t('尚无工单数据可供比较。','Job data is not available for comparison.')
    :report.status==='alarm_reimport_required'?t('需重新导入原告警文件后再比较。','Re-import the original alarms to compare these periods.')
    :report.status==='zero_baseline'?t('基准期均值为零，无法计算提升率。','The baseline mean is zero.')
    :!baseline.count&&!current.count?t('两期均无有效工单，无法比较。','Neither period has eligible Jobs.')
    :!baseline.count?t('基准期无有效工单，无法比较。','No eligible baseline Jobs.')
    :!current.count?t('对比期无有效工单，无法比较。','No eligible comparison Jobs.')
    :t('数据不足，无法比较。','Insufficient data to compare.');
  return <div className="job-focus-summary" aria-live="polite" aria-atomic="true"><p><b>{t('明细范围','Detail scope')}:</b> {scope}</p>
    <dl>
      {([[t('基准期均值','Baseline mean'),baseline],[t('对比期均值','Comparison mean'),current]] as const).map(([label,p])=><div key={label}>
        <dt>{label}</dt><dd>{formatDuration(p.meanSeconds)}<small>{p.days===0?'—':t(`${count(p.count)} 个工单`,`${count(p.count)} ${p.count===1?'Job':'Jobs'}`)} · {p.from||'—'} — {p.to||'—'}</small></dd></div>)}
      <div className={rate===null||rate===0?'':rate>0?'focus-improved':'focus-longer'}><dt>{t('MTTR 提升率','MTTR improvement')}</dt><dd>{rateLabel}<small>{hint}</small></dd></div>
    </dl></div>;
}

export default function JobMttrDetails({onExport,report,availablePeople=[],focusPerson=null,onFocusPersonChange,...common}:Props){
  const {t,data,assignees}=common;
  const [exporting,setExporting]=useState(false);
  const legacy=getJobProxyAxis(data)==='AG';
  const scope=focusPerson??(assignees===null?t('当前报表范围（全部入选人员）','Current report scope (all eligible people)'):
    !assignees.length?t('当前报表范围（未选人员）','Current report scope (no people selected)'):
    t(`当前报表范围（${count(assignees.length)} 人）：`,`Current report scope (${count(assignees.length)} selected): `)+assignees.join(t('、',', ')));
  const scopeKey=JSON.stringify([focusPerson,assignees,data?.revision,data?.allowlist,data?.lastImport?.importedAt,data?.lastJobImport?.importedAt]);
  const include=(label:string,period:MttrAggregate)=><DetailPeriod
    key={JSON.stringify([label,period.from,period.to,scopeKey])} {...common} title={label} period={period}/>;
  return <section id="job-mttr-details" tabIndex={-1} className="job-detail-section" aria-label={t('工单明细','Job details')}>
    <header className="job-detail-heading"><div><h3>{t('工单明细','Job details')}</h3><p className="alarm-note">{t('每行是一个计入平均值的工单，日期取自其最长有效告警的 K 列。','Each row is one Job used in the mean. Its date comes from column K of its longest eligible alarm.')}</p></div>
      {onExport&&(!common.offline||common.offlineRows)&&<button className="btn screen-only" type="button" disabled={exporting||!report.baseline.count&&!report.current.count} onClick={async()=>{setExporting(true);try{await onExport()}finally{setExporting(false)}}}><Download size={15}/>{exporting?t('正在导出…','Exporting…'):focusPerson!==null?t('导出此人明细','Export this person’s details'):t('导出完整明细','Export all detail rows')}</button>}
    </header>
    <PersonControl t={t} legacy={legacy} availablePeople={availablePeople} focusPerson={focusPerson} onFocusPersonChange={onFocusPersonChange}/>
    <MttrCalculationRules t={t} report={report} scope={scope} legacy={legacy} formatDuration={common.formatDuration}/>
    <FocusSummary t={t} scope={scope} report={report} formatDuration={common.formatDuration}/>
    <p className="job-detail-print-note">{t('明细仅打印当前页；完整筛选结果可导出 Excel。','Only the displayed page of each table is printed. Export Excel for all matching Jobs.')}</p>
    <div className="job-detail-grid">{include(t('基准期工单','Baseline Jobs'),report.baseline)}{include(t('对比期工单','Comparison Jobs'),report.current)}</div>
  </section>;
}
