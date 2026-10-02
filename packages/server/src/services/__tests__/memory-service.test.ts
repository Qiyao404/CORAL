import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryService, distillMemory } from '../memory-service.js';
import { makeMemoryTools, MEMORY_GUIDE } from '../../tools/builtin/memory.js';
import { makeToolContext } from '../../tools/types.js';

const tmp = mkdtempSync(join(tmpdir(), 'coral-memory-'));
const memDir = join(tmp, 'memory');
beforeAll(() => {
  const svc = new MemoryService(memDir);
  svc.write('user-preferences', '# 用户偏好\n\n- 报告用中文撰写\n- 偏好简洁直接的回复风格\n');
  svc.write('project-x', '# 项目 X\n\n部署目录是 /srv/x，每周五发版。\n');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('MemoryService（M1-11 / D18）', () => {
  const svc = new MemoryService(memDir);

  it('文件名消毒：自动补 .md、非法字符替换、路径穿越拦截', () => {
    expect(svc.sanitizeName('user-preferences')).toBe('user-preferences.md');
    expect(svc.sanitizeName('报告 规范')).toBe('报告-规范.md');
    expect(svc.sanitizeName('../evil')).toBe('..-evil.md'); // 分隔符被替换，穿越失效
    expect(svc.sanitizeName('../../etc/passwd')).not.toContain('/');
    expect(svc.sanitizeName('')).toBeNull();
    expect(svc.sanitizeName('...')).toBeNull();
    expect(svc.sanitizeName('a'.repeat(100))!.length).toBeLessThanOrEqual(64 + 3);
  });

  it('list / read / write 往返', () => {
    const files = svc.list();
    expect(files.map(f => f.name)).toContain('user-preferences.md');
    const r = svc.read('user-preferences.md')!;
    expect(r.content).toContain('报告用中文撰写');
    expect(svc.read('ghost.md')).toBeNull();
  });

  it('search：空格分词 AND 语义、大小写不敏感、带行号与文件名', () => {
    const r = svc.search('报告 中文');
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
    expect(r.matches[0].file).toBe('user-preferences.md');
    expect(r.matches[0].text).toContain('报告用中文撰写');

    const none = svc.search('完全不存在的词');
    expect(none.matches).toHaveLength(0);
    expect(none.scannedFiles).toBe(2);
  });

  it('内容截断保护：64KB 上限 + 截断标记', () => {
    const w = svc.write('big', 'x'.repeat(70_000));
    expect(w.truncated).toBe(true);
    const r = svc.read('big')!;
    expect(r.size).toBeLessThanOrEqual(64 * 1024 + 100); // 截断 + 标记行
    expect(r.size).toBeGreaterThan(64 * 1024 - 100);
    expect(r.content.endsWith('已截断]')).toBe(true); // 标记在尾部
  });
});

describe('memory 四工具（M1-11 / D18）', () => {
  const svc = new MemoryService(memDir);
  const [list, read, write, search] = makeMemoryTools(svc);
  const ctx = () => makeToolContext();

  it('全 auto 权限 + 命名规范', () => {
    for (const t of [list, read, write, search]) {
      expect(t.permission).toBe('auto');
      expect(t.name).toMatch(/^memory_/);
    }
    expect(MEMORY_GUIDE).toContain('memory_search');
  });

  it('list / read / write / search 全链路', async () => {
    const l = await list.invoke({}, ctx());
    expect((l.data as any).count).toBeGreaterThanOrEqual(2);

    const r = await read.invoke({ name: 'project-x.md' }, ctx());
    expect((r.data as any).content).toContain('/srv/x');
    expect((await read.invoke({ name: 'nope.md' }, ctx())).error?.code).toBe('NOT_FOUND');

    const w = await write.invoke({ name: 'lessons-learned', content: '# 教训\n\n代理超时要设上限。\n' }, ctx());
    expect((w.data as any).written).toBe('lessons-learned.md');
    expect(existsSync(join(memDir, 'lessons-learned.md'))).toBe(true);
    expect((await write.invoke({ name: 'x', content: '' }, ctx())).error?.code).toBe('BAD_INPUT');
    expect((await write.invoke({ name: '../evil', content: 'x' }, ctx())).ok).toBe(true); // 消毒后安全落地
    expect(existsSync(join(memDir, '..', 'evil.md'))).toBe(false);

    const s = await search.invoke({ query: '超时 上限' }, ctx());
    expect((s.data as any).matches[0].file).toBe('lessons-learned.md');
    expect((await search.invoke({ query: '' }, ctx())).error?.code).toBe('BAD_INPUT');
  });
});

describe('distillMemory — 会话结束记忆整理（M1-11）', () => {
  it('合法 JSON 条目 → 落盘；空数组 → 零写入', async () => {
    const dir = join(tmp, 'distill-a');
    const svc = new MemoryService(dir);
    const llm = {
      async complete() {
        return {
          content: JSON.stringify([
            { filename: 'user-preferences.md', content: '# 偏好\n- 喜欢表格汇总\n' },
            { filename: 'project-x.md', content: '# X\n- 周五发版\n' },
          ]),
        };
      },
    };
    const written = await distillMemory(llm, svc, '[user] 帮我汇总\n[assistant] 已按喜好用表格汇总');
    expect(written.map(w => w.name)).toEqual(['user-preferences.md', 'project-x.md']);
    expect(svc.read('user-preferences.md')!.content).toContain('表格');

    const empty = await distillMemory({ async complete() { return { content: '[]' }; } }, svc, 'transcript');
    expect(empty).toHaveLength(0);
  });

  it('带 code fence / 尾部杂质的输出仍可解析；非法输出 → 空数组不抛错', async () => {
    const fenced = {
      async complete() {
        return { content: '```json\n[{"filename":"a.md","content":"内容"}]\n```' };
      },
    };
    const svcA = new MemoryService(join(tmp, 'distill-b'));
    expect((await distillMemory(fenced, svcA, 't')).length).toBe(1);

    const garbage = { async complete() { return { content: '我觉得没什么值得记的' }; } };
    expect(await distillMemory(garbage, svcA, 't')).toHaveLength(0);

    const throwing = { async complete() { throw new Error('quota'); } };
    expect(await distillMemory(throwing, svcA, 't')).toHaveLength(0); // LLM 失败不影响 run
  });

  it('条目数量上限 10 + 非法条目过滤', async () => {
    const svc = new MemoryService(join(tmp, 'distill-c'));
    const llm = {
      async complete() {
        return {
          content: JSON.stringify(
            Array.from({ length: 15 }, (_, i) => ({ filename: `f${i}.md`, content: `v${i}` }))
              .concat([{ filename: 'bad', content: '' }, { filename: 42, content: 'x' }]),
          ),
        };
      },
    };
    const written = await distillMemory(llm, svc, 't');
    expect(written.length).toBe(10); // 15 条被截到 10；空内容与非字符串条目被过滤
  });
});
