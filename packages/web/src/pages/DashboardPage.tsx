import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowRight, Cpu, Sparkles, Workflow } from 'lucide-react';
import { api } from '../api/client';
import { Card, Tag, EmptyState, Skeleton } from '../components/ui';

interface Stats {
  tasks: { total: number; byStatus: Record<string, number>; successRate: number };
  agents: { total: number; byStatus: Record<string, number> };
  skills: { total: number; available: number; domains: string[] };
  system: { demoMode: boolean; uptime: number };
}

const statusLabels: Record<string, string> = {
  created: '已创建', planning: '规划中', executing: '执行中',
  completed: '已完成', failed: '已失败', cancelled: '已取消',
  waiting_human: '等待审批', pending: '等待中', running: '运行中', suspended: '已挂起',
};

const statusVariant: Record<string, 'default' | 'success' | 'warn' | 'danger' | 'info' | 'brand'> = {
  created: 'default', planning: 'info', executing: 'info',
  completed: 'success', failed: 'danger', cancelled: 'default',
  waiting_human: 'warn', pending: 'default', running: 'info', suspended: 'warn',
};

function StatCard({ title, value, subtitle, icon, accent }: { title: string; value: string | number; subtitle?: string; icon: React.ReactNode; accent?: string }) {
  return (
    <Card className="glass-hover">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-fg-muted mb-1">{title}</p>
          <p className={`text-3xl font-heading font-bold ${accent || 'text-fg-primary'}`}>{value}</p>
          {subtitle && <p className="text-xs text-fg-muted mt-1">{subtitle}</p>}
        </div>
        <div className="text-fg-muted">{icon}</div>
      </div>
    </Card>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentTasks, setRecentTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    Promise.all([
      api.stats().catch(() => null),
      api.listTasks({ limit: 5 }).catch(() => ({ items: [] })),
    ]).then(([s, t]) => {
      setStats(s);
      setRecentTasks(t?.items || []);
      setLoading(false);
    });
  };

  useEffect(() => {
    load();
    // 控制台同步：10s 轮询刷新统计与最近任务
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, []);

  if (loading) {
    return (
      <div className="p-8 max-w-7xl mx-auto">
        <Skeleton height="h-8" width="w-64" className="mb-2" />
        <Skeleton height="h-4" width="w-96" className="mb-8" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[1,2,3,4].map(i => <Skeleton key={i} height="h-28" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton height="h-64" />
          <Skeleton height="h-64" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto animate-fade-in-up">
      <div className="mb-8">
        <h1 className="text-3xl font-heading font-bold text-fg-primary">控制台</h1>
        <p className="text-fg-muted mt-1">CORAL v1.1.0 · 自动化多智能体协作平台</p>
      </div>

      {stats?.system.demoMode && (
        <div className="mb-6 p-4 glass border border-status-warn/30 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-status-warn mt-0.5" />
          <p className="text-status-warn text-sm font-medium">
            系统当前处于<b>演示模式</b>（--demo 启动）— 所有 LLM 调用返回模拟数据，
            任务结果带 <code className="font-mono">mock: true</code> 标记，不代表真实模型输出。
            重新启动（不带 --demo）即可恢复真实调用。
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard title="总任务数" value={stats?.tasks.total || 0} subtitle="全部任务" icon={<Workflow className="w-6 h-6" />} />
        <StatCard
          title="成功率"
          value={`${stats?.tasks.successRate || 0}%`}
          accent={stats?.tasks.successRate && stats.tasks.successRate >= 80 ? 'text-status-success' : 'text-status-warn'}
          icon={<Activity className="w-6 h-6" />}
        />
        <StatCard
          title="已注册技能"
          value={stats?.skills.available || 0}
          subtitle={`${stats?.skills.domains?.length || 0} 个能力域`}
          icon={<Sparkles className="w-6 h-6" />}
        />
        <StatCard
          title="Agent 实例"
          value={stats?.agents.total || 0}
          subtitle={`运行中 ${stats?.agents.byStatus?.running || 0}`}
          icon={<Cpu className="w-6 h-6" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <h2 className="font-heading font-semibold text-fg-primary mb-4">任务状态分布</h2>
          <div className="space-y-3">
            {Object.entries(stats?.tasks.byStatus || {}).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <Tag variant={statusVariant[status] || 'default'}>{statusLabels[status] || status}</Tag>
                <span className="text-sm font-medium text-fg-primary tabular-nums">{count}</span>
              </div>
            ))}
            {Object.keys(stats?.tasks.byStatus || {}).length === 0 && (
              <EmptyState title="暂无任务数据" description="去对话页提交一个任务" />
            )}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading font-semibold text-fg-primary">最近任务</h2>
            <Link to="/tasks" className="text-xs text-brand hover:text-brand-hover flex items-center gap-1 cursor-pointer">
              查看全部 <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="space-y-2">
            {recentTasks.map((task: any) => (
              <Link
                key={task.taskId}
                to={`/tasks/${task.taskId}`}
                className="block p-3 rounded-lg hover:bg-bg-elev/40 transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-fg-primary truncate flex-1">{task.goal}</p>
                  <Tag variant={statusVariant[task.status] || 'default'}>
                    {statusLabels[task.status] || task.status}
                  </Tag>
                </div>
                <p className="text-xs text-fg-muted mt-1">
                  {new Date(task.createdAt).toLocaleString('zh-CN')}
                </p>
              </Link>
            ))}
            {recentTasks.length === 0 && (
              <EmptyState
                title="暂无任务"
                description="试试用自然语言描述一个目标"
                action={
                  <Link to="/chat" className="text-brand hover:text-brand-hover text-sm cursor-pointer underline">
                    前往对话页
                  </Link>
                }
              />
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
