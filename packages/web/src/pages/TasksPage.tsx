import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Filter } from 'lucide-react';
import { api } from '../api/client';
import { Card, Tag, Button, EmptyState, Skeleton } from '../components/ui';
import { useI18n } from '../i18n';

const statusLabels: Record<string, string> = {
  created: 'tasks.statusCreated', planning: 'tasks.statusPlanning', executing: 'tasks.statusExecuting',
  completed: 'tasks.statusCompleted', failed: 'tasks.statusFailed', cancelled: 'tasks.statusCancelled',
  waiting_human: 'tasks.statusWaitingHuman',
};

const statusVariant: Record<string, 'default' | 'success' | 'warn' | 'danger' | 'info'> = {
  created: 'default',
  planning: 'info',
  executing: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'default',
  waiting_human: 'warn',
};

const filterOptions = [
  { value: '', label: 'tasks.filterAll' },
  { value: 'planning', label: 'tasks.filterPlanning' },
  { value: 'executing', label: 'tasks.filterExecuting' },
  { value: 'completed', label: 'tasks.filterCompleted' },
  { value: 'failed', label: 'tasks.filterFailed' },
];

export default function TasksPage() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const loadSeq = useRef(0);
  const loadTasks = () => {
    const mySeq = ++loadSeq.current; // 审查 P3：慢响应后到不覆盖新筛选结果
    setLoading(true);
    api.listTasks({ status: filter || undefined, limit: 100 })
      .then(res => {
        if (mySeq !== loadSeq.current) return;
        setTasks(res.items || []);
        setTotal(res.total || 0);
      })
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadTasks(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  return (
    <div className="p-8 max-w-7xl mx-auto animate-fade-in-up">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-heading font-bold text-fg-primary">{t('tasks.title')}</h1>
          <p className="text-fg-muted mt-1">{t('tasks.subtitle')}</p>
        </div>
        <Link to="/chat">
          <Button icon={<Plus className="w-4 h-4" />}>{t('tasks.newTask')}</Button>
        </Link>
      </div>

      <Card className="!p-0 overflow-hidden">
        <div className="p-4 border-b border-glass-border flex items-center gap-3">
          <Filter className="w-4 h-4 text-fg-muted" />
          {filterOptions.map(opt => (
            <button
              key={opt.value}
              onClick={() => setFilter(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                filter === opt.value
                  ? 'bg-brand-soft text-brand border border-brand/30'
                  : 'text-fg-muted hover:bg-bg-elev/40 border border-transparent'
              }`}
            >
              {t(opt.label)}
            </button>
          ))}
          <span className="ml-auto text-xs text-fg-muted">{t('tasks.totalCount', { n: total })}</span>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1,2,3].map(i => <Skeleton key={i} height="h-12" />)}
          </div>
        ) : tasks.length === 0 ? (
          <div className="p-6">
            <EmptyState title={t('tasks.emptyTitle')} description={t('tasks.emptyDesc')} />
          </div>
        ) : (
          <div className="divide-y divide-glass-border">
            {tasks.map(task => (
              <Link
                key={task.taskId}
                to={`/tasks/${task.taskId}`}
                className="flex items-center gap-4 p-4 hover:bg-bg-elev/30 transition-colors cursor-pointer"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-fg-primary truncate">{task.goal}</p>
                  <p className="text-xs text-fg-muted mt-1">
                    ID: {task.taskId.substring(0, 8)}... · {new Date(task.createdAt).toLocaleString('zh-CN')}
                  </p>
                </div>
                <Tag variant={statusVariant[task.status] || 'default'}>
                  {t(statusLabels[task.status] || task.status)}
                </Tag>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
