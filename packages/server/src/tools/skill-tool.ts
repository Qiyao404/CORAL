import type { SkillExecutor } from '../skill-runtime/skill-executor.js';
import type { ParsedSkillManifest } from '../types/index.js';
import type { Tool, ToolResult } from './types.js';
import { toolOk, toolError } from './types.js';

/**
 * M1-2：SKILL.md → Tool 适配器 — 文件系统注册表里的技能即刻成为模型可调用工具。
 *
 *  · 工具名 `skill_<name>`（与内置 fs_/http_/shell_/memory_ 命名空间隔离）
 *  · description 取 manifest.description（裁剪 1024 字符保护上下文）
 *  · inputSchema 直接使用 frontmatter 的 input_schema
 *  · 权限：manifest.human_gate=true → approval，否则 auto
 *  · 执行复用 SkillExecutor（取消信号/超时/重试/进度协议全部继承）
 */

const MAX_DESCRIPTION_CHARS = 1024;

export function makeSkillTool(manifest: ParsedSkillManifest, executor: SkillExecutor): Tool {
  return {
    name: `skill_${manifest.name}`,
    description: clip(manifest.description, MAX_DESCRIPTION_CHARS),
    inputSchema: manifest.inputSchema && Object.keys(manifest.inputSchema).length > 0
      ? manifest.inputSchema
      : { type: 'object', properties: {} },
    source: 'skill',
    permission: manifest.humanGate ? 'approval' : 'auto',

    async invoke(input: unknown, ctx): Promise<ToolResult> {
      const result = await executor.execute({
        skillName: manifest.name,
        input: (input && typeof input === 'object' ? input : {}) as Record<string, any>,
        context: {
          taskId: ctx.runId,
          agentId: ctx.agentId,
          abortSignal: ctx.signal,
        },
      });

      if (result.success) {
        return toolOk(result.data ?? {});
      }

      const err = result.error;
      // 工具层不重试（SkillExecutor 内部已有脚本级语义）；取消如实上报
      return toolError(
        err?.code ?? 'SKILL_FAILED',
        err?.message ?? `Skill "${manifest.name}" 执行失败`,
        false
      );
    },
  };
}

function clip(text: string, max: number): string {
  if (!text) return '(no description)';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
