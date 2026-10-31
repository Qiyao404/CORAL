import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, ArrowRight, Cpu, Sparkles, Workflow } from 'lucide-react';
import { api } from '../api/client';
import { Card, Tag, EmptyState, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';

interface Stats {
  tasks: { total: number; byStatus: Record<string, number>; successRate: number };
  agents: { total: number; byStatus: Record<string, number> };
  skills: { total: number; available: number; domains: string[] };
  system: { demoMode: boolean; uptime: number };
}

const statusLabels: Record<string, string> = {
  created: 'dashboard.statusCreated', planning: 'dashboard.statusPlanning', executing: 'dashboard.statusExecuting',
  completed: 'dashboard.statusCompleted', failed: 'dashboard.statusFailed', cancelled: 'dashboard.statusCancelled',
  waiting_human: 'dashboard.statusWaitingHuman', pending: 'dashboard.statusPending', running: 'dashboard.statusRunning', suspended: 'dashboard.statusSuspended',
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
  const { t } = useI18n();
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
        <h1 className="text-3xl font-heading font-bold text-fg-primary">{t('dashboard.title')}</h1>
        <p className="text-fg-muted mt-1">{t('dashboard.subtitle')}</p>
      </div>

      {stats?.system.demoMode && (
        <div className="mb-6 p-4 glass border border-status-warn/30 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-status-warn mt-0.5" />
          <p className="text-status-warn text-sm font-medium">
            {t('dashboard.demoPrefix')}<b>{t('dashboard.demoMode')}</b>{t('dashboard.demoMid')}<code className="font-mono">mock: true</code>{t('dashboard.demoSuffix')}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard title={t('dashboard.totalTasks')} value={stats?.tasks.total || 0} subtitle={t('dashboard.allTasks')} icon={<Workflow className="w-6 h-6" />} />
        <StatCard
          title={t('dashboard.successRate')}
          value={`${stats?.tasks.successRate || 0}%`}
          accent={stats?.tasks.successRate && stats.tasks.successRate >= 80 ? 'text-status-success' : 'text-status-warn'}
          icon={<Activity className="w-6 h-6" />}
        />
        <StatCard
          title={t('dashboard.registeredSkills')}
          value={stats?.skills.available || 0}
          subtitle={t('dashboard.domainCount', { n: stats?.skills.domains?.length || 0 })}
          icon={<Sparkles className="w-6 h-6" />}
        />
        <StatCard
          title={t('dashboard.agentInstances')}
          value={stats?.agents.total || 0}
          subtitle={t('dashboard.runningCount', { n: stats?.agents.byStatus?.running || 0 })}
          icon={<Cpu className="w-6 h-6" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <h2 className="font-heading font-semibold text-fg-primary mb-4">{t('dashboard.statusDistribution')}</h2>
          <div className="space-y-3">
            {Object.entries(stats?.tasks.byStatus || {}).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between">
                <Tag variant={statusVariant[status] || 'default'}>{t(statusLabels[status] || status)}</Tag>
                <span className="text-sm font-medium text-fg-primary tabular-nums">{count}</span>
              </div>
            ))}
            {Object.keys(stats?.tasks.byStatus || {}).length === 0 && (
              <EmptyState title={t('dashboard.noTaskDataTitle')} description={t('dashboard.noTaskDataDesc')} />
            )}
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading font-semibold text-fg-primary">{t('dashboard.recentTasks')}</h2>
            <Link to="/tasks" className="text-xs text-brand hover:text-brand-hover flex items-center gap-1 cursor-pointer">
              {t('dashboard.viewAll')} <ArrowRight className="w-3 h-3" />
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
                    {t(statusLabels[task.status] || task.status)}
                  </Tag>
                </div>
                <p className="text-xs text-fg-muted mt-1">
                  {new Date(task.createdAt).toLocaleString('zh-CN')}
                </p>
              </Link>
            ))}
            {recentTasks.length === 0 && (
              <EmptyState
                title={t('dashboard.emptyTitle')}
                description={t('dashboard.emptyDesc')}
                action={
                  <Link to="/chat" className="text-brand hover:text-brand-hover text-sm cursor-pointer underline">
                    {t('dashboard.goChat')}
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
