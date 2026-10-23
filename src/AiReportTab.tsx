import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Clipboard, Download, FileText, FolderOpen, History, Info, Printer, Sparkles } from 'lucide-react';
import type { AiFacts, AiReport } from '../lib/ai-reporting.ts';
import { buildAiReportPrompt, aiPromptFilename } from '../lib/report-prompt.ts';
import './ai-report.css';

type Language = 'zh' | 'en';
export type AiReportTabProps = {
  lang: Language; facts: AiFacts; readOnly: boolean; savedReports: AiReport[]; savedReportsTotal: number;
  onReportSaved: (report: AiReport) => void; notify: (message: string) => void; onLatestDay: () => void;
};

/** Group messages use readable text, without Markdown heading/bold markers. */
export function reportPlainText(text: string): string {
  return text.trim().replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^[-*]\s+/gm, '• ');
}
function boldText(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => part.startsWith('**') && part.endsWith('**')
    ? <strong key={index}>{part.slice(2, -2)}</strong> : part);
}
/** A text-only Markdown subset for previously saved drafts; HTML stays escaped. */
function ReportBody({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [], items: string[] = [];
  let ordered = false;
  const flushParagraph = () => { if (paragraph.length) { blocks.push(<p key={blocks.length}>{boldText(paragraph.join('\n'))}</p>); paragraph = []; } };
  const flushList = () => {
    if (!items.length) return;
    const content = items.map((item, index) => <li key={index}>{boldText(item)}</li>);
    blocks.push(ordered ? <ol key={blocks.length}>{content}</ol> : <ul key={blocks.length}>{content}</ul>); items = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
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
    try { await navigator.clipboard.writeText(text); return; } catch { /* Local HTTP may need the legacy clipboard path. */ }
  }
  const active = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text; field.setAttribute('readonly', ''); field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
  document.body.appendChild(field); field.select(); field.setSelectionRange(0, field.value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } finally { field.remove(); active?.focus(); }
  if (!copied) throw new Error('Clipboard unavailable');
}
function downloadText(text: string, filename: string, markdown = false) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: `${markdown ? 'text/markdown' : 'text/plain'};charset=utf-8` }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt creation is entirely local and also works in an exported offline report. */
export default function AiReportTab({ lang, facts, readOnly, savedReports = [], savedReportsTotal = 0, notify, onLatestDay }: AiReportTabProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [instructions, setInstructions] = useState('');
  const [generated, setGenerated] = useState<{ signature: string; text: string; filename: string } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(savedReports[0]?.id || '');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const signature = useMemo(() => JSON.stringify(facts) + '\u0000' + instructions, [facts, instructions]);
  // An old prompt cannot be copied or downloaded after its filters or preferences change.
  const prompt = generated?.signature === signature ? generated : null;
  const selected = savedReports.find(report => report.id === selectedId) || savedReports[0] || null;
  const totals = facts.totals, range = facts.range;
  const filename = prompt?.filename || aiPromptFilename(facts);
  const command = t(`请读取 ${filename}，按要求生成中英文汇报。`, `Read ${filename} and generate the Chinese and English reports as instructed.`);
  const outputStem = `reports/FMEMate_Progress_${range.from}_${range.to}`;
  useEffect(() => { setCopied(''); setError(''); }, [signature]);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  function generatePrompt() {
    try {
      setGenerated({ signature, text: buildAiReportPrompt(facts, instructions), filename: aiPromptFilename(facts) });
      setCopied(''); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function copy(text: string, key: string) {
    try {
      await copyText(text); setCopied(key);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(''), 2200);
      notify(key === 'command' ? t('指令已复制，可粘贴到本地 AI 工具。', 'Command copied. Paste it into your local AI tool.') : key === 'prompt' ? t('完整提示词已复制，可粘贴到本地 AI 工具。', 'Full prompt copied. Paste it into your local AI tool.') : t('汇报正文已复制。', 'Report text copied.'));
    } catch { notify(t('无法自动复制，请选中文本手动复制。', 'Automatic copy is unavailable. Select and copy the text manually.')); }
  }
  function displayScene(scene: string) { return !scene ? t('全部场景', 'All scenes') : scene === '\u0000' ? t('空白场景', 'Blank scene') : scene; }
  function displayCreated(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function exportSaved(reportLang: Language, markdown: boolean) {
    if (!selected) return;
    const period = selected.from === selected.to ? selected.from : `${selected.from}_${selected.to}`;
    downloadText(markdown ? selected[reportLang] : reportPlainText(selected[reportLang]), `FMEMate_Progress_${period}_${reportLang}.${markdown ? 'md' : 'txt'}`, markdown);
  }

  return <div className="ai-tab">
    <section className="ai-prompt-workbench card" aria-label={t('AI 总结提示词', 'AI summary prompt')}>
      <div className="ai-compose-heading"><div className="ai-title-icon"><FileText size={22}/></div><div><div className="ai-kicker">AI SUMMARY WORKSPACE</div><h2>{t('准备数据，用本地 AI 工具生成总结', 'Prepare your data for a summary in your local AI tool')}</h2><p>{t('网页整理统计口径与提示词，你在项目根目录打开本地 AI 工具后生成中英文汇报。', 'This page prepares the facts and prompt. Open your local AI tool in the project root to write both report versions.')}</p></div></div>
      <div className="ai-scope">
        <div className="ai-scope-period"><span>{t('提示词的数据范围', 'Data included in the prompt')}{facts.demo && <b className="ai-demo-tag">{t('演示数据', 'DEMO')}</b>}</span><strong>{range.from || '—'}{range.to !== range.from ? ` — ${range.to || '—'}` : ''}</strong><small>{displayScene(range.scene)} · {range.days || 0} {t('天', range.days === 1 ? 'day' : 'days')}</small></div>
        <div className="ai-scope-stat"><strong>{totals.uses.toLocaleString()}</strong><span>{t('次使用', 'interactions')}</span></div>
        <div className="ai-scope-stat"><strong>{totals.users.toLocaleString()}</strong><span>{t('可识别活跃用户', 'identifiable active users')}</span></div>
        <div className="ai-scope-stat"><strong>{totals.failures.toLocaleString()}</strong><span>{t('次失败', 'Sorry responses')}</span></div>
        <button className="text-button" type="button" onClick={onLatestDay}>{t('仅看最近有日志的一天', 'Use latest log day')}</button>
      </div>
      {readOnly && <div className="ai-offline-note"><Info size={15}/><p>{t(`当前使用离线文件中的 ${range.from} 至 ${range.to} 数据，仍可在此生成、复制和下载提示词。`, `This uses the offline snapshot for ${range.from} to ${range.to}. You can still generate, copy and download the prompt here.`)}</p></div>}
      <div className="ai-data-note"><Info size={16}/><p>{t('提示词包含统计摘要及有限的问题、失败记录、已填原因和群反馈文字，不含截图。browser 保留使用次数但实际人数未知；MML 不计自主提问，空回答正常。', 'The prompt includes summary metrics and a limited selection of questions, failures, saved causes and group feedback text. Screenshots are excluded. browser activity is counted, but its actual people count is unknown; MML is excluded from custom questions and empty MML answers are normal.')}</p></div>
      <label className="ai-writing-field"><span>{t('补充汇报要求', 'Writing preferences')} <em>{t('可选', 'optional')}</em></span><textarea aria-label={t('AI 总结补充要求', 'AI summary writing preferences')} value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={4000} rows={3} placeholder={t('例如：适合在项目群里直接发，重点写客户自主提问、失败排查与下一步动作。', 'For example: keep it suitable for a project group and focus on custom questions, failure investigations and next actions.')}/></label>
      <div className="ai-generate-row"><p>{t('生成过程在浏览器内完成，无需配置 API 或 API Key。', 'The prompt is generated in your browser. No API or API key is needed.')}</p><button className="btn primary ai-generate" type="button" onClick={generatePrompt}><Sparkles size={16}/>{t('生成 AI 总结提示词', 'Generate AI summary prompt')}</button></div>
      {error && <p className="ai-error" role="alert">{error}</p>}
      {generated && !prompt && <p className="ai-stale-note" role="status">{t('筛选范围或补充要求已变化，请重新生成提示词。', 'Your filters or preferences changed. Generate the prompt again.')}</p>}
      {prompt && <section className="ai-prompt-result" aria-label={t('已生成的 AI 总结提示词', 'Generated AI summary prompt')}>
        <div className="ai-prompt-result-head"><div><span className="ai-kicker">READY FOR YOUR AI TOOL</span><h3>{t('提示词已准备好', 'Your prompt is ready')}</h3><p>{t('包含中英文写作要求、统计规则与本次数据。', 'Includes bilingual writing instructions, metric definitions and the selected data.')}</p></div><div className="ai-prompt-actions"><button className="btn primary" type="button" onClick={() => copy(prompt.text, 'prompt')}>{copied === 'prompt' ? <Check size={14}/> : <Clipboard size={14}/>} {copied === 'prompt' ? t('已复制', 'Copied') : t('复制完整提示词', 'Copy full prompt')}</button><button className="btn" type="button" onClick={() => downloadText(prompt.text, prompt.filename, true)}><Download size={14}/>{t('下载 .md', 'Download .md')}</button></div></div>
        <textarea className="ai-full-prompt" aria-label={t('完整 AI 总结提示词', 'Full AI summary prompt')} value={prompt.text} readOnly rows={16} spellCheck={false}/>
        <div className="ai-claude-workflow"><div className="ai-workflow-title"><FolderOpen size={17}/><h3>{t('在项目根目录交给本地 AI 工具', 'Use your local AI tool from the project root')}</h3></div><ol><li>{t('下载上面的 .md 文件，放到 FMEMateDashBoard 项目根目录。', 'Download the .md file above and place it in the FMEMateDashBoard project root.')}<code>{prompt.filename}</code></li><li>{t('在该目录打开本地 AI 工具，粘贴下面的指令；也可直接粘贴完整提示词。', 'Open your local AI tool in that directory and paste the command below, or paste the full prompt directly.')}</li><li>{t('提示词要求 AI 生成两份 Markdown 汇报文件，核对后复制正文发群。', 'The prompt asks your AI tool to produce two Markdown reports. Review them, then copy the text into your group.')}<code>{outputStem}_zh.md</code><code>{outputStem}_en.md</code></li></ol><div className="ai-claude-command"><pre>{command}</pre><button className="btn" type="button" onClick={() => copy(command, 'command')}>{copied === 'command' ? <Check size={14}/> : <Clipboard size={14}/>} {copied === 'command' ? t('已复制', 'Copied') : t('复制指令', 'Copy command')}</button></div><p className="ai-workflow-note">{t('本地生成汇报后，回到「每日总结」导入中英文文件或粘贴正文，保存后即可在网页展示。', 'After generating the reports locally, import both language files or paste the text into Daily summaries. Save to make them available on this website.')}</p></div>
      </section>}
    </section>
    {savedReports.length > 0 && <details className="ai-legacy-reports" open={legacyOpen} onToggle={event => setLegacyOpen(event.currentTarget.open)}><summary><History size={17}/><div><strong>{t('查看之前保存的汇报', 'Previously saved reports')}</strong><p>{t(`保留已有的 ${savedReportsTotal || savedReports.length} 份汇报草稿`, `${savedReportsTotal || savedReports.length} existing report drafts are retained`)}</p></div><ChevronDown size={16}/></summary><section className="ai-results" aria-label={t('历史 AI 汇报草稿', 'Previously saved AI report drafts')}>
      <div className="ai-results-heading"><p>{t('以下为之前保存的草稿，与当前生成的 AI 总结提示词分开保留。', 'These are previously saved drafts, retained separately from the current AI summary prompt.')}</p><button className="btn" type="button" onClick={() => window.print()}><Printer size={14}/>{t('打印 / PDF', 'Print / PDF')}</button></div>
      <div className="ai-history-bar"><label><span>{t('历史汇报', 'Saved report')}</span><select aria-label={t('选择历史 AI 汇报', 'Select a saved AI report')} value={selected?.id || ''} onChange={event => { setSelectedId(event.target.value); setCopied(''); }}>{savedReports.map(report => <option value={report.id} key={report.id}>{displayCreated(report.createdAt)} · {report.from}{report.to !== report.from ? ` — ${report.to}` : ''} · {report.demo ? t('演示', 'Demo') : displayScene(report.scene)}</option>)}</select></label><span>{t(`此处保留最近 ${savedReports.length} 份`, `Latest ${savedReports.length} available here`)}</span></div>
      {selected && <><div className="ai-report-meta"><span>{t('分析期间', 'Reporting period')} · {selected.from}{selected.to !== selected.from ? ` — ${selected.to}` : ''}</span><span>{displayScene(selected.scene)}</span><span>{selected.model}</span><span>{displayCreated(selected.createdAt)}</span>{selected.demo && <b className="ai-demo-tag">{t('演示数据', 'DEMO')}</b>}</div><div className="ai-report-grid">{(['zh', 'en'] as Language[]).map(reportLang => <article className="ai-report-card" key={reportLang} lang={reportLang === 'zh' ? 'zh-CN' : 'en'}><div className="ai-report-card-top"><span className="ai-language-tag">{reportLang === 'zh' ? '中文' : 'ENGLISH'}</span><span>{t('已保存草稿', 'Saved draft')}</span></div><ReportBody text={selected[reportLang]}/><div className="ai-report-card-actions"><button className="btn primary" type="button" onClick={() => copy(reportPlainText(selected[reportLang]), reportLang)}>{copied === reportLang ? <Check size={14}/> : <Clipboard size={14}/>} {copied === reportLang ? t('已复制', 'Copied') : t('复制正文', 'Copy text')}</button><button className="btn" type="button" onClick={() => exportSaved(reportLang, false)}><Download size={14}/>.txt</button><button className="text-button" type="button" onClick={() => exportSaved(reportLang, true)}>.md</button></div></article>)}</div></>}
    </section></details>}
  </div>;
}
