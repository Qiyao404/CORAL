import { useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import { StatusIcon, Tag, ProgressBar } from '../ui';
import type { ProgressState } from '../../hooks/useTaskStream';
import { useTheme } from '../../contexts/ThemeContext';

export interface AgentNodeData {
  name: string;
  role: string;
  skill: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: number;
  message?: string;
}

const STATUS_BORDER: Record<AgentNodeData['status'], string> = {
  pending: 'border-glass-border',
  running: 'border-status-info',
  completed: 'border-status-success',
  failed: 'border-status-danger',
  cancelled: 'border-fg-muted/40 border-dashed',
};

const STATUS_BG: Record<AgentNodeData['status'], string> = {
  pending: 'bg-bg-raise/40',
  running: 'bg-status-info/10 node-running',
  completed: 'bg-status-success/10',
  failed: 'bg-status-danger/10',
  cancelled: 'bg-bg-raise/40 opacity-60',
};

function AgentNode({ data }: NodeProps<AgentNodeData>) {
  return (
    <div className={`glass rounded-xl p-3 w-64 border ${STATUS_BORDER[data.status]} ${STATUS_BG[data.status]}`}>
      <Handle type="target" position={Position.Left} className="!bg-fg-muted !border-0 !w-2 !h-2" />
      <div className="flex items-center gap-2 mb-1">
        <StatusIcon status={data.status} />
        <span className="font-semibold text-sm text-fg-primary truncate flex-1">{data.name}</span>
      </div>
      <div className="text-xs text-fg-muted mt-1 line-clamp-2 min-h-[2em]">{data.role}</div>
      <div className="mt-2 flex items-center gap-2">
        <Tag variant="brand">{data.skill}</Tag>
      </div>
      {data.status === 'running' && typeof data.progress === 'number' && (
        <div className="mt-2">
          <ProgressBar value={data.progress} status="running" compact showText={false} />
          {data.message && (
            <div className="text-[10px] text-fg-muted mt-1 truncate">{data.message}</div>
          )}
        </div>
      )}
      {(data.status === 'completed') && (
        <div className="mt-2 text-xs text-status-success font-mono">100%</div>
      )}
      {data.status === 'cancelled' && (
        <div className="mt-2 text-xs text-fg-muted">已优雅短路</div>
      )}
      <Handle type="source" position={Position.Right} className="!bg-fg-muted !border-0 !w-2 !h-2" />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

function layoutGraph(nodes: Node[], edges: Edge[], direction: 'LR' | 'TB' = 'LR'): Node[] {
  if (nodes.length === 0) return [];
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 50, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    g.setNode(n.id, { width: 256, height: 130 });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  try {
    dagre.layout(g);
  } catch {
    // 极端情况下 dagre 失败，给一个简单线性布局兜底
    return nodes.map((n, i) => ({
      ...n,
      position: { x: i * 280, y: 0 },
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
    }));
  }

  return nodes.map(n => {
    const pos = g.node(n.id);
    if (!pos) return { ...n, position: { x: 0, y: 0 } };
    return {
      ...n,
      position: { x: pos.x - 128, y: pos.y - 65 },
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
    };
  });
}

export interface AgentDagProps {
  agents: any[];
  edges: any[];
  agentStatuses: Record<string, AgentNodeData['status']>;
  progressByAgent: Record<string, ProgressState>;
}

export function AgentDag({ agents, edges, agentStatuses, progressByAgent }: AgentDagProps) {
  const { effective } = useTheme();
  const isDark = effective === 'dark';

  // 把 nodes + edges 放在同一个 useMemo 中，避免之前的 TDZ 循环引用
  const { flowNodes, flowEdges } = useMemo(() => {
    const completedColor = '#22C55E';
    const idleStroke = isDark ? '#475569' : '#CBD5E1';
    const labelFill = isDark ? '#94A3B8' : '#64748B';
    const labelBg   = isDark ? '#0F172A' : '#FFFFFF';

    const rawNodes: Node<AgentNodeData>[] = (agents || []).map(a => ({
      id: a.agentId,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        name: a.name,
        role: a.role,
        skill: (a.assignedSkills || [])[0] || '',
        status: agentStatuses[a.agentId] || 'pending',
        progress: progressByAgent[a.agentId]?.percent,
        message: progressByAgent[a.agentId]?.message,
      } as AgentNodeData,
    }));

    const rawEdges: Edge[] = (edges || []).map((e: any, idx: number) => ({
      id: `e-${idx}`,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      animated: agentStatuses[e.from] === 'running' || agentStatuses[e.from] === 'completed',
      style: {
        stroke: agentStatuses[e.from] === 'completed' ? completedColor : idleStroke,
        strokeWidth: 2,
        strokeDasharray: agentStatuses[e.from] === 'completed' ? '0' : '4 4',
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: completedColor },
      label: e.dataMapping ? Object.keys(e.dataMapping).join(', ') : '',
      labelStyle: { fill: labelFill, fontSize: 10 },
      labelBgStyle: { fill: labelBg, fillOpacity: 0.85 },
    }));

    const laidOut = layoutGraph(rawNodes as Node[], rawEdges) as Node<AgentNodeData>[];
    return { flowNodes: laidOut, flowEdges: rawEdges };
  }, [agents, edges, agentStatuses, progressByAgent, isDark]);

  if (!flowNodes || flowNodes.length === 0) {
    return (
      <div className="w-full h-32 glass rounded-2xl flex items-center justify-center text-fg-muted text-sm">
        暂无可视化的执行节点（任务可能仍在规划中）
      </div>
    );
  }

  return (
    <div className="w-full h-[400px] glass rounded-2xl">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background color={isDark ? '#1E293B' : '#CBD5E1'} gap={16} />
        <Controls className="!bg-bg-panel !border-glass-border [&_button]:!bg-bg-panel [&_button]:!border-glass-border [&_button]:!text-fg-secondary" />
      </ReactFlow>
    </div>
  );
}
