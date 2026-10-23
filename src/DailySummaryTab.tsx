import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CalendarDays, Check, Clipboard, Download, FileText, Info, Pencil, Plus, Printer, Save, Search, Trash2, Upload, X } from 'lucide-react';
import type { DailySummary } from '../lib/daily-summary.ts';
import './daily-summary.css';

type Language = 'zh' | 'en';
export type DailySummaryTabProps = {
  lang: Language;
  summaries: DailySummary[];
  readOnly: boolean;
  onSaved: (summary: DailySummary) => void;
  onDeleted: (date: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  notify: (message: string) => void;
};
type Draft = { date: string; title: string; zh: string; en: string; expectedUpdatedAt: string | null };

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function inlineText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => part.startsWith('**') && part.endsWith('**')
    ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part);
}
/** Deliberately render only a text-based Markdown subset. Imported HTML and URLs never execute. */
function SummaryBody({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [], items: string[] = [], ordered = false, quote: string[] = [];
  function flushParagraph() { if (paragraph.length) { blocks.push(<p key={blocks.length}>{inlineText(paragraph.join('\n'))}</p>); paragraph = []; } }
  function flushList() { if (items.length) { const nodes = items.map((item, index) => <li key={index}>{inlineText(item)}</li>); blocks.push(ordered ? <ol key={blocks.length}>{nodes}</ol> : <ul key={blocks.length}>{nodes}</ul>); items = []; } }
  function flushQuote() { if (quote.length) { blocks.push(<blockquote key={blocks.length}>{inlineText(quote.join('\n'))}</blockquote>); quote = []; } }
  function flush() { flushParagraph(); flushList(); flushQuote(); }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const item = /^\s*(?:([-*])|\d+[.)])\s+(.+)$/.exec(line);
    const quoted = /^>\s?(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) { flush(); blocks.push(<h3 key={blocks.length}>{inlineText(heading[1])}</h3>); }
    else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { flush(); blocks.push(<hr key={blocks.length}/>); }
    else if (item) { flushParagraph(); flushQuote(); const nextOrdered = !item[1]; if (items.length && ordered !== nextOrdered) flushList(); ordered = nextOrdered; items.push(item[2]); }
    else if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); }
    else { flushList(); flushQuote(); paragraph.push(line); }
  }
  flush();
  return <div className="daily-summary-prose">{blocks}</div>;
}
function plainText(text: string) {
  return text.trim().replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^[-*]\s+/gm, '• ');
}
async function copyText(text: string) {
  if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP fallback below. */ } }
  const active = document.activeElement as HTMLElement | null;
  const field = document.createElement('textarea');
  field.value = text; field.readOnly = true; field.style.cssText = 'position:fixed;left:-10000px;opacity:0';
  document.body.appendChild(field); field.select(); field.setSelectionRange(0, field.value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } finally { field.remove(); active?.focus(); }
  if (!copied) throw new Error('Clipboard unavailable');
}
function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function request(url: string, options: RequestInit) {
  const response = await fetch(url, options);
  let result;
  try { result = await response.json(); } catch { throw new Error(`HTTP ${response.status}`); }
  if (!response.ok) { const error = new Error(result.error || `HTTP ${response.status}`) as Error & { status: number }; error.status = response.status; throw error; }
  return result;
}

export default function DailySummaryTab({ lang, summaries = [], readOnly, onSaved, onDeleted, onDirtyChange, notify }: DailySummaryTabProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const ordered = useMemo(() => [...summaries].sort((a, b) => b.date.localeCompare(a.date)), [summaries]);
  const [selectedDate, setSelectedDate] = useState('');
  const [reportLang, setReportLang] = useState<Language>(lang);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [original, setOriginal] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), importLanguage = useRef<Language>('zh'), editorSession = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const dirty = !!draft && JSON.stringify(draft) !== original;
  const selected = ordered.find(item => item.date === selectedDate) || ordered[0] || null;
  const shown = ordered.filter(item => `${item.date} ${item.title} ${item.zh} ${item.en}`.toLowerCase().includes(query.trim().toLowerCase()));
  const content = selected?.[reportLang] || '';
  useEffect(() => { setReportLang(lang); }, [lang]);
  useEffect(() => { dirtyCallback.current?.(dirty); }, [dirty]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; dirtyCallback.current?.(false); }; }, []);
  useEffect(() => { setCopied(false); }, [selected?.date, selected?.updatedAt, reportLang]);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function mayLeave() { return !dirty || window.confirm(t('当前修改尚未保存，放弃修改并继续？', 'You have unsaved changes. Discard them and continue?')); }
  function clearEditor() { editorSession.current++; setDraft(null); setOriginal(''); setError(''); setImporting(false); }
  function select(date: string) { if (saving || !mayLeave()) return; clearEditor(); setSelectedDate(date); }
  function openEditor(item: DailySummary | null) {
    if (readOnly || saving || !mayLeave()) return;
    editorSession.current++;
    setImporting(false);
    const next: Draft = item ? { date: item.date, title: item.title, zh: item.zh, en: item.en, expectedUpdatedAt: item.updatedAt }
      : { date: today(), title: '', zh: '', en: '', expectedUpdatedAt: null };
    setDraft(next); setOriginal(JSON.stringify(next)); setError('');
  }
  function change(field: 'date' | 'title' | Language, value: string) { setDraft(previous => previous ? { ...previous, [field]: value } : previous); setError(''); }
  async function importFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0], language = importLanguage.current, session = editorSession.current;
    event.target.value = '';
    if (!file || !draft || readOnly || saving || importing) return;
    if (!/\.(md|txt)$/i.test(file.name) || file.size > 1024 * 1024) { setError(t('请选择 1 MB 以内的 .md 或 .txt 文件。', 'Choose an .md or .txt file no larger than 1 MB.')); return; }
    setImporting(true);
    try {
      const text = (await file.text()).replace(/^\uFEFF/, '');
      if (!mounted.current || session !== editorSession.current) return;
      if (text.length > 100000) { setError(t('正文最多 100,000 字符，请精简后导入。', 'Each report body can contain at most 100,000 characters.')); return; }
      setDraft(previous => previous ? { ...previous, [language]: text } : previous); setError('');
    } catch { if (mounted.current && session === editorSession.current) setError(t('文件读取失败，请重试或直接粘贴正文。', 'The file could not be read. Try again or paste the text.')); }
    finally { if (mounted.current && session === editorSession.current) setImporting(false); }
  }
  async function save() {
    if (!draft || readOnly || saving || importing) return;
    if (!draft.date || (!draft.zh.trim() && !draft.en.trim())) { setError(t('请选择日期，并至少填写一种语言的正文。', 'Choose a date and add the report in at least one language.')); return; }
    if (draft.expectedUpdatedAt === null && summaries.some(item => item.date === draft.date)) { setError(t('该日期已有总结，请在左侧选中后点击“编辑”，避免覆盖。', 'A summary already exists for this date. Select it and choose Edit.')); return; }
    setSaving(true); setError('');
    try {
      const result = await request('/api/daily-summaries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      onSaved(result.summary);
      if (!mounted.current) return;
      dirtyCallback.current?.(false);
      setSelectedDate(result.summary.date); setReportLang(lang); clearEditor();
      notify(t('每日总结已保存，领导可在网页直接查看。', 'Daily summary saved and ready to read on the dashboard.'));
    } catch (cause) {
      if (!mounted.current) return;
      setError((cause as Error & { status?: number }).status === 409
        ? t('这份总结已被更新，或该日期已有总结。你的草稿仍保留，请另存正文后刷新核对。', 'This summary changed, or its date is already in use. Your draft is retained. Copy it somewhere safe, then refresh to review.')
        : (cause instanceof Error ? cause.message : String(cause)));
    } finally { if (mounted.current) setSaving(false); }
  }
  async function remove() {
    if (!selected || readOnly || saving || !window.confirm(t(`删除 ${selected.date} 的每日总结？此操作无法撤销。`, `Delete the daily summary for ${selected.date}? This cannot be undone.`))) return;
    setSaving(true);
    try {
      await request(`/api/daily-summaries?date=${encodeURIComponent(selected.date)}&expectedUpdatedAt=${encodeURIComponent(selected.updatedAt)}`, { method: 'DELETE' });
      onDeleted(selected.date); if (!mounted.current) return; setSelectedDate(''); notify(t('每日总结已删除。', 'Daily summary deleted.'));
    } catch (cause) { if (mounted.current) notify((cause as Error & { status?: number }).status === 409 ? t('该总结已被更新，请刷新后核对。', 'This summary changed. Refresh and review it first.') : (cause instanceof Error ? cause.message : String(cause))); }
    finally { if (mounted.current) setSaving(false); }
  }
  async function copy() {
    if (!content) return;
    try { await copyText(plainText(content)); if (!mounted.current) return; setCopied(true); if (copiedTimer.current) clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 2200); notify(t('总结正文已复制。', 'Summary text copied.')); }
    catch { if (mounted.current) notify(t('无法自动复制，请选中正文手动复制。', 'Automatic copy is unavailable. Select and copy the text manually.')); }
  }
  function updated(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

  return <section className="daily-summary-workspace" aria-label={t('每日总结', 'Daily summaries')}>
    <div className="daily-summary-toolbar"><div><FileText size={18}/><span>{t(`已保存 ${ordered.length} 份每日总结`, `${ordered.length} saved daily ${ordered.length === 1 ? 'summary' : 'summaries'}`)}</span>{ordered[0] && <small>{t('最新总结', 'Latest report')} · {ordered[0].date}</small>}</div>{!readOnly && <button type="button" className="btn primary" disabled={saving} onClick={() => openEditor(null)}><Plus size={15}/>{t('新增总结', 'Add summary')}</button>}</div>
    {readOnly && <div className="daily-summary-offline"><Info size={15}/>{t('离线快照包含导出时已保存的总结，可阅读、复制、下载和打印。', 'This offline snapshot includes summaries saved at export time. Read, copy, download or print them here.')}</div>}
    <div className="daily-summary-layout">
      <aside className="daily-summary-archive card" aria-label={t('每日总结历史', 'Daily summary archive')}><div className="daily-summary-archive-title"><h2>{t('进展档案', 'Progress archive')}</h2><span>{t('按日期查看', 'By date')}</span></div><label className="daily-summary-search"><Search size={14}/><input aria-label={t('搜索每日总结', 'Search daily summaries')} placeholder={t('搜索日期或内容', 'Search date or content')} value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" onClick={() => setQuery('')} aria-label={t('清除总结搜索', 'Clear summary search')}><X size={13}/></button>}</label><div className="daily-summary-date-list">{shown.map(item => <button className={selected?.date === item.date ? 'selected' : ''} aria-pressed={selected?.date === item.date} disabled={saving} type="button" key={item.date} onClick={() => select(item.date)}><span className="daily-summary-date"><CalendarDays size={14}/>{item.date}</span><strong>{item.title || t('项目每日总结', 'Daily project summary')}</strong><span className="daily-summary-available">{item.zh.trim() && <small>中文</small>}{item.en.trim() && <small>EN</small>}</span></button>)}{!shown.length && <p className="daily-summary-list-empty">{query ? t('没有匹配的总结', 'No matching summaries') : t('保存后会在这里按日期归档', 'Saved reports will appear here by date')}</p>}</div></aside>
      {draft && !readOnly ? <section className="daily-summary-editor card" aria-label={t('编辑每日总结', 'Edit daily summary')}>
        <div className="daily-summary-editor-heading"><div><span className="daily-summary-kicker">DAILY UPDATE</span><h2>{draft.expectedUpdatedAt ? t('编辑已保存的总结', 'Edit saved summary') : t('保存一份每日总结', 'Save a daily summary')}</h2><p>{t('粘贴生成后的中英文内容，或分别导入 Markdown / 文本文件。', 'Paste the Chinese and English reports, or import Markdown / text files.')}</p></div><button className="icon-button" type="button" disabled={saving} onClick={() => { if (mayLeave()) clearEditor(); }} aria-label={t('关闭总结编辑', 'Close summary editor')}><X size={18}/></button></div>
        <div className="daily-summary-form-meta"><label><span>{t('总结日期', 'Report date')}</span><input aria-label={t('总结日期', 'Report date')} type="date" required value={draft.date} disabled={saving || draft.expectedUpdatedAt !== null} onInput={event => change('date', event.currentTarget.value)} onChange={event => change('date', event.target.value)}/></label><label><span>{t('标题', 'Title')} <small>{t('可选', 'optional')}</small></span><input aria-label={t('总结标题', 'Summary title')} value={draft.title} disabled={saving} maxLength={200} onChange={event => change('title', event.target.value)} placeholder={t('例如：客户试点进展', 'For example: Customer pilot progress')}/></label></div>
        <input ref={fileInput} type="file" accept=".md,.txt,text/markdown,text/plain" hidden onChange={importFile}/>
        <div className="daily-summary-editor-bodies">{(['zh', 'en'] as Language[]).map(language => <label className="daily-summary-editor-language" key={language}><span className="daily-summary-editor-label"><b>{language === 'zh' ? t('中文总结', 'Chinese report') : t('英文总结', 'English report')}</b><button className="text-button" type="button" aria-label={language === 'zh' ? t('导入中文总结文件', 'Import Chinese report file') : t('导入英文总结文件', 'Import English report file')} disabled={saving || importing} onClick={event => { event.preventDefault(); importLanguage.current = language; fileInput.current?.click(); }}><Upload size={13}/>{t('导入 .md / .txt', 'Import .md / .txt')}</button></span><textarea aria-label={language === 'zh' ? t('中文总结正文', 'Chinese summary body') : t('英文总结正文', 'English summary body')} rows={17} maxLength={100000} disabled={saving} value={draft[language]} onChange={event => change(language, event.target.value)} placeholder={language === 'zh' ? t('将中文总结粘贴到这里，支持标题、段落和列表。', 'Paste the Chinese report here. Headings, paragraphs and lists are supported.') : t('将英文总结粘贴到这里，支持标题、段落和列表。', 'Paste the English report here. Headings, paragraphs and lists are supported.')}/><small>{draft[language].length.toLocaleString()} / 100,000</small></label>)}</div>
        {error && <p className="daily-summary-error" role="alert">{error}</p>}
        <div className="daily-summary-editor-actions"><p>{t('同一日期保留一份总结，至少填写一种语言。保存后可随时编辑。', 'One summary per date. Add at least one language; you can edit it later.')}{dirty && <span>{t('有未保存的修改', 'Unsaved changes')}</span>}</p><div><button className="btn" type="button" disabled={saving} onClick={() => { if (mayLeave()) clearEditor(); }}>{t('取消', 'Cancel')}</button><button className="btn primary" type="button" disabled={saving || importing} onClick={save}><Save size={15}/>{importing ? t('读取文件中…', 'Reading file…') : saving ? t('保存中…', 'Saving…') : t('保存总结', 'Save summary')}</button></div></div>
      </section> : selected ? <article className="daily-summary-reader card" aria-label={t('已保存的每日总结', 'Saved daily summary')} lang={reportLang === 'zh' ? 'zh-CN' : 'en'}>
        <div className="daily-summary-reader-top"><div><span className="daily-summary-kicker">FMEMATE / DAILY UPDATE</span><div className="daily-summary-report-date"><CalendarDays size={15}/>{selected.date}</div><h2>{selected.title || (reportLang === 'zh' ? '项目每日总结' : 'Daily project summary')}</h2><p>{t('保存于', 'Saved')} {updated(selected.updatedAt)}</p></div>{!readOnly && <div className="daily-summary-manage"><button type="button" className="btn" disabled={saving} onClick={() => openEditor(selected)}><Pencil size={14}/>{t('编辑', 'Edit')}</button><button type="button" className="icon-button daily-summary-delete" disabled={saving} onClick={remove} aria-label={t('删除当前总结', 'Delete selected summary')}><Trash2 size={15}/></button></div>}</div>
        <div className="daily-summary-reading-tools"><div className="daily-summary-language-tabs" role="tablist" aria-label={t('总结语言', 'Summary language')}>{(['zh', 'en'] as Language[]).map(language => <button type="button" role="tab" aria-selected={reportLang === language} key={language} onClick={() => setReportLang(language)}>{language === 'zh' ? '中文' : 'English'}{!selected[language].trim() && <small>{t('未添加', 'Missing')}</small>}</button>)}</div><div className="daily-summary-actions"><button className="btn" type="button" disabled={!content} onClick={copy}>{copied ? <Check size={14}/> : <Clipboard size={14}/>} {copied ? t('已复制', 'Copied') : t('复制正文', 'Copy text')}</button><button className="btn" type="button" disabled={!content} onClick={() => download(content, `FMEMate_Daily_Summary_${selected.date}_${reportLang}.md`)}><Download size={14}/>.md</button><button className="btn" type="button" disabled={!content} onClick={() => window.print()}><Printer size={14}/>{t('打印 / PDF', 'Print / PDF')}</button></div></div>
        <div className="daily-summary-print-language">{reportLang === 'zh' ? '中文总结' : 'English summary'}</div>
        {content.trim() ? <SummaryBody text={content}/> : <div className="daily-summary-missing"><FileText size={26}/><h3>{reportLang === 'zh' ? '尚未添加中文总结' : 'No English report has been added'}</h3><p>{t('可切换到另一种语言查看已有内容。', 'Switch to the other language to read the available report.')}</p>{!readOnly && <button type="button" className="btn" onClick={() => openEditor(selected)}><Pencil size={14}/>{t('补充总结', 'Add report text')}</button>}</div>}
      </article> : <div className="daily-summary-empty card"><div><FileText size={34}/></div><span className="daily-summary-kicker">YOUR PROGRESS, SAVED</span><h2>{t('把每日进展，留在这里。', 'Keep a record of every day’s progress.')}</h2><p>{readOnly ? t('此快照还没有保存的每日总结。', 'This snapshot has no saved daily summaries yet.') : t('将生成好的总结粘贴或导入，保存后领导就能直接在网页查看。', 'Paste or import your finished reports. Once saved, leaders can read them directly on this dashboard.')}</p>{!readOnly && <button className="btn primary" type="button" onClick={() => openEditor(null)}><Plus size={15}/>{t('新增第一份总结', 'Add your first summary')}</button>}</div>}
    </div>
  </section>;
}
