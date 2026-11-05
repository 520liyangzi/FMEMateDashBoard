import type {JobProxyMttrComparison} from '../lib/alarm-mttr';

type Props={
  t:(zh:string,en:string)=>string;
  report:JobProxyMttrComparison;
  scope:string;
  legacy:boolean;
  formatDuration:(seconds:number|null)=>string;
};

/** Read the same aggregates as the adjacent cards, including when viewing an offline snapshot. */
export default function MttrCalculationRules({t,report,scope,legacy,formatDuration}:Props){
  const {baseline,current,reductionRate}=report;
  // Keep a positive subsecond divisor visible, even when the metric card rounds to 0:00:00.
  const auditTime=(seconds:number|null)=>seconds!==null&&seconds>0&&seconds<1
    ? t(`${Number(seconds.toPrecision(6))} 秒`,`${Number(seconds.toPrecision(6))} s`)
    : formatDuration(seconds);
  const meanLine=(p:typeof baseline)=>p.count&&p.meanSeconds!==null
    ? t(`${auditTime(p.totalSeconds)} ÷ ${p.count.toLocaleString('zh-CN')} 单 ≈ ${auditTime(p.meanSeconds)} / 单`,
        `${auditTime(p.totalSeconds)} ÷ ${p.count.toLocaleString('en-US')} ${p.count===1?'Job':'Jobs'} ≈ ${auditTime(p.meanSeconds)} / Job`)
    : '—';
  return <details className="mttr-calc-rules">
    <summary><span>{t('计算规则','Calculation rules')}</span>
      <small aria-hidden="true" className="mttr-calc-open">{t('展开','Show')}</small>
      <small aria-hidden="true" className="mttr-calc-close">{t('收起','Hide')}</small>
    </summary>
    <div className="mttr-calc-body">
      <ol>
        <li><strong>{t('哪些工单计入？','Which Jobs count?')}</strong>{' '}
          {t('告警表 B 列的告警 ID 须在白名单内，AE 列有 Job ID，I 列时长大于 0，K 列发生日期有效。','An alarm qualifies if its ID (B) is on the allowlist, its Job ID (AE) is present, duration (I) is positive, and its occurrence date (K) is valid.')}
          {' '}{legacy?t('此历史快照沿用原有的 AG 人员归属。','This historical snapshot uses its original AG assignees.'):t('用 AE 关联 Job 表 C 列，按 AL 列姓名归属。未匹配或 AL 为空的工单排除，再应用已保存的人员名单和页面选人范围。','Match AE to column C in the Job file and use AL for the person. Exclude unmatched Jobs and blank AL names, then apply the saved personnel list and the people selected for this view.')}</li>
        <li><strong>{t('一单多条告警怎么算？','What if a Job has several alarms?')}</strong>{' '}
          {t('每个 Job ID 只取其所有有效告警中最长的时长，作为这张工单处理时间的估算值。用最长告警的 K 列日期归期；并列最长时取最早日期。两期都包含起止当天；日期重叠的工单在每期各计一次。','Use the longest eligible alarm across all dates as the estimate for each Job ID. Assign the Job to that alarm’s K date; if tied, use the earliest date. Both date ranges are inclusive. A Job on an overlapping date counts once in each period.')}</li>
        <li><strong>{t('平均 MTTR','Mean MTTR')}</strong>{' '}
          {t('= 当期工单时长之和 ÷ 当期工单数。选多人时合并他们的工单，每单权重相同。','= sum of Job durations in the period ÷ number of Jobs in that period. For a group, pool the Jobs across people; each Job has the same weight.')}</li>
        <li><strong>{t('提升率','Improvement rate')}</strong>{' '}
          {t('=（基准期平均 MTTR − 对比期平均 MTTR）÷ 基准期平均 MTTR × 100%。正值表示平均每单变快，负值表示变慢；两期均值之差就是平均每单缩短或延长的时间。任一期没有工单，或基准均值为零，不计算提升率，也不参与排名。排名按未取整的提升率从高到低排列，相同者并列。','= (baseline mean MTTR − comparison mean MTTR) ÷ baseline mean MTTR × 100%. Positive means faster; negative means slower. The difference between means gives the time saved or added per Job. No rate or rank is assigned if either period has no Jobs or the baseline mean is zero. Rank by unrounded rate, highest first; exact ties share a rank.')}</li>
      </ol>
      <div className="mttr-calc-worked">
        <p><strong>{t('用当前数据核对','Check the current figures')}</strong> · {scope}</p>
        <dl>
          <div><dt>{t('基准期均值','Baseline mean')}</dt><dd>{meanLine(baseline)}</dd></div>
          <div><dt>{t('对比期均值','Comparison mean')}</dt><dd>{meanLine(current)}</dd></div>
          <div><dt>{t('提升率','Improvement rate')}</dt><dd>{reductionRate===null?'—':
            `(${auditTime(baseline.meanSeconds)} − ${auditTime(current.meanSeconds)}) ÷ ${auditTime(baseline.meanSeconds)} × 100% ≈ ${reductionRate.toFixed(1)}%`}</dd></div>
        </dl>
        <small>{t('时长以 时:分:秒 显示（不足一秒用小数）；提升率用取整前的均值计算。','Durations use h:mm:ss (decimal seconds below one second). The rate uses the unrounded means.')}</small>
      </div>
    </div>
  </details>;
}
