import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Save } from 'lucide-react';
import './FailureReason.css';

export type FailureReasonProps = {
  taskId: string;
  reason: string;
  lang: 'zh' | 'en';
  readOnly: boolean;
  onSaved: (taskId: string, reason: string) => void;
  notify: (message: string) => void;
};

/** Notes belong to an individual task, so identical questions may have different causes. */
export default function FailureReason({ taskId, reason = '', lang, readOnly, onSaved, notify }: FailureReasonProps) {
  const t = (zh: string, en: string) => lang === 'zh' ? zh : en;
  const [draft, setDraft] = useState(reason);
  const [savedReason, setSavedReason] = useState(reason);
  const [saving, setSaving] = useState(false);
  const previous = useRef({ taskId, reason });
  const currentTask = useRef(taskId);
  const alive = useRef(true);
  currentTask.current = taskId;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const prior = previous.current;
    if (taskId !== prior.taskId) {
      setDraft(reason);
      setSavedReason(reason);
      setSaving(false);
    } else if (reason !== prior.reason) {
      // Refreshes may update the saved value, but must not overwrite local edits.
      setDraft(value => value === prior.reason ? reason : value);
      setSavedReason(reason);
    }
    previous.current = { taskId, reason };
  }, [taskId, reason]);

  const dirty = draft !== savedReason;
  async function save() {
    if (readOnly || saving || !dirty) return;
    const requestTask = taskId;
    const requestDraft = draft;
    setSaving(true);
    try {
      const response = await fetch('/api/failure-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: requestTask, reason: requestDraft }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || result.message || `HTTP ${response.status}`);
      const normalized = typeof result.reason === 'string' ? result.reason : requestDraft.trim();
      if (alive.current && currentTask.current === requestTask) {
        setSavedReason(normalized);
        setDraft(normalized);
      }
      onSaved(requestTask, normalized);
      notify(normalized ? t('失败原因已保存。', 'Failure cause saved.') : t('失败原因已清空。', 'Failure cause cleared.'));
    } catch (error) {
      notify(t('失败原因保存失败：', 'Could not save the failure cause: ') + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (alive.current && currentTask.current === requestTask) setSaving(false);
    }
  }

  if (readOnly) {
    return <div className={'failure-reason-readonly' + (reason ? '' : ' failure-reason-empty')}>
      {reason || t('未填写', 'Not recorded')}
    </div>;
  }

  return <div className="failure-reason">
    <div className="failure-reason-editor">
      <textarea
        aria-label={t(`${taskId} 的失败原因`, `Failure reason for ${taskId}`)}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        maxLength={10000}
        rows={3}
        disabled={saving}
        placeholder={t('填写排查原因…', 'Enter the failure cause…')}
      />
      <div className="failure-reason-actions">
        <span className={dirty ? 'failure-reason-unsaved' : 'failure-reason-status'} aria-live="polite">
          {saving ? t('正在保存…', 'Saving…') : dirty ? t('尚未保存', 'Unsaved changes') : savedReason ? <><Check size={11}/>{t('已保存', 'Saved')}</> : t('未填写', 'Not recorded')}
        </span>
        <button type="button" className="failure-reason-save" onClick={save} disabled={saving || !dirty}>
          {saving ? <LoaderCircle size={12} className="failure-reason-spinner"/> : <Save size={12}/>}
          {t('保存原因', 'Save cause')}
        </button>
      </div>
    </div>
    {/* Reports print persisted notes only, never an unsaved editor draft. */}
    <div className={'failure-reason-print' + (savedReason ? '' : ' failure-reason-empty')}>
      {savedReason || t('未填写', 'Not recorded')}
    </div>
  </div>;
}
