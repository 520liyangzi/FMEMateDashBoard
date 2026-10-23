import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, CalendarDays, ImagePlus, MessageSquareQuote, Plus, Trash2, Users, X, ZoomIn } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import './Community.css';

export type GroupSnapshot = { date: string; count: number };
export type CommunityFeedback = { id: string; date: string; author: string; text: string; imageUrl?: string };
export type CommunityProps = {
  lang: 'zh' | 'en'; groups: GroupSnapshot[]; feedback: CommunityFeedback[]; demo: boolean;
  onChanged: () => Promise<void>; notify: (message: string) => void; from: string; to: string; readOnly?: boolean;
  onRecordSaved?: (date: string) => void;
};

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T12:00:00'));
}
async function request(path: string, options: RequestInit) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}
const exampleGroups: GroupSnapshot[] = Array.from({ length: 21 }, (_, i) => ({ date: `2026-10-${String(i + 3).padStart(2, '0')}`, count: 36 + Math.floor(i * 2.15) }));

export default function Community({ lang, groups, feedback, demo, onChanged, notify, from, to, readOnly = false, onRecordSaved }: CommunityProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [snapshotDate, setSnapshotDate] = useState(localDate);
  const [memberCount, setMemberCount] = useState('');
  const [feedbackDate, setFeedbackDate] = useState(localDate);
  const [author, setAuthor] = useState('');
  const [text, setText] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [savingGroup, setSavingGroup] = useState(false);
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [expanded, setExpanded] = useState<CommunityFeedback | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const groupSaveInFlight = useRef(false);
  const feedbackSaveInFlight = useRef(false);
  const displayGroups = useMemo(() => [...(demo && groups.length === 0 ? exampleGroups : groups)].sort((a, b) => a.date.localeCompare(b.date)), [groups, demo]);
  const snapshots = displayGroups.filter(g => (!from || g.date >= from) && (!to || g.date <= to));
  const latest = displayGroups.filter(g => !to || g.date <= to).at(-1);
  const baseline = (from ? displayGroups.filter(g => g.date < from).at(-1) : undefined) ?? snapshots[0];
  const growth = latest && baseline && latest.date !== baseline.date ? latest.count - baseline.count : null;
  const growthPct = growth !== null && baseline && baseline.count > 0 ? growth / baseline.count * 100 : null;
  const examples: CommunityFeedback[] = [
    { id: 'example-feedback-1', date: '2026-10-22', author: t('示例卡片 · 可替换为客户姓名', 'Example card · replace with customer name'), text: t('上传客户在 Line group 中点赞或分享使用体验的截图，在这里展示真实的一线反馈。', 'Upload a screenshot of a customer reaction or usage experience from your Line group to display real field feedback here.') },
    { id: 'example-feedback-2', date: '2026-10-23', author: t('示例卡片 · 反馈展示位', 'Example card · feedback placeholder'), text: t('可补充场景、使用收益和后续动作，让每一条反馈都能说明项目价值。', 'Add the use case, practical benefit and follow-up action to show the value behind each piece of feedback.') },
  ];
  const displayFeedback = (demo && feedback.length === 0 ? examples : feedback).filter(f => (!from || f.date >= from) && (!to || f.date <= to)).sort((a, b) => b.date.localeCompare(a.date));

  useEffect(() => {
    if (!expanded) return;
    const before = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null);
      if (event.key === 'Tab') { event.preventDefault(); closeButton.current?.focus(); }
    };
    document.addEventListener('keydown', handle);
    return () => { document.removeEventListener('keydown', handle); before?.focus(); };
  }, [expanded]);

  function guardWritable() {
    if (readOnly) {
      notify(t('离线报表为只读，无法修改数据。', 'Offline reports are read only. Data cannot be changed.'));
      return true;
    }
    return false;
  }
  function guardDelete() {
    if (guardWritable()) return true;
    if (!demo) return false;
    notify(t('演示数据无法删除。保存真实记录后会自动退出演示模式。', 'Demo entries cannot be deleted. Saving a real entry exits demo mode.'));
    return true;
  }
  async function saveSnapshot(event: React.FormEvent) {
    event.preventDefault();
    if (guardWritable() || groupSaveInFlight.current) return;
    const submittedDate = snapshotDate;
    const count = Number(memberCount);
    if (!validDate(submittedDate) || !memberCount.trim() || !Number.isSafeInteger(count) || count < 0) {
      notify(t('请选择有效日期，并填写大于或等于 0 的整数人数。', 'Choose a valid date and enter a whole member count of zero or more.')); return;
    }
    groupSaveInFlight.current = true;
    setSavingGroup(true);
    try {
      await request('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: submittedDate, count }) });
      onRecordSaved?.(submittedDate);
      await onChanged(); setMemberCount('');
      notify(t('群人数已保存；同一天的记录会更新。', 'Member count saved. Entries on the same date are updated.'));
    } catch (error) { notify(t('保存失败：', 'Could not save: ') + (error instanceof Error ? error.message : String(error))); }
    finally { groupSaveInFlight.current = false; setSavingGroup(false); }
  }
  async function deleteSnapshot(date: string) {
    if (guardDelete() || !window.confirm(t(`删除 ${date} 的人数记录？`, `Delete the member count for ${date}?`))) return;
    try { await request(`/api/groups?date=${encodeURIComponent(date)}`, { method: 'DELETE' }); await onChanged(); notify(t('人数记录已删除。', 'Member count deleted.')); }
    catch (error) { notify(t('删除失败：', 'Could not delete: ') + (error instanceof Error ? error.message : String(error))); }
  }
  function chooseImage(file: File | null) {
    if (file && (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024)) {
      notify(t('请选择 10 MB 以内的 PNG、JPG、GIF 或 WebP 图片。', 'Choose a PNG, JPG, GIF or WebP image up to 10 MB.'));
      if (fileInput.current) fileInput.current.value = ''; setImageFile(null); return;
    }
    setImageFile(file);
  }
  async function saveFeedback(event: React.FormEvent) {
    event.preventDefault();
    if (guardWritable() || feedbackSaveInFlight.current) return;
    const submittedDate = feedbackDate;
    if (!validDate(submittedDate) || (!text.trim() && !imageFile)) {
      notify(t('请选择有效日期，并填写反馈内容或上传截图。', 'Choose a valid date and add feedback text or a screenshot.')); return;
    }
    const body = new FormData();
    body.append('date', submittedDate); body.append('author', author.trim()); body.append('text', text.trim());
    if (imageFile) body.append('image', imageFile);
    feedbackSaveInFlight.current = true;
    setSavingFeedback(true);
    try {
      await request('/api/feedback', { method: 'POST', body });
      onRecordSaved?.(submittedDate);
      await onChanged();
      setAuthor(''); setText(''); setImageFile(null); if (fileInput.current) fileInput.current.value = '';
      notify(t('客户反馈已保存。', 'Customer feedback saved.'));
    } catch (error) { notify(t('保存失败：', 'Could not save: ') + (error instanceof Error ? error.message : String(error))); }
    finally { feedbackSaveInFlight.current = false; setSavingFeedback(false); }
  }
  async function deleteFeedback(id: string) {
    if (guardDelete() || !window.confirm(t('删除这条客户反馈和对应截图？', 'Delete this feedback and its screenshot?'))) return;
    try { await request(`/api/feedback?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); await onChanged(); notify(t('客户反馈已删除。', 'Customer feedback deleted.')); }
    catch (error) { notify(t('删除失败：', 'Could not delete: ') + (error instanceof Error ? error.message : String(error))); }
  }

  return <section className={`community${readOnly ? ' community-readonly' : ''}`}>
    <div className="community-heading"><div><p className="community-eyebrow">LINE GROUP</p><h2>{t('让一线反馈，成为项目成效', 'From field engagement to visible impact')}</h2><p>{t('记录社群增长，留存客户真实的认可与使用体验。', 'Track community growth and preserve real customer reactions and experiences.')}</p></div><span className="community-soft-pill"><Users size={15}/>{t('社群成效', 'Community impact')}</span></div>
    {readOnly && <div className="community-readonly-notice">{t('离线报表 · 只读', 'Offline report · Read only')}</div>}
    {demo && <div className="community-demo">{t('当前人数和反馈展示位仅用于演示，不代表真实客户数据。', 'Member counts and feedback placeholders below are illustrative, not real customer data.')}</div>}
    <div className="community-stats">
      <div className="community-stat"><span>{t('群成员人数', 'Group members')}</span><strong>{latest ? latest.count.toLocaleString() : '—'}</strong><small>{latest ? `${t('截至', 'As of')} ${latest.date}` : t('还没有人数记录', 'No member counts recorded')}</small></div>
      <div className="community-stat"><span>{t('区间人数净增长', 'Net member growth')}</span><strong className={growth === null ? '' : growth >= 0 ? 'community-positive' : 'community-negative'}>{growth === null ? '—' : `${growth >= 0 ? '+' : ''}${growth.toLocaleString()}`}</strong><small>{growth === null ? t('至少两天记录后计算跨日增长', 'Two dates are needed for growth') : `${t('基准', 'Baseline')}: ${baseline!.count} · ${baseline!.date}`}</small></div>
      <div className="community-stat"><span>{t('区间增长率', 'Member growth rate')}</span><strong className={growthPct === null ? '' : growthPct >= 0 ? 'community-positive' : 'community-negative'}>{growthPct === null ? '—' : <>{growthPct >= 0 ? <ArrowUpRight size={23}/> : <ArrowDownRight size={23}/>} {Math.abs(growthPct).toFixed(1)}%</>}</strong><small>{t('净增长 ÷ 基准人数；基准为 0 时不计算', 'Net growth ÷ baseline; unavailable for a zero baseline')}</small></div>
      <div className="community-stat"><span>{t('区间客户反馈', 'Feedback in period')}</span><strong>{displayFeedback.length}</strong><small>{t('真实案例，是价值最好的说明', 'Customer evidence makes progress tangible')}</small></div>
    </div>
    <div className="community-growth-grid">
      <article className="community-card community-chart-card"><div className="community-card-heading"><div><h3>{t('群成员增长趋势', 'Member growth')}</h3><p>{t('展示实际记录的快照日期，不推算未记录的每日人数。', 'Actual snapshots only; missing daily counts are not estimated.')}</p></div><span className="community-chart-key"><i/>{t('成员人数', 'Members')}</span></div>
        {snapshots.length ? <div className="community-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={snapshots} margin={{ top: 20, right: 20, bottom: 5, left: -20 }}><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="#edf0f2"/><XAxis dataKey="date" tickFormatter={v => String(v).slice(5)} tick={{ fill: '#788893', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24}/><YAxis allowDecimals={false} domain={['auto','auto']} tick={{ fill: '#788893', fontSize: 11 }} axisLine={false} tickLine={false}/><Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e4e9ed', fontSize: 12 }} formatter={(value) => [value, t('成员人数','Members')]}/><Line type="linear" dataKey="count" stroke="#087f6b" strokeWidth={3} dot={{ r: 3, fill: '#087f6b', stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 6 }} isAnimationActive={false}/></LineChart></ResponsiveContainer></div> : <div className="community-empty community-chart-empty"><Users size={30}/><strong>{t('所选区间还没有人数快照', 'No member snapshots in this period')}</strong><p>{readOnly ? t('所选区间未导出人数记录。', 'No member counts were exported for this period.') : t('在右侧记录群人数，增长趋势会自动更新。', 'Record a member count to start tracking growth.')}</p></div>}
        <details className="community-history"><summary>{readOnly ? t('查看人数记录', 'View member counts') : t('查看及管理人数记录', 'View and manage member counts')} <span>{snapshots.length}</span></summary><div className="community-history-list">{snapshots.length ? snapshots.slice().reverse().map(g => <div key={g.date}><span>{g.date}</span><strong>{g.count.toLocaleString()} {t('人','members')}</strong>{!readOnly && !demo && <button type="button" className="community-icon-button" onClick={() => deleteSnapshot(g.date)} title={t('删除此记录','Delete this entry')} aria-label={`${t('删除','Delete')} ${g.date}`}><Trash2 size={14}/></button>}</div>) : <p>{t('暂无记录','No entries')}</p>}</div></details>
      </article>
      {!readOnly && <article className="community-card community-entry-card"><div className="community-entry-icon"><CalendarDays size={21}/></div><h3>{t('记录今日群人数', 'Record a member count')}</h3><p>{t('每天记一次，让增长看得见。', 'One daily snapshot makes growth visible.')}</p><form onSubmit={saveSnapshot} data-testid="group-snapshot-form">{demo && <div className="community-save-notice">{t('保存后切换到真实数据', 'Saving switches to real data')}</div>}<label>{t('记录日期','Snapshot date')}<input type="date" data-testid="group-snapshot-date" disabled={savingGroup} value={snapshotDate} onInput={e => setSnapshotDate(e.currentTarget.value)} onChange={e => setSnapshotDate(e.target.value)} required/></label><label>{t('当日群总人数（非新增人数）','Total members on this date (not new members)')}<input type="number" data-testid="group-total-members" disabled={savingGroup} min="0" step="1" placeholder={t('例如：85','e.g. 85')} value={memberCount} onChange={e => setMemberCount(e.target.value)} required/></label><button className="community-primary" disabled={savingGroup}>{savingGroup ? t('保存中…','Saving…') : <><Plus size={16}/>{t('保存人数记录','Save member count')}</>}</button></form><small>{t('同日更新总人数；至少两天记录才有跨日增长。','Same-date entries update total; two dates are needed for growth.')}</small></article>}
    </div>
    <div className="community-feedback-heading"><div><p className="community-eyebrow">VOICE OF CUSTOMER</p><h3>{t('客户认可与一线反馈', 'Customer voices, captured')}</h3><p>{t('把群内点赞、使用心得和改进建议留存在这里。','Keep customer reactions, experiences and improvement suggestions together.')}</p></div><span className="community-soft-pill"><MessageSquareQuote size={15}/>{displayFeedback.length} {t('条反馈','entries')}</span></div>
    <div className="community-feedback-grid">
      <div className="community-feedback-cards">{displayFeedback.length ? displayFeedback.map(f => <article className="community-card community-feedback-card" key={f.id}>{f.imageUrl ? <button className="community-image-button" type="button" onClick={() => setExpanded(f)} aria-label={t('放大查看反馈截图','Enlarge feedback screenshot')}><img src={f.imageUrl} alt={t('客户反馈截图','Customer feedback screenshot')} loading="lazy"/><span><ZoomIn size={15}/>{t('点击放大','Enlarge')}</span></button> : <div className="community-quote-icon"><MessageSquareQuote size={23}/></div>}<div className="community-feedback-body">{demo && f.id.startsWith('example-') && <span className="community-example-label">{t('示例展示位','Example placeholder')}</span>}{f.text && <p>{f.text}</p>}<div className="community-feedback-meta"><div><strong>{f.author || t('客户反馈','Customer feedback')}</strong><span>{f.date}</span></div>{!readOnly && !demo && <button type="button" className="community-icon-button" onClick={() => deleteFeedback(f.id)} title={t('删除反馈','Delete feedback')} aria-label={t('删除反馈','Delete feedback')}><Trash2 size={15}/></button>}</div></div></article>) : <div className="community-empty community-feedback-empty"><MessageSquareQuote size={31}/><strong>{t('好反馈，值得被看见','Good feedback deserves a place')}</strong><p>{readOnly ? t('所选区间未导出客户反馈。', 'No feedback was exported for this period.') : t('上传第一张群内反馈截图，开始积累项目成效。','Upload your first group feedback screenshot to start building an evidence collection.')}</p></div>}</div>
      {!readOnly && <article className="community-card community-feedback-form"><h3><ImagePlus size={19}/>{t('添加客户反馈','Add customer feedback')}</h3><form onSubmit={saveFeedback} data-testid="community-feedback-form">{demo && <div className="community-save-notice">{t('保存后切换到真实数据', 'Saving switches to real data')}</div>}<div className="community-two-fields"><label>{t('反馈日期','Feedback date')}<input type="date" data-testid="feedback-date" disabled={savingFeedback} value={feedbackDate} onInput={e => setFeedbackDate(e.currentTarget.value)} onChange={e => setFeedbackDate(e.target.value)} required/></label><label>{t('客户 / 来源（选填）','Customer / source (optional)')}<input disabled={savingFeedback} value={author} onChange={e => setAuthor(e.target.value)} placeholder={t('客户姓名或群名称','Name or group')} maxLength={200}/></label></div><label>{t('反馈内容 / 背景说明','Feedback / context')}<textarea disabled={savingFeedback} rows={4} value={text} onChange={e => setText(e.target.value)} placeholder={t('记录场景、客户评价或实际使用收益…','Describe the use case, customer reaction or practical benefit…')} maxLength={10000}/></label><label className="community-upload"><ImagePlus size={22}/><strong>{imageFile ? imageFile.name : t('选择反馈截图','Choose a screenshot')}</strong><span>PNG / JPG / GIF / WebP · ≤ 10 MB</span><input ref={fileInput} disabled={savingFeedback} type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={e => chooseImage(e.target.files?.[0] ?? null)} aria-label={t('选择反馈截图','Choose feedback screenshot')}/></label>{imageFile && <button className="community-text-button" disabled={savingFeedback} type="button" onClick={() => { setImageFile(null); if (fileInput.current) fileInput.current.value = ''; }}>{t('移除已选图片','Remove selected image')}</button>}<button className="community-primary" disabled={savingFeedback}>{savingFeedback ? t('保存中…','Saving…') : <><Plus size={16}/>{t('保存客户反馈','Save feedback')}</>}</button><small>{t('反馈文字与截图至少填写一项。','Add at least feedback text or a screenshot.')}</small></form></article>}
    </div>
    {expanded?.imageUrl && <div className="community-modal" role="dialog" aria-modal="true" aria-label={t('反馈截图预览','Feedback screenshot preview')} onClick={() => setExpanded(null)}><button ref={closeButton} type="button" className="community-modal-close" onClick={() => setExpanded(null)} aria-label={t('关闭预览','Close preview')}><X size={24}/></button><figure onClick={e => e.stopPropagation()}><img src={expanded.imageUrl} alt={t('客户反馈截图原图','Full customer feedback screenshot')}/><figcaption>{expanded.author} · {expanded.date}{expanded.text && <p>{expanded.text}</p>}</figcaption></figure></div>}
  </section>;
}
