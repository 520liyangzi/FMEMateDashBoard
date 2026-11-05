import {compareJobProxyMttr,getJobAlPolicy,getJobProxyAxis,rankJobProxyMttr,resolveJobProxyScope,selectJobProxyDays,type JobProxyMttrDataset} from '../lib/alarm-mttr.ts';
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
 const axis=getJobProxyAxis(data),policy=getJobAlPolicy(data),usesAL=axis==='AL';
 const ownerColumn=usesAL?t('Job 表 AL 列人员','Job AL person'):t('处理人（历史 Job AG 列）','Assignee (historical Job AG)');
 const effective=resolveJobProxyScope(data,owners,baseline,current);
 const scope=effective===null?(usesAL?t('AL 规则内全部具名人员','All matched Job AL people under the policy'):t('全部已匹配处理人（历史 AG）','All matched owners (historical AG)')):effective.join(', ')||t('无符合条件的所选人员','No eligible selected owners');
 const range=(p:MttrPeriod)=>`${p.from} — ${p.to}`;
 const c=compareJobProxyMttr(data,baseline,current,effective);
 const ranked=rankJobProxyMttr(data,baseline,current,effective);
 const days=selectJobProxyDays(data,effective);
 const common:Record<string,Cell>={[t('人员范围','Owner selection')]:scope,[t('人员归属列','Job personnel column')]:axis,
   [t('待重传的历史告警行','Historical alarm rows awaiting reimport')]:data?.legacyUnlinkedRows??''};
 if(usesAL){
   common[t('已应用 AL 模式','Applied AL mode')]=policy?.mode??'';
   common[t('已配置 AL 名单（JSON）','Configured AL names (JSON)')]=policy?JSON.stringify(policy.names):'';
   common[t('未匹配或缺少 AL 人员的工单数（所有日期）','Jobs without a matched AL person (all dates)')]=data?.alDiagnostics?.missingALJobs??'';
   common[t('AL 名单过滤工单数（所有日期）','Jobs filtered by AL policy (all dates)')]=data?.alDiagnostics?.filteredOutJobs??'';
 } else common[t('未匹配处理人排除工单数（所有日期）','Excluded Jobs without matched owners (all dates)')]=data?.unassignedJobs??'';

 const measured=!['no_dataset','invalid_range','alarm_reimport_required'].includes(c.status);
 const joinRule=usesAL
   ? t('告警 AE 关联 Job C；仅使用 Job AL 筛选人员并排名。AL 模式 all 包含所有具名 AL 人员，include 仅保留名单内人员，exclude 排除名单内人员；AL 未匹配或为空的工单不计。','Link alarm AE to Job C. Scope and rank using Job AL only. All includes named AL people, include keeps listed people, and exclude removes listed people. Missing or unmatched AL is excluded.')
   : t('这是历史快照：告警 AE 关联 Job C，人员来自历史 AG 列。','Historical snapshot: alarm AE joins Job C; personnel came from the historical AG column.');
 const method=joinRule+' '+t('B 白名单，AE 非空，I>0；每个 Job 只取最长有效告警时长，按该告警 K 列日期分期；并列最长取最早发生日期。平均值按工单计；仅计入已关联具名处理人的工单。两期均无有效工单的人不展示，仅一期有工单的人不排名。','B in allowlist, nonblank AE, I>0. Count each Job once using its longest eligible alarm. Assign it to that alarm’s K date (earliest on ties). Mean is Job-weighted. Only Jobs with a matched named owner count. Owners with no Jobs in either period are omitted; owners with Jobs in only one period are unranked.');
 const summary=(p:typeof c.baseline)=>({
   From:p.from,To:p.to,...common,[t('有效工单数','Eligible Jobs')]:measured?p.count:'',
   [t('工单总时长（秒）','Total Job seconds')]:measured?p.totalSeconds:'',
   [t('平均 MTTR（秒）','Mean MTTR (seconds)')]:measured?p.meanSeconds??'':'',
   [t('对比状态','Comparison status')]:c.status,
 });

 // Overlapping periods may have been loaded separately. Deduplicate identical winners
 // before splitting by period; different winners for one ID indicate a stale snapshot.
 const winners=new Map<string,JobProxyDetailRow>();
 const selected=effective===null?null:new Set(effective);
 const stale=()=>new Error(t('工单明细与统计数据不一致，请刷新页面后重新导出。','Job details and totals differ. Refresh the dashboard and export again.'));
 for(const d of detailRows) {
   if(!d.assignee.trim()||(selected&&!selected.has(d.assignee)))continue;
   const prior=winners.get(d.jobId);
   if(!prior)winners.set(d.jobId,d);
   else if(prior.seconds!==d.seconds||prior.date!==d.date||prior.assignee!==d.assignee)throw stale();
 }
 const unique=[...winners.values()];
 function detailSheet(name:string,p:typeof c.baseline):Sheet {
   const rows=measured?filterJobProxyDetails(unique,{from:p.from,to:p.to,assignees:effective}):[];
   const total=rows.reduce((sum,d)=>sum+d.seconds,0);
   if(measured && (rows.length!==p.count || Math.abs(total-p.totalSeconds)>Math.max(1e-6,Math.abs(total)*1e-10)))throw stale();
   if(rows.length>1_048_574)throw new Error(t('单期工单数超过 Excel 单表容量，请缩小日期或人员范围。','This period exceeds one Excel worksheet. Narrow the dates or owner selection.'));
   const type=t('行类型','Row type'),id='Job ID',owner=ownerColumn,date=t('最长告警发生日期（K列）','Winning alarm date (K)');
   const seconds=t('最长有效告警时长（秒）','Longest eligible duration (seconds)'),time=t('最长有效告警时长（时:分:秒）','Longest eligible duration (hh:mm:ss)');
   return {name,rows:[
     {[type]:t('所选范围合计','Selected scope total'),[id]:'',[owner]:'',[date]:'',[seconds]:'',[time]:'',...summary(p)},
     ...rows.map(d=>({[type]:t('工单','Job'),[id]:d.jobId,[owner]:d.assignee,[date]:d.date,[seconds]:d.seconds,[time]:elapsed(d.seconds)})),
   ]};
 }
 return [
  {name:t('工单 MTTR 对比','Job MTTR comparison'),rows:([[t('基准期','Baseline'),c.baseline],[t('对比期','Comparison'),c.current]] as const).map(([label,p])=>({[t('周期','Period')]:label,...summary(p),[t('减少率 (%)','Reduction (%)')]:p===c.current?c.reductionRate??'':'',[t('告警白名单','Alarm allowlist')]:data?.allowlist.join(', ')??'',[t('统计口径','Calculation')]:method}))},
  detailSheet(t('基准期工单明细','Baseline Job details'),c.baseline),
  detailSheet(t('对比期工单明细','Comparison Job details'),c.current),
  {name:t('处理人 MTTR 排名','MTTR by owner'),rows:ranked.map(r=>({[t('排名','Rank')]:r.rank??'',[ownerColumn]:r.assignee,[t('基准期','Baseline')]:range(baseline),[t('对比期','Comparison')]:range(current),[t('基准工单数','Baseline Jobs')]:r.comparison.baseline.count,[t('对比工单数','Comparison Jobs')]:r.comparison.current.count,[t('基准均值（秒）','Baseline mean (seconds)')]:r.comparison.baseline.meanSeconds??'',[t('对比均值（秒）','Comparison mean (seconds)')]:r.comparison.current.meanSeconds??'',[t('减少率 (%)','Reduction (%)')]:r.comparison.reductionRate??'',[t('对比状态','Comparison status')]:r.comparison.status}))},
  {name:t('工单 MTTR 每日明细','Job MTTR by date'),rows:days.filter(d=>(d.date>=baseline.from&&d.date<=baseline.to)||(d.date>=current.from&&d.date<=current.to)).map(d=>({[t('工单归属日期','Job attribution date')]:d.date,[t('有效工单数','Eligible Jobs')]:d.count,[t('工单总时长（秒）','Total Job seconds')]:d.totalSeconds,[t('平均 MTTR（秒）','Mean MTTR (seconds)')]:d.totalSeconds/d.count}))},
 ];
}
