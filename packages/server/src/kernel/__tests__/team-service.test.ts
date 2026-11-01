import { describe, it, expect } from 'vitest';
import { TeamService } from '../team-service.js';

/** Teams 单元：任务板 CAS/DAG、邮箱步边界排空、名字永久占用、上限 */

function svc() {
  const events: Array<{ type: string; payload?: any }> = [];
  return { team: new TeamService('run-t', ev => events.push(ev)), events };
}

describe('TeamService — 任务板', () => {
  it('create/list：blockedBy 引用校验 + ready 派生', () => {
    const { team } = svc();
    const a = team.createTask({ subject: '查 A' });
    const b = team.createTask({ subject: '汇总', blockedBy: [a.task!.id] });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const view = team.listTasks();
    expect(view.find(t => t.id === 't1')!.ready).toBe(true);
    expect(view.find(t => t.id === 't2')!.ready).toBe(false); // 被 t1 阻塞

    const ghost = team.createTask({ subject: 'x', blockedBy: ['t99'] });
    expect(ghost.ok).toBe(false);
    expect((ghost as any).error).toContain('不存在');
  });

  it('无环校验：A→B→A 拒绝', () => {
    const { team } = svc();
    const a = team.createTask({ subject: 'A' }).task!;
    const b = team.createTask({ subject: 'B', blockedBy: [a.id] }).task!;
    const cyc = team.updateTask({ id: a.id, addBlockedBy: [b.id] });
    expect(cyc.ok).toBe(false);
    expect((cyc as any).error).toContain('环');
  });

  it('revision CAS：过期版本被拒，revision 每次变更 +1', () => {
    const { team } = svc();
    const t = team.createTask({ subject: 'A' }).task!;
    expect(t.revision).toBe(1);
    const ok1 = team.updateTask({ id: t.id, status: 'in_progress', expectedRevision: 1 });
    expect(ok1.ok).toBe(true);
    expect((ok1 as any).task.revision).toBe(2);
    const stale = team.updateTask({ id: t.id, status: 'completed', expectedRevision: 1 });
    expect(stale.ok).toBe(false);
    expect((stale as any).error).toContain('版本冲突');
  });

  it('completed 解除阻塞：blockedBy 全完成后 ready', () => {
    const { team } = svc();
    const a = team.createTask({ subject: 'A' }).task!;
    team.createTask({ subject: 'B', blockedBy: [a.id] });
    team.updateTask({ id: a.id, status: 'completed' });
    expect(team.listTasks().find(t => t.id === 't2')!.ready).toBe(true);
  });
});

describe('TeamService — 邮箱与名册', () => {
  it('send/drain：入队 → 步边界排空（一次性取走）', () => {
    const { team } = svc();
    team.claimName('scout');
    team.registerTeammate('scout', 'mate-1');
    expect(team.send('main', 'scout', '去查 X').ok).toBe(true);
    expect(team.send('main', 'scout', '顺便查 Y').ok).toBe(true);

    const got = team.drain('mate-1');
    expect(got.length).toBe(2);
    expect(got[0].from).toBe('main');
    expect(team.drain('mate-1')).toHaveLength(0); // 排空后为空
  });

  it('send 到未知目标 → 明确报错；main 恒可达', () => {
    const { team } = svc();
    const bad = team.send('scout', 'nobody', 'hi');
    expect(bad.ok).toBe(false);
    expect(team.send('scout', 'main', 'report').ok).toBe(true);
    expect(team.drain('main').length).toBe(1);
  });

  it('名字永久占用（含失败成员，不复用）', () => {
    const { team } = svc();
    expect(team.claimName('scout').ok).toBe(true);
    team.registerTeammate('scout', 'mate-1');
    team.settleTeammate('scout', 'failed', { status: 'crashed', finalContent: '' });
    const again = team.claimName('scout');
    expect(again.ok).toBe(false);
  });

  it('非法名字与成员上限', () => {
    const { team } = svc();
    expect(team.claimName('Bad Name').ok).toBe(false);
    expect(team.claimName('x').ok).toBe(false); // 至少 2 位
    // 装满 16 个
    for (let i = 0; i < 16; i++) expect(team.claimName(`mate-${i}`).ok, `mate-${i}`).toBe(true);
    expect(team.claimName('one-more').ok).toBe(false);
  });

  it('事件流：任务与消息操作全部留痕（team.*）', () => {
    const { team, events } = svc();
    team.createTask({ subject: 'A' });
    team.claimName('scout');
    team.registerTeammate('scout', 'mate-1');
    team.send('main', 'scout', 'hi');
    team.drain('mate-1');
    const types = events.map(e => e.type);
    expect(types).toContain('team.task_created');
    expect(types).toContain('team.teammate_started');
    expect(types).toContain('team.message_queued');
  });
});
