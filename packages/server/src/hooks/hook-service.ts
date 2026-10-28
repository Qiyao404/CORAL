import { spawn } from 'child_process';
import { existsSync, readFileSync, watchFile, unwatchFile } from 'fs';
import { join, dirname, resolve } from 'path';
import { platformConfig } from '../services/config.js';

/**
 * Hooks 系统 — 把运行时内部纪律（效果契约/事实门/收工门）变成**用户可扩展**的开放接口：
 * 在关键生命周期点调用外部命令守卫，外部脚本可以否决、改写、补充。
 *
 * 事件（8 个核心点）：
 *  · pre_tool_use      工具执行前（事实门之后、人工审批之前）— 可 allow/deny/ask + 改写入参
 *  · post_tool_use     工具完成后 — 只读观察（拿结果做审计/记录）
 *  · stop              最终回答将被接受时 — 可 block 打回重写（与收工门并行生效）
 *  · user_prompt_submit 首次 LLM 调用前（goal 就绪）— 可 deny 拦下任务 + additionalContext 补充上下文
 *  · session_start     会话续接历史加载后 — additionalContext 注入
 *  · session_end       run 终态后 — 只读观察
 *  · pre_compact       全量压缩前 — 可 block 跳过本次压缩
 *  · notification      审批请求等通知 — 只读观察（fire-and-forget）
 *
 * 契约（命令型 hook）：
 *  · stdin：JSON（event + 上下文字段）
 *  · stdout：可解析 JSON 时取 {decision, reason, updatedInput, additionalContext}；
 *    退出码 2 = deny/block（stderr 作为原因回喂）；退出码 0 无 JSON = 放行
 *  · 超时（默认 60s，上限 300s）杀死进程
 *  · fail-closed 方向：pre_tool_use 的执行失败/超时 = deny（宁可误拦）；
 *    其余事件失败 = 放行（观察类 hook 不应有能力杀 run）
 *  · 同事件多条命中 → 并行执行，deny 优先合并；updatedInput 按配置顺序取第一个
 */

export type HookEvent =
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'stop'
  | 'user_prompt_submit'
  | 'session_start'
  | 'session_end'
  | 'pre_compact'
  | 'notification';

export const HOOK_EVENTS: HookEvent[] = [
  'pre_tool_use', 'post_tool_use', 'stop', 'user_prompt_submit',
  'session_start', 'session_end', 'pre_compact', 'notification',
];

interface HookDef {
  matcher?: string;   // 工具名正则（仅工具类事件生效）
  command: string;
  timeout?: number;   // 秒
}

export interface HookOutcome {
  event: HookEvent;
  /** allow（默认）/ deny（工具事件拒绝执行）/ block（stop/pre_compact 拦下）/ ask（升级为人工审批） */
  decision: 'allow' | 'deny' | 'block' | 'ask';
  reason?: string;
  /** pre_tool_use：改写后的工具入参（第一条提供者生效） */
  updatedInput?: Record<string, any>;
  /** 提示类事件：追加注入的上下文 */
  additionalContext?: string;
  /** 命中的 hook 数与失败数（事件留痕用） */
  matched: number;
  failed: number;
}

const ALLOW: HookOutcome = { event: 'pre_tool_use', decision: 'allow', matched: 0, failed: 0 };

/** 单条 hook 的原始裁决（failed 是布尔 — 与 HookOutcome.failed 计数区分） */
type HookPartial = Omit<Partial<HookOutcome>, 'failed' | 'matched'> & { failed?: boolean };

export class HookService {
  private hooks = new Map<HookEvent, HookDef[]>();
  private configPath: string;
  private loadedAt = 0;
  private watcherOn = false;

  constructor(baseDir?: string) {
    this.configPath = baseDir
      ? join(resolve(baseDir), 'hooks.json')
      : join(dirname(resolve(platformConfig.databasePath)), 'hooks.json');
    this.reload();
  }

  get path(): string {
    return this.configPath;
  }

  /** 读取 data/hooks.json（不存在=空配置；损坏=忽略并保留空 — 观察面不伤执行面） */
  reload(): void {
    this.hooks.clear();
    this.loadedAt = Date.now();
    if (!existsSync(this.configPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf-8'));
      const source = parsed.hooks && typeof parsed.hooks === 'object' ? parsed.hooks : parsed;
      for (const ev of HOOK_EVENTS) {
        const list = source[ev];
        if (!Array.isArray(list)) continue;
        const defs = list
          .filter((h: any) => h && typeof h.command === 'string' && h.command.trim())
          .map((h: any) => ({
            ...(typeof h.matcher === 'string' && h.matcher.trim() ? { matcher: h.matcher } : {}),
            command: String(h.command),
            timeout: Math.min(Math.max(Number(h.timeout) || 60, 1), 300),
          })) as HookDef[];
        if (defs.length > 0) this.hooks.set(ev, defs);
      }
    } catch {
      // 配置损坏：按空处理（doctor 会报）
    }
  }

  /** 配置文件变更监听（启动时开一次；解析失败自动回退空配置） */
  watchConfig(): void {
    if (this.watcherOn || !existsSync(this.configPath)) return;
    this.watcherOn = true;
    watchFile(this.configPath, { interval: 2000 }, () => this.reload());
  }

  unwatchConfig(): void {
    if (this.watcherOn) unwatchFile(this.configPath);
    this.watcherOn = false;
  }

  listConfig(): Record<string, HookDef[]> {
    const out: Record<string, HookDef[]> = {};
    for (const [ev, defs] of this.hooks) out[ev] = defs;
    return out;
  }

  /** 该事件是否有配置（无配置 = 零开销直通） */
  has(event: HookEvent): boolean {
    return (this.hooks.get(event)?.length ?? 0) > 0;
  }

  private matchDefs(event: HookEvent, toolName?: string): HookDef[] {
    const defs = this.hooks.get(event);
    if (!defs) return [];
    return defs.filter(d => {
      if (!d.matcher || !toolName) return true;
      try {
        return new RegExp(d.matcher, 'i').test(toolName);
      } catch {
        return false; // 坏正则不命中（fail 静默 — doctor 报）
      }
    });
  }

  /**
   * 触发一个事件：命中并行的外部命令守卫，合并裁决。
   * 无命中 → 立即 allow（零开销）。
   */
  async run(event: HookEvent, payload: Record<string, any>): Promise<HookOutcome> {
    const toolName = typeof payload.tool === 'string' ? payload.tool : undefined;
    const defs = this.matchDefs(event, toolName);
    if (defs.length === 0) return { ...ALLOW, event };

    const results = await Promise.all(defs.map(d => this.runOne(event, d, payload)));

    // deny 优先；其次 ask；stop/pre_compact 的 deny 语义映射为 block
    let decision: HookOutcome['decision'] = 'allow';
    let reason: string | undefined;
    let updatedInput: Record<string, any> | undefined;
    const contexts: string[] = [];
    let failed = 0;

    for (const r of results) {
      if (r.failed) failed++;
      if (r.decision === 'deny' || r.decision === 'block') {
        decision = event === 'stop' || event === 'pre_compact' ? 'block' : 'deny';
        if (!reason) reason = r.reason;
      } else if (r.decision === 'ask' && decision === 'allow') {
        decision = 'ask';
        if (!reason) reason = r.reason;
      }
      if (!updatedInput && r.updatedInput) updatedInput = r.updatedInput;
      if (r.additionalContext) contexts.push(r.additionalContext);
    }

    const merged: HookOutcome = {
      event,
      decision,
      ...(reason ? { reason } : {}),
      ...(updatedInput ? { updatedInput } : {}),
      ...(contexts.length > 0 ? { additionalContext: contexts.join('\n\n') } : {}),
      matched: defs.length,
      failed,
    };
    return merged;
  }

  private async runOne(event: HookEvent, def: HookDef, payload: Record<string, any>): Promise<HookPartial> {
    const stdin = JSON.stringify({ event, ...payload, configPath: this.configPath });
    return new Promise<HookPartial>(resolve_ => {
      let child;
      try {
        child = spawn(def.command, {
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err: any) {
        return resolve_({ decision: 'deny', reason: `hook 无法启动: ${err?.message ?? err}`, failed: true });
      }
      let out = '';
      let errOut = '';
      let settled = false;
      const settle = (v: HookPartial) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve_(v);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle({ decision: 'deny', reason: `hook 超时（${def.timeout ?? 60}s）`, failed: true });
      }, (def.timeout ?? 60) * 1000);
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { errOut += d.toString(); });
      child.on('error', err => settle({ decision: 'deny', reason: `hook 执行失败: ${err.message}`, failed: true }));
      child.on('close', (code) => {
        if (code === 2) {
          // 退出码 2 = 拒绝/拦截（stderr 是原因）
          const reason = errOut.trim().slice(0, 500) || 'hook denied (exit 2)';
          return settle({ decision: 'deny', reason });
        }
        if (code !== 0) {
          return settle({ decision: 'deny', reason: `hook 异常退出（code ${code}）${errOut.trim().slice(0, 200)}`, failed: true });
        }
        // 退出码 0：stdout 可解析 JSON 则应用
        const parsed = parseHookStdout(out);
        if (parsed) return settle(parsed);
        settle({ decision: 'allow' });
      });
      child.stdin?.on('error', () => { /* EPIPE：hook 不读 stdin — 忽略 */ });
      child.stdin?.end(stdin, 'utf-8');
    });
  }
}

function parseHookStdout(out: string): HookPartial | null {
  const text = out.trim();
  if (!text) return null;
  // 从左往右找第一个能完整解析的 JSON 对象（外层优先 —
  // lastIndexOf 会命中嵌套内层对象，导致 updatedInput 这类嵌套字段丢失）
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    for (let end = text.length; end > start; end--) {
      if (text[end - 1] !== '}') continue;
      try {
        const obj = JSON.parse(text.slice(start, end));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        const decision = ['allow', 'deny', 'block', 'ask'].includes(obj.decision) ? obj.decision : 'allow';
        return {
          decision,
          ...(typeof obj.reason === 'string' && obj.reason.trim() ? { reason: obj.reason.slice(0, 500) } : {}),
          ...(obj.updatedInput && typeof obj.updatedInput === 'object' ? { updatedInput: obj.updatedInput } : {}),
          ...(typeof obj.additionalContext === 'string' && obj.additionalContext.trim() ? { additionalContext: obj.additionalContext.slice(0, 4000) } : {}),
        } as HookPartial;
      } catch { /* 收短再试 */ }
    }
  }
  return null;
}
