import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Download, FileText, FileSpreadsheet, Code2, ChevronDown, ChevronRight, X, Maximize2, Minimize2, FileDown } from 'lucide-react';
import { api } from '../api/client';
import { useTaskStream, type ArtifactItem, type ProgressState } from '../hooks/useTaskStream';
import { Card, Tag, Button, ProgressBar, EmptyState, Skeleton, ConnectionDot } from '../components/ui';
import { AgentDag, type AgentNodeData } from '../components/dag/AgentDag';

const taskStatusLabels: Record<string, string> = {
  created: '已创建', planning: '规划中', executing: '执行中',
  completed: '已完成', failed: '已失败', cancelled: '已取消',
  waiting_human: '等待审批',
};

const taskStatusVariant: Record<string, 'default' | 'success' | 'warn' | 'danger' | 'info'> = {
  created: 'default',
  planning: 'info',
  executing: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'default',
  waiting_human: 'warn',
};

const ARTIFACT_ICONS: Record<string, React.ReactNode> = {
  markdown: <FileText className="w-4 h-4 text-status-info" />,
  csv: <FileSpreadsheet className="w-4 h-4 text-status-success" />,
  json: <Code2 className="w-4 h-4 text-status-warn" />,
  file: <FileText className="w-4 h-4 text-fg-muted" />,
  text: <FileText className="w-4 h-4 text-fg-muted" />,
};

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [taskData, setTaskData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [logsOpen, setLogsOpen] = useState(true);
  const [goalExpanded, setGoalExpanded] = useState(false);
  const { events, progressByAgent, artifacts, logs, transport, wsConnected, sseConnected, seedEvents } = useTaskStream(taskId);

  const refresh = () => {
    if (!taskId) return;
    api.getTask(taskId).then((data) => {
      setTaskData(data);
      // v1.1.1：把后端持久化/合并后的历史事件灌入实时流（按 eventId 去重）
      // 让任务完成后再次进入也能恢复进度/产物/事件时间线
      if (data?.events) seedEvents(data.events);
    }).catch(() => setTaskData(null));
  };

  useEffect(() => {
    if (!taskId) return;
    setLoading(true);
    api.getTask(taskId)
      .then((data) => {
        setTaskData(data);
        if (data?.events) seedEvents(data.events);
      })
      .catch(() => setTaskData(null))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // 当事件中含 task / agent 状态变化时刷新
  useEffect(() => {
    if (!events.length) return;
    const last = events[events.length - 1];
    if (
      last.type.startsWith('task.') ||
      last.type === 'agent.completed' ||
      last.type === 'agent.failed' ||
      last.type === 'agent.cancelled'
    ) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  const handleCancel = async () => {
    if (!taskId) return;
    try { await api.cancelTask(taskId); } catch (err: any) { alert('取消失败: ' + (err.message || err)); }
    refresh();
  };

  const agentStatuses = useMemo<Record<string, AgentNodeData['status']>>(() => {
    const result: Record<string, AgentNodeData['status']> = {};
    if (!taskData) return result;
    // 1) 规划阶段快照（默认 pending）
    const planAgents = taskData.plan?.agents || [];
    for (const a of planAgents) {
      result[a.agentId] = (a.status as AgentNodeData['status']) || 'pending';
    }
    // 2) 持久化的 agents（含最终 status，权威）
    const liveAgents = taskData.agents || [];
    for (const a of liveAgents) {
      if (a?.agentId && a?.status) {
        result[a.agentId] = a.status as AgentNodeData['status'];
      }
    }
    // 3) 实时事件覆盖（最新优先）
    for (const ev of events) {
      if (!ev.agentId) continue;
      if (ev.type === 'agent.started') result[ev.agentId] = 'running';
      if (ev.type === 'agent.completed') result[ev.agentId] = 'completed';
      if (ev.type === 'agent.failed') result[ev.agentId] = 'failed';
      if (ev.type === 'agent.cancelled') result[ev.agentId] = 'cancelled';
    }
    return result;
  }, [taskData, events]);

  // v1.1.1：从 agents[].skillResults / agents[].output 扫描 *_path 重建产物兜底
  // 即使 skill.artifact 事件被淘汰，也能从 agentStore 持久化结果中重建产物列表
  const fallbackArtifacts = useMemo<ArtifactItem[]>(() => {
    const list: ArtifactItem[] = [];
    const liveAgents = taskData?.agents || [];
    for (const ag of liveAgents) {
      if (ag?.status === 'cancelled') continue;
      const skillResults = ag.skillResults || {};
      for (const [skillName, sr] of Object.entries<any>(skillResults)) {
        if (!sr?.success) continue;
        const data = sr.data || {};
        for (const [k, v] of Object.entries<any>(data)) {
          if (typeof v !== 'string' || !v) continue;
          if (!/_path$/i.test(k)) continue;
          const ext = (v.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
          const type: ArtifactItem['type'] =
            ext === 'md' ? 'markdown' :
            ext === 'csv' ? 'csv' :
            ext === 'json' ? 'json' :
            ext === 'txt' ? 'text' :
            'file';
          const name = v.split(/[\\/]/).pop() || k;
          list.push({
            type,
            name,
            path: v,
            agentId: ag.agentId,
            skillName,
            createdAt: ag.completedAt || ag.startedAt || ag.createdAt || new Date().toISOString(),
          });
        }
      }
    }
    return list;
  }, [taskData]);

  // 合并实时 artifacts + 兜底，按 path/name 去重（实时优先）
  const mergedArtifacts = useMemo<ArtifactItem[]>(() => {
    const seen = new Set<string>();
    const out: ArtifactItem[] = [];
    for (const a of [...artifacts, ...fallbackArtifacts]) {
      const key = `${a.skillName}|${a.path || a.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    return out;
  }, [artifacts, fallbackArtifacts]);

  // v1.1.1：进度兜底 — 完成的 agent 强制 100%，失败的标 failed
  const mergedProgress = useMemo<Record<string, ProgressState>>(() => {
    const out: Record<string, ProgressState> = { ...progressByAgent };
    const liveAgents = taskData?.agents || [];
    for (const ag of liveAgents) {
      if (!ag?.agentId) continue;
      const existing = out[ag.agentId];
      if (ag.status === 'completed') {
        out[ag.agentId] = {
          agentId: ag.agentId,
          skillName: existing?.skillName || ag.assignedSkills?.[0] || '',
          phase: 'done',
          step: existing?.step,
          total: existing?.total,
          percent: 100,
          message: existing?.message || '已完成',
          updatedAt: ag.completedAt || existing?.updatedAt || new Date().toISOString(),
        };
      } else if (ag.status === 'failed' && !existing) {
        out[ag.agentId] = {
          agentId: ag.agentId,
          skillName: ag.assignedSkills?.[0] || '',
          phase: 'failed',
          percent: 0,
          message: ag.error?.message || '执行失败',
          updatedAt: ag.completedAt || new Date().toISOString(),
        };
      }
    }
    return out;
  }, [progressByAgent, taskData]);

  if (loading) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <Skeleton height="h-8" width="w-96" className="mb-2" />
        <Skeleton height="h-4" width="w-64" className="mb-8" />
        <Skeleton height="h-64" />
      </div>
    );
  }
  if (!taskData) return <div className="p-8 text-fg-muted">任务不存在</div>;

  const { task, plan } = taskData;
  const agents = plan?.agents || [];
  const edges = plan?.edges || [];

  return (
    <div className="p-8 max-w-7xl mx-auto animate-fade-in-up">
      <button
        onClick={() => navigate('/tasks')}
        className="text-sm text-fg-muted hover:text-fg-primary mb-4 inline-flex items-center gap-1 cursor-pointer"
      >
        <ArrowLeft className="w-4 h-4" /> 返回任务列表
      </button>

      <div className="flex items-start justify-between mb-6 gap-4">
        <div className="flex-1 min-w-0">
          <GoalDisplay
            goal={task.goal}
            expanded={goalExpanded}
            onToggle={() => setGoalExpanded(v => !v)}
          />
          <div className="flex items-center gap-3 text-xs text-fg-muted mt-2 flex-wrap">
            <span>ID: <span className="font-mono">{task.taskId}</span></span>
            <span>·</span>
            <span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span>
            <span>·</span>
            <ConnectionDot
              state={transport === 'both' ? 'connected' : transport === 'none' ? 'disconnected' : 'partial'}
              label={`传输：${transport.toUpperCase()}`}
            />
            <span>WS {wsConnected ? '✓' : '✗'} · SSE {sseConnected ? '✓' : '✗'}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Tag variant={taskStatusVariant[task.status] || 'default'}>
            {taskStatusLabels[task.status] || task.status}
          </Tag>
          {['planning', 'executing'].includes(task.status) && (
            <Button variant="danger" size="sm" icon={<X className="w-4 h-4" />} onClick={handleCancel}>取消任务</Button>
          )}
          {task.metadata?.kind === 'run' && ['completed', 'failed'].includes(task.status) && (
            <a href={`/api/runs/${taskId}/export.md`} download
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold glass border border-glass-borderStrong text-fg-primary hover:bg-bg-elev/60 cursor-pointer">
              <FileDown className="w-4 h-4" /> 导出报告
            </a>
          )}
        </div>
      </div>

      {agents.length > 0 && (
        <Card className="mb-6">
          <h2 className="font-heading font-semibold text-fg-primary mb-2">执行计划 DAG</h2>
          {plan?.plannerReasoning && (
            <p className="text-sm text-fg-muted mb-4 p-3 bg-bg-panel/50 rounded-lg border border-glass-border">
              {plan.plannerReasoning}
            </p>
          )}
          <AgentDag
            agents={agents}
            edges={edges}
            agentStatuses={agentStatuses}
            progressByAgent={mergedProgress}
          />
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 space-y-4">
          {agents.map((a: any) => {
            const status = agentStatuses[a.agentId] || 'pending';
            const prog = mergedProgress[a.agentId];
            return (
              <Card key={a.agentId} className="!p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-fg-primary">{a.name}</span>
                      <Tag variant={status === 'completed' ? 'success' : status === 'failed' ? 'danger' : status === 'running' ? 'info' : 'default'}>
                        {taskStatusLabels[status] || status}
                      </Tag>
                    </div>
                    <p className="text-xs text-fg-muted line-clamp-2">{a.role}</p>
                    {prog && (
                      <div className="mt-3">
                        <ProgressBar value={prog.percent || 0} status={status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'running'} />
                        <div className="text-xs text-fg-muted mt-1">
                          {prog.message}{prog.step && prog.total ? ` (${prog.step}/${prog.total})` : ''}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        <Card>
          <h3 className="font-heading font-semibold text-fg-primary mb-3 flex items-center gap-2">
            <FileText className="w-4 h-4" /> 产物（{mergedArtifacts.length}）
          </h3>
          {mergedArtifacts.length === 0 ? (
            <p className="text-sm text-fg-muted">暂无产物</p>
          ) : (
            <div className="space-y-2">
              {mergedArtifacts.map((a, i) => (
                <a
                  key={i}
                  href={a.skillName && a.path ? api.artifactUrl(a.skillName, a.path) : '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 p-2 rounded-lg bg-bg-panel/50 hover:bg-bg-elev/50 transition-colors cursor-pointer group"
                >
                  {ARTIFACT_ICONS[a.type] || ARTIFACT_ICONS.file}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-fg-primary truncate">{a.name}</div>
                    <div className="text-xs text-fg-muted">{formatBytes(a.sizeBytes)}</div>
                  </div>
                  <Download className="w-4 h-4 text-fg-muted group-hover:text-brand" />
                </a>
              ))}
            </div>
          )}
        </Card>
      </div>

      {task.error && (
        <Card className="mb-6 border-status-danger/30">
          <h2 className="font-heading font-semibold text-status-danger mb-3">错误信息</h2>
          <pre className="text-sm text-status-danger font-mono whitespace-pre-wrap">{JSON.stringify(task.error, null, 2)}</pre>
        </Card>
      )}

      {task.result && (
        <Card className="mb-6">
          <h2 className="font-heading font-semibold text-fg-primary mb-3">执行结果</h2>
          <pre className="bg-bg-panel/60 rounded-lg p-4 text-xs text-fg-secondary overflow-auto max-h-96 font-mono">
            {JSON.stringify(task.result, null, 2)}
          </pre>
        </Card>
      )}

      <Card>
        <button
          className="w-full flex items-center justify-between font-heading font-semibold text-fg-primary mb-3 cursor-pointer"
          onClick={() => setLogsOpen(v => !v)}
        >
          <span className="flex items-center gap-2">
            实时日志 / 事件时间线
            <Tag variant="default">日志 {logs.length}</Tag>
            <Tag variant="info">事件 {events.length}</Tag>
            {(['completed','failed','cancelled'].includes(task.status)) && (
              <Tag variant="success">已归档</Tag>
            )}
          </span>
          {logsOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        {logsOpen && (
          <div className="font-mono text-xs space-y-1 max-h-96 overflow-auto">
            {logs.length === 0 && events.length === 0 && (
              <EmptyState title="暂无日志" description="任务尚未运行，或事件已被内存与持久化双重淘汰" />
            )}
            {/* 任务完成态下，若日志已被淘汰则给出说明 */}
            {logs.length === 0 && events.length > 0 && ['completed','failed','cancelled'].includes(task.status) && (
              <div className="text-fg-muted bg-bg-panel/40 rounded p-2 mb-1">
                ⓘ 任务已归档：高频日志（skill.log / skill.progress）出于体积考虑不会持久化，
                以下展示从 audit_logs 重建的关键事件时间线。
              </div>
            )}
            {logs.slice(-200).map((log, i) => (
              <div key={`log-${i}`} className="flex items-start gap-2 p-1.5 rounded hover:bg-bg-elev/30">
                <span className="text-fg-disabled">{new Date(log.timestamp).toLocaleTimeString('zh-CN')}</span>
                <span className={`px-1.5 rounded text-[10px] uppercase ${
                  log.level === 'error' ? 'bg-status-danger/20 text-status-danger' :
                  log.level === 'warn' ? 'bg-status-warn/20 text-status-warn' :
                  'bg-bg-elev/40 text-fg-muted'
                }`}>{log.level}</span>
                {log.skillName && <span className="text-brand">{log.skillName}</span>}
                <span className="text-fg-secondary break-all flex-1">{log.message}</span>
              </div>
            ))}
            {events.filter(e => !['skill.log', 'skill.progress'].includes(e.type)).slice(-200).map(e => (
              <div key={`ev-${e.eventId}`} className="flex items-start gap-2 p-1.5 rounded text-fg-muted hover:bg-bg-elev/30">
                <span className="text-fg-disabled">{new Date(e.timestamp).toLocaleTimeString('zh-CN')}</span>
                <span className="px-1.5 rounded bg-bg-elev/40 text-[10px]">{e.type}</span>
                {e.skillName && <span className="text-brand">{e.skillName}</span>}
                {e.payload?.message && <span className="text-fg-secondary break-all flex-1">{String(e.payload.message)}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="mt-4 text-xs text-fg-muted">
        <Link to="/tasks" className="text-brand hover:text-brand-hover cursor-pointer">← 返回列表</Link>
      </div>
    </div>
  );
}

/**
 * 任务目标显示组件
 *  - 默认单行截断（line-clamp-1）+ 省略号
 *  - 文字过长时显示「展开/收起」按钮
 *  - 展开后字体仍保持中等大小，超过一定高度时滚动
 */
function GoalDisplay({
  goal,
  expanded,
  onToggle,
}: {
  goal: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const text = (goal || '').trim();
  const isMultiLine = text.includes('\n') || text.length > 80;

  return (
    <div>
      <div className="flex items-start gap-2">
        {isMultiLine ? (
          <button
            type="button"
            onClick={onToggle}
            title={expanded ? '收起' : '展开完整内容'}
            aria-label={expanded ? '收起' : '展开'}
            className="mt-1 p-1 rounded-md text-fg-muted hover:text-fg-primary hover:bg-bg-elev/40 cursor-pointer transition-colors shrink-0"
          >
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        ) : null}

        {!expanded ? (
          <h1
            className={`text-base font-heading font-semibold text-fg-primary leading-snug flex-1 min-w-0 ${
              isMultiLine ? 'line-clamp-1 cursor-pointer hover:text-brand transition-colors' : ''
            }`}
            onClick={isMultiLine ? onToggle : undefined}
            title={isMultiLine ? text : undefined}
          >
            {text || '（未命名任务）'}
          </h1>
        ) : (
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-heading font-semibold text-fg-primary leading-snug mb-1">
              任务目标（完整）
            </h1>
            <pre
              className="text-xs text-fg-secondary whitespace-pre-wrap break-words font-body leading-relaxed bg-bg-panel/50 border border-glass-border rounded-lg p-3 max-h-64 overflow-auto"
            >
              {text}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
