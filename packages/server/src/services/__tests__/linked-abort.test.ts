import { describe, it, expect } from 'vitest';
import { linkAbortWithTimeout } from '../linked-abort.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('linkAbortWithTimeout（M0-3 超时/取消联动）', () => {
  it('超时到期：内层信号 abort，timedOut=true，外层信号不受影响', async () => {
    const outer = new AbortController();
    const linked = linkAbortWithTimeout(outer.signal, 50);

    expect(linked.signal.aborted).toBe(false);
    await sleep(120);

    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut).toBe(true);
    expect(outer.signal.aborted).toBe(false); // 超时不是用户取消
    linked.cleanup();
  });

  it('外层取消：内层信号立即 abort，timedOut=false', () => {
    const outer = new AbortController();
    const linked = linkAbortWithTimeout(outer.signal, 60000);

    outer.abort();
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut).toBe(false);
    linked.cleanup();
  });

  it('外层已取消时创建：内层立即 abort（不等待）', () => {
    const outer = new AbortController();
    outer.abort();
    const linked = linkAbortWithTimeout(outer.signal, 60000);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut).toBe(false);
    linked.cleanup();
  });

  it('cleanup 后：timer 不再触发、外层监听已摘除', async () => {
    const outer = new AbortController();
    const linked = linkAbortWithTimeout(outer.signal, 50);
    linked.cleanup();

    await sleep(120);
    expect(linked.signal.aborted).toBe(false); // timer 已清除
    expect(linked.timedOut).toBe(false);

    outer.abort();
    expect(linked.signal.aborted).toBe(false); // 监听已摘除，不再联动
  });
});
