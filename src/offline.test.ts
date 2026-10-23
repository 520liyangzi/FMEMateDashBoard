import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfflineDocument, downloadOfflineReport } from './offline.ts';

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
    await assert.rejects(downloadOfflineReport({ state: { feedback: [{ imageUrl: '/uploads/missing.png' }] } }, 'en'), /screenshot is unavailable/);
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
    const live={demo:false,tab:'daily',state:{feedback:[],failureNotes:{task1:'Saved cause: upstream timeout'},aiReports:[{id:'r1',zh:'已保存的汇报',en:'Saved AI update'}],aiReportsTotal:1,dailySummaries}};
    await downloadOfflineReport(live,'en');
    let html=await context.generated()!.text();
    assert.ok(html.includes('Saved cause: upstream timeout'));
    assert.ok(html.includes('Saved AI update'));
    const realExported=JSON.parse(html.match(/window\.__PULSE_OFFLINE__=([\s\S]+?);<\/script>/)![1]);
    assert.deepEqual(realExported.state.dailySummaries,dailySummaries);
    assert.equal(realExported.tab,'daily');
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
