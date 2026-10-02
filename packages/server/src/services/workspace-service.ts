import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { nanoid } from 'nanoid';
import { getDb } from '../store/db.js';

/**
 * M1-10（D11-D14）：多工作区 — 绑定本地目录 + 权限档。
 * 持久化在 kv 表（key = workspaces.v1 / workspaces.active）— 量级小，无需独立表。
 *
 * 权限档（D12）：
 *  · readonly — 只读工具（fs_list/fs_read/fs_search）
 *  · ask      — 出厂默认：fs 写改需审批（diff 卡片）
 *  · auto     — fs 工具直接执行（shell 仍每次审批，D13）
 */

export type WorkspacePermission = 'readonly' | 'ask' | 'auto';

export interface Workspace {
  id: string;
  name: string;
  dir: string;
  permission: WorkspacePermission;
  createdAt: string;
}

const LIST_KEY = 'workspaces.v1';
const ACTIVE_KEY = 'workspaces.active';

const PERMISSIONS: ReadonlySet<string> = new Set(['readonly', 'ask', 'auto']);

export class WorkspaceService {
  private kvGet(key: string): any {
    const row = getDb().prepare('SELECT value_json FROM kv WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json);
    } catch {
      return null;
    }
  }

  private kvSet(key: string, value: any): void {
    getDb()
      .prepare('INSERT OR REPLACE INTO kv (key, value_json) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  list(): { items: Workspace[]; activeId: string | null } {
    const items: Workspace[] = this.kvGet(LIST_KEY) ?? [];
    const activeId: string | null = this.kvGet(ACTIVE_KEY) ?? null;
    return { items, activeId: items.some(w => w.id === activeId) ? activeId : null };
  }

  get(id: string): Workspace | null {
    return this.list().items.find(w => w.id === id) ?? null;
  }

  create(input: { name: string; dir: string; permission?: WorkspacePermission }): Workspace {
    const name = String(input.name ?? '').trim();
    const dir = resolve(String(input.dir ?? '').trim());
    const permission = (PERMISSIONS.has(String(input.permission)) ? input.permission : 'ask') as WorkspacePermission;

    if (!name) throw new Error('name 必填');
    if (!dir) throw new Error('dir 必填');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`目录不存在（请先创建文件夹再绑定）: ${dir}`);
    }

    const { items } = this.list();
    if (items.some(w => resolve(w.dir) === dir)) {
      throw new Error(`该目录已被工作区「${items.find(w => resolve(w.dir) === dir)!.name}」绑定`);
    }
    const ws: Workspace = {
      id: `ws_${nanoid(8)}`,
      name: name.slice(0, 64),
      dir,
      permission,
      createdAt: new Date().toISOString(),
    };
    this.kvSet(LIST_KEY, [...items, ws]);
    if (!this.list().activeId) this.kvSet(ACTIVE_KEY, ws.id); // 首个自动激活
    return ws;
  }

  update(id: string, patch: { name?: string; permission?: string }): Workspace | null {
    const { items } = this.list();
    const idx = items.findIndex(w => w.id === id);
    if (idx === -1) return null;
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error('name 不能为空');
      items[idx].name = name.slice(0, 64);
    }
    if (patch.permission !== undefined) {
      if (!PERMISSIONS.has(patch.permission)) throw new Error(`非法权限档: ${patch.permission}`);
      items[idx].permission = patch.permission as WorkspacePermission;
    }
    this.kvSet(LIST_KEY, items);
    return items[idx];
  }

  remove(id: string): boolean {
    const { items, activeId } = this.list();
    const next = items.filter(w => w.id !== id);
    if (next.length === items.length) return false;
    this.kvSet(LIST_KEY, next);
    if (activeId === id) this.kvSet(ACTIVE_KEY, next[0]?.id ?? null);
    return true;
  }

  activate(id: string): Workspace {
    const ws = this.get(id);
    if (!ws) throw new Error(`工作区不存在: ${id}`);
    this.kvSet(ACTIVE_KEY, id);
    return ws;
  }

  getActive(): Workspace | null {
    const { items, activeId } = this.list();
    return items.find(w => w.id === activeId) ?? null;
  }
}
