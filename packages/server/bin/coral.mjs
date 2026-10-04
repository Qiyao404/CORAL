#!/usr/bin/env node
/**
 * M4-3：`coral` CLI — 单命令启动（npx coral / npm start）。
 * 自检：端口占用 / 数据库可写 / 模型配置（缺 key 提示 demo 模式）→ 拉起 server。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, '..');
const distIndex = join(serverRoot, 'dist', 'index.js');

const log = (icon, msg) => console.log(`${icon} ${msg}`);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// ── 自检 1：构建产物 ──
if (!existsSync(distIndex)) {
  fail(`server 构建产物缺失: ${distIndex}\n  请先运行: npm run build -w packages/server`);
}
log('✓', 'server 构建产物就绪');

// ── 自检 2：端口 ──
const PORT = Number(process.env.PORT || 3001);
const portFree = await new Promise(resolve => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(PORT, '127.0.0.1');
});
if (!portFree) {
  fail(`端口 ${PORT} 已被占用。释放它，或用 PORT=xxxx coral 换端口。`);
}
log('✓', `端口 ${PORT} 可用`);

// ── 自检 3：数据目录可写 ──
const dataDir = join(serverRoot, 'data');
try {
  mkdirSync(dataDir, { recursive: true });
  const probe = join(dataDir, '.write-probe');
  closeSync(openSync(probe, 'w'));
  unlinkSync(probe);
  log('✓', `数据目录可写: ${dataDir}`);
} catch (err) {
  fail(`数据目录不可写: ${dataDir}（${err.message}）`);
}

// ── 自检 4：模型配置 ──
const envFile = join(serverRoot, '..', '..', '.env');
const hasEnv = existsSync(envFile);
if (!hasEnv && !process.env.LLM_API_KEY) {
  log('⚠', '未检测到 .env / LLM_API_KEY — 将以演示模式启动（结果带 mock 标记）。');
  log(' ', '配置真实模型：复制 .env.example 为 .env 并填入任意 OpenAI 兼容端点的 Key。');
}

// ── 启动 ──
const args = [...process.argv.slice(2)];
if (!hasEnv && !process.env.LLM_API_KEY && !args.includes('--demo')) {
  args.push('--demo');
}
log('▶', `启动 CORAL（http://127.0.0.1:${PORT}）…`);
const child = spawn(process.execPath, [distIndex, ...args], {
  stdio: 'inherit',
  env: { ...process.env },
  cwd: serverRoot,
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0))); // 终审 P3：信号终止不以 0 退出
// 终审 P2（本机实证）：Windows 的 SIGINT 是 TerminateProcess 硬杀，handler 不会跑 —
// 控制台 Ctrl+C 事件本就直达子进程，父进程转发反而抢在优雅关闭前打死它
if (process.platform !== 'win32') {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig));
  }
}
