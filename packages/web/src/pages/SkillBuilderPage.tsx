import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Send, Mic, MicOff, CheckCircle2, Eye, Code2, Loader2,
  FileCode2, AlertTriangle, Sparkles, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../api/client';
import { useI18n } from '../i18n';
import { Card, Button, Tag, Textarea, Modal, EmptyState } from '../components/ui';

const REQUIRED_LABEL: Record<string, string> = {
  name: 'skillbuilder.fieldName',
  description: 'skillbuilder.fieldDescription',
  execution_mode: 'skillbuilder.fieldExecutionMode',
  input_schema: 'skillbuilder.fieldInputSchema',
  output_schema: 'skillbuilder.fieldOutputSchema',
  tags: 'skillbuilder.fieldTags',
};

const OPTIONAL_LABEL: Record<string, string> = {
  script_content: 'skillbuilder.fieldScriptContent',
};

interface ConversationMsg {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export default function SkillBuilderPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const [sessionId, setSessionId] = useState<string | undefined>(urlSessionId);
  const [conversation, setConversation] = useState<ConversationMsg[]>([]);
  const [draft, setDraft] = useState<any>({});
  const [filled, setFilled] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>(['name', 'description', 'execution_mode']);
  const [readyToPreview, setReadyToPreview] = useState(false);
  const [preview, setPreview] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [scriptOpen, setScriptOpen] = useState(true);

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState('');

  const recogRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const speechSupported = typeof window !== 'undefined' && (
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  );

  // 是否需要脚本（script / hybrid 模式）
  const needsScript = draft.executionMode === 'script' || draft.executionMode === 'hybrid';
  const hasScript = !!(draft.scriptContent && String(draft.scriptContent).trim());
  const scriptMissing = needsScript && !hasScript;

  // 是否所有必填字段都已 filled
  const allRequired = useMemo(
    () => Object.keys(REQUIRED_LABEL).every(f => filled.includes(f)),
    [filled]
  );
  // 真的能提交：必填全 OK + 脚本（如需要）已生成
  const canCommit = allRequired && !scriptMissing && draft.name && draft.description;

  // 首次进入：若没有 sessionId 则创建
  useEffect(() => {
    if (sessionId) {
      api.getBuilderSession(sessionId).then(s => {
        setConversation(s.conversation || []);
        setDraft(s.draft || {});
        setFilled(s.draftFilledFields || []);
        setPending(s.pendingFields || []);
      }).catch(() => {});
    } else {
      api.createBuilderSession().then(s => {
        setSessionId(s.sessionId);
        navigate(`/skill-builder/${s.sessionId}`, { replace: true });
        setConversation([{
          role: 'assistant',
          content: t('skillbuilder.welcomeMessage'),
          timestamp: new Date().toISOString(),
        }]);
      }).catch((err) => setError(t('skillbuilder.createSessionFailed', { msg: err.message })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动滚到对话最底
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.length, sending]);

  const send = async () => {
    if (!input.trim() || sending || !sessionId) return;
    const text = input.trim();
    setInput('');
    setConversation(prev => [...prev, { role: 'user', content: text, timestamp: new Date().toISOString() }]);
    setSending(true);
    setError('');
    try {
      const res = await api.sendBuilderMessage(sessionId, text);
      setConversation(res.conversation || []);
      setDraft(res.draft || {});
      setFilled(res.draftFilledFields || []);
      setPending(res.pendingFields || []);
      setReadyToPreview(Boolean(res.readyToPreview));
    } catch (err: any) {
      setError(err.message || t('skillbuilder.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const startVoice = () => {
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const t = e.results[0]?.[0]?.transcript || '';
      setInput(prev => prev ? (prev + ' ' + t) : t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    recogRef.current = rec;
    setListening(true);
  };

  const stopVoice = () => {
    try { recogRef.current?.stop?.(); } catch { /* */ }
    setListening(false);
  };

  const openPreview = async () => {
    if (!sessionId) return;
    try {
      const res = await api.getBuilderPreview(sessionId);
      setPreview(res.skillMd || '');
      setShowPreview(true);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const commit = async (overwrite = false) => {
    if (!sessionId) return;
    setCommitting(true);
    setError('');
    try {
      await api.commitBuilder(sessionId, overwrite);
      navigate('/skills');
    } catch (err: any) {
      if (err.status === 409) {
        if (confirm(t('skillbuilder.overwriteConfirm', { name: draft.name }))) {
          await commit(true);
          return;
        }
      } else {
        setError(err.message || t('skillbuilder.commitFailed'));
      }
    } finally {
      setCommitting(false);
    }
  };

  // 还差几个字段
  const remainingFieldsLabel = useMemo(() => {
    const missing = Object.keys(REQUIRED_LABEL).filter(f => !filled.includes(f));
    if (scriptMissing) missing.push('script_content');
    return missing;
  }, [filled, scriptMissing]);

  return (
    <div className="p-8 max-w-7xl mx-auto h-screen flex flex-col animate-fade-in-up">
      <div className="flex items-center justify-between mb-4">
        <div>
          <button
            onClick={() => navigate('/skills')}
            className="text-sm text-fg-muted hover:text-fg-primary flex items-center gap-1 mb-1 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" /> {t('skillbuilder.backToSkills')}
          </button>
          <h1 className="text-xl font-heading font-bold text-fg-primary">{t('skillbuilder.title')}</h1>
          <p className="text-fg-muted text-xs mt-0.5">{t('skillbuilder.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<Eye className="w-4 h-4" />}
            onClick={openPreview}
            disabled={!draft.name}
          >
            {t('skillbuilder.preview')}
          </Button>
          <Button
            disabled={!canCommit}
            loading={committing}
            size="sm"
            icon={<CheckCircle2 className="w-4 h-4" />}
            onClick={() => commit(false)}
          >
            {canCommit ? t('skillbuilder.submit') : t('skillbuilder.submitRemaining', { n: remainingFieldsLabel.length })}
          </Button>
        </div>
      </div>

      {/* 准备就绪横幅（醒目） */}
      {canCommit && (
        <div className="mb-4 p-4 rounded-xl border-2 border-status-success/40 bg-status-success/10 flex items-center gap-3 animate-fade-in-up">
          <Sparkles className="w-6 h-6 text-status-success" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-status-success">
              {t('skillbuilder.readyTitle')}
            </p>
            <p className="text-xs text-fg-secondary mt-0.5">
              {t('skillbuilder.readyDesc', { script: needsScript ? ' + scripts/main.py' : '' })}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={openPreview} icon={<Eye className="w-4 h-4" />}>{t('skillbuilder.preview')}</Button>
          <Button size="sm" loading={committing} onClick={() => commit(false)} icon={<CheckCircle2 className="w-4 h-4" />}>
            {t('skillbuilder.submitNow')}
          </Button>
        </div>
      )}

      {/* 字段进度 */}
      <Card className="!p-3 mb-4">
        <div className="flex flex-wrap gap-2 items-center text-xs">
          <span className="text-fg-muted shrink-0">{t('skillbuilder.requiredFields', { filled: filled.length, total: Object.keys(REQUIRED_LABEL).length })}</span>
          {Object.keys(REQUIRED_LABEL).map(f => (
            <Tag key={f} variant={filled.includes(f) ? 'success' : 'warn'}>
              {filled.includes(f) ? '✓' : '○'} {t(REQUIRED_LABEL[f])}
            </Tag>
          ))}
          {needsScript && (
            <>
              <span className="text-fg-muted shrink-0 ml-2">|</span>
              <Tag variant={hasScript ? 'success' : 'danger'}>
                {hasScript ? '✓' : '○'} {t(OPTIONAL_LABEL.script_content)}
              </Tag>
            </>
          )}
          {canCommit && <Tag variant="brand">{t('skillbuilder.readyBadge')}</Tag>}
        </div>
        {!canCommit && remainingFieldsLabel.length > 0 && (
          <p className="text-xs text-fg-muted mt-2">
            {t('skillbuilder.stillNeeded')}{remainingFieldsLabel.map(f => t(REQUIRED_LABEL[f] || OPTIONAL_LABEL[f] || f)).join(t('skillbuilder.fieldSeparator'))}
          </p>
        )}
      </Card>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-0">
        {/* 左：对话区 */}
        <Card className="!p-0 flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-glass-border text-sm font-semibold text-fg-primary flex items-center justify-between">
            <span>{t('skillbuilder.conversationArea')}</span>
            <span className="text-xs font-normal text-fg-muted">{t('skillbuilder.messageCount', { n: conversation.length })}</span>
          </div>
          <div className="flex-1 overflow-auto p-4 space-y-3 min-h-0">
            {conversation.length === 0 ? (
              <EmptyState title={t('skillbuilder.conversationEmptyTitle')} description={t('skillbuilder.conversationEmptyDesc')} />
            ) : conversation.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-md rounded-2xl px-4 py-2 text-sm ${
                  m.role === 'user'
                    ? 'bg-brand text-white'
                    : 'glass border border-glass-border text-fg-primary'
                }`}>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="glass rounded-2xl px-4 py-2 text-sm flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> {t('skillbuilder.thinking')}
                </div>
              </div>
            )}
            {/* 已就绪时在对话区也插一条系统提示，保证用户必然看见 */}
            {!sending && canCommit && (
              <div className="flex justify-start">
                <div className="rounded-2xl px-4 py-2 text-sm bg-status-success/10 border border-status-success/30 text-status-success max-w-md">
                  <div className="flex items-center gap-2 font-semibold mb-0.5">
                    <CheckCircle2 className="w-4 h-4" /> {t('skillbuilder.collectedDone')}
                  </div>
                  <div className="text-xs text-fg-secondary">
                    {t('skillbuilder.readyChatHint', { withScript: needsScript ? t('skillbuilder.withPythonScript') : '' })}
                  </div>
                </div>
              </div>
            )}
            <div ref={conversationEndRef} />
          </div>
          <div className="border-t border-glass-border p-3 flex gap-2">
            <Textarea
              rows={2}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={t('skillbuilder.inputPlaceholder')}
              className="!h-auto"
            />
            {speechSupported && (
              <Button
                variant={listening ? 'danger' : 'secondary'}
                size="md"
                onClick={listening ? stopVoice : startVoice}
                icon={listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              >
                {listening ? t('skillbuilder.stopVoice') : t('skillbuilder.voice')}
              </Button>
            )}
            <Button onClick={send} loading={sending} icon={<Send className="w-4 h-4" />}>{t('skillbuilder.send')}</Button>
          </div>
        </Card>

        {/* 右：实时草稿 + 脚本 */}
        <Card className="!p-0 flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-glass-border text-sm font-semibold text-fg-primary flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Code2 className="w-4 h-4" /> {t('skillbuilder.liveDraft')}
            </span>
            {draft.executionMode && (
              <Tag variant={needsScript ? 'info' : 'default'}>
                mode: {draft.executionMode}
              </Tag>
            )}
          </div>
          <div className="flex-1 overflow-auto min-h-0 flex flex-col">
            <div className="p-4 font-mono text-xs text-fg-secondary whitespace-pre-wrap">
              <DraftPreview draft={draft} filled={filled} />
            </div>

            {/* 脚本预览面板（仅在 script/hybrid 模式或已生成脚本时显示） */}
            {(needsScript || hasScript) && (
              <div className="border-t border-glass-border">
                <button
                  type="button"
                  onClick={() => setScriptOpen(v => !v)}
                  className="w-full px-4 py-3 flex items-center justify-between text-sm hover:bg-bg-elev/30 cursor-pointer transition-colors"
                >
                  <span className="flex items-center gap-2 font-semibold text-fg-primary">
                    {scriptOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    <FileCode2 className="w-4 h-4" />
                    scripts/main.py
                    {hasScript ? (
                      <Tag variant="success">
                        {t('skillbuilder.lineCount', { n: String(draft.scriptContent).split('\n').length })}
                      </Tag>
                    ) : (
                      <Tag variant="danger">{t('skillbuilder.missing')}</Tag>
                    )}
                  </span>
                </button>
                {scriptOpen && (
                  <div className="px-4 pb-4">
                    {scriptMissing ? (
                      <div className="p-3 rounded-lg bg-status-danger/10 border border-status-danger/30 text-status-danger text-xs flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold mb-1">{t('skillbuilder.scriptMissingTitle')}</p>
                          <p className="text-fg-secondary mb-2">
                            {t('skillbuilder.scriptMissingMode')} <span className="font-mono">{draft.executionMode}</span>{t('skillbuilder.scriptMissingNeed')}{' '}
                            {t('skillbuilder.scriptMissingTell')} <span className="font-mono">{t('skillbuilder.scriptQuote1')}</span>{t('skillbuilder.scriptMissingRegen')}
                          </p>
                          <p className="text-fg-muted">
                            {t('skillbuilder.scriptAltPre')} <span className="italic">{t('skillbuilder.scriptQuote2')}</span>{t('skillbuilder.scriptAltPost')}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <pre className="text-xs font-mono bg-bg-panel/60 border border-glass-border rounded-lg p-3 overflow-auto max-h-64 text-fg-primary">
                        {String(draft.scriptContent || '').slice(0, 5000)}
                        {String(draft.scriptContent || '').length > 5000 ? '\n\n' + t('skillbuilder.scriptTruncated') : ''}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

      {error && (
        <div className="mt-4 p-3 rounded-lg bg-status-danger/10 border border-status-danger/30 text-status-danger text-sm">
          {error}
        </div>
      )}

      <Modal
        open={showPreview}
        onClose={() => setShowPreview(false)}
        title={t('skillbuilder.previewTitle')}
        width="max-w-3xl"
      >
        <pre className="bg-bg-panel/60 rounded-lg p-4 text-xs text-fg-secondary overflow-auto max-h-[60vh] font-mono whitespace-pre-wrap">
          {preview || t('skillbuilder.noPreview')}
        </pre>
        {hasScript && (
          <div className="mt-3">
            <p className="text-xs text-fg-muted mb-2 flex items-center gap-1">
              <FileCode2 className="w-3 h-3" /> {t('skillbuilder.scriptRealPath')}
            </p>
            <pre className="bg-bg-panel/60 rounded-lg p-4 text-xs text-fg-secondary overflow-auto max-h-[40vh] font-mono whitespace-pre-wrap">
              {String(draft.scriptContent || '')}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

function DraftPreview({ draft, filled }: { draft: any; filled: string[] }) {
  const { t } = useI18n();
  if (!draft || Object.keys(draft).length === 0) {
    return <span className="text-fg-disabled">{t('skillbuilder.draftEmpty')}</span>;
  }

  const lines: Array<{ key: string; text: string }> = [{ key: '_open', text: '---' }];
  if (draft.name) lines.push({ key: 'name', text: `name: ${draft.name}` });
  if (draft.version) lines.push({ key: 'version', text: `version: "${draft.version}"` });
  if (draft.description) lines.push({ key: 'description', text: `description: ${JSON.stringify(draft.description)}` });
  if (draft.domain) lines.push({ key: 'domain', text: `domain: ${draft.domain}` });
  if (draft.executionMode) lines.push({ key: 'execution_mode', text: `execution_mode: ${draft.executionMode}` });
  if (draft.tags?.length) lines.push({ key: 'tags', text: `tags: [${draft.tags.join(', ')}]` });
  if (draft.inputSchema && Object.keys(draft.inputSchema.properties || {}).length > 0) {
    lines.push({ key: 'input_schema', text: `input_schema:\n${indent(JSON.stringify(draft.inputSchema, null, 2), 2)}` });
  }
  if (draft.outputSchema && Object.keys(draft.outputSchema.properties || {}).length > 0) {
    lines.push({ key: 'output_schema', text: `output_schema:\n${indent(JSON.stringify(draft.outputSchema, null, 2), 2)}` });
  }
  if (draft.executionMode === 'script' || draft.executionMode === 'hybrid') {
    lines.push({ key: 'script_entry', text: `script_entry: ${draft.scriptEntry || 'scripts/main.py'}` });
  }
  lines.push({ key: '_close', text: '---' });
  lines.push({ key: '_gap', text: '' });
  lines.push({ key: 'promptContent', text: draft.promptContent || t('skillbuilder.promptPending') });

  return (
    <>
      {lines.map((line, idx) => {
        const isFilled = filled.includes(line.key);
        const isMeta = line.key.startsWith('_');
        return (
          <div
            key={idx}
            className={`${isFilled ? 'text-fg-primary' : isMeta ? 'text-fg-muted' : 'text-fg-secondary'}`}
            style={{ whiteSpace: 'pre-wrap' }}
          >
            {line.text}
          </div>
        );
      })}
    </>
  );
}

function indent(text: string, n: number): string {
  const sp = ' '.repeat(n);
  return text.split('\n').map(l => sp + l).join('\n');
}
