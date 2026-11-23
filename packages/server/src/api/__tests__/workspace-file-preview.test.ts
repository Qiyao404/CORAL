import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * REG-40：文件预览 / 下载接口先把**整个文件**读进内存。
 *
 * 工作区里放一个几 GB 的日志，点一下"预览"就是几 GB 的字符串（之后才截到 20 万字符）；
 * /raw 下载同样整文件读入。修法：预览只读开头一段（按字节上限），下载改为流式转发。
 */

const tmp = mkdtempSync(join(tmpdir(), 'coral-preview-'));
process.env.DATABASE_PATH = join(tmp, 'test.db');
const WS = join(tmp, 'ws');

const Fastify = (await import('fastify')).default;
const { registerWorkspaceFileRoutes, readTextHead, MAX_PREVIEW_TEXT } = await import('../workspace-file.routes.js');
const { WorkspaceService } = await import('../../services/workspace-service.js');
const { closeDb } = await import('../../store/index.js');

let app: ReturnType<typeof Fastify>;
let wsId: string;

beforeAll(async () => {
  mkdirSync(WS, { recursive: true });
  // 9MB 的文本文件（远超预览需要的量）
  const line = '这一行是测试用的日志内容，重复很多很多次。\n';
  writeFileSync(join(WS, 'big.log'), line.repeat(Math.ceil((9 * 1024 * 1024) / Buffer.byteLength(line))));
  writeFileSync(join(WS, 'small.txt'), '你好，世界\nhello', 'utf-8');
  wsId = new WorkspaceService().create({ name: 'preview-test', dir: WS, permission: 'auto' }).id;
  app = Fastify();
  registerWorkspaceFileRoutes(app);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('readTextHead（只读文件开头）', () => {
  it('实际读取的字节数不超过上限，并如实报告是否截断', () => {
    const r = readTextHead(join(WS, 'big.log'), 64 * 1024);
    expect(r.bytesRead).toBeLessThanOrEqual(64 * 1024);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeGreaterThan(1000);
    expect(r.text.startsWith('这一行是测试用的日志内容')).toBe(true);
  });

  it('文件比上限小：完整读取，不截断', () => {
    const r = readTextHead(join(WS, 'small.txt'), 64 * 1024);
    expect(r).toEqual({ text: '你好，世界\nhello', bytesRead: Buffer.byteLength('你好，世界\nhello'), truncated: false });
  });

  it('截断处切在多字节字符中间时，不留下残缺字符', () => {
    const file = join(WS, 'cjk.txt');
    writeFileSync(file, '中'.repeat(1000)); // 每个汉字 3 字节
    const r = readTextHead(file, 10); // 10 字节 = 3 个整字 + 1 个残缺字节
    expect(r.bytesRead).toBe(10);
    expect(r.text).toBe('中中中');
    expect(r.text.includes('\uFFFD')).toBe(false);
  });
});

describe('GET /api/workspaces/:id/preview', () => {
  it('大文件：只返回开头一段，并明确告诉调用方"这是截断的、多大"', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}/preview?path=big.log` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe('text');
    expect(body.size).toBeGreaterThan(8 * 1024 * 1024);
    expect(body.truncated).toBe(true);
    expect(typeof body.note).toBe('string');
    expect(body.note).toMatch(/下载/);
    expect(body.content.length).toBeLessThanOrEqual(MAX_PREVIEW_TEXT + 200);
  });

  it('小文件：完整内容，没有截断标记', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}/preview?path=small.txt` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe('你好，世界\nhello');
    expect(body.truncated).toBeFalsy();
    expect(body.note).toBeUndefined();
  });
});

describe('GET /api/workspaces/:id/raw', () => {
  it('内容原样返回，带正确的长度与类型头', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}/raw?path=small.txt` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('你好，世界\nhello');
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength('你好，世界\nhello')));
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });

  it('大文件原样返回（流式转发不改变内容）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}/raw?path=big.log` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(res.rawPayload.length));
    expect(res.rawPayload.length).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('download=1：带附件下载头', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}/raw?path=small.txt&download=1` });
    expect(res.headers['content-disposition']).toContain('attachment');
  });
});
