import {useEffect,useMemo,useState} from 'react';
import {
  DEFAULT_JOB_AL_POLICY,getJobAlPolicy,getJobProxyAxis,parseJobAlNames,
  type JobAlPolicy,type JobProxyMttrDataset,
} from '../lib/alarm-mttr';

type Translate=(zh:string,en:string)=>string;
type Props={data:JobProxyMttrDataset|null;t:Translate;disabled?:boolean;saving?:boolean;onSave?:(policy:JobAlPolicy)=>Promise<JobAlPolicy>};
function modeLabel(mode:JobAlPolicy['mode'],t:Translate){
  if(mode==='include')return t('仅包含名单内人员','Include listed people');
  if(mode==='exclude')return t('排除名单内人员','Exclude listed people');
  return t('不按名单筛选','No list filter');
}
export default function JobAlPolicyPanel({data,t,disabled=false,saving=false,onSave}:Props){
  const policy=getJobAlPolicy(data);
  const saved=policy??DEFAULT_JOB_AL_POLICY,legacy=getJobProxyAxis(data)==='AG';
  const key=JSON.stringify(saved);
  const [mode,setMode]=useState<JobAlPolicy['mode']>(saved.mode),[text,setText]=useState(saved.names.join('\n'));
  const [error,setError]=useState(''),[receipt,setReceipt]=useState('');
  useEffect(()=>{setMode(saved.mode);setText(saved.names.join('\n'));setError('')},[key]);
  const names=useMemo(()=>parseJobAlNames(text),[text]);
  const draft={mode,names},changed=mode!==saved.mode||JSON.stringify(names)!==JSON.stringify(saved.names);
  const emptyList=mode!=='all'&&!names.length;
  const active=saved.mode!=='all';
  const dg=data?.alDiagnostics;
  const priorReceipt=data?.lastJobImport;
  const historicImport=!!priorReceipt&&(!('personColumn' in priorReceipt)||priorReceipt.personColumn!=='AL');
  const clearMessage=()=>{setError('');setReceipt('')};
  async function apply(next:JobAlPolicy){
    if(!onSave||disabled)return;
    clearMessage();
    try{const applied=await onSave(next);setReceipt(JSON.stringify(applied))}catch(e){setError(e instanceof Error?e.message:String(e))}
  }
  return <section className="job-al-policy" aria-label={t('AL 人员名单','AL personnel list')}>
    <div className="job-al-heading"><h3>{t('AL 人员名单','AL personnel list')}</h3><span>{t('整个项目','Project-wide')}</span></div>
    {legacy?<p className="alarm-note">{t('这是升级前的人员统计，未记录 AL 人员及名单设置。请在本地服务中重新导入含 C、AL 列的 Job 表，再生成新的报表。','This historical report predates column AL. It has no AL names or list settings. Import the Job files with C and AL into the local service and generate a new report.')}</p>:<>
      <p className="job-al-applied"><b>{t('已应用','Applied')}:</b> {modeLabel(saved.mode,t)}
        {saved.names.length>0&&<span> · <b>{active?t('名单','Names'):t('保留名单（未启用）','Saved names (inactive)')}:</b> {saved.names.join(t('、',', '))}</span>}</p>
      <p className="alarm-note">{t('先将告警 AE 列 Job ID 匹配到 Job 表 C 列，再按 AL 列的完整姓名匹配名单；不区分大小写，不按部分姓名匹配。AL 为空或无法匹配 Job 的工单始终排除。名单作用于所有日期、均值、排名和明细。','Alarm Job IDs (AE) are matched to the Job file (C). The list matches whole names in column AL, ignoring case. Partial names do not match. Jobs with a blank AL or no matching Job ID are always excluded. The saved list applies across all dates, averages, rankings and details.')}</p>
      {dg&&<p className="job-al-diagnostics">{t('所有日期已排除工单','Excluded Jobs across all dates')}: <span>{t('未匹配 AL 姓名','No matched AL name')} <b>{dg.missingALJobs.toLocaleString('en-US')}</b></span> · <span>{t('被 AL 名单过滤','Filtered by AL list')} <b>{dg.filteredOutJobs.toLocaleString('en-US')}</b></span></p>}
      {(historicImport||!!dg?.missingALJobs)&&<p className="alarm-note">{t('旧版 Job 表只保存了原人员字段。如需补录 AL，请重新导入含 C、AL 列的原 Job 表；无需重传告警文件。','Earlier imports did not capture AL. To supply missing names, re-import the Job files with columns C and AL. The alarm files do not need to be uploaded again.')}</p>}
    </>}
    {onSave&&<details className="job-al-edit screen-only"><summary>{t('配置 AL 名单','Configure AL list')}</summary>
      <p className="alarm-note">{t('更改并保存项目名单后，本次报表的人员选择会重置为全部入选 AL 人员。','Saving a change to the project list resets the report selection to all eligible AL people.')}</p>
      <label>{t('名单模式','List mode')}<select value={mode} disabled={disabled} onChange={e=>{setMode(e.target.value as JobAlPolicy['mode']);clearMessage()}}>{(['all','include','exclude'] as const).map(m=><option value={m} key={m}>{modeLabel(m,t)}</option>)}</select></label>
      {mode!=='all'&&<label>{t('AL 人员姓名','AL names')}<textarea rows={3} value={text} disabled={disabled} onChange={e=>{setText(e.target.value);clearMessage()}}/><small>{t('用逗号、分号或换行分隔完整姓名。','Separate full names with commas, semicolons or line breaks.')}</small></label>}
      {emptyList&&<p className="alarm-warning">{t('请至少填写一个姓名再保存。','Enter at least one name to save this mode.')}</p>}
      <div className="alarm-actions"><button type="button" className="btn primary" disabled={disabled||!changed||emptyList} onClick={()=>apply(draft)}>{saving?t('正在保存…','Saving…'):t('保存并应用','Save and apply')}</button>
      <button type="button" className="btn" disabled={disabled||(!active&&!saved.names.length&&!changed)} onClick={()=>{const next=DEFAULT_JOB_AL_POLICY;setMode(next.mode);setText(next.names.join('\n'));if(active||saved.names.length)void apply(next);else clearMessage()}}>{t('关闭筛选并清空名单','Turn off and clear list')}</button></div>
      {error&&<p className="alarm-status error-text" role="alert">{error}</p>}{receipt===key&&!error&&<p className="alarm-note" role="status">{t('名单已保存，工单统计已更新。','List saved. Job metrics are up to date.')}</p>}
    </details>}
  </section>;
}
