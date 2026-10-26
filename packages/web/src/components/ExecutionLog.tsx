import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2, XCircle, Loader2, ChevronDown, ChevronRight,
  ListTodo, FileText, Globe, Search, Brain, Users, FileEdit,
  FilePlus, Wrench, Circle, Zap,
} from 'lucide-react';

/**
 * 执行过程 UI v2 — 逐步操作日志（截图风格）。
 * 替代旧 ToolCardsView：不再是展开式工具卡片，而是垂直时间线上的一行行操作，
 * 每行 = 人话描述 + 状态图标 + 可展开的详细输入/输出。
 */

export interface ToolCardItem {
  callId: string;
  tool: string;
  agentId: string;
  status: 'running' | 'ok' | 'failed';
  inputPreview?: string;
  resultPreview?: string;
  error?: string;
}

export interface TodoItem {
  content: string;
  status: string;
}

/** 把工具调用翻译成一行人话 + 图标 */
function describeAction(card: ToolCardItem): { icon: typeof FileText; text: string } {
  const input = card.inputPreview ?? '';
  const tryMatch = (re: RegExp): string | null => {
    const m = input.match(re);
    return m ? m[1] : null;
  };

  const path = tryMatch(/"path"\s*:\s*"([^"]{1,60})"/);
  const url = tryMatch(/"url"\s*:\s*"([^"]{1,60})"/);
  const query = tryMatch(/"query"\s*:\s*"([^"]{1,40})"/);
  const goal = tryMatch(/"goal"\s*:\s*"([^"]{1,40})"/);

  switch (card.tool) {
    case 'fs_list':
      return { icon: FileText, text: `查看文件列表${path ? ` · ${path}` : ''}` };
    case 'fs_read':
      return { icon: FileText, text: `读取文件 ${path ?? ''}` };
    case 'fs_write':
      return { icon: FilePlus, text: `写入文件 ${path ?? ''}` };
    case 'fs_edit':
      return { icon: FileEdit, text: `编辑文件 ${path ?? ''}` };
    case 'fs_search':
      return { icon: Search, text: `搜索 "${query ?? ''}"${path ? ` in ${path}` : ''}` };
    case 'docx_read':
      return { icon: FileText, text: `读取 Word ${path ?? ''}` };
    case 'docx_write':
      return { icon: FilePlus, text: `生成 Word ${path ?? ''}` };
    case 'http_fetch':
      return { icon: Globe, text: `访问网页 ${url ?? ''}` };
    case 'todo_write':
      return { icon: ListTodo, text: `更新任务清单` };
    case 'memory_search':
      return { icon: Brain, text: `查找记忆 "${query ?? ''}"` };
    case 'memory_write':
      return { icon: Brain, text: `记录到长期记忆` };
    case 'memory_read':
    case 'memory_list':
      return { icon: Brain, text: `读取长期记忆` };
    case 'agent_spawn':
      return { icon: Users, text: `派出子代理：${goal ?? '执行子任务'}` };
    case 'past_runs':
      return { icon: Search, text: `查找历史运行` };
    case 'shell_run':
      return { icon: Zap, text: `执行命令` };
    default:
      if (card.tool.startsWith('skill_')) {
        return { icon: Wrench, text: `执行技能 ${card.tool.replace('skill_', '')}` };
      }
      return { icon: Wrench, text: card.tool };
  }
}

/** 单条操作行 */
function ActionRow({ card }: { card: ToolCardItem }) {
  const [open, setOpen] = useState(false);
  const { icon: Icon, text } = describeAction(card);
  const isSub = card.agentId !== 'main';

  return (
    <div className={`group relative ${isSub ? 'ml-4' : ''}`}>
      {/* 时间线连接线 */}
      <div className="absolute left-[9px] top-[22px] bottom-[-6px] w-px bg-glass-border group-last:hidden" />

      <button
        className="w-full flex items-start gap-2 py-[3px] cursor-pointer text-left"
        onClick={() => setOpen(o => !o)}
      >
        {/* 状态图标 */}
        <span className="shrink-0 mt-[1px] w-[18px] h-[18px] flex items-center justify-center">
          {card.status === 'running' ? <Loader2 className="w-3.5 h-3.5 text-status-info animate-spin" />
           : card.status === 'ok' ? <CheckCircle2 className="w-3.5 h-3.5 text-status-success" />
           : <XCircle className="w-3.5 h-3.5 text-status-danger" />}
        </span>

        {/* 图标 + 描述 */}
        <span className="flex items-center gap-1.5 min-w-0 flex-1">
          <Icon className={`w-3 h-3 shrink-0 ${card.status === 'ok' ? 'text-fg-muted' : 'text-fg-secondary'}`} />
          <span className={`text-xs truncate ${card.status === 'running' ? 'text-fg-primary font-medium' : card.status === 'failed' ? 'text-status-danger' : 'text-fg-secondary'}`}>
            {text}
          </span>
          {isSub && <span className="text-[9px] text-brand/60 shrink-0 font-mono">{card.agentId.slice(0, 8)}</span>}
        </span>

        {/* 展开箭头 */}
        {(card.inputPreview || card.resultPreview || card.error) && (
          <span className="shrink-0 mt-[2px]">
            {open ? <ChevronDown className="w-3 h-3 text-fg-muted" /> : <ChevronRight className="w-3 h-3 text-fg-disabled group-hover:text-fg-muted" />}
          </span>
        )}
      </button>

      {/* 展开的详情 */}
      {open && (
        <div className="ml-[26px] mb-1 space-y-1 expand-anim">
          {card.inputPreview && (
            <div>
              <p className="text-[9px] text-fg-muted mb-0.5 uppercase tracking-wide">Input</p>
              <pre className="bg-bg-elev/60 border border-glass-border/50 rounded px-2 py-1 text-[10px] font-mono text-fg-secondary overflow-auto max-h-28 whitespace-pre-wrap break-all">{card.inputPreview}</pre>
            </div>
          )}
          {card.resultPreview && (
            <div>
              <p className="text-[9px] text-fg-muted mb-0.5 uppercase tracking-wide">Result</p>
              <pre className="bg-bg-elev/60 border border-glass-border/50 rounded px-2 py-1 text-[10px] font-mono text-fg-secondary overflow-auto max-h-36 whitespace-pre-wrap break-all">{card.resultPreview}</pre>
            </div>
          )}
          {card.error && <p className="text-[10px] text-status-danger bg-status-danger/5 border border-status-danger/20 rounded px-2 py-1">{card.error}</p>}
        </div>
      )}
    </div>
  );
}

/** 主组件：任务清单 + 操作时间线 */
export function ExecutionLogView({ todos, toolCards, running }: {
  todos: TodoItem[];
  toolCards: ToolCardItem[];
  running?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastCardId = toolCards.at(-1)?.callId;

  // 直播时自动滚动到最新操作
  useEffect(() => {
    if (running && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lastCardId, running]);

  const completed = todos.filter(t => t.status === 'completed').length;

  return (
    <div className="space-y-2">
      {/* 任务清单（有 todo 时显示） */}
      {todos.length > 0 && (
        <div className="pb-1">
          <div className="flex items-center gap-1.5 mb-1">
            <ListTodo className="w-3 h-3 text-fg-muted" />
            <span className="text-[10px] text-fg-muted font-medium">任务清单</span>
            <span className={`text-[9px] px-1 py-px rounded ${completed === todos.length ? 'bg-status-success/10 text-status-success' : 'bg-status-info/10 text-status-info'}`}>
              {completed}/{todos.length}
            </span>
          </div>
          <div className="space-y-[2px] pl-1">
            {todos.map((t, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[11px] leading-4">
                {t.status === 'completed' ? <CheckCircle2 className="w-3 h-3 text-status-success shrink-0" />
                 : t.status === 'in_progress' ? <Loader2 className="w-3 h-3 text-status-info animate-spin shrink-0" />
                 : <Circle className="w-3 h-3 text-fg-disabled shrink-0" />}
                <span className={t.status === 'completed' ? 'text-fg-muted line-through' : 'text-fg-secondary'}>{t.content}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {todos.length === 0 && running && (
        <p className="text-[11px] text-fg-muted">正在制定计划…</p>
      )}

      {/* 操作时间线 */}
      {toolCards.length > 0 && (
        <div className="pt-1">
          <div className="flex items-center gap-1.5 mb-1">
            <Zap className="w-3 h-3 text-fg-muted" />
            <span className="text-[10px] text-fg-muted font-medium">操作步骤</span>
            <span className="text-[9px] text-fg-disabled">{toolCards.length} 步</span>
          </div>
          <div ref={scrollRef} className="space-y-0 max-h-none">
            {toolCards.map(card => (
              <ActionRow key={card.callId} card={card} />
            ))}
          </div>
        </div>
      )}
      {toolCards.length === 0 && running && (
        <p className="text-[11px] text-fg-muted">等待 agent 开始执行…</p>
      )}
    </div>
  );
}
