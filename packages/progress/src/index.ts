/**
 * @coral/progress — CORAL_PROGRESS 协议 SDK（Node）。
 *
 * 与 skills/_lib/coral-progress.mjs 同语义的类型化实现（npm 发布用，M3-3）；
 * 技能脚本内零配置用法是直接相对导入 _lib 单文件版。
 *
 * 协议：stderr 单行 JSON，前缀 [CORAL_PROGRESS]，由 CORAL 平台实时解析为
 * skill.progress / skill.log / skill.artifact 事件下发前端。
 */

export interface EmitProgressOptions {
  step?: number;
  total?: number;
  /** 0-100，超出会被钳制 */
  percent?: number;
  detail?: Record<string, unknown>;
}

export interface ArtifactInfo {
  name: string;
  path: string;
  type: 'markdown' | 'csv' | 'json' | 'file' | 'text' | string;
  preview?: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface ProgressSink {
  write(line: string): void;
}

/** 默认写 process.stderr；测试/嵌入可注入 */
export function createProgress(sink: ProgressSink = process.stderr) {
  const write = (line: string) => sink.write(line + '\n');

  return {
    emitProgress(phase: string, message = '', opts: EmitProgressOptions = {}): void {
      const payload: Record<string, unknown> = { phase, message };
      if (Number.isFinite(opts.step)) payload.step = opts.step;
      if (Number.isFinite(opts.total)) payload.total = opts.total;
      if (Number.isFinite(opts.percent)) {
        payload.percent = Math.max(0, Math.min(100, opts.percent as number));
      }
      if (opts.detail && typeof opts.detail === 'object') payload.detail = opts.detail;
      write('[CORAL_PROGRESS] ' + JSON.stringify(payload));
    },

    emitLog(message: string, level: LogLevel = 'info'): void {
      const prefix =
        level === 'warn' ? '[WARN] ' :
        level === 'error' ? '[ERROR] ' :
        level === 'debug' ? '[DEBUG] ' : '';
      write(`${prefix}${message}`);
    },

    emitArtifact(artifact: ArtifactInfo): void {
      const payload = {
        phase: 'artifact',
        message: `产物: ${artifact.name}`,
        detail: { _artifact: artifact },
      };
      write('[CORAL_PROGRESS] ' + JSON.stringify(payload));
    },
  };
}

/** 便捷默认实例（直写 process.stderr） */
export const progress = createProgress();
export const emitProgress = progress.emitProgress;
export const emitLog = progress.emitLog;
export const emitArtifact = (name: string, path: string, type: ArtifactInfo['type'] = 'file', preview?: string) =>
  progress.emitArtifact({ name, path, type, preview });
