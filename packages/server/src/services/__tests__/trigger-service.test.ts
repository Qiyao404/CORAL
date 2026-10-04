import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'coral-trig-'));
process.env.DATABASE_PATH = join(tmp, 'trig.db');

const { TriggerService, nextCronTime } = await import('../trigger-service.js');
const { closeDb } = await import('../../store/db.js');

let svc: TriggerService;
const fired: Array<{ action: any; vars: any }> = [];

beforeAll(() => {
  svc = new TriggerService();
  svc.bind({
    startRun: async (action, vars) => {
      fired.push({ action, vars });
      return { runId: `r_fake_${fired.length}` };
    },
  });
});
afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('nextCronTime — cron 子集解析', () => {
  it('基本字段/步进/区间/列表', () => {
    const base = new Date('2026-10-04T10:00:00Z'); // 周日
    expect(nextCronTime('* * * * *', base)).toBeTruthy();
    expect(nextCronTime('*/15 * * * *', base)?.getUTCMinutes()).toBe(15);
    expect(nextCronTime('0 9 * * 1', base)?.getUTCDay()).toBe(1); // 下周一
    expect(nextCronTime('30 8 1-10 * *', base)?.getUTCDate()).toBeLessThanOrEqual(10);
    expect(nextCronTime('0 9,18 * * *', base)).toBeTruthy();
  });
  it('REG-14 回归：0 9 * * 1（每周一）在周二/周三不得命中（OR 语义误判曾致每天触发）', () => {
    const base = new Date('2026-10-06T10:00:00Z'); // 周二
    for (let i = 0; i < 7 * 24 * 60; i++) {
      const t = new Date(base.getTime() + i * 60000);
      const next = nextCronTime('0 9 * * 1', t);
      // 从周二开始的 7 天内的"下一次"必须是下周一，绝不能是周二~周日
      const day = next ? next.getUTCDay() : -1;
      expect([0, 1]).toContain(day); // 只有周一(1)或已在周一后算下周一(0 不可能——周日不在集合)
      if (day === 1) break;
    }
  });

  it('非法表达式返回 null', () => {
    expect(nextCronTime('* * * *')).toBeNull();
    expect(nextCronTime('61 * * * *')).toBeNull();
    expect(nextCronTime('a * * * *')).toBeNull();
  });
});

describe('TriggerService — 定时与 webhook（M3-5）', () => {
  it('创建校验：interval <60s 拒绝；cron 非法拒绝；goal 必填', () => {
    expect(svc.create({ name: 'x', kind: 'interval', spec: '30', action: { mode: 'free', goal: 'g' } }).ok).toBe(false);
    expect(svc.create({ name: 'x', kind: 'cron', spec: 'bad', action: { mode: 'free', goal: 'g' } }).ok).toBe(false);
    expect(svc.create({ name: 'x', kind: 'interval', spec: '300', action: { mode: 'free', goal: '' } }).ok).toBe(false);
  });

  it('tick：due 的 interval 触发 fire（创建 run）并推进 next_fire_at；未 due 的不动', async () => {
    const due = svc.create({ name: 'due', kind: 'interval', spec: '60', action: { mode: 'free', goal: '每分钟任务' } });
    const notDue = svc.create({ name: 'notdue', kind: 'interval', spec: '3600', action: { mode: 'free', goal: '每小时' } });
    expect(due.ok && notDue.ok).toBe(true);
    // 创建即 +60s 不算 due — 手动把 due 的下次触发拨到过去
    const { getDb } = await import('../../store/db.js');
    getDb().prepare(`UPDATE schedules SET next_fire_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', due.schedule!.id);

    const n = await svc.tick();
    expect(n).toBe(1);
    expect(fired).toHaveLength(1);
    expect(fired[0].action.goal).toBe('每分钟任务');

    const dueRow = svc.get(due.schedule!.id)!;
    expect(dueRow.fire_count).toBe(1);
    expect(new Date(dueRow.next_fire_at!).getTime()).toBeGreaterThan(Date.now());
    const notDueRow = svc.get(notDue.schedule!.id)!;
    expect(notDueRow.fire_count).toBe(0);
  });

  it('启停：disable 后 tick 不再触发', async () => {
    const r = svc.create({ name: 'stop', kind: 'interval', spec: '60', action: { mode: 'free', goal: 'x' } });
    const { getDb } = await import('../../store/db.js');
    getDb().prepare(`UPDATE schedules SET next_fire_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', r.schedule!.id);
    const before = fired.length;
    svc.setEnabled(r.schedule!.id, false);
    await svc.tick();
    expect(fired.length).toBe(before);
  });

  it('webhook：POST 触发 + body 变量注入 goal 模板 {{key}}', async () => {
    const r = svc.create({
      name: 'hook',
      kind: 'webhook',
      spec: '',
      action: { mode: 'free', goal: '处理告警：{{title}}（级别 {{level}}）' },
    });
    expect(r.ok).toBe(true);
    const hookId = r.schedule!.id;
    expect(hookId.startsWith('hook_')).toBe(true);

    const res = await svc.fireWebhook(hookId, { title: 'CPU 过高', level: 'P1' });
    expect(res.ok).toBe(true);
    const last = fired[fired.length - 1];
    expect(last.action.goal).toBe('处理告警：CPU 过高（级别 P1）');
    expect(svc.get(hookId)!.fire_count).toBe(1);

    // 不存在的 hook 404 语义
    expect((await svc.fireWebhook('hook_nonexistent', {})).ok).toBe(false);
  });

  it('fire 失败记 last_error（startRun 抛错）', async () => {
    const errSvc = new TriggerService();
    errSvc.bind({
      startRun: async () => { throw new Error('引擎炸了'); },
    });
    const r = errSvc.create({ name: 'bad', kind: 'interval', spec: '60', action: { mode: 'free', goal: 'x' } });
    const { getDb } = await import('../../store/db.js');
    getDb().prepare(`UPDATE schedules SET next_fire_at = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', r.schedule!.id);
    await errSvc.tick();
    expect(errSvc.get(r.schedule!.id)!.last_error).toContain('引擎炸了');
  });
});
