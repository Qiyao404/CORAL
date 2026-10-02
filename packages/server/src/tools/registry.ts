import type { Tool, ToolContext, ToolResult } from './types.js';
import { TOOL_NAME_REGEX } from './types.js';
import { makeSkillTool } from './skill-tool.js';
import { httpFetchTool } from './builtin/http.js';
import { fsTools } from './builtin/fs.js';
import { makeShellTool } from './builtin/shell.js';
import type { FilesystemSkillRegistry } from '../skill-runtime/filesystem-registry.js';
import type { SkillExecutor } from '../skill-runtime/skill-executor.js';

/**
 * M1-2：ToolRegistry — 三源工具的统一注册与查找。
 *
 * agent loop（M1-3）从这里取 listDefinitions() 喂给 provider 的 function calling，
 * 模型回包后经 invoke() 执行。审批（approval 权限位）由 loop 层接管，registry 本身
 * 只做纯执行 — 保持可测试性。
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (!TOOL_NAME_REGEX.test(tool.name)) {
      throw new Error(`非法工具名: ${tool.name}（须匹配 ${TOOL_NAME_REGEX}）`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`工具名冲突: ${tool.name} 已注册`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 替换同名工具（skill 热重载用） */
  replace(tool: Tool): void {
    if (!TOOL_NAME_REGEX.test(tool.name)) {
      throw new Error(`非法工具名: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** 供 function calling 的定义列表（name/description/inputSchema） */
  listDefinitions(): Array<{ name: string; description: string; inputSchema: Record<string, any> }> {
    return this.list().map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async invoke(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      return { ok: false, error: { code: 'TOOL_NOT_FOUND', message: `工具不存在: ${name}`, retryable: false } };
    }
    ctx.signal.throwIfAborted?.();
    return tool.invoke(input, ctx);
  }

  /** 从 skill 文件系统注册表同步全部技能为工具（启动与热重载时调用），返回数量 */
  syncSkillTools(skillRegistry: FilesystemSkillRegistry, executor: SkillExecutor): number {
    const manifests = skillRegistry.listAvailable();
    const liveNames = new Set<string>();
    for (const manifest of manifests) {
      const name = `skill_${manifest.name}`;
      liveNames.add(name);
      const existing = this.get(name);
      // fileHash 未变则跳过（避免热重载时无谓替换）
      if (existing && (existing as any).__fileHash === manifest.fileHash) continue;
      const tool = makeSkillTool(manifest, executor);
      (tool as any).__fileHash = manifest.fileHash;
      this.replace(tool);
    }
    // 已下线的技能工具一并摘除
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith('skill_') && !liveNames.has(name)) {
        this.unregister(name);
      }
    }
    return manifests.length;
  }
}

export interface DefaultRegistryOptions {
  skillRegistry: FilesystemSkillRegistry;
  skillExecutor: SkillExecutor;
  /** D13：shell_run 默认关闭；SHELL_TOOL_ENABLED 显式开启 */
  enableShell?: boolean;
  /** fs 工具是否注册（M1-10 工作区绑定前可不注册；默认注册，运行时由 workspaceDir 守卫） */
  includeFs?: boolean;
}

/** 默认 registry：内置工具 + 全部可用技能 */
export function createDefaultToolRegistry(options: DefaultRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(httpFetchTool);
  if (options.includeFs !== false) {
    for (const tool of fsTools) registry.register(tool);
  }
  if (options.enableShell) {
    registry.register(makeShellTool());
  }
  registry.syncSkillTools(options.skillRegistry, options.skillExecutor);
  return registry;
}
