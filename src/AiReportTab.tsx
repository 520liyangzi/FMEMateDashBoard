import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Clipboard, Download, FileText, History, Info, LoaderCircle, Printer, Settings2, Sparkles } from 'lucide-react';
import type { AiFacts, AiReport } from '../lib/ai-reporting.ts';
import './ai-report.css';

type Language = 'zh' | 'en';
type AiConfig = {
  baseUrl: string; apiFormat: 'chat_completions' | 'responses'; model: string;
  maxOutputTokens: number; timeoutSeconds: number; hasApiKey: boolean; configured: boolean;
};
type ConnectionTest = { status: 'passed'; latencyMs: number; testedAt: string; model: string }
  | { status: 'skipped'; reason: 'api_key_cleared' };
export type AiReportTabProps = {
  lang: Language; facts: AiFacts; readOnly: boolean; savedReports: AiReport[]; savedReportsTotal: number;
  onReportSaved: (report: AiReport) => void; notify: (message: string) => void; onLatestDay: () => void;
};
const emptyConfig: AiConfig = { baseUrl: 'https://api.openai.com/v1', apiFormat: 'chat_completions', model: '', maxOutputTokens: 4096, timeoutSeconds: 120, hasApiKey: false, configured: false };

async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function mergeReports(current: AiReport[], incoming: AiReport[]) {
  const reports = new Map(current.map(report => [report.id, report]));
  incoming.forEach(report => reports.set(report.id, report));
  return [...reports.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Group messages use readable text, without Markdown heading/bold markers. */
export function reportPlainText(text: string): string {
  return text.trim().replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^[-*]\s+/gm, '• ');
}
function boldText(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**')
    ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}
/** A small text-only Markdown subset: model HTML and links are never executed. */
function ReportBody({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  let items: string[] = [];
  let ordered = false;
  const flushParagraph = () => { if (paragraph.length) { blocks.push(<p key={blocks.length}>{boldText(paragraph.join('\n'))}</p>); paragraph = []; } };
  const flushList = () => {
    if (!items.length) return;
    const content = items.map((item, index) => <li key={index}>{boldText(item)}</li>);
    blocks.push(ordered ? <ol key={blocks.length}>{content}</ol> : <ul key={blocks.length}>{content}</ul>);
    items = [];
  };
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const item = /^\s*(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
    if (!line.trim()) { flushParagraph(); flushList(); }
    else if (heading) { flushParagraph(); flushList(); blocks.push(<h3 key={blocks.length}>{boldText(heading[1])}</h3>); }
    else if (item) { flushParagraph(); const nextOrdered = !item[1]; if (items.length && ordered !== nextOrdered) flushList(); ordered = nextOrdered; items.push(item[2]); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList();
  return <div className="ai-report-prose">{blocks}</div>;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* LAN HTTP may require the legacy clipboard path. */ }
  }
  const active = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', ''); field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
  document.body.appendChild(field); field.select(); field.setSelectionRange(0, field.value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } finally { field.remove(); active?.focus(); }
  if (!copied) throw new Error('Clipboard unavailable. Select the report text and copy it.');
}
function downloadText(text: string, filename: string, markdown = false) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: `${markdown ? 'text/markdown' : 'text/plain'};charset=utf-8` }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AiReportTab({ lang, facts, readOnly, savedReports = [], savedReportsTotal = 0, onReportSaved, notify, onLatestDay }: AiReportTabProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [config, setConfig] = useState<AiConfig>(emptyConfig);
  const [draftConfig, setDraftConfig] = useState<AiConfig>(emptyConfig);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState('');
  const [configErrorSource, setConfigErrorSource] = useState<'load' | 'save'>('load');
  const [connectionTest, setConnectionTest] = useState<ConnectionTest | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [instructions, setInstructions] = useState('');
  const [preview, setPreview] = useState<{ system: string; user: string } | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [reports, setReports] = useState<AiReport[]>(savedReports);
  const [reportTotal, setReportTotal] = useState(savedReportsTotal);
  const [selectedId, setSelectedId] = useState(savedReports[0]?.id || '');
  const [historyPending, setHistoryPending] = useState(false);
  const [copied, setCopied] = useState('');
  const inFlight = useRef(false);
  const saveInFlight = useRef(false);
  const alive = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (copyTimer.current) clearTimeout(copyTimer.current); }; }, []);
  useEffect(() => {
    setReports(current => mergeReports(current, savedReports));
    setReportTotal(total => Math.max(total, savedReportsTotal));
    setSelectedId(current => current || savedReports[0]?.id || '');
  }, [savedReports, savedReportsTotal]);
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    request('/api/ai/config').then(result => {
      if (cancelled) return;
      const next = { ...emptyConfig, ...result }; setConfig(next); setDraftConfig(next); setConfigLoaded(true); setConfigOpen(!next.configured); setConfigError('');
    }).catch(error => { if (!cancelled) { setConfigLoaded(true); setConfigOpen(true); setConfigErrorSource('load'); setConfigError(errorText(error)); } });
    return () => { cancelled = true; };
  }, [readOnly]);
  // A preview must always correspond to the current filters and editor contents.
  const serializedFacts = useMemo(() => JSON.stringify(facts), [facts]);
  const previewRequest = useRef(0);
  useEffect(() => { previewRequest.current += 1; setPreview(null); setPreviewError(''); setPreviewPending(false); }, [serializedFacts, instructions]);
  const selected = reports.find(report => report.id === selectedId) || null;
  const totals = facts.totals;
  const range = facts.range;
  const disabled = saving || generating;
  const configDirty = draftConfig.baseUrl !== config.baseUrl || draftConfig.apiFormat !== config.apiFormat || draftConfig.model !== config.model || draftConfig.maxOutputTokens !== config.maxOutputTokens || draftConfig.timeoutSeconds !== config.timeoutSeconds || !!apiKey || clearApiKey;

  function editConfig(fields: Partial<AiConfig>) {
    setDraftConfig(value => ({ ...value, ...fields })); setConnectionTest(null); setConfigError('');
  }
  function editKey(value: string) {
    setApiKey(value); if (value) setClearApiKey(false); setConnectionTest(null); setConfigError('');
  }
  function editClearKey(value: boolean) {
    setClearApiKey(value); if (value) setApiKey(''); setConnectionTest(null); setConfigError('');
  }

  async function saveConfig(event: React.FormEvent) {
    event.preventDefault();
    if (readOnly || saveInFlight.current || inFlight.current) return;
    saveInFlight.current = true; setSaving(true); setConfigError(''); setConnectionTest(null);
    try {
      const result = await request('/api/ai/config', { baseUrl: draftConfig.baseUrl.trim(), apiFormat: draftConfig.apiFormat, model: draftConfig.model.trim(), maxOutputTokens: Number(draftConfig.maxOutputTokens), timeoutSeconds: Number(draftConfig.timeoutSeconds), apiKey, clearApiKey });
      const next = { ...emptyConfig, ...result }; setConfig(next); setDraftConfig(next); setApiKey(''); setClearApiKey(false);
      if (result.connectionTest?.status === 'passed') {
        setConnectionTest({ status: 'passed', latencyMs: result.connectionTest.latencyMs, testedAt: result.connectionTest.testedAt, model: next.model });
        notify(t('连接测试通过，AI 接口配置已保存。', 'Connection test passed. AI connection saved.'));
      } else if (result.connectionTest?.status === 'skipped' && result.connectionTest.reason === 'api_key_cleared') {
        setConnectionTest({ status: 'skipped', reason: 'api_key_cleared' });
        notify(t('API Key 已清除，未进行连接测试。', 'API key cleared. No connection test was run.'));
      }
    } catch (error) { setConfigErrorSource('save'); setConfigError(errorText(error)); }
    finally { saveInFlight.current = false; if (alive.current) setSaving(false); }
  }
  async function previewPrompt() {
    if (readOnly || previewPending) return;
    const requestId = ++previewRequest.current;
    setPreviewPending(true); setPreviewError('');
    try {
      const result = await request('/api/ai/preview', { facts, instructions });
      if (alive.current && requestId === previewRequest.current) setPreview({ system: result.system, user: result.user });
    } catch (error) { if (alive.current && requestId === previewRequest.current) setPreviewError(errorText(error)); }
    finally { if (alive.current && requestId === previewRequest.current) setPreviewPending(false); }
  }
  async function generate() {
    if (readOnly || !config.configured || configDirty || inFlight.current || saveInFlight.current) return;
    inFlight.current = true; setGenerating(true); setGenerationError('');
    try {
      const result = await request('/api/ai/generate', { facts, instructions });
      const report: AiReport = result.report;
      if (!report?.id || typeof report.zh !== 'string' || typeof report.en !== 'string') throw new Error(t('接口没有返回完整的中英文汇报。', 'The API did not return both report versions.'));
      if (alive.current) { setReports(current => mergeReports(current, [report])); setSelectedId(report.id); setReportTotal(total => total + 1); }
      onReportSaved(report); notify(t('中英文汇报已生成并保存。', 'Chinese and English reports generated and saved.'));
    } catch (error) { if (alive.current) setGenerationError(errorText(error)); }
    finally { inFlight.current = false; if (alive.current) setGenerating(false); }
  }
  async function loadHistory() {
    if (readOnly || historyPending) return;
    setHistoryPending(true);
    try {
      const result = await request(`/api/ai/reports?offset=${reports.length}&limit=20`);
      if (alive.current) { setReports(current => mergeReports(current, result.reports || [])); setReportTotal(result.total || 0); }
    } catch (error) { notify(t('读取历史汇报失败：', 'Could not load report history: ') + errorText(error)); }
    finally { if (alive.current) setHistoryPending(false); }
  }
  async function copyReport(reportLang: Language) {
    if (!selected) return;
    try {
      await copyText(reportPlainText(selected[reportLang])); setCopied(reportLang);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => { if (alive.current) setCopied(''); }, 2200);
      notify(t('已复制，可粘贴到群里发送。', 'Copied. Paste it into your group to share.'));
    } catch { notify(t('无法自动复制，请选中汇报正文手动复制。', 'Automatic copy is unavailable. Select and copy the report text manually.')); }
  }
  function exportReport(reportLang: Language, markdown: boolean) {
    if (!selected) return;
    const period = selected.from === selected.to ? selected.from : `${selected.from}_${selected.to}`;
    downloadText(markdown ? selected[reportLang] : reportPlainText(selected[reportLang]), `FMEMate_Progress_${period}_${reportLang}.${markdown ? 'md' : 'txt'}`, markdown);
  }
  function displayScene(scene: string) { return !scene ? t('全部场景', 'All scenes') : scene === '\u0000' ? t('空白场景', 'Blank scene') : scene; }
  function displayCreated(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return <div className="ai-tab">
    {!readOnly && <section className="ai-compose card" aria-label={t('生成 AI 进展汇报', 'Generate an AI progress report')}>
      <div className="ai-compose-heading"><div className="ai-title-icon"><Sparkles size={21}/></div><div><div className="ai-kicker">AI REPORT STUDIO</div><h2>{t('把数据，写成一份好汇报', 'Turn your data into a clear progress update')}</h2><p>{t('按当前筛选范围，一次生成中文与英文两版，适合每日发群同步。', 'Generate Chinese and English updates for the current filters, ready to share with your group.')}</p></div></div>
      <div className="ai-scope">
        <div className="ai-scope-period"><span>{t('本次分析范围', 'Report scope')}{facts?.demo && <b className="ai-demo-tag">{t('演示数据', 'DEMO')}</b>}</span><strong>{range.from || '—'}{range.to !== range.from ? ` — ${range.to || '—'}` : ''}</strong><small>{displayScene(range.scene)} · {range.days || 0} {t('天', range.days === 1 ? 'day' : 'days')}</small></div>
        <div className="ai-scope-stat"><strong>{Number(totals.uses || 0).toLocaleString()}</strong><span>{t('次使用', 'interactions')}</span></div>
        <div className="ai-scope-stat"><strong>{Number(totals.users || 0).toLocaleString()}</strong><span>{t('可识别活跃用户', 'identifiable active users')}</span></div>
        <div className="ai-scope-stat"><strong>{Number(totals.failures || 0).toLocaleString()}</strong><span>{t('次失败', 'Sorry responses')}</span></div>
        <button className="text-button" type="button" disabled={generating} onClick={onLatestDay}>{t('仅看最近有日志的一天', 'Use latest log day')}</button>
      </div>
      <div className="ai-data-note"><Info size={16}/><p>{t('AI 将收到统计摘要及有限的问题、失败记录、已填写原因和群反馈文字。截图不会发送。browser 的使用量保留，但人数未知；MML 不计自主提问，空回答正常。', 'AI receives summary metrics and a limited selection of questions, failures, saved causes and group feedback text. Screenshots are not sent. browser activity is counted but its people count is unknown; MML is excluded from custom questions and empty MML answers are normal.')}</p></div>
      <details className="ai-config" open={configOpen} onToggle={event => setConfigOpen(event.currentTarget.open)}>
        <summary><Settings2 size={16}/><strong>{t('AI 接口配置', 'AI connection')}</strong><span className={config.configured ? 'ai-config-status ready' : 'ai-config-status'}>{!configLoaded ? t('读取中…', 'Loading…') : config.configured ? t('已配置', 'Configured') : t('待配置', 'Not configured')}</span><ChevronDown size={15}/></summary>
        <form onSubmit={saveConfig}>
          <fieldset disabled={disabled || !configLoaded} className="ai-config-fields">
            <label className="ai-field ai-wide-field"><span>API Base URL</span><input aria-label="AI API Base URL" type="url" value={draftConfig.baseUrl} onChange={event => editConfig({ baseUrl: event.target.value })} required placeholder="https://api.openai.com/v1" autoComplete="off" spellCheck={false}/><small>{t('填写基础地址（如以 /v1 结尾）；系统会自动追加对应 API 路径。', 'Enter the base URL (for example, ending in /v1). The API path is added automatically.')}</small></label>
            <label className="ai-field"><span>{t('API 格式', 'API format')}</span><select aria-label={t('AI API 格式', 'AI API format')} value={draftConfig.apiFormat} onChange={event => editConfig({ apiFormat: event.target.value as AiConfig['apiFormat'] })}><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select></label>
            <label className="ai-field"><span>{t('模型名称', 'Model name')}</span><input aria-label={t('AI 模型名称', 'AI model name')} value={draftConfig.model} onChange={event => editConfig({ model: event.target.value })} required placeholder={t('填写接口支持的模型 ID', 'Enter a supported model ID')} maxLength={200} autoComplete="off" spellCheck={false}/></label>
            <label className="ai-field ai-wide-field"><span>API Key <em>{config.hasApiKey ? t('已保存在本地服务，留空保留', 'Saved on the local server; leave blank to keep') : t('由你配置', 'Configure your key')}</em></span><input aria-label="AI API Key" type="password" value={apiKey} onChange={event => editKey(event.target.value)} placeholder={config.hasApiKey ? t('输入新 Key 可替换已保存的 Key', 'Enter a new key to replace the saved key') : t('输入 API Key', 'Enter API Key')} autoComplete="new-password" spellCheck={false}/></label>
            <label className="ai-field"><span>{t('最大输出 Token 数', 'Maximum output tokens')}</span><input aria-label={t('AI 最大输出 Token 数', 'AI maximum output tokens')} type="number" min="256" max="65536" step="1" required value={draftConfig.maxOutputTokens} onChange={event => editConfig({ maxOutputTokens: Number(event.target.value) })}/></label>
            <label className="ai-field"><span>{t('请求超时（秒）', 'Timeout (seconds)')}</span><input aria-label={t('AI 请求超时', 'AI request timeout')} type="number" min="30" max="300" step="1" required value={draftConfig.timeoutSeconds} onChange={event => editConfig({ timeoutSeconds: Number(event.target.value) })}/></label>
            {config.hasApiKey && <label className="ai-clear-key ai-wide-field"><input type="checkbox" checked={clearApiKey} onChange={event => editClearKey(event.target.checked)}/>{t('保存时清除已保存的 API Key', 'Remove the saved API key when saving')}</label>}
          </fieldset>
          <div className="ai-config-test-note"><Info size={14}/><p>{clearApiKey ? t('清除 Key 时不调用 AI 接口。', 'Clearing the key does not call the AI endpoint.') : t('点击后仅向所选模型发送一条简短测试文本，不发送日志；通过后保存，失败保留原配置。', 'This sends one short test message to the selected model, without logs. The connection is saved only after the test passes; a failed test keeps your previous configuration.')}</p></div>
          <div className="ai-config-foot"><p>{t('Key 仅保存在运行服务的电脑，不写入浏览器存储、报表或备份。', 'The key stays on the server computer, outside browser storage, reports and backups.')}</p><button className="btn" type="submit" disabled={disabled || !configLoaded}>{saving ? <LoaderCircle size={14} className="spin"/> : <Check size={14}/>} {saving ? clearApiKey ? t('正在清除 Key…', 'Clearing key…') : t('正在测试连接…', 'Testing connection…') : clearApiKey ? t('清除 Key 并保存', 'Clear key & save') : t('测试连接并保存', 'Test & save')}</button></div>
        </form>
      </details>
      {connectionTest?.status === 'passed' && <div className="ai-connection-result passed" role="status"><Check size={15}/><div><strong>{t('连接测试通过，配置已保存。', 'Connection test passed. Configuration saved.')}</strong><p>{connectionTest.model} · {Number(connectionTest.latencyMs).toLocaleString()} ms · {displayCreated(connectionTest.testedAt)}</p></div></div>}
      {connectionTest?.status === 'skipped' && <div className="ai-connection-result" role="status"><Info size={15}/><div><strong>{t('API Key 已清除，未进行连接测试。', 'API key cleared. No connection test was run.')}</strong></div></div>}
      {configError && <div className="ai-error" role="alert"><strong>{configErrorSource === 'save' ? t('连接测试或保存失败', 'Connection test or save failed') : t('无法读取接口配置', 'Could not read the connection')}</strong><p>{configError}</p>{configErrorSource === 'save' && <small>{t('原配置已保留，请检查后重试。', 'Your previous configuration is preserved. Check the settings and try again.')}</small>}</div>}
      <details className="ai-instructions"><summary><FileText size={15}/>{t('补充汇报要求与查看提示词', 'Writing preferences and prompt preview')}</summary><label className="ai-field"><span>{t('补充要求（可选）', 'Additional instructions (optional)')}</span><textarea aria-label={t('AI 汇报补充要求', 'AI report additional instructions')} value={instructions} disabled={generating} onChange={event => setInstructions(event.target.value)} maxLength={4000} rows={3} placeholder={t('例如：控制在 3 分钟可读完，重点介绍客户自主提问和下一步改进。', 'For example: keep it brief and focus on custom questions and next actions.')}/></label><div className="ai-preview-actions"><p>{t('提示词会统一约束统计口径，不编造收益或失败原因。预览不调用模型。', 'The prompt enforces consistent metrics and avoids invented benefits or failure causes. Preview does not call the model.')}</p><button className="btn" type="button" disabled={previewPending || generating} onClick={previewPrompt}>{previewPending && <LoaderCircle size={13} className="spin"/>}{t('预览完整提示词', 'Preview full prompt')}</button></div>{previewError && <p className="ai-error" role="alert">{previewError}</p>}{preview && <div className="ai-prompt-preview"><h3>SYSTEM</h3><pre>{preview.system}</pre><h3>USER · {t('汇报要求与数据', 'Report request and data')}</h3><pre>{preview.user}</pre></div>}</details>
      <div className="ai-generate-row"><p aria-live="polite">{generating ? t('AI 正在分析并生成两版汇报，请稍候…', 'AI is analysing the data and writing both versions…') : configDirty ? t('配置有修改，请先保存后再生成。', 'Save your connection changes before generating.') : !config.configured ? t('先配置 API 地址、模型和 Key，即可生成汇报。', 'Configure the API URL, model and key to generate a report.') : t('点击后，将以上范围的数据发送到你配置的 AI 接口。', 'Click to send data for the scope above to your configured AI endpoint.')}</p><button className="btn primary ai-generate" type="button" disabled={!configLoaded || !config.configured || configDirty || disabled} onClick={generate}>{generating ? <LoaderCircle size={16} className="spin"/> : <Sparkles size={16}/>} {generating ? t('正在生成…', 'Generating…') : t('生成中英文汇报', 'Generate Chinese & English')}</button></div>
      {generationError && <div className="ai-error" role="alert"><strong>{t('生成失败', 'Generation failed')}</strong><p>{generationError}</p><small>{t('之前的汇报已保留，可检查配置后重试。', 'Your previous report is preserved. Check the connection and try again.')}</small></div>}
    </section>}
    <section className="ai-results" aria-label={t('AI 汇报结果', 'AI report results')}>
      <div className="ai-results-heading"><div><h2><History size={17}/>{t('汇报草稿', 'Report drafts')}</h2><p>{readOnly ? t('离线报表中的已保存汇报，可直接复制或下载。', 'Saved reports in this offline file can be copied or downloaded.') : t('生成结果会保存，可随时查看和复用。核对后再发到群里。', 'Generated reports are saved for later use. Review the draft before sharing.')}</p></div>{selected && <button className="btn" type="button" onClick={() => window.print()}><Printer size={14}/>{t('打印 / PDF', 'Print / PDF')}</button>}</div>
      {!!reports.length && <div className="ai-history-bar"><label><span>{t('历史汇报', 'Saved report')}</span><select aria-label={t('选择历史 AI 汇报', 'Select a saved AI report')} value={selectedId} onChange={event => { setSelectedId(event.target.value); setCopied(''); }}>{reports.map(report => <option value={report.id} key={report.id}>{displayCreated(report.createdAt)} · {report.from}{report.to !== report.from ? ` — ${report.to}` : ''} · {report.demo ? t('演示', 'Demo') : displayScene(report.scene)}</option>)}</select></label><span>{t(`已显示 ${reports.length} / ${reportTotal} 份`, `${reports.length} of ${reportTotal} shown`)}</span>{!readOnly && reports.length < reportTotal && <button type="button" className="text-button" disabled={historyPending || generating} onClick={loadHistory}>{historyPending && <LoaderCircle size={12} className="spin"/>}{t('加载更早汇报', 'Load earlier reports')}</button>}</div>}
      {selected ? <><div className="ai-report-meta"><span>{t('分析期间', 'Reporting period')} · {selected.from}{selected.to !== selected.from ? ` — ${selected.to}` : ''}</span><span>{displayScene(selected.scene)}</span><span>{selected.model}</span><span>{displayCreated(selected.createdAt)}</span>{selected.demo && <b className="ai-demo-tag">{t('演示数据', 'DEMO')}</b>}</div><div className="ai-report-grid">{(['zh', 'en'] as Language[]).map(reportLang => <article className="ai-report-card" key={reportLang} lang={reportLang === 'zh' ? 'zh-CN' : 'en'}><div className="ai-report-card-top"><span className="ai-language-tag">{reportLang === 'zh' ? '中文' : 'ENGLISH'}</span><span>{t('AI 生成草稿', 'AI-generated draft')}</span></div><ReportBody text={selected[reportLang]}/><div className="ai-report-card-actions"><button className="btn primary" type="button" onClick={() => copyReport(reportLang)}>{copied === reportLang ? <Check size={14}/> : <Clipboard size={14}/>} {copied === reportLang ? t('已复制', 'Copied') : t('复制正文', 'Copy text')}</button><button className="btn" type="button" onClick={() => exportReport(reportLang, false)}><Download size={14}/>.txt</button><button className="text-button" type="button" onClick={() => exportReport(reportLang, true)}>.md</button></div></article>)}</div></> : <div className="ai-empty card"><div><FileText size={30}/></div><h3>{t('第一份项目汇报，从这里开始', 'Your first progress report starts here')}</h3><p>{readOnly ? t('这份离线文件中还没有保存 AI 汇报。', 'There are no saved AI reports in this offline file.') : t('配置好接口后，点击生成。中文与英文会并排展示，复制即可分享。', 'Configure your connection and generate a report. Chinese and English versions appear side by side, ready to copy and share.')}</p></div>}
    </section>
  </div>;
}
