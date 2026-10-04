import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, Play, Plus, ShieldAlert, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { Card, Tag, Button, Modal, Drawer, Textarea, Input, EmptyState, Skeleton } from '../components/ui';

const modeLabels: Record<string, string> = {
  llm_only: 'LLM',
  script: '脚本',
  hybrid: '混合',
};

const statusLabels: Record<string, string> = {
  stable: '稳定',
  experimental: '实验性',
  deprecated: '已弃用',
};

const sourceLabels: Record<string, string> = {
  builtin: '内置',
  user: '用户',
};

type SourceFilter = '' | 'builtin' | 'user';

export default function SkillsPage() {
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<SourceFilter>('');

  const [testing, setTesting] = useState<{ name: string; input: string } | null>(null);
  const [testResult, setTestResult] = useState<any>(null);
  const [testRunning, setTestRunning] = useState(false);

  const [editing, setEditing] = useState<any>(null);
  const [editForm, setEditForm] = useState({ promptContent: '', frontmatterText: '' });
  const [saving, setSaving] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [editError, setEditError] = useState('');

  const [deleting, setDeleting] = useState<any>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleteError, setDeleteError] = useState('');

  const loadSeq = useRef(0);
  const loadSkills = () => {
    const mySeq = ++loadSeq.current; // 审查 P3：筛选竞态守卫
    setLoading(true);
    api.listSkills(filter ? { source: filter } : undefined)
      .then(res => {
        if (mySeq !== loadSeq.current) return;
        setSkills(res.items || []);
      })
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  };

  useEffect(loadSkills, [filter]);

  const openEdit = async (skill: any) => {
    try {
      const full = await api.getSkill(skill.name, true);
      setEditing(full);
      setEditForm({
        promptContent: full.promptContent || '',
        frontmatterText: JSON.stringify(full.frontmatter || {}, null, 2),
      });
      setConfirmName('');
      setEditError('');
    } catch (err: any) {
      alert('加载失败: ' + err.message);
    }
  };

  const submitEdit = async () => {
    if (!editing) return;
    setSaving(true);
    setEditError('');
    try {
      let frontmatter: any;
      try {
        frontmatter = JSON.parse(editForm.frontmatterText);
      } catch {
        setEditError('frontmatter 不是合法 JSON');
        setSaving(false);
        return;
      }
      const isBuiltin = editing.source === 'builtin';
      if (isBuiltin && confirmName !== editing.name) {
        setEditError(`内置 Skill 编辑需要输入名称 "${editing.name}" 进行二次确认`);
        setSaving(false);
        return;
      }
      await api.updateSkill(editing.name, {
        frontmatter,
        promptContent: editForm.promptContent,
      }, isBuiltin ? confirmName : undefined);
      setEditing(null);
      loadSkills();
    } catch (err: any) {
      setEditError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const submitDelete = async (physical: boolean) => {
    if (!deleting) return;
    setDeleteError('');
    try {
      const isBuiltin = deleting.source === 'builtin';
      if (isBuiltin && deleteConfirmName !== deleting.name) {
        setDeleteError(`内置 Skill 删除需要输入名称 "${deleting.name}" 进行二次确认`);
        return;
      }
      await api.deleteSkill(deleting.name, {
        physical,
        confirmBuiltin: isBuiltin ? deleteConfirmName : undefined,
      });
      setDeleting(null);
      setDeleteConfirmName('');
      loadSkills();
    } catch (err: any) {
      setDeleteError(err.message || '删除失败');
    }
  };

  const runTest = async () => {
    if (!testing) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const input = JSON.parse(testing.input);
      const result = await api.testSkill(testing.name, input);
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ success: false, error: { message: err.message } });
    }
    setTestRunning(false);
  };

  return (
    <div className="p-8 max-w-7xl mx-auto animate-fade-in-up">
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-heading font-bold text-fg-primary">技能列表</h1>
          <p className="text-fg-muted mt-1">浏览、编辑、测试已注册的所有 Skill</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex bg-bg-panel/60 backdrop-blur rounded-lg border border-glass-border p-0.5">
            {[
              { v: '', label: '全部' },
              { v: 'builtin', label: '内置' },
              { v: 'user', label: '用户' },
            ].map(t => (
              <button
                key={t.v}
                onClick={() => setFilter(t.v as SourceFilter)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition cursor-pointer ${
                  filter === t.v ? 'bg-brand text-white' : 'text-fg-muted hover:text-fg-primary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <Link to="/skill-builder">
            <Button icon={<Plus className="w-4 h-4" />}>创建技能</Button>
          </Link>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} height="h-36" />)}
        </div>
      ) : skills.length === 0 ? (
        <Card>
          <EmptyState title="暂无技能" description="去技能创建页用对话方式生成第一个技能" />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {skills.map(skill => (
            <Card key={skill.name} className="glass-hover">
              <div className="flex items-start justify-between mb-3 gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-heading font-semibold text-fg-primary">{skill.name}</h3>
                    <span className="text-xs text-fg-muted">v{skill.version}</span>
                  </div>
                  <p className="text-sm text-fg-secondary line-clamp-2">{skill.description}</p>
                </div>
                <Tag variant={skill.source === 'builtin' ? 'info' : 'brand'}>
                  {sourceLabels[skill.source] || skill.source}
                </Tag>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                <Tag variant={skill.status === 'stable' ? 'success' : skill.status === 'experimental' ? 'warn' : 'default'}>
                  {statusLabels[skill.status] || skill.status}
                </Tag>
                <Tag variant="info">{modeLabels[skill.executionMode] || skill.executionMode}</Tag>
                <Tag>{skill.domain}</Tag>
                {skill.consumesCompanyProfile && <Tag variant="brand">公司画像</Tag>}
                {(skill.tags || []).slice(0, 3).map((tag: string) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-glass-border">
                <Button size="sm" variant="ghost" icon={<Play className="w-4 h-4" />} onClick={() => { setTesting({ name: skill.name, input: '{}' }); setTestResult(null); }}>测试</Button>
                <Button size="sm" variant="secondary" icon={<Pencil className="w-4 h-4" />} onClick={() => openEdit(skill)}>编辑</Button>
                <Button size="sm" variant="danger" icon={<Trash2 className="w-4 h-4" />} onClick={() => { setDeleting(skill); setDeleteConfirmName(''); setDeleteError(''); }}>删除</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 测试 Modal */}
      <Modal
        open={!!testing}
        onClose={() => { setTesting(null); setTestResult(null); }}
        title={`测试 Skill：${testing?.name || ''}`}
        width="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setTesting(null); setTestResult(null); }}>关闭</Button>
            <Button loading={testRunning} onClick={runTest}>执行</Button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block text-xs text-fg-muted">输入 JSON</label>
          <Textarea
            value={testing?.input || '{}'}
            onChange={e => setTesting(t => t ? { ...t, input: e.target.value } : null)}
            rows={6}
            className="font-mono"
          />
          {testResult && (
            <div className="mt-2">
              <div className={`text-sm font-medium mb-1 ${testResult.success ? 'text-status-success' : 'text-status-danger'}`}>
                {testResult.success ? '✓ 执行成功' : '✗ 执行失败'}
              </div>
              <pre className="bg-bg-panel/60 rounded-lg p-3 text-xs overflow-auto max-h-72 font-mono text-fg-secondary border border-glass-border">
                {JSON.stringify(testResult.data || testResult.error, null, 2)}
              </pre>
              {testResult.meta && (
                <p className="text-xs text-fg-muted mt-2">
                  耗时: {testResult.meta.durationMs}ms · Token: {testResult.meta.tokensUsed || 0}
                </p>
              )}
            </div>
          )}
        </div>
      </Modal>

      {/* 编辑 Drawer */}
      <Drawer
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`编辑：${editing?.name || ''}`}
        width="max-w-4xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
            <Button loading={saving} onClick={submitEdit}>保存</Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            {editing.source === 'builtin' && (
              <div className="p-3 rounded-lg bg-status-warn/10 border border-status-warn/30 flex gap-2 items-start">
                <ShieldAlert className="w-5 h-5 text-status-warn shrink-0 mt-0.5" />
                <div className="text-xs text-status-warn">
                  这是 <b>内置 Skill</b>，编辑会被同步到 SKILL.md 文件并触发热重载。
                  请在下方输入框输入完整名称 <b className="font-mono">{editing.name}</b> 以二次确认。
                </div>
              </div>
            )}
            {editing.source === 'builtin' && (
              <div>
                <label className="text-xs text-fg-muted block mb-1">输入 Skill 名以确认</label>
                <Input value={confirmName} onChange={e => setConfirmName(e.target.value)} placeholder={editing.name} />
              </div>
            )}
            <div>
              <label className="text-xs text-fg-muted block mb-1">Frontmatter（JSON）</label>
              <Textarea
                value={editForm.frontmatterText}
                onChange={e => setEditForm(f => ({ ...f, frontmatterText: e.target.value }))}
                rows={12}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label className="text-xs text-fg-muted block mb-1">Prompt 正文（Markdown）</label>
              <Textarea
                value={editForm.promptContent}
                onChange={e => setEditForm(f => ({ ...f, promptContent: e.target.value }))}
                rows={16}
                className="font-mono text-xs"
              />
            </div>
            {editError && <div className="text-sm text-status-danger">{editError}</div>}
          </div>
        )}
      </Drawer>

      {/* 删除 Modal */}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="删除 Skill"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>取消</Button>
            <Button variant="secondary" onClick={() => submitDelete(false)}>仅取消注册</Button>
            <Button variant="danger" onClick={() => submitDelete(true)}>物理删除（移入回收站）</Button>
          </>
        }
      >
        {deleting && (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-status-warn shrink-0 mt-0.5" />
              <p className="text-sm text-fg-secondary">
                你即将删除 <b className="text-fg-primary">{deleting.name}</b>（{sourceLabels[deleting.source] || deleting.source}）
              </p>
            </div>
            {deleting.source === 'builtin' && (
              <div>
                <p className="text-xs text-fg-muted mb-1">这是内置 Skill，请输入完整名称 <b className="font-mono">{deleting.name}</b> 进行二次确认</p>
                <Input value={deleteConfirmName} onChange={e => setDeleteConfirmName(e.target.value)} placeholder={deleting.name} />
              </div>
            )}
            <ul className="text-xs text-fg-muted list-disc pl-4 space-y-1">
              <li>仅取消注册：从注册表移除，物理文件保留（可手动恢复）</li>
              <li>物理删除：把 skills/{deleting.name}/ 整个移到 skills/.trash/{deleting.name}-时间戳/</li>
            </ul>
            {deleteError && <div className="text-sm text-status-danger">{deleteError}</div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
