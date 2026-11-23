import { describe, it, expect } from 'vitest';
import { evaluateDeterministic, taskLooksMultiPart } from '../self-eval.js';

/**
 * REG-33：自评"任务规模"判断的正则写成了字符类。
 *
 * 原写法 /[并且|以及|然后|同时|;|；|1\.|2\.]/ —— 方括号里 `|` 与每个汉字都只是单个字符，
 * 等于"目标里出现 并/且/以/及/然/后/同/时/;/；/1/./2 任意一个就算大任务"。
 * 于是带版本号、日期、网址的目标（几乎全部）都被判成"大任务"，简洁的回答被扣上
 * "回答长度与任务规模明显不成比例"。
 */

describe('taskLooksMultiPart（任务规模判断）', () => {
  it('真正的多部分任务：并列连词 / 分号 / 步骤编号 / 超长目标', () => {
    expect(taskLooksMultiPart('总结这份文档，并且列出三个风险')).toBe(true);
    expect(taskLooksMultiPart('先翻译，再润色，然后给出三个标题')).toBe(true);
    expect(taskLooksMultiPart('生成报告；附带数据表；写一段摘要')).toBe(true);
    expect(taskLooksMultiPart('完成以下步骤：\n1. 调研\n2. 写作\n3. 校对')).toBe(true);
    expect(taskLooksMultiPart('日程：1. 站会 2. 评审 3. 复盘')).toBe(true);
    expect(taskLooksMultiPart('同'.repeat(130))).toBe(true); // 仅按长度判定
  });

  it('只是出现了单个汉字 / 数字 / 小数 / 日期 / 竖线，不算多部分任务', () => {
    expect(taskLooksMultiPart('2024 年诺贝尔物理学奖得主是谁？')).toBe(false);
    expect(taskLooksMultiPart('把 3.14 转成分数')).toBe(false);
    expect(taskLooksMultiPart('今天 2024.11.23 有什么科技新闻')).toBe(false);
    expect(taskLooksMultiPart('之后|以前 这两个词哪个更正式？')).toBe(false);
    expect(taskLooksMultiPart('同一时间、同一地点，用英语怎么说')).toBe(false);
    expect(taskLooksMultiPart('1 加 2 等于几')).toBe(false);
  });
});

describe('evaluateDeterministic · completeness 轴不受无关字符影响', () => {
  // 单任务目标，长度落在 (100, 120]：不触发"仅按长度"规则；含版本号 "1" —— 原字符类会把它判成大任务
  const goal = ('请把产品说明里的一句话翻译成英文，保持原有的礼貌语气，不要增减任何信息，也不要添加任何解释或备注，' +
    '直接给出译文即可，明天上午九点前要交给客户审阅第 1 版，请务必仔细核对，这件事对我很重要，麻烦你了' + '。'.repeat(20)).slice(0, 119);
  // 51 字符：不算"过短"（<50），但不到目标长度的一半 —— 只有"误判成大任务"时才会被扣分
  const answer = 'Thank you for choosing our product. Setup is quick.';

  it('目标含 "1" 不等于大任务：回答不应被扣"长度不成比例"', () => {
    expect(goal.length).toBeGreaterThan(100);
    expect(goal.length).toBeLessThanOrEqual(120);
    expect(answer.length).toBeGreaterThanOrEqual(50);
    expect(answer.length).toBeLessThan(goal.length / 2);
    const r = evaluateDeterministic(goal, answer);
    const completeness = r.axes.find(a => a.axis === 'completeness')!;
    expect(completeness.score).toBe(5);
    expect(r.heuristicNotes.some(n => n.includes('不成比例'))).toBe(false);
  });

  it('真正的多部分任务 + 明显不成比例的回答，仍然要扣分（既有行为不变）', () => {
    const bigGoal = '写一份市场调研报告，并且制作数据表格，然后给出三页幻灯片大纲，同时附上参考文献列表，全部保存为文件，' +
      '不要遗漏任何一项内容，每一部分都要有明确的标题和简短的说明，方便我直接拿去汇报使用，明天下午的部门会议上要用，请尽量写得完整一些，谢谢你的帮忙，辛苦了。';
    const thinAnswer = '调研报告、数据表格、幻灯片大纲和参考文献列表都已经全部完成了，每一个文件也都已经保存到工作区根目录下面了。'; // ≥50 且不到目标一半
    expect(bigGoal.length).toBeGreaterThan(120);
    expect(thinAnswer.length).toBeGreaterThanOrEqual(50);
    expect(thinAnswer.length).toBeLessThan(bigGoal.length / 2);
    expect(evaluateDeterministic(bigGoal, thinAnswer).axes.find(a => a.axis === 'completeness')!.score).toBe(3);
    // 过短回答：与任务规模无关，直接 2 分
    expect(evaluateDeterministic(bigGoal, '已完成。').axes.find(a => a.axis === 'completeness')!.score).toBe(2);
  });
});
