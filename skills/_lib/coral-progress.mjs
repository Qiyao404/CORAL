#!/usr/bin/env node
/**
 * CORAL_PROGRESS 协议 helper — Node 版（M1-7，与 Python 版 skills/_lib/coral_progress.py 同语义）。
 *
 * 通过 stderr 输出单行 JSON（前缀 [CORAL_PROGRESS]），平台据此向前端下发细粒度进度。
 * 零依赖单文件 — Node 技能直接相对路径导入：
 *
 *   import { emitProgress, emitLog, emitArtifact } from '../../_lib/coral-progress.mjs';
 *
 *   emitProgress('init', '开始处理', { percent: 0 });
 *   emitProgress('scraping', '[3/8] 第 1 页', { step: 3, total: 8, percent: 37, detail: { site: 'gdii' } });
 *   emitLog('普通日志', 'warn');
 *   emitArtifact('报告', 'output/report.md', 'markdown');
 *
 * 注意：stdout 是 Skill 的"返回值"通道 —— 除最终 JSON 结果外不要往 stdout 写任何内容。
 */

const stderrWrite = (line) => process.stderr.write(line + '\n');

function emitProgress(phase, message = '', opts = {}) {
  const { step, total, percent, detail } = opts;
  const payload = { phase, message };
  if (Number.isFinite(step)) payload.step = step;
  if (Number.isFinite(total)) payload.total = total;
  if (Number.isFinite(percent)) payload.percent = Math.max(0, Math.min(100, percent));
  if (detail && typeof detail === 'object') payload.detail = detail;
  stderrWrite('[CORAL_PROGRESS] ' + JSON.stringify(payload));
}

function emitLog(message, level = 'info') {
  const prefix =
    level === 'warn' || level === 'warning' ? '[WARN] ' :
    level === 'err' || level === 'error' ? '[ERROR] ' :
    level === 'debug' ? '[DEBUG] ' : '';
  stderrWrite(`${prefix}${message}`);
}

function emitArtifact(name, path, artifactType = 'file', preview = undefined) {
  const payload = {
    phase: 'artifact',
    message: `产物: ${name}`,
    detail: {
      _artifact: {
        name,
        path,
        type: artifactType,
        ...(preview !== undefined ? { preview } : {}),
      },
    },
  };
  stderrWrite('[CORAL_PROGRESS] ' + JSON.stringify(payload));
}

export { emitProgress, emitLog, emitArtifact };
