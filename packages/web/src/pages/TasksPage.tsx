import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Filter } from 'lucide-react';
import { api } from '../api/client';
import { Card, Tag, Button, EmptyState, Skeleton } from '../components/ui';

const statusLabels: Record<string, string> = {
  created: '已创建', planning: '规划中', executing: '执行中',
  completed: '已完成', failed: '已失败', cancelled: '已取消',
  waiting_human: '等待审批',
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
  { value: '', label: '全部' },
  { value: 'planning', label: '规划中' },
  { value: 'executing', label: '执行中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '已失败' },
];

export default function TasksPage() {
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
          <h1 className="text-2xl font-heading font-bold text-fg-primary">任务中心</h1>
          <p className="text-fg-muted mt-1">管理和监控所有提交的任务</p>
        </div>
        <Link to="/chat">
          <Button icon={<Plus className="w-4 h-4" />}>新建任务</Button>
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
              {opt.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-fg-muted">共 {total} 条</span>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1,2,3].map(i => <Skeleton key={i} height="h-12" />)}
          </div>
        ) : tasks.length === 0 ? (
          <div className="p-6">
            <EmptyState title="暂无任务" description="去对话页或点击右上角新建任务" />
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
                  {statusLabels[task.status] || task.status}
                </Tag>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
