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
