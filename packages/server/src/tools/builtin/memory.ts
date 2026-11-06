import type { Tool } from '../types.js';
import { toolOk, toolError } from '../types.js';
import type { MemoryService } from '../../services/memory-service.js';
import { routeNewMemory, appendToMemory, autoConsolidate, type LlmChat as RouterLlm } from '../../services/memory-router.js';

/**
 * M1-11（D18）：文件式记忆四工具 — agent 的长期记忆读写。
 * 全部 auto 权限（记忆目录有边界，文件名消毒防穿越）。
 */

export function makeMemoryTools(service: MemoryService, llm?: RouterLlm, automationSession = false): Tool[] {
  const list: Tool = {
    name: 'memory_list',
    description:
      'List long-term memory files (topic-based markdown). Check before writing to update existing topics instead of duplicating.',
    inputSchema: { type: 'object', required: [], properties: {} },
    source: 'builtin',
    permission: 'auto',
    async invoke() {
      const files = service.list();
      return toolOk({ files, count: files.length, note: files.length === 0 ? '记忆为空' : undefined });
    },
  };

  const read: Tool = {
    name: 'memory_read',
    description: 'Read one long-term memory file by name (from memory_list).',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', description: 'File name from memory_list (e.g. user-preferences.md)' } },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any) {
      const r = service.read(String(input?.name ?? ''));
      if (!r) return toolError('NOT_FOUND', `记忆文件不存在: ${input?.name}`);
      return toolOk({ content: r.content, truncated: r.truncated, size: r.size, trust: r.trust });
    },
  };

  const write: Tool = {
    name: 'memory_write',
    description:
      'Write a long-term memory file (create-only by default: writing over an existing file requires overwrite=true). ' +
      'Use for durable facts: user preferences, corrections, project conventions, lessons learned. ' +
      'Read the existing file first and merge your update into it — do not create near-duplicate topic files. ' +
      'IMPORTANT: the file name parameter is called "name" (e.g. "user-preferences.md").',
    inputSchema: {
      type: 'object',
      required: ['name', 'content'],
      properties: {
        name: { type: 'string', description: 'Short kebab-case topic file name (e.g. "user-preferences.md"). NOT "topic".' },
        content: { type: 'string', description: 'Full markdown content of the file' },
        overwrite: { type: 'boolean', description: 'Must be explicitly true to replace an existing file (default false — create-only)' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any, ctx: any) {
      if (typeof input?.content !== 'string' || !input.content.trim()) {
        return toolError('BAD_INPUT', 'content 必须为非空字符串');
      }
      // 健壮性（用户实测反馈）：模型常用 topic/filename 误作参数名 — 接受别名
      const rawName = input?.name ?? input?.topic ?? input?.filename;
      if (rawName === undefined || rawName === null || String(rawName).trim() === '') {
        return toolError('BAD_INPUT', '缺少文件名参数：请用 "name" 传入主题文件名（如 "user-preferences.md"）');
      }
      // 防覆盖守卫（create-only 语义）：覆盖既有记忆必须显式声明 —
      // 先 memory_read 看过原文、确认要替换，再带 overwrite=true 重写
      if (service.exists(String(rawName)) && input?.overwrite !== true) {
        return toolError(
          'MEMORY_EXISTS',
          `记忆文件 ${String(rawName)} 已存在。要更新请先 memory_read 读原文，把新内容合并进去后以 overwrite=true 整体写入；要另立主题请换文件名。`,
          false
        );
      }
      try {
        // 记忆自动归档：新建文件前由平台路由（主题匹配并入 / 按准入标准拒绝；LLM 不可用时回落原行为）
        let finalName = String(rawName);
        let routed: 'create' | 'append' = 'create';
        if (!service.exists(finalName) && llm) {
          // 评测隔离：自动化 run（gaia-eval-session 等标识性会话）的 memory_write 默认拒
          if (automationSession) {
            return toolError(
              'MEMORY_AUTOMATION_BLOCKED',
              '当前为自动化/评测 run，长期记忆写入已隔离（评测经验不污染用户记忆库）。用户交互式会话不受影响。',
              false
            );
          }
          const decision = await routeNewMemory(service, llm, finalName, input.content);
          if (decision.action === 'reject') {
            return toolError(
              'MEMORY_REJECTED',
              `长期记忆准入拒绝：${decision.reason ?? '不符合准入标准'}。这类信息（环境快照/对话复述/易失状态）通过 fs_list、session_search 等工具随时可查，不占长期记忆。如果是用户明确交代要记住的，请在 content 开头加 "[user-instructed]" 标记后重试。`,
              false
            );
          }
          if (decision.action === 'append') {
            appendToMemory(service, decision.target, input.content, finalName);
            routed = 'append';
            finalName = decision.target;
          } else {
            finalName = service.exists(decision.target) ? String(rawName) : decision.target;
          }
        }
        const w = routed === 'append'
          ? { name: finalName, bytes: Buffer.byteLength(input.content, 'utf-8'), truncated: false }
          : service.write(finalName, input.content);
        // 写入后检查超量整理（fire-and-forget，失败不影响写入结果）
        if (llm) void autoConsolidate(service, llm, 15).catch(() => {});
        return routed === 'append'
          ? toolOk(
              { written: w.name, bytes: w.bytes, action: 'append', routedFrom: String(rawName), note: `主题与既有记忆匹配，已并入 ${finalName}（原文保留，新内容作为新小节追加）` },
              `已并入 ${finalName}（原拟名 ${String(rawName)}，原文保留）`
            )
          : toolOk({ written: w.name, bytes: w.bytes, truncated: w.truncated });
      } catch (err: any) {
        return toolError(
          'BAD_NAME',
          `文件名 "${String(rawName)}" 无法使用：${err?.message ?? '非法'}。请改用简洁的 kebab-case 主题名（如 "user-preferences.md"），并以 "name" 参数传入`,
          false
        );
      }
    },
  };

  const review: Tool = {
    name: 'memory_review',
    description:
      'Mark a long-term memory file as reviewed (user confirmed its content is accurate). ' +
      'Only call this when the user has actually verified/endorsed the memory — e.g. they confirmed a preference or corrected-and-approved content.',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Memory file name from memory_list' },
      },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any) {
      const name = String(input?.name ?? '');
      if (!service.exists(name)) return toolError('NOT_FOUND', `记忆文件不存在: ${name}`);
      const ok = service.setTrust(name, 'reviewed');
      return ok ? toolOk({ reviewed: name }) : toolError('BAD_NAME', `无法标记: ${name}`);
    },
  };

  const search: Tool = {
    name: 'memory_search',
    description:
      'Search long-term memory by keywords (case-insensitive; space-separated terms must all appear on the same line). ' +
      'Search at the start of a task for relevant user preferences or past lessons.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string', description: 'Keyword(s), space-separated (AND)' } },
    },
    source: 'builtin',
    permission: 'auto',
    async invoke(input: any) {
      const query = String(input?.query ?? '').trim();
      if (!query) return toolError('BAD_INPUT', 'query 必填');
      const r = service.search(query);
      return toolOk({
        matches: r.matches,
        scannedFiles: r.scannedFiles,
        truncated: r.truncated,
        // 不完整召回必须如实报告（宁可说"未扫完"也不谎报"没有"）
        incomplete: r.truncated,
        note: r.matches.length === 0
          ? (r.truncated ? '未找到匹配（注意：结果已达上限，扫描可能不完整 — 可换更具体的关键词再试）' : '无匹配记忆')
          : r.truncated ? '结果已达上限，可能还有更多匹配' : undefined,
      });
    },
  };

  return [list, read, write, search, review];
}

/** 注入 agent 系统提示的记忆使用指引（D18：何时读/写/更新） */
export const MEMORY_GUIDE = `## Long-term memory
You have file-based long-term memory tools (memory_list / memory_read / memory_write / memory_review / memory_search).
- At the start of a task, run 1-2 memory_search queries with keywords about the user, the project, or the task type — apply what you find.
- When you learn a durable fact (user preference, correction, project convention, useful lesson), record it with memory_write. Read the existing topic file first and merge into it; replacing an existing file requires overwrite=true (create-only guard).
- When the user explicitly confirms a remembered fact is correct, mark it with memory_review.
- Never memorize volatile task details or one-off data. When in doubt, skip writing.`;

