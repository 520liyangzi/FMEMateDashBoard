import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfflineDocument, downloadOfflineReport } from './offline.ts';
import { getJobDetailFocus } from '../lib/alarm-mttr.ts';

test('offline HTML embeds snapshot strings without allowing script closure', () => {
  const hostile = '</script><img src=x onerror=alert(1)><!--\u2028';
  const html = createOfflineDocument({ records: [{ question: hostile }], lang: 'en' }, 'en', 'console.log("</ScRiPt>");', 'body{color:#123}');
  assert.equal((html.match(/<script\b/g) ?? []).length, 2);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 2);
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(html.includes('<\\/ScRiPt>'));
  assert.ok(html.includes('\\u2028'));
  const serialized = html.match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1];
  assert.equal(JSON.parse(serialized).records[0].question, hostile);
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(html.includes('<div id="root"></div>'));
});

test('offline HTML rejects missing assets and external module dependencies', () => {
  for (const js of ['', 'import x from "./chunk.js";', 'import "https://example.com/mod.js";', 'const p=import("./chunk.js");']) assert.throws(() => createOfflineDocument({}, 'en', js, 'body{}'));
  assert.throws(() => createOfflineDocument({}, 'zh', 'console.log(1)', ''));
  assert.throws(() => createOfflineDocument({}, 'zh', 'console.log(1)', '@import url("https://example.com/style.css");'));
});

test('offline HTML escapes style boundaries and removes source map links', () => {
  const html = createOfflineDocument({}, 'zh', 'console.log(1);\n//# sourceMappingURL=entry.js.map', 'body::after{content:"</style>"}\n/*# sourceMappingURL=main.css.map */');
  assert.equal((html.match(/<\/style>/g) ?? []).length, 1);
  assert.ok(!html.includes('sourceMappingURL'));
  assert.ok(html.includes('<html lang="zh-CN">'));
});

async function browserMock(run: (context: { generated: () => Blob | undefined; setFetch: (handler: typeof fetch) => void; imageReads: () => number }) => Promise<void>) {
  const saved = new Map(['window', 'document', 'FileReader', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const savedCreate = URL.createObjectURL, savedRevoke = URL.revokeObjectURL;
  let generated: Blob | undefined, imageReads = 0;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = {};
  globals.document = { body: { appendChild() {} }, createElement() { return { click() {}, remove() {}, href: '', download: '' }; } };
  globals.FileReader = class {
    result: string | null = null;
    onload?: () => void;
    async readAsDataURL(blob: Blob) {
      imageReads++;
      this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
      this.onload?.();
    }
  };
  URL.createObjectURL = (blob) => { generated = blob as Blob; return 'blob:offline-test'; };
  URL.revokeObjectURL = () => {};
  try {
    await run({ generated: () => generated, setFetch: handler => { globals.fetch = handler; }, imageReads: () => imageReads });
  } finally {
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globals[key];
    URL.createObjectURL = savedCreate; URL.revokeObjectURL = savedRevoke;
  }
}

test('offline downloader embeds and caches screenshots without changing live snapshot URLs', async () => {
  await browserMock(async context => {
    let downloads = 0;
    context.setFetch((async (input: RequestInfo | URL) => {
      if (String(input) === '/api/offline-assets') return Response.json({ js: 'document.getElementById("root").textContent="Report";', css: 'body{}' });
      downloads++;
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } });
    }) as typeof fetch);
    const snapshot = { demo: false, state: { feedback: [{ imageUrl: '/uploads/pic.png' }, { imageUrl: '/uploads/pic.png' }] }, records: [] };
    await downloadOfflineReport(snapshot, 'en');
    assert.equal(downloads, 1);
    assert.equal(context.imageReads(), 1);
    assert.equal(snapshot.state.feedback[0].imageUrl, '/uploads/pic.png');
    const html = await context.generated()!.text();
    assert.ok(html.includes('data:image/png;base64,iVBORw=='));
    assert.ok(!html.includes('/uploads/pic.png'));
  });
});

test('missing feedback screenshots stop the download instead of producing an incomplete report', async () => {
  await browserMock(async context => {
    context.setFetch((async (input: RequestInfo | URL) => String(input) === '/api/offline-assets' ? Response.json({ js: 'console.log(1)', css: 'body{}' }) : new Response('missing', { status: 404 })) as typeof fetch);
    await assert.rejects(downloadOfflineReport({ state: { feedback: [{ imageUrl: '/uploads/missing.png' }] } }, 'en'), /report image is unavailable/);
    assert.equal(context.generated(), undefined);
  });
});

test('real failure causes, AI reports and full daily archives remain offline while demo export strips private content', async () => {
  await browserMock(async context => {
    context.setFetch((async (input:RequestInfo|URL)=>{
      assert.equal(String(input),'/api/offline-assets');
      return Response.json({js:'console.log(1)',css:'body{}'});
    }) as typeof fetch);
    const dailySummaries=Array.from({length:25},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,title:'Daily archive',zh:'已保存的每日总结',en:`Saved daily update ${i}`}));
    const live={demo:false,tab:'daily',minimumActiveDays:5,retentionDays:7,repeatMode:'consecutive',state:{feedback:[],failureNotes:{task1:'Saved cause: upstream timeout'},aiReports:[{id:'r1',zh:'已保存的汇报',en:'Saved AI update'}],aiReportsTotal:1,dailySummaries}};
    await downloadOfflineReport(live,'en');
    let html=await context.generated()!.text();
    assert.ok(html.includes('Saved cause: upstream timeout'));
    assert.ok(html.includes('Saved AI update'));
    const realExported=JSON.parse(html.match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.deepEqual(realExported.state.dailySummaries,dailySummaries);
    assert.equal(realExported.tab,'daily');
    assert.equal(realExported.minimumActiveDays,5);
    assert.equal(realExported.retentionDays,7);
    assert.equal(realExported.repeatMode,'consecutive');
    const demo={demo:true,state:{feedback:[{imageUrl:'/uploads/production.png'}],failureNotes:{task1:'PRIVATE_CAUSE_ONLY_IN_LIVE_STATE'},aiReports:[{id:'r2',en:'PRIVATE_AI_REPORT_ONLY_IN_LIVE_STATE'}],aiReportsTotal:1,dailySummaries:[{date:'2026-10-23',en:'PRIVATE_DAILY_SUMMARY_ONLY_IN_LIVE_STATE'}]}};
    await downloadOfflineReport(demo,'zh');
    html=await context.generated()!.text();
    assert.ok(!html.includes('PRIVATE_CAUSE_ONLY_IN_LIVE_STATE'));
    assert.ok(!html.includes('PRIVATE_AI_REPORT_ONLY_IN_LIVE_STATE'));
    assert.ok(!html.includes('PRIVATE_DAILY_SUMMARY_ONLY_IN_LIVE_STATE'));
    const exported=JSON.parse(html.match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.deepEqual(exported.state.failureNotes,{});
    assert.deepEqual(exported.state.feedback,[]);
    assert.deepEqual(exported.state.aiReports,[]);
    assert.equal(exported.state.aiReportsTotal,0);
    assert.deepEqual(exported.state.dailySummaries,[]);
    assert.equal(demo.state.failureNotes.task1,'PRIVATE_CAUSE_ONLY_IN_LIVE_STATE');
    assert.equal(demo.state.aiReportsTotal,1);
    assert.equal(demo.state.dailySummaries.length,1);
  });
});

test('offline visits embed all photos, preserve metadata, and strip private visits from demo exports', async () => {
  await browserMock(async context => {
    let reads=0;
    context.setFetch((async (input:RequestInfo|URL)=>{
      if(String(input)==='/api/offline-assets')return Response.json({js:'console.log(1)',css:'body{}'});
      reads++;return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}});
    }) as typeof fetch);
    const visit={id:'v1',date:'2026-10-31',site:'PRIVATE_SITE',description:'Field description',photos:['/uploads/a.png','/uploads/b.png']};
    const snapshot={demo:false,tab:'visits',state:{siteVisits:[visit],feedback:[{imageUrl:'/uploads/a.png'}]}};
    await downloadOfflineReport(snapshot,'en');
    const exported=JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.equal(reads,2);assert.equal(exported.tab,'visits');assert.equal(exported.state.siteVisits[0].description,'Field description');
    assert.ok(exported.state.siteVisits[0].photos.every((url:string)=>url.startsWith('data:image/png;base64,')));
    assert.deepEqual(visit.photos,['/uploads/a.png','/uploads/b.png']);
    await downloadOfflineReport({...snapshot,demo:true},'en');
    assert.ok(!(await context.generated()!.text()).includes('PRIVATE_SITE'));
  });
});

test('offline report preserves the captured cross-day selection and exact same-day aggregates without inventing old snapshot data', async () => {
  await browserMock(async context => {
    context.setFetch((async () => Response.json({ js: 'console.log(1)', css: 'body{}' })) as typeof fetch);
    const sameDay = {
      days: [{ date: '2026-10-31', count: 1, totalSeconds: 7200 }],
      personDays: [{ assignee: 'A', date: '2026-10-31', count: 1, totalSeconds: 7200 }],
    };
    const snapshot = { demo: false, mttrExcludeCrossDay: true, mttr: { formatVersion: 3, sameDay }, state: { feedback: [] } };
    await downloadOfflineReport(snapshot, 'en');
    const exported = JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.equal(exported.mttrExcludeCrossDay, true);
    assert.deepEqual(exported.mttr.sameDay, sameDay);
    assert.equal(snapshot.mttrExcludeCrossDay, true);
    const oldSnapshot = { demo: false, mttr: { formatVersion: 3, days: [{ date: '2026-10-31', count: 1, totalSeconds: 120 }] }, state: { feedback: [] } };
    await downloadOfflineReport(oldSnapshot, 'en');
    const oldExported = JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.ok(!('mttrExcludeCrossDay' in oldExported));
    assert.ok(!('sameDay' in oldExported.mttr), 'two-minute duration alone cannot establish a same-calendar-day Job');
  });
});

test('offline snapshots preserve editable duration threshold and exact duration groups without inventing old data', async () => {
  await browserMock(async context => {
    context.setFetch((async () => Response.json({ js: 'console.log(1)', css: 'body{}' })) as typeof fetch);
    const durationGroups = [{ date: '2026-10-31', assignee: 'A', durationSeconds: 1800, count: 2, sameDay: true }];
    const snapshot = { demo: false, mttrDurationLimitEnabled: true, mttrDurationLimitHours: '0.5', mttrExcludeCrossDay: true,
      mttr: { formatVersion: 3, durationGroups }, state: { feedback: [] } };
    await downloadOfflineReport(snapshot, 'en');
    const exported = JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.equal(exported.mttrDurationLimitEnabled, true);
    assert.equal(exported.mttrDurationLimitHours, '0.5');
    assert.equal(exported.mttrExcludeCrossDay, true);
    assert.deepEqual(exported.mttr.durationGroups, durationGroups);
    assert.equal(snapshot.mttrDurationLimitHours, '0.5');
    await downloadOfflineReport({ demo: false, mttr: { formatVersion: 3, days: [] }, state: { feedback: [] } }, 'en');
    const old = JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.ok(!('durationGroups' in old.mttr));
    assert.ok(!('mttrDurationLimitEnabled' in old));
    assert.ok(!('mttrDurationLimitHours' in old));
  });
});

test('offline snapshots preserve editable personal mean-gap filter and original person aggregates', async () => {
  await browserMock(async context => {
    context.setFetch((async () => Response.json({ js: 'console.log(1)', css: 'body{}' })) as typeof fetch);
    const personDays = [
      { date: '2026-10-21', assignee: 'A', count: 1, totalSeconds: 7200 },
      { date: '2026-10-22', assignee: 'A', count: 1, totalSeconds: 3600 },
    ];
    const snapshot = { demo: false, mttrGapLimitEnabled: true, mttrGapLimitHours: '0.5',
      mttr: { formatVersion: 3, personDays }, state: { feedback: [] } };
    await downloadOfflineReport(snapshot, 'en');
    const exported = JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.equal(exported.mttrGapLimitEnabled, true);
    assert.equal(exported.mttrGapLimitHours, '0.5');
    assert.deepEqual(exported.mttr.personDays, personDays, 'keep original person data so the threshold can be changed offline');
    assert.equal(snapshot.mttr.personDays.length, 2);
    await downloadOfflineReport({ demo: false, mttr: { formatVersion: 3, days: [] }, state: { feedback: [] } }, 'en');
    const old = JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.ok(!('mttrGapLimitEnabled' in old));
    assert.ok(!('personDays' in old.mttr));
  });
});

test('alarm snapshots keep eligible daily sums for changing periods offline, and strip real alarm data from demo exports', async () => {
  await browserMock(async context => {
    context.setFetch((async () => Response.json({js:'console.log(1)',css:'body{}'})) as typeof fetch);
    const alarmMttr={formatVersion:4,source:'alarms',days:[{date:'2026-10-19',count:2,totalSeconds:1200}],allowlist:['26540','26564']};
    const mttrBaseline={from:'2026-10-19',to:'2026-10-25'}, mttrCurrent={from:'2026-10-26',to:'2026-11-01'};
    for(const demo of [false,true]){
      await downloadOfflineReport({demo,state:{},mttrBaseline,mttrCurrent,alarmMttr},'zh');
      const exported=JSON.parse((await context.generated()!.text()).match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
      assert.deepEqual(exported.alarmMttr,demo?null:alarmMttr);assert.deepEqual(exported.mttrBaseline,mttrBaseline);assert.deepEqual(exported.mttrCurrent,mttrCurrent);
    }
  });
});

test('offline Job details reopen on one AL person without narrowing the group or losing other people’s rows',async()=>{
  await browserMock(async context=>{
    context.setFetch((async()=>Response.json({js:'console.log(1)',css:'body{}'})) as typeof fetch);
    const focus='PRIVATE-FOCUS', selectedAssignees=[focus,'PRIVATE-TEAMMATE'];
    const jobMttrRows=selectedAssignees.map((assignee,i)=>({jobId:'PRIVATE-JOB-'+i,assignee,date:'2026-10-28',seconds:360+i}));
    const alarmJobMttr={formatVersion:5,source:'alarm-jobs',alPolicy:{mode:'all',names:[]},totalJobs:2,storedRows:2,needsAlarmReimport:false,
      days:[{date:'2026-10-28',count:2,totalSeconds:721}],personDays:jobMttrRows.map(r=>({date:r.date,assignee:r.assignee,count:1,totalSeconds:r.seconds}))};
    const mttrBaseline={from:'2026-10-28',to:'2026-10-28'},mttrCurrent={from:'2026-10-29',to:'2026-10-29'};
    const template={state:{},jobMttrRows,alarmJobMttr,selectedAssignees,mttrBaseline,mttrCurrent};
    const readSnapshot=async()=>{
      const html=await context.generated()!.text();
      return {html,data:JSON.parse(html.match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1])};
    };
    await downloadOfflineReport({...template,detailFocusPerson:focus,jobMaxDurationHours:0.1},'en');
    const current=await readSnapshot();
    assert.equal(current.data.detailFocusPerson,focus);
    assert.equal(current.data.jobMaxDurationHours,0.1);
    assert.ok(current.data.jobMttrRows.some((r:{seconds:number})=>r.seconds>360),'the recipient can lift the cap and recover over-limit Jobs');
    assert.deepEqual(current.data.selectedAssignees,selectedAssignees);
    assert.deepEqual(current.data.jobMttrRows,jobMttrRows,'the reader can switch to the other AL person without the server');
    assert.deepEqual(current.data.alarmJobMttr,alarmJobMttr);
    const focused=getJobDetailFocus(current.data.alarmJobMttr,current.data.mttrBaseline,current.data.mttrCurrent,current.data.selectedAssignees,current.data.detailFocusPerson);
    assert.deepEqual(focused.assignees,[focus]);assert.equal(focused.comparison.baseline.meanSeconds,360);
    assert.equal(focused.comparison.reductionRate,null,'one-period detail must not invent a reduction');
    await downloadOfflineReport({...template,detailFocusPerson:focus,jobMaxDurationHours:0.1,demo:true},'zh');
    const demo=await readSnapshot();
    assert.equal(demo.data.detailFocusPerson,null);
    assert.equal(demo.data.jobMaxDurationHours,undefined);
    assert.deepEqual(demo.data.jobMttrRows,[]);assert.equal(demo.data.alarmJobMttr,null);assert.equal(demo.data.selectedAssignees,null);
    assert.doesNotMatch(demo.html,/PRIVATE-(FOCUS|TEAMMATE|JOB)/);
    await downloadOfflineReport(template,'en');
    const legacy=await readSnapshot();
    assert.equal(legacy.data.detailFocusPerson,undefined,'do not infer a focus from the first person in a legacy selection');
    const grouped=getJobDetailFocus(legacy.data.alarmJobMttr,legacy.data.mttrBaseline,legacy.data.mttrCurrent,legacy.data.selectedAssignees,legacy.data.detailFocusPerson??null);
    assert.deepEqual(grouped.assignees,selectedAssignees);assert.equal(grouped.comparison.baseline.meanSeconds,360.5);
  });
});
