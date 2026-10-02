import type { FastifyInstance } from 'fastify';
import type { RunEngine } from '../kernel/run-engine.js';

/**
 * 创新点④：Run 一键导出 Markdown 报告（时间线 + 结论）— 求职演示利器。
 * GET /api/runs/:id/export.md → text/markdown 附件下载。
 */
export function registerRunExportRoutes(app: FastifyInstance, engine: RunEngine): void {
  app.get('/api/runs/:runId/export.md', async (request, reply) => {
    const { runId } = request.params as any;
    const detail = engine.getRunDetail(runId);
    if (!detail) return reply.status(404).send({ error: 'run 不存在' });

    const { run, events } = detail;
    const md = renderRunMarkdown(run, events);

    reply.header('Content-Type', 'text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="coral-run-${runId}.md"`);
    return md;
  });
}

function renderRunMarkdown(run: any, events: any[]): string {
  const lines: string[] = [];
  lines.push(`# CORAL 运行报告`);
  lines.push('');
  lines.push(`- **Run ID**: \`${run.id}\``);
  lines.push(`- **状态**: ${run.status}${run.end_reason ? `（${run.end_reason}）` : ''}`);
  lines.push(`- **目标**: ${run.goal.replace(/\n/g, ' ')}`);
  lines.push(`- **创建时间**: ${run.created_at}`);
  if (run.completed_at) lines.push(`- **完成时间**: ${run.completed_at}`);
  if (run.session_id) lines.push(`- **会话**: ${run.session_id}`);
  lines.push(`- **Token 用量**: 输入 ${run.tokens_in} / 输出 ${run.tokens_out}`);
  lines.push('');

  lines.push('## 最终回答');
  lines.push('');
  lines.push(run.final_content || '（无最终回答）');
  lines.push('');

  // 工具调用时间线
  const toolEvents = events.filter(e => e.type.startsWith('tool.') || e.type === 'todo.updated');
  if (toolEvents.length > 0) {
    lines.push('## 执行时间线');
    lines.push('');
    lines.push('| 时间 | 事件 | 工具 | 摘要 |');
    lines.push('|------|------|------|------|');
    for (const e of toolEvents) {
      const time = (e.timestamp || '').slice(11, 19);
      const summary = e.type === 'tool.call_started'
        ? shortJson(e.payload?.inputPreview)
        : e.type === 'tool.call_completed' || e.type === 'tool.call_failed'
          ? shortJson(e.payload?.error) || '完成'
          : e.type === 'todo.updated'
            ? `清单更新（${(e.payload?.todos ?? []).length} 项）`
            : '';
      lines.push(`| ${time} | ${e.type} | ${e.tool_name ?? ''} | ${summary} |`);
    }
    lines.push('');
  }

  // 记忆写入（如有）
  const distilled = events.find(e => e.type === 'memory.distilled');
  if (distilled) {
    lines.push('## 记忆归档');
    lines.push('');
    for (const f of distilled.payload?.files ?? []) {
      lines.push(`- \`${f.name}\``);
    }
    lines.push('');
  }

  if (run.error) {
    lines.push('## 错误');
    lines.push('');
    lines.push('```');
    lines.push(typeof run.error === 'string' ? run.error : JSON.stringify(run.error, null, 2));
    lines.push('```');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*由 CORAL — 本地优先个人 Agent 运行时 生成*`);
  return lines.join('\n') + '\n';
}

function shortJson(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.replace(/\|/g, '\\|').slice(0, 60);
}
