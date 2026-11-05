import assert from 'node:assert/strict';
import test from 'node:test';
import {aggregateAlarmMttr,compareAlarmMttr,type AlarmMttrDataset} from './alarm-mttr.ts';

const baseline={from:'2026-10-01',to:'2026-10-02'};
const current={from:'2026-10-03',to:'2026-10-03'};
const dataset:AlarmMttrDataset={
  formatVersion:4,source:'alarms',allowlist:['26540','26564'],storedRows:6,totalAlarms:5,
  earliestDate:'2026-10-01',latestDate:'2026-10-03',lastImport:null,
  days:[{date:'2026-10-01',count:1,totalSeconds:3600},{date:'2026-10-02',count:3,totalSeconds:3600},{date:'2026-10-03',count:1,totalSeconds:900}],
};

test('mean and reduction weight each eligible alarm occurrence equally across both inclusive endpoints',()=>{
  const c=compareAlarmMttr(dataset,baseline,current);
  assert.deepEqual(c.baseline,{...baseline,days:2,count:4,totalSeconds:7200,meanSeconds:1800});
  assert.equal(c.current.meanSeconds,900);
  assert.equal(c.reductionRate,50);
  assert.equal(c.savedSeconds,900);
  assert.equal(c.overlap,false);
  assert.equal(c.unequalDays,true);
  assert.equal(compareAlarmMttr(dataset,current,baseline).reductionRate,-100);
});

test('overlapping ranges each count the shared occurrences; identical periods have zero reduction',()=>{
  const c=compareAlarmMttr(dataset,baseline,{from:baseline.to,to:current.to});
  assert.equal(c.overlap,true);
  assert.equal(c.unequalDays,false);
  assert.equal(c.current.count,4);
  assert.equal(c.current.meanSeconds,1125);
  assert.equal(compareAlarmMttr(dataset,current,current).reductionRate,0);
});

test('missing data, reversed dates and impossible dates do not yield reduction rates',()=>{
  const noMatches={from:'2026-11-01',to:'2026-11-02'};
  for(const [c,status] of [
    [compareAlarmMttr(dataset,noMatches,current),'no_baseline_alarms'],
    [compareAlarmMttr(dataset,baseline,noMatches),'no_current_alarms'],
    [compareAlarmMttr(null,baseline,current),'no_dataset'],
    [compareAlarmMttr({...dataset,storedRows:0,totalAlarms:0,days:[]},baseline,current),'no_dataset'],
    [compareAlarmMttr(dataset,{from:baseline.to,to:baseline.from},current),'invalid_range'],
    [compareAlarmMttr(dataset,baseline,{from:'2026-02-30',to:'2026-03-01'}),'invalid_range'],
  ] as const){
    assert.equal(c.status,status);assert.equal(c.reductionRate,null);
  }
});

test('unusable zero-duration day groups do not contribute alarms or a zero-hour observation',()=>{
  const c=compareAlarmMttr({...dataset,days:[{date:baseline.from,count:2,totalSeconds:0},dataset.days[2]]},baseline,current);
  assert.equal(c.status,'no_baseline_alarms');
  assert.equal(c.baseline.count,0);
  assert.equal(c.baseline.meanSeconds,null);
  assert.equal(c.reductionRate,null);
  assert.equal(aggregateAlarmMttr(dataset,{from:'2026-10-02',to:'2026-10-02'}).meanSeconds,1200);
});

test('legacy Job aggregates cannot enter alarm comparisons through an old offline snapshot',()=>{
  const legacy={formatVersion:3,days:dataset.days} as unknown as AlarmMttrDataset;
  assert.equal(compareAlarmMttr(legacy,baseline,current).status,'no_dataset');
  assert.equal(aggregateAlarmMttr(legacy,baseline).count,0);
});
