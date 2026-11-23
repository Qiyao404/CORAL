import type { SkillExecutor } from '../skill-runtime/skill-executor.js';
import type { ParsedSkillManifest } from '../types/index.js';
import type { Tool, ToolEffects, ToolResult } from './types.js';
import { toolOk, toolError } from './types.js';

/**
 * M1-2：SKILL.md → Tool 适配器 — 文件系统注册表里的技能即刻成为模型可调用工具。
 *
 *  · 工具名 `skill_<name>`（与内置 fs_/http_/shell_/memory_ 命名空间隔离）
 *  · description 取 manifest.description（裁剪 1024 字符保护上下文）
 *  · inputSchema 直接使用 frontmatter 的 input_schema
 *  · 权限：manifest.human_gate=true → approval，否则 auto
 *  · 执行复用 SkillExecutor（取消信号/超时/重试/进度协议全部继承）
 *
 * 效果契约（REG-22）— 脚本类技能分两种，风险完全不同：
 *  · 入参是**数据**（web-search 的查询词…）：执行的是技能包自带的固定程序，不构成
 *    launchesProcess / executesForeignCode 意义上的"外部代码"（否则每次联网搜索都要人工审批）
 *  · 入参是**模型写的代码**（accepts_code）：必须在清单里声明 sandboxed，效果标记
 *    runsSandboxedCode（可审计）。声明了接收代码却没有沙箱 → 直接拒绝执行并提升为审批：
 *    "没声明沙箱"不能被当成"不需要沙箱"。
 */

const MAX_DESCRIPTION_CHARS = 1024;

export function skillToolEffects(manifest: Pick<ParsedSkillManifest, 'executionMode' | 'acceptsCode' | 'sandboxed'>): ToolEffects | undefined {
  if (manifest.executionMode !== 'script' || !manifest.acceptsCode) return undefined;
  return manifest.sandboxed ? { runsSandboxedCode: true } : { executesForeignCode: true };
}

export function makeSkillTool(manifest: ParsedSkillManifest, executor: SkillExecutor): Tool {
  const effects = skillToolEffects(manifest);
  const unsandboxedCode = effects?.executesForeignCode === true;
  return {
    name: `skill_${manifest.name}`,
    description: clip(manifest.description, MAX_DESCRIPTION_CHARS),
    inputSchema: manifest.inputSchema && Object.keys(manifest.inputSchema).length > 0
      ? manifest.inputSchema
      : { type: 'object', properties: {} },
    source: 'skill',
    // 接收模型代码却未声明沙箱：恒审批（且下方 invoke 仍会拒绝 — 审批不是沙箱的替代品）
    permission: manifest.humanGate || unsandboxedCode ? 'approval' : 'auto',
    ...(effects ? { effects } : {}),

    async invoke(input: unknown, ctx): Promise<ToolResult> {
      if (unsandboxedCode) {
        return toolError(
          'SANDBOX_REQUIRED',
          `技能 "${manifest.name}" 接收模型生成的代码，但没有声明执行沙箱（SKILL.md 缺少 sandboxed: true）— 已拒绝执行。`,
          false
        );
      }
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
