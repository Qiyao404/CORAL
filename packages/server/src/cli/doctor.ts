/**
 * `coral doctor` — 分发健康自检（不启动服务）。
 *
 * 定位：把"重启没生效/端口被旧进程占着/配置坏了"这类用户高频故障从
 * 玄学变成清单。每项检查独立、只读、带修复建议；✗ 才影响退出码。
 *
 * 检查通道：
 *  1. 构建产物存在与新鲜度（源码比 dist 新 = 跑的是旧代码 — 实测血泪产品化）
 *  2. 端口占用（占用者是否为 CORAL 实例 — 提示正确的重启方式）
 *  3. 数据目录可写 / 磁盘水位（50G 提醒 / 30G 警告 / 15G 阻塞）
 *  4. 数据库可打开 + 核心表齐全
 *  5. 模型配置（env / llm_configs 表 + active 配置完整性）
 *  6. 技能目录（可解析数量 / 损坏清单）
 *  7. MCP servers（启用数 / last_error 清单）
 */

import { existsSync, mkdirSync, statSync, readdirSync, closeSync, openSync, unlinkSync, readFileSync } from 'fs';
import { statfs as statFsPromised } from 'node:fs/promises';
import { join, dirname, resolve } from 'path';
import { createServer } from 'net';
import { createRequire } from 'node:module';

// ESM 环境下的同步 require（better-sqlite3 是 CJS 原生模块）
const require = createRequire(import.meta.url);

export interface DoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  summary: string;
  detail?: string;
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean; // 无 fail 项
}

interface DoctorPaths {
  serverRoot: string;   // packages/server
  repoRoot: string;     // 仓库根
  dataDir: string;
  skillsDir: string;
  port: number;
}

/** 探测源码树中最新的 .ts 修改时间（node_modules/dist/data 除外） */
export function newestSourceMtime(serverRoot: string, now = Date.now()): number {
  let newest = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || newest > now) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'data' || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!e.name.endsWith('.ts')) continue;
      try {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* ignore */ }
    }
  };
  walk(join(serverRoot, 'src'), 0);
  return newest;
}

/** 构建产物新鲜度判定（REG-18 产品化：源码新于产物 = 服务跑的是旧代码） */
export function buildStaleness(distMtime: number, srcNewest: number): 'fresh' | 'stale' | 'unknown' {
  if (!distMtime || !srcNewest) return 'unknown';
  // 2 秒容差：同一次 build 的时钟抖动不算过期
  return srcNewest > distMtime + 2000 ? 'stale' : 'fresh';
}

async function probePort(port: number): Promise<{ free: boolean; coralAlive: boolean; healthBody?: string }> {
  const free = await new Promise<boolean>(resolve_ => {
    const probe = createServer();
    probe.once('error', () => resolve_(false));
    probe.once('listening', () => probe.close(() => resolve_(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (free) return { free: true, coralAlive: false };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.text();
    return { free: false, coralAlive: res.ok || body.includes('coral') || body.includes('version'), healthBody: body.slice(0, 200) };
  } catch {
    return { free: false, coralAlive: false };
  }
}

async function checkDiskSpace(dataDir: string): Promise<DoctorCheck> {
  try {
    const st = await statFsPromised(dataDir);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    const freeGB = freeBytes / 1024 ** 3;
    if (freeGB < 15) {
      return { id: 'disk', status: 'fail', summary: `磁盘剩余 ${freeGB.toFixed(1)}GB（<15GB 阻塞线）`, fix: '清理磁盘空间后再启动 — 数据库写入随时可能失败' };
    }
    if (freeGB < 30) {
      return { id: 'disk', status: 'warn', summary: `磁盘剩余 ${freeGB.toFixed(1)}GB（<30GB 警告线）`, fix: '建议清理磁盘空间' };
    }
    if (freeGB < 50) {
      return { id: 'disk', status: 'ok', summary: `磁盘剩余 ${freeGB.toFixed(1)}GB（<50GB，留意）` };
    }
    return { id: 'disk', status: 'ok', summary: `磁盘剩余 ${freeGB.toFixed(0)}GB` };
  } catch (err: any) {
    return { id: 'disk', status: 'skip', summary: `磁盘水位检查失败: ${err?.message ?? err}` };
  }
}

function checkDatabase(dbPath: string): DoctorCheck {
  if (!existsSync(dbPath)) {
    return { id: 'database', status: 'ok', summary: '数据库尚未创建（首次启动会自动建库）' };
  }
  try {
    // better-sqlite3 只读打开（服务在跑也不锁冲突）
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name)
    );
    db.close();
    const required = ['runs', 'run_events', 'checkpoints'];
    const missing = required.filter(t => !tables.has(t));
    if (missing.length > 0) {
      return { id: 'database', status: 'fail', summary: `数据库缺表: ${missing.join(', ')}`, fix: '库文件可能损坏 — 备份 data/ 后删除 coral.db 重建，或换 DATABASE_PATH 试试' };
    }
    const sizeMB = statSync(dbPath).size / 1024 ** 2;
    return { id: 'database', status: 'ok', summary: `数据库正常（${sizeMB.toFixed(1)}MB，${tables.size} 张表）` };
  } catch (err: any) {
    return { id: 'database', status: 'fail', summary: `数据库无法打开: ${err?.message ?? err}`, fix: '若服务正在运行请先停止；仍失败则备份后重建 data/coral.db' };
  }
}

function checkLlmConfig(paths: DoctorPaths, dbPath: string): DoctorCheck {
  const envFile = join(paths.repoRoot, '.env');
  const hasEnvKey = Boolean(process.env.LLM_API_KEY) || existsSync(envFile);
  let active: { name: string; model: string; base_url: string; api_key?: string } | null = null;
  try {
    if (existsSync(dbPath)) {
      const Database = require('better-sqlite3');
      const db = new Database(dbPath, { readonly: true });
      const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name);
      if (tables.includes('llm_configs')) {
        const rows = db.prepare(`SELECT name, model, base_url, api_key, is_active FROM llm_configs`).all() as any[];
        active = rows.find(r => Number(r.is_active) === 1) ?? null;
        if (!active && rows.length > 0) active = rows[rows.length - 1];
      }
      db.close();
    }
  } catch { /* 只读探测失败不算 fail */ }
  if (active) {
    const hasKey = Boolean(active.api_key) || hasEnvKey;
    if (!hasKey) {
      return { id: 'llm', status: 'warn', summary: `模型配置 "${active.name}"（${active.model}）缺 API Key`, fix: '设置页或 .env 补 Key，否则将以演示模式运行' };
    }
    return { id: 'llm', status: 'ok', summary: `模型配置 "${active.name}"（${active.model} @ ${active.base_url}）` };
  }
  if (hasEnvKey) return { id: 'llm', status: 'ok', summary: '检测到 .env / LLM_API_KEY' };
  return {
    id: 'llm',
    status: 'warn',
    summary: '未配置模型（将以演示模式启动，结果带 mock 标记）',
    fix: '复制 .env.example 为 .env 填入任意 OpenAI 兼容端点 Key，或在设置页添加模型配置',
  };
}

function checkSkills(skillsDir: string): DoctorCheck {
  if (!existsSync(skillsDir)) {
    return { id: 'skills', status: 'warn', summary: `技能目录不存在: ${skillsDir}`, fix: '启动时会自动创建；内置技能用 npm run import-skill 恢复' };
  }
  let ok = 0;
  const broken: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_lib') continue;
    const md = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(md)) { broken.push(`${entry.name}/（无 SKILL.md）`); continue; }
    try {
      // CRLF 归一（Windows 下的 SKILL.md 多为 \r\n — 不归一则 frontmatter 匹配全灭）
      const text = readFileSync(md, 'utf-8').replace(/\r\n/g, '\n');
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      if (!fm || !/^name:/m.test(fm[1]) || !/^description:/m.test(fm[1])) {
        broken.push(`${entry.name}/（frontmatter 缺 name/description）`);
      } else {
        ok++;
      }
    } catch {
      broken.push(`${entry.name}/（读取失败）`);
    }
  }
  if (broken.length > 0) {
    return {
      id: 'skills',
      status: 'warn',
      summary: `技能 ${ok} 个正常，${broken.length} 个损坏`,
      detail: broken.join('、'),
      fix: '损坏技能会被启动时跳过；删除或修复对应目录',
    };
  }
  return { id: 'skills', status: 'ok', summary: `技能 ${ok} 个全部可解析` };
}

function checkMcp(dbPath: string): DoctorCheck {
  try {
    if (!existsSync(dbPath)) return { id: 'mcp', status: 'ok', summary: '尚无 MCP server 配置' };
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(r => r.name);
    if (!tables.includes('mcp_servers')) { db.close(); return { id: 'mcp', status: 'ok', summary: '尚无 MCP server 配置' }; }
    const rows = db.prepare(`SELECT name, enabled, last_error FROM mcp_servers`).all() as any[];
    db.close();
    if (rows.length === 0) return { id: 'mcp', status: 'ok', summary: '尚无 MCP server 配置' };
    const enabled = rows.filter(r => Number(r.enabled) === 1);
    const errored = enabled.filter(r => r.last_error);
    if (errored.length > 0) {
      return {
        id: 'mcp',
        status: 'warn',
        summary: `MCP ${rows.length} 个（启用 ${enabled.length}），${errored.length} 个连接失败`,
        detail: errored.map(r => `${r.name}: ${String(r.last_error).slice(0, 120)}`).join('；'),
        fix: '连接器页检查命令/URL 是否可用；失败 server 的工具会缺席但不影响其他功能',
      };
    }
    return { id: 'mcp', status: 'ok', summary: `MCP ${rows.length} 个（启用 ${enabled.length}）` };
  } catch (err: any) {
    return { id: 'mcp', status: 'skip', summary: `MCP 检查失败: ${err?.message ?? err}` };
  }
}

export async function runDoctor(serverRootInput?: string): Promise<DoctorReport> {
  const serverRoot = resolve(serverRootInput ?? process.cwd());
  // serverRoot = packages/server → 仓库根 = 上两级（.env 与 skills/ 都在仓库根）
  const repoRoot = dirname(dirname(serverRoot));
  const paths: DoctorPaths = {
    serverRoot,
    repoRoot,
    dataDir: join(serverRoot, 'data'),
    skillsDir: resolve(repoRoot, 'skills'),
    port: Number(process.env.PORT || 3001),
  };
  const dbPath = join(paths.dataDir, 'coral.db');
  const checks: DoctorCheck[] = [];

  // 1. 构建产物
  const distIndex = join(serverRoot, 'dist', 'index.js');
  if (!existsSync(distIndex)) {
    checks.push({ id: 'build', status: 'fail', summary: `构建产物缺失: ${distIndex}`, fix: '运行 npm run build -w packages/server' });
  } else {
    const distMtime = statSync(distIndex).mtimeMs;
    const srcNewest = newestSourceMtime(serverRoot);
    const staleness = buildStaleness(distMtime, srcNewest);
    if (staleness === 'stale') {
      checks.push({
        id: 'build',
        status: 'warn',
        summary: `源码比构建产物新（src 最新 ${new Date(srcNewest).toLocaleString()} > dist ${new Date(distMtime).toLocaleString()}）`,
        fix: '运行中的服务仍是旧代码 — npm run build 后重启（重启务必先确认旧进程已退出）',
      });
    } else {
      checks.push({ id: 'build', status: 'ok', summary: '构建产物就绪且不过期' });
    }
  }

  // 2. 端口
  const port = await probePort(paths.port);
  if (port.free) {
    checks.push({ id: 'port', status: 'ok', summary: `端口 ${paths.port} 空闲` });
  } else if (port.coralAlive) {
    checks.push({
      id: 'port',
      status: 'warn',
      summary: `端口 ${paths.port} 已有一个 CORAL 实例在响应`,
      detail: port.healthBody,
      fix: '直接使用现有实例；若要重启：先停掉旧进程并确认端口空闲，再启动（否则跑的还是旧进程）',
    });
  } else {
    checks.push({
      id: 'port',
      status: 'warn',
      summary: `端口 ${paths.port} 被占用（且不是 CORAL）`,
      fix: `释放该端口，或用 PORT=xxxx coral 换端口`,
    });
  }

  // 3. 数据目录 + 磁盘
  try {
    mkdirSync(paths.dataDir, { recursive: true });
    const probeFile = join(paths.dataDir, '.doctor-probe');
    closeSync(openSync(probeFile, 'w'));
    unlinkSync(probeFile);
    checks.push({ id: 'datadir', status: 'ok', summary: `数据目录可写: ${paths.dataDir}` });
  } catch (err: any) {
    checks.push({ id: 'datadir', status: 'fail', summary: `数据目录不可写: ${err?.message ?? err}`, fix: '检查目录权限或换 DATABASE_PATH/MEMORY_DIR' });
  }
  checks.push(await checkDiskSpace(paths.dataDir));

  // 3.5 ESTOP 急停哨兵（存在 = 拉闸中，新任务全拒）
  const estopFile = join(paths.dataDir, 'ESTOP');
  if (existsSync(estopFile)) {
    const reason = readFileSync(estopFile, 'utf-8').trim() || '（未写原因）';
    checks.push({
      id: 'estop',
      status: 'warn',
      summary: `平台处于急停状态（ESTOP）: ${reason}`,
      fix: '预期行为则忽略；解除用 coral resume 或删除 data/ESTOP',
    });
  }

  // 4-5. 数据库 + 模型配置
  checks.push(checkDatabase(dbPath));
  checks.push(checkLlmConfig(paths, dbPath));

  // 6-7. 技能 + MCP
  checks.push(checkSkills(paths.skillsDir));
  checks.push(checkMcp(dbPath));

  return { checks, ok: checks.every(c => c.status !== 'fail') };
}

/** CLI 输出（人类可读表格） */
export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: '✓', warn: '⚠', fail: '✗', skip: '·' } as const;
  const lines = ['', 'CORAL 健康自检（coral doctor）', '─'.repeat(56)];
  for (const c of report.checks) {
    lines.push(`${icon[c.status]} [${c.id}] ${c.summary}`);
    if (c.detail) lines.push(`    ${c.detail}`);
    if (c.fix) lines.push(`    → ${c.fix}`);
  }
  lines.push('─'.repeat(56));
  lines.push(report.ok ? '结论：无阻塞项，可以启动' : '结论：存在阻塞项（✗），请先按建议修复');
  lines.push('');
  return lines.join('\n');
}
