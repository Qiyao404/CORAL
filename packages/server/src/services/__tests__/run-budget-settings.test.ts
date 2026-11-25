import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunBudgetSettingsService, DEFAULT_MAX_SPAWNS, MAX_SPAWNS_LIMIT } from '../run-budget-settings.js';

let dir = '';

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'coral-run-budget-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('RunBudgetSettingsService · 派生上限设置', () => {
  it('未设置时 maxSpawns 为 null，生效值取默认 16', () => {
    const svc = new RunBudgetSettingsService(dir);
    expect(svc.get().maxSpawns).toBeNull();
    expect(svc.effective().maxSpawns).toBe(DEFAULT_MAX_SPAWNS);
    expect(DEFAULT_MAX_SPAWNS).toBe(16);
  });

  it('可以设成具体值；0 是合法值（不允许派生）；null 恢复默认', () => {
    const svc = new RunBudgetSettingsService(dir);
    expect(svc.set({ maxSpawns: 6 }).maxSpawns).toBe(6);
    expect(svc.effective().maxSpawns).toBe(6);
    expect(svc.set({ maxSpawns: 0 }).maxSpawns).toBe(0);
    expect(svc.effective().maxSpawns).toBe(0);
    expect(svc.set({ maxSpawns: null }).maxSpawns).toBeNull();
  });

  it('越界 / 非法值被修正：超过上限夹到 64，负数与小数取整', () => {
    const svc = new RunBudgetSettingsService(dir);
    expect(svc.set({ maxSpawns: 999 }).maxSpawns).toBe(MAX_SPAWNS_LIMIT);
    expect(svc.set({ maxSpawns: -3 }).maxSpawns).toBeNull();
    expect(svc.set({ maxSpawns: 7.6 }).maxSpawns).toBe(8);
  });

  it('只改别的设置时，派生上限保持不变；文件缺失 / 损坏时按默认', () => {
    const svc = new RunBudgetSettingsService(dir);
    svc.set({ maxSpawns: 5 });
    svc.set({ maxSteps: 300 });
    expect(svc.get().maxSpawns).toBe(5);
    expect(svc.get().maxSteps).toBe(300);

    const file = join(dir, 'run-budget.json');
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, '{ not json', 'utf8');
    expect(new RunBudgetSettingsService(dir).get().maxSpawns).toBeNull();
    new RunBudgetSettingsService(dir).set({ maxSpawns: 3 });
    expect(JSON.parse(readFileSync(file, 'utf8')).maxSpawns).toBe(3);
  });
});
