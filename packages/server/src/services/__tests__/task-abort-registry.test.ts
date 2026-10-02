import { describe, it, expect } from 'vitest';
import {
  createAbortController,
  abortTask,
  abortAll,
  isTaskAborted,
  releaseAbortController,
} from '../task-abort-registry.js';

describe('task-abort-registry（M0-2 A1 修复）', () => {
  it('create → abort → isAborted 生效', () => {
    createAbortController('t1');
    expect(isTaskAborted('t1')).toBe(false);

    expect(abortTask('t1')).toBe(true);
    expect(isTaskAborted('t1')).toBe(true);
  });

  it('重复 abort 幂等；不存在的任务返回 false', () => {
    createAbortController('t2');
    abortTask('t2');
    expect(abortTask('t2')).toBe(true); // 幂等
    expect(abortTask('never-exists')).toBe(false);
  });

  it('release 后 abortTask 找不到（执行管线已结束）', () => {
    createAbortController('t3');
    releaseAbortController('t3');
    expect(abortTask('t3')).toBe(false);
  });

  it('同 taskId 重复 create 返回全新 controller（旧信号不受影响）', () => {
    const c1 = createAbortController('t4');
    const c2 = createAbortController('t4');
    expect(c1).not.toBe(c2);
    c1.abort();
    expect(c2.signal.aborted).toBe(false);
    expect(isTaskAborted('t4')).toBe(false);
    releaseAbortController('t4');
  });

  it('abortAll 中止全部存活任务、跳过已中止的，并返回数量（关机清理用）', () => {
    createAbortController('m1');
    createAbortController('m2');
    createAbortController('m3');
    abortTask('m3'); // m3 已中止 — 不应重复计入

    expect(abortAll()).toBe(2);
    expect(isTaskAborted('m1')).toBe(true);
    expect(isTaskAborted('m2')).toBe(true);

    releaseAbortController('m1');
    releaseAbortController('m2');
    releaseAbortController('m3');
  });

  it('abortAll 空注册表返回 0', () => {
    expect(abortAll()).toBe(0);
  });
});
