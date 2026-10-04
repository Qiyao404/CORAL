# CORAL_PROGRESS Protocol

**Version: 1.0** · Status: stable · 2026-10-04

一个让任意子进程脚本向 CORAL 平台**实时上报进度、日志、产物**的极简协议：
**stderr 上的一行一个 JSON**，固定前缀 `[CORAL_PROGRESS] `。零依赖、双语言 SDK、
可被人直接阅读调试。

> 为什么不用 stdout？stdout 是技能脚本的"返回值"通道（最终 JSON 结果），
> 协议数据混进去会破坏结果解析。stderr 天然适合旁路信号。

---

## 1. 传输与帧

| 项 | 约定 |
|---|---|
| 通道 | 子进程 stderr |
| 帧 | 一行一条，`\n` 结尾 |
| 协议帧前缀 | `[CORAL_PROGRESS] ` + JSON（UTF-8，`ensure_ascii=false`） |
| 非协议帧 | 无前缀的行 = 普通日志（见 §4 启发式分级） |
| stdout | **只允许**最终结果 JSON（协议不占用） |

### 解析器行为（平台侧，`ProgressParser`）

- **跨 chunk 缓冲**：stderr 按字节流到达，一行可能被切在任意位置 — 解析器按 `\n` 组帧后再解析，不丢帧
- **坏行容错**：JSON 解析失败的协议帧降级为一条 `warn` 日志，不中断
- **前缀裁剪**：`[CORAL_PROGRESS] ` 之前允许有行首空白（lib 打印场景）
- **钳制**：`percent` 超出 `[0,100]` 一律钳制；`step > total` 时进度按 100% 显示
- **flush**：进程退出前未完结的行（无尾随 `\n`）在 close 时冲刷一次

## 2. 消息体

### 2.1 progress（进度）

```json
{"phase":"scraping","message":"[3/8] 佛山政数局 第 1 页","step":3,"total":8,"percent":37,"detail":{"site":"佛山政数局","page":1}}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|:--:|---|
| `phase` | string | ✓ | 阶段标识（脚本自定义，如 init/scraping/done） |
| `message` | string | | 人类可读描述 |
| `step` / `total` | number | | 分子/分母（可选，平台渲染 3/8） |
| `percent` | number | | 0-100（钳制；与 step/total 独立可用） |
| `detail` | object | | 任意附加数据（透传到事件流） |

约定：`phase: "done"` 或 `percent: 100` 表示完成。

### 2.2 artifact（产物声明）

```json
{"phase":"artifact","message":"产物: 报告.docx","detail":{"_artifact":{"name":"报告.docx","path":"output/报告.docx","type":"file","preview":"…前 200 字"}}}
```

- 自动检测之外的手动产物声明：**`phase === "artifact"` 且 `detail._artifact` 存在**即识别
- `_artifact` 字段：`name`（必填）/ `path`（必填）/ `type`（file/markdown/csv/json/text，默认 file）/ `preview`（可选）
- 平台将其转为与自动检测同款的 `skill.artifact` 事件

### 2.3 普通日志（无前缀帧）

无前缀的 stderr 行直接作为 `skill.log` 事件下发。级别由**行首启发式**判定：

| 行首 | 级别 |
|---|---|
| `[WARN] ` | warn |
| `[ERROR] ` / `[ERR] ` | error |
| `[DEBUG] ` | debug |
| 其他 | info |

## 3. SDK

### Node（`@coral/progress`，npm）

```js
import { createProgress, emitProgress, emitLog, emitArtifact } from '@coral/progress';

const p = createProgress();               // 默认写 process.stderr；可注入 sink
p.emitProgress('init', '开始处理', { percent: 0 });
p.emitProgress('scraping', '[3/8] 第 1 页', { step: 3, total: 8, percent: 37, detail: { page: 1 } });
p.emitLog('一条普通日志');
p.emitLog('警告', 'warn');
p.emitArtifact({ name: '结果.md', path: 'output/result.md', type: 'markdown', preview: '…' });
```

技能脚本内**零配置用法**：直接相对导入单文件版（不依赖 npm 包）：

```js
import { emitProgress } from '../../_lib/coral-progress.mjs';
```

### Python（`coral-progress`，PyPI）

```python
from coral_progress import emit_progress, emit_log, emit_artifact

emit_progress("init", "开始处理", percent=0)
emit_progress("scraping", "[3/8] 佛山政数局 第 1 页", step=3, total=8, percent=37, site="佛山政数局", page=1)
emit_log("普通日志")
emit_log("出现警告", level="warn")
emit_artifact("结果.csv", "output/result.csv", "csv", preview="a,b\n1,2")
```

技能脚本内零配置用法：`from skills._lib.coral_progress import emit_progress`（平台注入 `sys.path`）。

> Python 版 `emit_progress` 的多余关键字参数自动收进 `detail`（符合直觉）；
> Node 版显式传 `detail` 对象。

## 4. 版本化

- 本规范 **v1.0**。向后兼容的字段新增 = 小版本；解析器必须忽略未知字段
- 破坏性变更（帧格式/通道/前缀变更）= 大版本，平台与 SDK 同步升级并双栈过渡
- 相关实现：`packages/server/src/skill-runtime/progress-parser.ts`（解析器，含跨 chunk/钳制/启发式测试）、
  `packages/progress`（npm）、`packages/progress-py`（PyPI 源）、`skills/_lib/`（单文件零依赖版）
