import { describe, it, expect } from 'vitest';
import { ProgressParser, parseProgressText } from '../progress-parser.js';

describe('ProgressParser — [CORAL_PROGRESS] 协议解析（M0-7）', () => {
  it('合法协议行 → progress 事件；step/total 自动算 percent', () => {
    const parser = new ProgressParser();
    const { progressEvents, logLines } = parser.feed(
      '[CORAL_PROGRESS] {"phase":"scraping","step":3,"total":8,"message":"正在抓取佛山政数局"}\n'
    );

    expect(progressEvents).toHaveLength(1);
    expect(logLines).toHaveLength(0);
    const ev = progressEvents[0];
    expect(ev.phase).toBe('scraping');
    expect(ev.message).toBe('正在抓取佛山政数局');
    expect(ev.step).toBe(3);
    expect(ev.total).toBe(8);
    expect(ev.percent).toBe(37.5); // 3/8
  });

  it('显式 percent 优先并被夹紧到 [0,100]', () => {
    const parser = new ProgressParser();
    const over = parser.feed('[CORAL_PROGRESS] {"phase":"x","percent":150,"message":"m"}\n');
    expect(over.progressEvents[0].percent).toBe(100);

    const parser2 = new ProgressParser();
    const under = parser2.feed('[CORAL_PROGRESS] {"phase":"x","percent":-5,"message":"m"}\n');
    expect(under.progressEvents[0].percent).toBe(0);
  });

  it('detail 对象透传；缺失字段不出现（undefined 不落）', () => {
    const parser = new ProgressParser();
    const { progressEvents } = parser.feed(
      '[CORAL_PROGRESS] {"phase":"p","message":"m","detail":{"site":"gdii","page":2}}\n'
    );
    expect(progressEvents[0].detail).toEqual({ site: 'gdii', page: 2 });
    expect(progressEvents[0].step).toBeUndefined();
    expect(progressEvents[0].percent).toBeUndefined();
  });

  it('协议前缀但 JSON 不合法 → 降级为 warn 日志', () => {
    const parser = new ProgressParser();
    const { progressEvents, logLines } = parser.feed('[CORAL_PROGRESS] {oops not json}\n');
    expect(progressEvents).toHaveLength(0);
    expect(logLines).toHaveLength(1);
    expect(logLines[0].level).toBe('warn');
    expect(logLines[0].message).toContain('CORAL_PROGRESS');
  });

  it('非协议行 → 日志，启发式分级（error/warn/info）', () => {
    const parser = new ProgressParser();
    const { logLines } = parser.feed(
      'starting up\nTraceback (most recent call last):\nwarning: retry in 5s\n'
    );
    expect(logLines.map(l => l.level)).toEqual(['info', 'error', 'warn']);
    // 复合词（如 DeprecationWarning）不触发 \b 边界匹配 — 按预期保持 info
    const parser2 = new ProgressParser();
    const compound = parser2.feed('DeprecationWarning: use new API instead\n');
    expect(compound.logLines[0].level).toBe('info');
  });

  it('跨 chunk 截断的协议行被缓冲到完整后再解析', () => {
    const parser = new ProgressParser();
    const part1 = parser.feed('[CORAL_PROGRESS] {"phase":"scrap","step":1,"to');
    expect(part1.progressEvents).toHaveLength(0); // 尚未完整

    const part2 = parser.feed('tal":2,"message":"跨块"}\n');
    expect(part2.progressEvents).toHaveLength(1);
    expect(part2.progressEvents[0].message).toBe('跨块');
  });

  it('CRLF 与空行被正确处理', () => {
    const parser = new ProgressParser();
    const { progressEvents, logLines } = parser.feed(
      '\r\n[CORAL_PROGRESS] {"phase":"a","message":"crlf"}\r\n\r\nplain line\r\n'
    );
    expect(progressEvents).toHaveLength(1);
    expect(logLines).toHaveLength(1);
    expect(logLines[0].message).toBe('plain line');
  });

  it('flush() 把无换行尾巴作为日志吐出；空 buffer 无输出', () => {
    const parser = new ProgressParser();
    parser.feed('[CORAL_PROGRESS] {"phase":"a","message":"done"}\n');
    const empty = parser.flush();
    expect(empty.logLines).toHaveLength(0);

    const parser2 = new ProgressParser();
    parser2.feed('dangling tail without newline');
    const tail = parser2.flush();
    expect(tail.logLines).toHaveLength(1);
    expect(tail.logLines[0].message).toBe('dangling tail without newline');
  });

  it('parseProgressText 一次性解析完整文本', () => {
    const { progressEvents, logLines } = parseProgressText(
      '[CORAL_PROGRESS] {"phase":"s","percent":50,"message":"half"}\nsome log\n'
    );
    expect(progressEvents).toHaveLength(1);
    expect(logLines).toHaveLength(1);
  });

  it('P3：超长无换行输出被截断（内存上限），尾部协议行仍可解析', () => {
    const parser = new ProgressParser();
    // 100KB 无换行垃圾
    const { logLines } = parser.feed('x'.repeat(100 * 1024));
    expect(logLines).toHaveLength(1);
    expect(logLines[0].level).toBe('warn');
    expect(logLines[0].message).toContain('corrupt');

    // buffer 已裁到上限以内 — 随后的协议行（拼接后）仍能正常解析
    const second = parser.feed('y'.repeat(500) + '\n[CORAL_PROGRESS] {"phase":"ok","message":"after"}\n');
    expect(second.progressEvents).toHaveLength(1);
    expect(second.progressEvents[0].message).toBe('after');
  });
});
