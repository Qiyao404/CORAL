import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { spawn } from 'child_process';
import { resolve } from 'path';

/**
 * web-reader 技能脚本的黑盒测试：按 SKILL.md 写的契约逐条核对（把脚本当进程跑，喂 stdin、读 stdout）。
 * 背景：说明书写着"分类错误 + 重试 + 超时 + 截断 + 桌面 UA"，脚本却一直是最初的简版——
 * 模型拿到的永远是裸错误字符串 `fetch failed`（实测该技能 56% 的调用失败，且调用方在盲目重试）。
 */

const SCRIPT = resolve(__dirname, '../../../../../skills/web-reader/scripts/main.mjs');
const ARTICLE = `<html><head><title>测试文章</title></head><body><nav>菜单</nav><article><h1>标题一</h1>
<p>${'这是正文内容，足够长以通过正文阈值。'.repeat(60)}</p></article></body></html>`;

let server: Server;
let base = '';
let hits = new Map<string, number>();

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === '/ok' || path === '/flaky' && (hits.get(path) ?? 0) >= 2) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
    } else if (path === '/flaky') {
      res.writeHead(503); res.end('later');
    } else if (path === '/degraded') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>没有正文容器的页面，只是一段散落的文字。</p></body></html>');
    } else if (path === '/blocked') {
      res.writeHead(403); res.end('denied');
    } else if (path === '/missing') {
      res.writeHead(404); res.end('gone');
    } else if (path === '/ua') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<article><p>UA=${String(req.headers['user-agent'] ?? '')}</p></article>`);
    } else if (path === '/down') {
      req.socket.destroy();
    } else if (path === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end(ARTICLE); }, 2500);
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

/** 跑一次技能脚本：stdin 喂 {input}，返回 stdout 解析出的 JSON */
function run(input: Record<string, unknown>): Promise<any> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`脚本超时\n${stderr}`)); }, 20_000);
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('close', code => {
      clearTimeout(timer);
      try { resolveRun(JSON.parse(stdout.trim())); } catch { reject(new Error(`stdout 不是 JSON（退出码 ${code}）: ${stdout.slice(0, 200)}\n${stderr.slice(0, 400)}`)); }
    });
    child.on('error', reject);
    child.stdin.end(JSON.stringify({ input }));
  });
}

describe('web-reader 脚本 · 成功路径', () => {
  it('抓到正文容器：title / content（Markdown）/ extraction=readable；默认不带 links', async () => {
    const r = await run({ url: `${base}/ok` });
    expect(r.error).toBeUndefined();
    expect(r.title).toBe('测试文章');
    expect(r.content).toContain('# 标题一');
    expect(r.content).toContain('这是正文内容');
    expect(r.content).not.toContain('菜单');
    expect(r.extraction).toBe('readable');
    expect(r.truncated).toBe(false);
    expect(r.total_chars).toBe(r.content.length);
    expect(r.links).toBeUndefined();
  });

  it('include_links=true 带出外链', async () => {
    const r = await run({ url: `${base}/ok`, include_links: true });
    expect(Array.isArray(r.links)).toBe(true);
  });

  it('max_chars 截断：truncated=true 且 total_chars 是完整长度', async () => {
    const full = await run({ url: `${base}/ok` });
    const r = await run({ url: `${base}/ok`, max_chars: 500 });
    expect(r.content.length).toBe(500);
    expect(r.truncated).toBe(true);
    expect(r.total_chars).toBe(full.total_chars);
  });

  it('抓取成功但没有正文容器 → 降级为去标签文本，extraction=raw，不报错', async () => {
    const r = await run({ url: `${base}/degraded` });
    expect(r.error).toBeUndefined();
    expect(r.extraction).toBe('raw');
    expect(r.content).toContain('没有正文容器的页面');
    expect(r.content).not.toContain('<p>');
  });

  it('默认桌面浏览器 UA；user_agent 可覆盖', async () => {
    const r = await run({ url: `${base}/ua` });
    expect(r.content).toContain('UA=Mozilla/5.0');
    const custom = await run({ url: `${base}/ua`, user_agent: 'coral-test/1.0' });
    expect(custom.content).toContain('UA=coral-test/1.0');
  });
});

describe('web-reader 脚本 · 失败是一行带类型的说明', () => {
  it('整个返回值只有 error 一个键（技能执行器据此判定为逻辑失败）', async () => {
    for (const path of ['/blocked', '/missing', '/down']) {
      const r = await run({ url: `${base}${path}`, retries: 0 });
      expect(Object.keys(r), path).toEqual(['error']);
      expect(typeof r.error, path).toBe('string');
      expect(r.error, path).toMatch(/^\[[a-z_4-5]+\] /);
    }
  });

  it('403 → [blocked]，明说不要重打同一地址；只请求了一次', async () => {
    hits.set('/blocked', 0);
    const r = await run({ url: `${base}/blocked` });
    expect(r.error).toContain('[blocked]');
    expect(r.error).toContain('不要重打同一 URL');
    expect(hits.get('/blocked')).toBe(1);
  });

  it('404 → [http_4xx]，不重试', async () => {
    hits.set('/missing', 0);
    const r = await run({ url: `${base}/missing` });
    expect(r.error).toContain('[http_4xx]');
    expect(r.error).toContain('勿重试');
    expect(hits.get('/missing')).toBe(1);
  });

  it('5xx → 内部退避重试，救回后正常返回（调用方看不到这次失败）', async () => {
    hits.set('/flaky', 0);
    const r = await run({ url: `${base}/flaky`, retries: 2 });
    expect(r.error).toBeUndefined();
    expect(r.extraction).toBe('readable');
    expect(hits.get('/flaky')).toBe(2);
  });

  it('连接被对端直接断开 → [network_error]，带重试次数提示', async () => {
    const r = await run({ url: `${base}/down`, retries: 0 });
    expect(r.error).toContain('[network_error]');
    expect(r.error).toContain('最多再调 1 次');
  });

  it('timeout_ms 生效：慢响应 → [timeout]，不会拖到脚本被杀', async () => {
    const started = Date.now();
    const r = await run({ url: `${base}/slow`, timeout_ms: 1000, retries: 0 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.error).toContain('[timeout]');
    expect(r.error).toContain('1000ms');
  }, 15_000);

  it('retries=0 时不重试 5xx', async () => {
    hits.set('/missing', 0);
    await run({ url: `${base}/missing`, retries: 0 });
    expect(hits.get('/missing')).toBe(1);
  });

  it('无效输入与越界参数：不是网址 → [bad_url]；timeout_ms 超出范围被夹到 [1s, 35s]', async () => {
    expect((await run({ url: 'not a url' })).error).toContain('[bad_url]');
    // 给 50 毫秒：被夹到下限 1000ms（慢响应要 2.5 秒）→ 仍然超时，说明里写的是夹后的值
    const tooSmall = await run({ url: `${base}/slow`, timeout_ms: 50, retries: 0 });
    expect(tooSmall.error).toContain('1000ms');
    // 给 44 秒：被夹到上限 35000ms，不会撞上脚本的 45 秒总超时
    const tooBig = await run({ url: `${base}/ok`, timeout_ms: 44_000 });
    expect(tooBig.extraction).toBe('readable');
  }, 15_000);
});
