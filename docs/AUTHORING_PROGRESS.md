# 给 Skill 作者：CORAL_PROGRESS 协议与进度埋点指南

> 适用：v1.1.0+
> 关联：[`DESIGN.md §4 CORAL_PROGRESS 协议`](./DESIGN.md#4-coral_progress-协议核心约定)

---

## 1. 为什么需要进度协议？

CORAL 的脚本类 Skill（python / node / bash）是一次性进程，stdout 用于返回最终结果（JSON）。
为了让前端在长任务中能看到「现在在做什么、进度多少、产出了啥」，约定通过 **stderr** 输出符合协议的进度行：

```
[CORAL_PROGRESS] {"phase":"scraping","step":3,"total":8,"percent":37,"message":"正在抓取佛山政数局"}
```

平台 SkillExecutor 会实时解析 stderr，把协议行 → `skill.progress` 事件，把普通 stderr 行 → `skill.log` 事件，
然后通过 WebSocket 与 SSE 双通道下发到前端。

---

## 2. 字段规范

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `phase` | string | ✅ | 阶段标识，自定义（如 `init` / `scraping` / `parsing` / `llm_call` / `writing` / `done`） |
| `message` | string | ✅ | 人类可读描述（前端渲染） |
| `step` | number | ❌ | 当前步骤 (1-based) |
| `total` | number | ❌ | 总步骤数 |
| `percent` | number | ❌ | 0–100；缺省时若 step+total 都给了，平台会自动算 step/total*100 |
| `detail` | object | ❌ | 任意扩展数据（前端可在折叠面板查看） |

---

## 3. Python helper（推荐）

CORAL 在 `skills/_lib/coral_progress.py` 提供了统一 helper，所有 Python Skill 直接 `import` 即可：

```python
import sys
from pathlib import Path

# 把 skills/_lib 加入 sys.path
_LIB = Path(__file__).resolve().parents[2] / '_lib'
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from coral_progress import emit_progress, emit_log, emit_artifact

emit_progress("init", "开始处理", percent=0)
emit_progress("scraping", "[3/8] 佛山政数局 第 1 页",
              step=3, total=8, percent=37,
              site="佛山政数局", page=1)
emit_progress("done", "全部完成", percent=100)

emit_log("普通日志（会作为 skill.log 下发）")
emit_log("出现警告", level="warn")

emit_artifact("政策报告.md", "/path/to/policy.md", artifact_type="markdown")
```

> 仍然可以用任意语言手写协议，只需保证：每行 stderr 以 `[CORAL_PROGRESS] ` 开头 + 合法 JSON。

---

## 3b. Node helper（默认推荐，零 Python 依赖）

Node 脚本技能（`script_runtime: node`）的入口文件用 **`.mjs`** 扩展（明确 ESM，不受外部
package.json 影响），并从 `skills/_lib/` 导入零依赖单文件 helper：

```javascript
// skills/my-skill/scripts/main.mjs
import { emitProgress, emitLog, emitArtifact } from '../../_lib/coral-progress.mjs';

// stdin 读平台输入（JSON），stdout 只写最终结果
const stdin = await new Promise(resolve => {
  let data = '';
  process.stdin.on('data', c => (data += c));
  process.stdin.on('end', () => resolve(data));
});
const { input } = JSON.parse(stdin || '{}');

emitProgress('init', '开始处理', { percent: 0 });
emitProgress('scraping', '[3/8] 第 1 页', { step: 3, total: 8, percent: 37, detail: { page: 1 } });
emitLog('一条普通日志');
emitArtifact('结果文件', 'output/result.md', 'markdown');
emitProgress('done', '全部完成', { percent: 100 });

process.stdout.write(JSON.stringify({ ok: true }));
```

Node 22 内置 `fetch` 与全部 `node:` 模块 — 常见抓取/文件处理技能**无需 npm install**。
npm 包形态的 SDK（`@coral/progress`，API 一致）供技能目录之外的项目使用。

---

## 4. 推荐的 phase 命名

| phase | 含义 |
|-------|------|
| `init` | 启动、加载输入、初始化资源 |
| `scraping` | 网页抓取阶段 |
| `parsing` | 解析、归一化输入 |
| `llm_call` | LLM API 调用阶段 |
| `processing` | 通用处理（按条目循环） |
| `fetching` | 抓取资源（附件、外部数据） |
| `writing` | 写入输出文件 |
| `done` | 完成（可选，最后一条 progress 设 percent=100）|
| `error` | 错误阶段（建议同时 emit_log 写入栈） |

---

## 5. 进度推进的最佳实践

### ✅ 正确做法

```python
emit_progress("init", "启动浏览器", percent=0)
# 真实需要时间的初始化
driver = launch_browser()

n = len(items)
for i, item in enumerate(items, 1):
    pct = round((i / n) * 90, 1)  # 留 10% 给最终写盘
    emit_progress("processing", f"[{i}/{n}] {item.title}",
                  step=i, total=n, percent=pct)
    # ...处理...

emit_progress("writing", "写出文件...", percent=95)
write_file(...)
emit_progress("done", f"完成 {n} 条", percent=100)
```

### ❌ 不推荐

```python
# 每秒发一次假进度（前端会被洗版）
for i in range(100):
    emit_progress("fake", "...", percent=i)
    time.sleep(0.05)

# 长时间不发进度（用户以为卡死）
data = some_30s_blocking_call()
emit_progress("done", "完成")

# stdout 写非协议文本（会污染最终 JSON）
print("正在处理...")  # 错！应该写 stderr
```

---

## 6. 跨语言示例

### Node.js

```javascript
function emitProgress(phase, message, opts = {}) {
  const payload = { phase, message, ...opts };
  process.stderr.write('[CORAL_PROGRESS] ' + JSON.stringify(payload) + '\n');
}
emitProgress('init', '启动', { percent: 0 });
```

### Bash

```bash
emit_progress() {
  local phase="$1"
  local message="$2"
  echo "[CORAL_PROGRESS] {\"phase\":\"$phase\",\"message\":\"$message\"}" >&2
}
emit_progress init "启动"
```

---

## 7. 自动产物检测

平台会在 Skill 输出 JSON 中自动检测 `md_path` / `csv_path` / `json_path` / `output_path` 字段，
若文件存在 → 自动 emit `skill.artifact` 事件并出现在前端「产物列表」。

如果产物路径不在顶层字段，可手动 `emit_artifact()`：

```python
emit_artifact("中间结果.json", "/abs/path.json", artifact_type="json")
```

---

## 8. 调试

```bash
# 直接命令行运行 Skill 脚本（手动喂 stdin JSON）
echo '{"input":{"year":2026,"month":3}}' | python skills/policy-scraper/scripts/scrape.py
```

进度行会打印到 stderr，结果 JSON 写到 stdout。

---

## 9. 协议变更兼容

- 缺失字段会被忽略（不会报错）
- 非法 JSON 行会作为 `skill.log` 下发（level=warn）
- 跨 chunk 截断的 JSON 行会被自动缓冲合并

---

## 10. 进度延迟与采样

如果你的循环非常密集（如毫秒级），建议**降采样**：

```python
LOG_EVERY = 10
for i, x in enumerate(big_list):
    if i % LOG_EVERY == 0 or i == len(big_list) - 1:
        emit_progress("processing", f"{i}/{len(big_list)}",
                      step=i + 1, total=len(big_list))
```

平台对单事件无频率限制，但前端只会保留最近 500 条 log，过密会刷掉关键信息。
