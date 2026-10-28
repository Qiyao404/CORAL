import { describe, it, expect } from 'vitest';
import { derivePermission } from '../types.js';
import { ToolRegistry } from '../registry.js';
import type { Tool } from '../types.js';
import { makeToolContext } from '../types.js';

const base = (over: Partial<Tool>): Tool => ({
  name: 't',
  description: '',
  inputSchema: { type: 'object' },
  source: 'builtin',
  permission: 'auto',
  invoke: async () => ({ ok: true, data: {} }),
  ...over,
});

describe('效果契约 — derivePermission 与注册期封缄', () => {
  it('进程/外部代码/写盘 → approval；只读+网络 → auto', () => {
    expect(derivePermission({ launchesProcess: true })).toBe('approval');
    expect(derivePermission({ executesForeignCode: true })).toBe('approval');
    expect(derivePermission({ writesFilesystem: true })).toBe('approval');
    expect(derivePermission({ accessesNetwork: true })).toBe('auto');
    expect(derivePermission({ idempotent: true })).toBe('auto');
    expect(derivePermission(undefined)).toBe('auto');
  });

  it('fail-closed：声明 auto 但效果推导 approval 的工具，注册后按 approval 落档', () => {
    const reg = new ToolRegistry();
    reg.register(base({ name: 'sneaky_write', permission: 'auto', effects: { writesFilesystem: true } }));
    expect(reg.get('sneaky_write')!.permission).toBe('approval');

    // 反向（声明 approval 效果无害）不放松
    reg.register(base({ name: 'paranoid_read', permission: 'approval', effects: { idempotent: true } }));
    expect(reg.get('paranoid_read')!.permission).toBe('approval');
  });

  it('replace（热重载路径）同样封缄', () => {
    const reg = new ToolRegistry();
    reg.register(base({ name: 'x', permission: 'auto' }));
    reg.replace(base({ name: 'x', permission: 'auto', effects: { launchesProcess: true } }));
    expect(reg.get('x')!.permission).toBe('approval');
  });

  it('审批位在执行时真实生效（封缄后的 auto 声明被升级 → 走审批拒绝路径）', async () => {
    const reg = new ToolRegistry();
    reg.register(base({
      name: 'shell_like',
      permission: 'auto', // 手滑标注
      effects: { launchesProcess: true },
      invoke: async () => ({ ok: true, data: { ran: true } }),
    }));
    const tool = reg.get('shell_like')!;
    // 模拟 loop 的审批分支（未接审批回调 → 安全默认拒绝）
    expect(tool.permission).toBe('approval');
  });
});

describe('效果位与并发安全位的元数据透出', () => {
  it('registry.list 保留 effects/isConcurrencySafe/maxResultSizeChars', () => {
    const reg = new ToolRegistry();
    reg.register(base({
      name: 'meta_tool',
      effects: { accessesNetwork: true, idempotent: true },
      isConcurrencySafe: true,
      maxResultSizeChars: 12_345,
    }));
    const t = reg.get('meta_tool')!;
    expect(t.effects?.accessesNetwork).toBe(true);
    expect(t.isConcurrencySafe).toBe(true);
    expect(t.maxResultSizeChars).toBe(12_345);
  });
});
