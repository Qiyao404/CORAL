import type { Tool, ToolResult } from '../types.js';
import { toolOk, toolError } from '../types.js';
import type { EvidenceStore } from '../../kernel/evidence.js';

/**
 * evidence_read — 读取证据记录（summary-first 配套工具）。
 *
 * 大结果被归档后，模型（以及后续工具轮次）通过本工具按 ID 取回完整内容，
 * 支持字符级翻页（offset/limit）。只读、幂等。
 */
export function makeEvidenceReadTool(store: EvidenceStore): Tool {
  return {
    name: 'evidence_read',
    description:
      'Read back an archived evidence record (large tool results are stored as evidence instead of staying in context). ' +
      'Pass the evidence_id from a previous tool result note; supports character-level paging via offset/limit.',
    inputSchema: {
      type: 'object',
      required: ['evidence_id'],
      properties: {
        evidence_id: { type: 'string', description: 'Evidence record ID, e.g. "ev-xxxx-xxxx" (from a tool result note)' },
        offset: { type: 'integer', description: 'Character offset to start reading from (default 0)' },
        limit: { type: 'integer', description: 'Max characters to read (default 8000)' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    effects: { idempotent: true },
    isConcurrencySafe: true,
    // 分页取回本身就是按需读取（limit 钳制 ≤60k）— 结果不再转存证据
    //（曾出现"证据的证据"循环归档：12k 的取回页又被归档成新证据）
    maxResultSizeChars: 70_000,

    async invoke(input: any, ctx): Promise<ToolResult> {
      const id = String(input?.evidence_id ?? '').trim();
      if (!id) return toolError('BAD_INPUT', 'evidence_id 必填');
      const offset = Math.max(0, Number(input?.offset) || 0);
      const limit = Math.min(Math.max(Number(input?.limit) || 8000, 500), 60_000);
      const r = store.read(ctx.runId, id, offset, limit);
      if (!r) {
        const available = store.list(ctx.runId);
        return toolError(
          'EVIDENCE_NOT_FOUND',
          `证据记录 ${id} 不存在（本 run 可用: ${available.map(x => `${x.id}(${x.tool}, ${x.chars}字符)`).join(', ') || '无'}）`
        );
      }
      return toolOk({
        evidenceId: r.record.id,
        tool: r.record.tool,
        totalChars: r.record.chars,
        offset: r.offset,
        hasMore: r.hasMore,
        content: r.page,
      });
    },
  };
}
