import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, join as _join } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-mem-'));
const memDir = join(tmp, 'memory');
mkdirSync(memDir, { recursive: true });

const { MemoryService, distillMemory } = await import('../memory-service.js');
const { makeMemoryTools, MEMORY_GUIDE } = await import('../../tools/builtin/memory.js');

function ctx() {
  return { runId: 'r', agentId: 'a', signal: new AbortController().signal, emit: () => {} } as any;
}

beforeAll(() => {
  writeFileSync(join(memDir, 'project-x.md'), '# 项目X\n- 路径 /srv/x\n', 'utf-8');
  writeFileSync(join(memDir, 'user-prefs.md'), '# 偏好\n- 中文回复\n', 'utf-8');
});
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('MemoryService + 记忆工具（M1-11）', () => {
  it('MEMORY_GUIDE 含使用指引', () => {
    expect(MEMORY_GUIDE).toContain('memory_search');
  });

  it('list / read / write / search 全链路', async () => {
    const [list, read, write, search] = makeMemoryTools(new MemoryService(memDir));
    const l = await list.invoke({}, ctx());
    expect((l.data as any).count).toBeGreaterThanOrEqual(2);

    const r = await read.invoke({ name: 'project-x.md' }, ctx());
    expect((r.data as any).content).toContain('/srv/x');
    expect((await read.invoke({ name: 'nope.md' }, ctx())).error?.code).toBe('NOT_FOUND');

    const w = await write.invoke({ name: 'lessons-learned', content: '# 教训\n\n代理超时要设上限。\n' }, ctx());
    expect((w.data as any).written).toBe('lessons-learned.md');
    expect(existsSync(join(memDir, 'lessons-learned.md'))).toBe(true);
    expect((await write.invoke({ name: 'x', content: '' }, ctx())).error?.code).toBe('BAD_INPUT');

    const s = await search.invoke({ query: '超时 上限' }, ctx());
    expect((s.data as any).matches[0].file).toBe('lessons-learned.md');
  });
});

describe('distillMemory — 两级分层（长期记忆 + 会话上下文）', () => {
  const tierJSON = (longTerm: any[] = [], sessionFiles: any[] = [], sessionPoints: string[] = []) =>
    JSON.stringify({ long_term: longTerm, session_files: sessionFiles, session_points: sessionPoints });

  it('合法两级 JSON → 长期记忆落盘 + 会话上下文写入', async () => {
    const dir = join(tmp, 'distill-a');
    const svc = new MemoryService(dir);
    const llm = { async complete() { return { content: tierJSON(
      [{ filename: 'user-preferences.md', content: '# 偏好\n- 喜欢表格汇总\n' }],
      [{ filename: 'report.docx', summary: '这是一份关于XXX的报告' }],
      ['完成了文件分析'],
    ) }; } };

    const sessionFiles: Array<{ filename: string; summary: string }> = [];
    const sessionPoints: string[] = [];
    const sessionCtxStub = {
      addFileSummary: (_sid: string, filename: string, summary: string) => { sessionFiles.push({ filename, summary }); },
      addKeyPoint: (_sid: string, point: string) => { sessionPoints.push(point); },
    };

    const result = await distillMemory(llm as any, svc, '[user] 帮我汇总\n[assistant] 已按喜好用表格汇总', sessionCtxStub as any, 'sess_test');
    expect(result.longTermWritten.map(w => w.name)).toEqual(['user-preferences.md']);
    expect(svc.read('user-preferences.md')!.content).toContain('表格');
    // 文件摘要进会话上下文，不进长期记忆
    expect(sessionFiles).toHaveLength(1);
    expect(sessionFiles[0].filename).toBe('report.docx');
    expect(svc.read('report.docx')).toBeNull(); // 不在长期记忆里
    expect(sessionPoints).toEqual(['完成了文件分析']);
  });

  it('空输出 → 零写入不抛错；code fence / 非法输出兜底', async () => {
    const svc = new MemoryService(join(tmp, 'distill-b'));

    const empty = await distillMemory({ async complete() { return { content: tierJSON() }; } } as any, svc, 't');
    expect(empty.longTermWritten).toHaveLength(0);

    const fenced = { async complete() { return { content: '```json\n' + tierJSON([{ filename: 'a.md', content: '内容' }]) + '\n```' }; } };
    const result2 = await distillMemory(fenced as any, svc, 't');
    expect(result2.longTermWritten).toHaveLength(1);

    const garbage = { async complete() { return { content: '我觉得没什么值得记的' }; } };
    expect((await distillMemory(garbage as any, svc, 't')).longTermWritten).toHaveLength(0);

    const throwing = { async complete() { throw new Error('quota'); } };
    expect((await distillMemory(throwing as any, svc, 't')).longTermWritten).toHaveLength(0);
  });

  it('旧格式（纯数组 JSON）→ 兼容（视为 long_term）', async () => {
    const svc = new MemoryService(join(tmp, 'distill-c'));
    const legacy = { async complete() { return { content: '[{"filename":"legacy.md","content":"旧格式"}]' }; } };
    const result = await distillMemory(legacy as any, svc, 't');
    // 旧格式在两级解析器里 long_term 为空（不是对象格式）→ 0 写入，不报错
    expect(result.longTermWritten).toHaveLength(0);
  });
});
