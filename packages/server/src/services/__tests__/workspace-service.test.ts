import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-ws-'));
const wsDir = join(tmp, 'project');
beforeAll(() => {
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, 'readme.md'), '# demo\n', 'utf-8');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// DATABASE_PATH 必须在 import 前设置（隔离真实库）
process.env.DATABASE_PATH = join(tmp, 'ws.db');

const { WorkspaceService } = await import('../workspace-service.js');
const { closeDb } = await import('../../store/index.js');
afterAll(() => closeDb());

describe('WorkspaceService（M1-10 / D11-D14）', () => {
  const svc = new WorkspaceService();

  it('create：默认权限档 ask、首个自动激活、目录必须存在', () => {
    const ws = svc.create({ name: '主项目', dir: wsDir });
    expect(ws.id).toMatch(/^ws_/);
    expect(ws.permission).toBe('ask');
    expect(svc.list().activeId).toBe(ws.id);

    expect(() => svc.create({ name: 'x', dir: join(tmp, 'nope') })).toThrow(/不存在/);
    expect(() => svc.create({ name: '', dir: wsDir })).toThrow(/name/);
  });

  it('重复绑定同目录被拒绝；不存在的目录被拒绝', () => {
    expect(() => svc.create({ name: '另一个', dir: wsDir })).toThrow(/已被工作区/);
    expect(() => svc.create({ name: 'x', dir: join(tmp, 'never-created') })).toThrow(/不存在/);
  });

  it('update / activate / remove', () => {
    const items = svc.list().items;
    const first = items[0];
    // 幂等保证（跨文件共享 kv 时第二个可能已存在）
    mkdirSync(join(tmp, 'second'), { recursive: true });
    let second = items.find(w => w.name === '副项目');
    if (!second) second = svc.create({ name: '副项目', dir: join(tmp, 'second'), permission: 'readonly' });

    svc.activate(second.id);
    expect(svc.getActive()!.id).toBe(second.id);

    svc.update(first.id, { permission: 'auto', name: '主项目-改名' });
    expect(svc.get(first.id)!.permission).toBe('auto');
    expect(svc.get(first.id)!.name).toBe('主项目-改名');
    expect(() => svc.update(first.id, { permission: 'yolo' })).toThrow(/非法权限档/);

    svc.remove(second.id);
    expect(svc.get(second.id)).toBeNull();
    expect(svc.list().activeId).toBe(first.id); // active 转移回剩余第一个
    expect(svc.remove(second.id)).toBe(false);
  });
});
