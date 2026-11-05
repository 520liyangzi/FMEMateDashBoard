import {compareJobProxyMttr,rankJobProxyMttr,selectJobProxyDays,type JobProxyMttrDataset} from '../lib/alarm-mttr.ts';
import {filterJobProxyDetails,type JobProxyDetailRow} from '../lib/job-mttr-details.ts';
import type {MttrPeriod} from '../lib/mttr.ts';

type Cell = number|string;
type Sheet = {name:string;rows:Record<string,Cell>[]};

function elapsed(seconds:number):string {
  const s=Math.round(seconds);
  return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(part=>String(part).padStart(2,'0')).join(':');
}

/** Every workbook uses the same selection and Job weights as the on-screen comparison. */
export function jobMttrSheets(data:JobProxyMttrDataset|null,baseline:MttrPeriod,current:MttrPeriod,owners:readonly string[]|null,lang:'zh'|'en',detailRows:readonly JobProxyDetailRow[]):Sheet[] {
 const t=(zh:string,en:string)=>lang==='zh'?zh:en;
 const unknown=t('未匹配处理人','Unmatched owner');
 const scope=owners===null?t('全部工单（含未匹配处理人）','All Jobs (including unmatched owners)'):[...new Set(owners)].map(name=>name||unknown).join(', ')||t('未选择人员','No owners selected');
 const range=(p:MttrPeriod)=>`${p.from} — ${p.to}`;
 const c=compareJobProxyMttr(data,baseline,current,owners);
 const ranked=rankJobProxyMttr(data,baseline,current,owners);
 const days=selectJobProxyDays(data,owners);
 const common={[t('人员范围','Owner selection')]:scope,[t('待重传的历史告警行','Historical alarm rows awaiting reimport')]:data?.legacyUnlinkedRows??''};
 const measured=!['no_dataset','invalid_range','alarm_reimport_required'].includes(c.status);
 const method=t('B 白名单，AE 非空，I>0；每个 Job 只取最长有效告警时长，按该告警 K 列日期分期；并列最长取最早发生日期。平均值按工单计；空白处理人和未匹配工单保留在整体。','B in allowlist, nonblank AE, I>0. Count each Job once using its longest eligible alarm. Assign it to that alarm’s K date (earliest on ties). Mean is Job-weighted. All Jobs includes those without a matched owner.');
 const summary=(p:typeof c.baseline)=>({
   From:p.from,To:p.to,...common,[t('有效工单数','Eligible Jobs')]:measured?p.count:'',
   [t('工单总时长（秒）','Total Job seconds')]:measured?p.totalSeconds:'',
   [t('平均 MTTR（秒）','Mean MTTR (seconds)')]:measured?p.meanSeconds??'':'',
   [t('对比状态','Comparison status')]:c.status,
 });

 // Overlapping periods may have been loaded separately. Deduplicate identical winners
 // before splitting by period; different winners for one ID indicate a stale snapshot.
 const winners=new Map<string,JobProxyDetailRow>();
 const stale=()=>new Error(t('工单明细与统计数据不一致，请刷新页面后重新导出。','Job details and totals differ. Refresh the dashboard and export again.'));
 for(const d of detailRows) {
   const prior=winners.get(d.jobId);
   if(!prior)winners.set(d.jobId,d);
   else if(prior.seconds!==d.seconds||prior.date!==d.date||prior.assignee!==d.assignee)throw stale();
 }
 const unique=[...winners.values()];
 function detailSheet(name:string,p:typeof c.baseline):Sheet {
   const rows=measured?filterJobProxyDetails(unique,{from:p.from,to:p.to,assignees:owners}):[];
   const total=rows.reduce((sum,d)=>sum+d.seconds,0);
   if(measured && (rows.length!==p.count || Math.abs(total-p.totalSeconds)>Math.max(1e-6,Math.abs(total)*1e-10)))throw stale();
   if(rows.length>1_048_574)throw new Error(t('单期工单数超过 Excel 单表容量，请缩小日期或人员范围。','This period exceeds one Excel worksheet. Narrow the dates or owner selection.'));
   const type=t('行类型','Row type'),id='Job ID',owner=t('处理人','Assignee'),date=t('最长告警发生日期（K列）','Winning alarm date (K)');
   const seconds=t('最长有效告警时长（秒）','Longest eligible duration (seconds)'),time=t('最长有效告警时长（时:分:秒）','Longest eligible duration (hh:mm:ss)');
   return {name,rows:[
     {[type]:t('所选范围合计','Selected scope total'),[id]:'',[owner]:'',[date]:'',[seconds]:'',[time]:'',...summary(p)},
     ...rows.map(d=>({[type]:t('工单','Job'),[id]:d.jobId,[owner]:d.assignee||unknown,[date]:d.date,[seconds]:d.seconds,[time]:elapsed(d.seconds)})),
   ]};
 }
 return [
  {name:t('工单 MTTR 对比','Job MTTR comparison'),rows:([[t('基准期','Baseline'),c.baseline],[t('对比期','Comparison'),c.current]] as const).map(([label,p])=>({[t('周期','Period')]:label,...summary(p),[t('减少率 (%)','Reduction (%)')]:p===c.current?c.reductionRate??'':'',[t('告警白名单','Alarm allowlist')]:data?.allowlist.join(', ')??'',[t('统计口径','Calculation')]:method}))},
  detailSheet(t('基准期工单明细','Baseline Job details'),c.baseline),
  detailSheet(t('对比期工单明细','Comparison Job details'),c.current),
  {name:t('处理人 MTTR 排名','MTTR by owner'),rows:ranked.map(r=>({[t('排名','Rank')]:r.rank??'',[t('处理人','Assignee')]:r.assignee,[t('基准期','Baseline')]:range(baseline),[t('对比期','Comparison')]:range(current),[t('基准工单数','Baseline Jobs')]:r.comparison.baseline.count,[t('对比工单数','Comparison Jobs')]:r.comparison.current.count,[t('基准均值（秒）','Baseline mean (seconds)')]:r.comparison.baseline.meanSeconds??'',[t('对比均值（秒）','Comparison mean (seconds)')]:r.comparison.current.meanSeconds??'',[t('减少率 (%)','Reduction (%)')]:r.comparison.reductionRate??'',[t('对比状态','Comparison status')]:r.comparison.status}))},
  {name:t('工单 MTTR 每日明细','Job MTTR by date'),rows:days.filter(d=>(d.date>=baseline.from&&d.date<=baseline.to)||(d.date>=current.from&&d.date<=current.to)).map(d=>({[t('工单归属日期','Job attribution date')]:d.date,[t('有效工单数','Eligible Jobs')]:d.count,[t('工单总时长（秒）','Total Job seconds')]:d.totalSeconds,[t('平均 MTTR（秒）','Mean MTTR (seconds)')]:d.totalSeconds/d.count}))},
 ];
}
