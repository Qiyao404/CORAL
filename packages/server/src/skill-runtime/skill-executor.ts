import { spawn, spawnSync } from 'child_process';
import { join, basename, isAbsolute } from 'path';
import { existsSync, statSync, readFileSync } from 'fs';
import { platform } from 'os';

/**
 * 在 Windows 上 python 可执行文件的常见名是 `py` 或 `python.exe`；
 * macOS/Linux 通常是 `python3` / `python`。
 * 这里做一次启动期探测，缓存结果。
 */
const PYTHON_CACHE: { resolved?: string } = {};
function detectPython(): string {
  if (PYTHON_CACHE.resolved) return PYTHON_CACHE.resolved;
  const isWin = platform() === 'win32';
  const candidates = isWin ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: true });
      if (result.status === 0) {
        PYTHON_CACHE.resolved = cmd;
        return cmd;
      }
    } catch { /* keep trying */ }
  }
  return isWin ? 'python' : 'python3';
}

function resolveRuntimeCommand(runtime: string): string {
  if (runtime === 'python3' || runtime === 'py' || runtime === 'python') {
    return detectPython();
  }
  return runtime;
}
import type { SkillExecutionRequest, SkillExecutionResult, ParsedSkillManifest } from '../types/index.js';
import { llmClient } from '../services/llm-client.js';
import { eventBus } from '../event/event-bus.js';
import type { FilesystemSkillRegistry } from './filesystem-registry.js';
import { ProgressParser } from './progress-parser.js';
import { killProcessTree } from './kill-tree.js';
import { buildSandboxEnv } from './sandbox-env.js';
import { platformConfig } from '../services/config.js';
import { getCompanyProfile, mergeCompanyProfile } from '../services/company-profile-service.js';

/**
 * 统一 Skill 执行入口 — 根据 execution_mode 分发到不同路径
 * v1.1.0 升级：
 *  · LLM 路径采用 streaming，按 chunk emit `skill.log`（source=llm_stream）+ Mock 假进度
 *  · Script 路径 stderr 实时按 [CORAL_PROGRESS] 协议解析，emit `skill.progress` / `skill.log`
 *  · 自动从 result 中识别产物字段（md_path/csv_path/...）emit `skill.artifact`
 *  · 公司画像（CompanyProfile）按 manifest.consumesCompanyProfile 自动注入
 */
export class SkillExecutor {
  private registry: FilesystemSkillRegistry;

  constructor(registry: FilesystemSkillRegistry) {
    this.registry = registry;
  }

  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const manifest = this.registry.getByName(request.skillName);

    if (!manifest) {
      return this.errorResult(`Skill "${request.skillName}" 未找到`, startTime);
    }

    // M0-2：已取消 → 直接返回，不发事件（agent.cancelled 已足够）
    if (request.context.abortSignal?.aborted) {
      return this.cancelledResult(startTime, manifest);
    }

    eventBus.emit('skill.executing', {
      taskId: request.context.taskId,
      agentId: request.context.agentId,
      skillName: request.skillName,
      executionMode: manifest.executionMode,
    });

    try {
      let result: SkillExecutionResult;

      switch (manifest.executionMode) {
        case 'llm_only':
          result = await this.executeLlmOnly(manifest, request, startTime);
          break;
        case 'script':
          result = await this.executeScript(manifest, request, startTime);
          break;
        case 'hybrid':
          result = await this.executeHybrid(manifest, request, startTime);
          break;
        default:
          result = this.errorResult(`不支持的执行模式: ${manifest.executionMode}`, startTime, manifest, 'EXECUTION_ERROR', false);
        }

      // 自动检测产物字段并发产物事件
      if (result.success && result.data) {
        this.emitArtifactsFromResult(manifest, request, result.data);
      }

      eventBus.emit(result.success ? 'skill.completed' : 'skill.failed', {
        taskId: request.context.taskId,
        agentId: request.context.agentId,
        skillName: request.skillName,
        durationMs: result.meta.durationMs,
        success: result.success,
        ...(result.success ? {} : { error: result.error?.message }),
      });

      return result;
    } catch (err: any) {
      // M0-2：取消 → CANCELLED 结果，不发 skill.failed（不算失败）
      const cancelled = request.context.abortSignal?.aborted || err?.name === 'AbortError';
      if (cancelled) {
        return this.cancelledResult(startTime, manifest);
      }
      const result = this.errorResult(err.message || '未知执行错误', startTime, manifest);
      eventBus.emit('skill.failed', {
        taskId: request.context.taskId,
        agentId: request.context.agentId,
        skillName: request.skillName,
        error: err.message,
      });
      return result;
    }
  }

  private async executeLlmOnly(
    manifest: ParsedSkillManifest,
    request: SkillExecutionRequest,
    startTime: number
  ): Promise<SkillExecutionResult> {
    const systemPrompt = this.buildSystemPrompt(manifest, request);

    const ctx = request.context;
    const skillName = manifest.name;

    // Demo 模式下：单独跑一个低频「演示进度」定时器（保证有视觉反馈）
    let fakeProgressTimer: ReturnType<typeof setInterval> | null = null;
    if (llmClient.isDemoMode()) {
      const total = Math.max(3, Math.min(8, Math.ceil((manifest.estimatedDurationMs || 6000) / 1500)));
      let step = 0;
      fakeProgressTimer = setInterval(() => {
        step++;
        eventBus.emit('skill.progress', {
          taskId: ctx.taskId, agentId: ctx.agentId, skillName,
          phase: 'demo_thinking',
          step,
          total,
          percent: Math.min(95, Math.round((step / total) * 100)),
          message: `[Demo] 正在思考（${step}/${total}）...`,
        });
        if (step >= total) clearInterval(fakeProgressTimer!);
      }, 1500);
    } else {
      eventBus.emit('skill.progress', {
        taskId: ctx.taskId, agentId: ctx.agentId, skillName,
        phase: 'init', percent: 0, message: '准备调用 LLM...',
      });
    }

    try {
      const { content, tokensUsed, mocked } = await llmClient.completeStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: '请根据以上要求处理输入数据并返回结果。' },
        ],
        (delta) => {
          eventBus.emit('skill.log', {
            taskId: ctx.taskId, agentId: ctx.agentId, skillName,
            level: 'info', message: delta, source: 'llm_stream',
          });
        },
        { signal: ctx.abortSignal }
      );

      eventBus.emit('skill.progress', {
        taskId: ctx.taskId, agentId: ctx.agentId, skillName,
        phase: 'done', percent: 100, message: 'LLM 调用完成',
      });

      let parsedData: Record<string, any>;
      try {
        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsedData = JSON.parse(cleanContent);
      } catch {
        parsedData = { result: content };
      }

      // M0-5：demo 模式结果一律带 mock: true 标记（绝不静默伪造）
      if (mocked) parsedData.mock = true;

      return {
        success: true,
        data: parsedData,
        meta: {
          durationMs: Date.now() - startTime,
          tokensUsed,
          skillVersion: manifest.version,
          executionMode: 'llm_only',
          sandboxUsed: false,
        },
      };
    } catch (err: any) {
      // 传输层瞬时错误已在 llm-client 重试过，到这里仍失败 → 不再在 Skill 层重试（避免重试层数相乘）
      return this.errorResult(`LLM 调用失败: ${err.message}`, startTime, manifest, 'LLM_CALL_FAILED', false);
    } finally {
      if (fakeProgressTimer) clearInterval(fakeProgressTimer);
    }
  }

  private async executeScript(
    manifest: ParsedSkillManifest,
    request: SkillExecutionRequest,
    startTime: number
  ): Promise<SkillExecutionResult> {
    if (!manifest.scriptEntry || !manifest.scriptRuntime) {
      return this.errorResult('Script Skill 缺少 scriptEntry 或 scriptRuntime 配置', startTime, manifest, 'SCRIPT_CONFIG_MISSING', false);
    }

    const scriptPath = join(manifest.skillDirPath, manifest.scriptEntry);
    if (!existsSync(scriptPath)) {
      return this.errorResult(`脚本文件不存在: ${scriptPath}`, startTime, manifest, 'SCRIPT_NOT_FOUND', false);
    }

    eventBus.emit('skill.sandbox_started', {
      taskId: request.context.taskId,
      skillName: manifest.name,
      runtime: manifest.scriptRuntime,
    });

    // M0-2：spawn 前再次检查取消
    if (request.context.abortSignal?.aborted) {
      return this.cancelledResult(startTime, manifest);
    }

    return new Promise<SkillExecutionResult>((resolve) => {
      const runtime = resolveRuntimeCommand(manifest.scriptRuntime!);
      // M0-3：脚本级超时（manifest 优先，回退平台沙箱默认值）
      const scriptTimeoutMs = manifest.scriptTimeoutMs || platformConfig.sandboxTimeoutMs || 30000;

      const isWin = platform() === 'win32';
      const child = spawn(runtime, [scriptPath], {
        cwd: manifest.skillDirPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        // M0-3：不再使用 spawn 的 timeout 选项 — Windows shell:true 下它只杀 shell，
        // python 子进程会变孤儿（A11）；改为显式 timer + killProcessTree 按进程树强杀
        shell: isWin,
        // POSIX 下 detached 使子进程独立成组，取消/超时可按进程组强杀
        detached: !isWin,
        windowsHide: true,
        // M0-6（A13）：环境变量白名单 — 不再把宿主全量 env（含 LLM_API_KEY 等机密）泄给脚本
        env: {
          ...buildSandboxEnv(manifest, {
            taskId: request.context.taskId,
            agentId: request.context.agentId,
          }),
          // M2 实测：graph run 绑定工作区时的产物落点（文件型技能优先写这里）
          ...(request.context.outputDir ? { CORAL_OUTPUT_DIR: request.context.outputDir } : {}),
        },
      });

      // M0-2：取消信号 → 按进程树强杀（Windows taskkill /T /F；POSIX 组 SIGTERM→SIGKILL）
      const signal = request.context.abortSignal;
      const onAbort = () => killProcessTree(child);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      // M0-3：脚本超时 → 强杀进程树，close 后按 SCRIPT_TIMEOUT 定性
      let timedOut = false;
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, scriptTimeoutMs);

      const clearAll = () => {
        clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
      };

      let stdout = '';
      const parser = new ProgressParser();

      const ctx = request.context;
      const skillName = manifest.name;

      child.stdout.on('data', (data) => { stdout += data.toString('utf-8'); });
      child.stderr.on('data', (data: Buffer) => {
        const { progressEvents, logLines } = parser.feed(data);
        for (const ev of progressEvents) {
          eventBus.emit('skill.progress', {
            taskId: ctx.taskId, agentId: ctx.agentId, skillName,
            ...ev,
          });

          // M1-7（协议缝隙修复）：脚本用 emit_artifact 手动声明的产物
          // （phase=artifact + detail._artifact）→ 与自动检测同款 skill.artifact 事件
          const manualArtifact = (ev.detail as any)?._artifact;
          if (manualArtifact && typeof manualArtifact === 'object' && manualArtifact.name && manualArtifact.path) {
            eventBus.emit('skill.artifact', {
              taskId: ctx.taskId,
              agentId: ctx.agentId,
              skillName,
              artifact: {
                type: String(manualArtifact.type || 'file'),
                name: String(manualArtifact.name),
                path: String(manualArtifact.path),
                ...(typeof manualArtifact.preview === 'string' ? { preview: manualArtifact.preview } : {}),
              },
            });
          }
        }
        for (const log of logLines) {
          eventBus.emit('skill.log', {
            taskId: ctx.taskId, agentId: ctx.agentId, skillName,
            level: log.level || 'info',
            message: log.message,
            source: 'stderr',
          });
        }
      });

      try {
        // 把公司画像也注入到 context，便于脚本（如 information-filter/normalize）使用
        const companyProfile = manifest.consumesCompanyProfile
          ? mergeCompanyProfile(getCompanyProfile(), ctx.companyProfileOverride)
          : undefined;

        child.stdin.write(JSON.stringify({
          input: request.input,
          context: {
            taskId: ctx.taskId,
            agentId: ctx.agentId,
            userId: ctx.userId,
            companyProfile,
          },
        }));
        child.stdin.end();
      } catch (err: any) {
        // ignore
      }

      child.on('close', (code) => {
        clearAll();

        // 把残留 buffer 也下发为日志
        const tail = parser.flush();
        for (const log of tail.logLines) {
          eventBus.emit('skill.log', {
            taskId: ctx.taskId, agentId: ctx.agentId, skillName,
            level: log.level || 'info',
            message: log.message,
            source: 'stderr',
          });
        }

        eventBus.emit('skill.sandbox_finished', {
          taskId: request.context.taskId,
          skillName: manifest.name,
          exitCode: code,
        });

        // M0-2：取消导致的退出（强杀退出码非 0）→ CANCELLED 而非失败
        if (signal?.aborted) {
          resolve(this.cancelledResult(startTime, manifest));
          return;
        }

        // M0-3：超时强杀 → SCRIPT_TIMEOUT（区别于普通失败，便于排查）
        if (timedOut) {
          resolve(this.errorResult(`脚本执行超时（${scriptTimeoutMs}ms，进程树已强杀）`, startTime, manifest, 'SCRIPT_TIMEOUT'));
          return;
        }

        if (code !== 0) {
          // 退出码非 0：脚本进程异常（可能瞬时 — 网页抓取类脚本的站点抖动），保持可重试
          resolve(this.errorResult(`脚本执行失败 (退出码: ${code})`, startTime, manifest, 'SCRIPT_EXIT_NONZERO', true));
          return;
        }

        try {
          const data = JSON.parse(stdout.trim());
          if (data && typeof data === 'object' && 'error' in data && Object.keys(data).length === 1) {
            // 脚本自身报告的逻辑错误 → 确定性失败，不重试
            resolve(this.errorResult(`脚本返回错误: ${data.error}`, startTime, manifest, 'SCRIPT_LOGICAL_ERROR', false));
            return;
          }
          resolve({
            success: true,
            data,
            meta: {
              durationMs: Date.now() - startTime,
              skillVersion: manifest.version,
              executionMode: 'script',
              sandboxUsed: true,
            },
          });
        } catch {
          resolve({
            success: true,
            data: { raw_output: stdout.trim() },
            meta: {
              durationMs: Date.now() - startTime,
              skillVersion: manifest.version,
              executionMode: 'script',
              sandboxUsed: true,
            },
          });
        }
      });

      child.on('error', (err) => {
        clearAll();
        if (signal?.aborted) {
          resolve(this.cancelledResult(startTime, manifest));
          return;
        }
        // 启动失败（runtime 不存在等）→ 环境性确定错误，不重试
        resolve(this.errorResult(`脚本启动失败: ${err.message}`, startTime, manifest, 'SCRIPT_SPAWN_FAILED', false));
      });
    });
  }

  private async executeHybrid(
    manifest: ParsedSkillManifest,
    request: SkillExecutionRequest,
    startTime: number
  ): Promise<SkillExecutionResult> {
    // hybrid v1.1：先脚本归一化（normalize），再 LLM 处理；
    // 若没有脚本，则退化为纯 LLM；脚本失败则按 LLM only 兜底
    if (manifest.scriptEntry) {
      const scriptResult = await this.executeScript(manifest, request, startTime);
      if (!scriptResult.success) return scriptResult;

      const merged: SkillExecutionRequest = {
        ...request,
        input: { ...request.input, ...(scriptResult.data || {}) },
      };
      const llmResult = await this.executeLlmOnly(manifest, merged, startTime);
      if (!llmResult.success) return llmResult;
      return {
        ...llmResult,
        data: { ...(scriptResult.data || {}), ...(llmResult.data || {}) },
        meta: { ...llmResult.meta, executionMode: 'hybrid' },
      };
    }

    const llmOnly = await this.executeLlmOnly(manifest, request, startTime);
    return { ...llmOnly, meta: { ...llmOnly.meta, executionMode: 'hybrid' } };
  }

  private buildSystemPrompt(manifest: ParsedSkillManifest, request: SkillExecutionRequest): string {
    let prompt = manifest.promptContent;

    if (manifest.referenceContent) {
      prompt += `\n\n## 参考资料\n${manifest.referenceContent}`;
    }

    // 公司画像注入（FR-G）
    if (manifest.consumesCompanyProfile) {
      const profile = mergeCompanyProfile(getCompanyProfile(), request.context.companyProfileOverride);
      prompt += `\n\n## 公司业务画像（用于业务相关性判断 / 内容筛选）\n\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\``;
    }

    prompt += `\n\n## 输入数据\n\`\`\`json\n${JSON.stringify(request.input, null, 2)}\n\`\`\``;
    prompt += `\n\n## 输出格式要求\n严格按照以下 JSON Schema 输出：\n\`\`\`json\n${JSON.stringify(manifest.outputSchema, null, 2)}\n\`\`\``;

    return prompt;
  }

  private errorResult(
    message: string,
    startTime: number,
    manifest?: ParsedSkillManifest,
    code: string = 'EXECUTION_ERROR',
    retryable: boolean = true
  ): SkillExecutionResult {
    return {
      success: false,
      error: {
        code,
        message,
        retryable,
      },
      meta: {
        durationMs: Date.now() - startTime,
        skillVersion: manifest?.version || 'unknown',
        executionMode: manifest?.executionMode || 'unknown',
        sandboxUsed: false,
      },
    };
  }

  /** M0-2：取消专用结果 — 不可重试、不算失败 */
  private cancelledResult(startTime: number, manifest?: ParsedSkillManifest): SkillExecutionResult {
    return {
      success: false,
      error: {
        code: 'CANCELLED',
        message: '执行已取消',
        retryable: false,
      },
      meta: {
        durationMs: Date.now() - startTime,
        skillVersion: manifest?.version || 'unknown',
        executionMode: manifest?.executionMode || 'unknown',
        sandboxUsed: false,
      },
    };
  }

  /** 自动从 Skill 输出中识别产物（md_path / csv_path / output_path 等）并发 skill.artifact 事件 */
  private emitArtifactsFromResult(manifest: ParsedSkillManifest, request: SkillExecutionRequest, data: Record<string, any>) {
    const candidates: Array<{ key: string; type: 'markdown' | 'csv' | 'json' | 'file'; }> = [
      { key: 'md_path', type: 'markdown' },
      { key: 'csv_path', type: 'csv' },
      { key: 'json_path', type: 'json' },
      { key: 'output_path', type: 'file' },
    ];

    for (const { key, type } of candidates) {
      const v = (data as any)[key];
      if (typeof v !== 'string' || !v) continue;
      const path = isAbsolute(v) ? v : join(manifest.skillDirPath, v);
      if (!existsSync(path)) continue;
      try {
        const stat = statSync(path);
        let preview: string | undefined;
        if (stat.size <= 4096 && type !== 'file') {
          try { preview = readFileSync(path, 'utf-8').slice(0, 1024); } catch { /* */ }
        }
        eventBus.emit('skill.artifact', {
          taskId: request.context.taskId,
          agentId: request.context.agentId,
          skillName: manifest.name,
          artifact: {
            type,
            name: basename(path),
            path,
            sizeBytes: stat.size,
            preview,
          },
        });
      } catch { /* 路径无效则忽略 */ }
    }
  }
}
