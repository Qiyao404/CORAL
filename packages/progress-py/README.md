# coral-progress (Python)

CORAL_PROGRESS 协议 SDK：让 CORAL 技能脚本（或任意子进程）通过 **stderr 单行 JSON**
实时上报进度 / 日志 / 产物。零依赖、可直接阅读调试。

```python
from coral_progress import emit_progress, emit_log, emit_artifact

emit_progress("init", "开始处理", percent=0)
emit_progress("scraping", "[3/8] 第 1 页", step=3, total=8, percent=37, page=1)
emit_log("一条普通日志")
emit_log("出现警告", level="warn")
emit_artifact("结果.csv", "output/result.csv", "csv", preview="a,b\n1,2")
```

协议规范：[docs/PROGRESS_PROTOCOL.md](https://github.com/Qiyao404/CORAL/blob/main/docs/PROGRESS_PROTOCOL.md)（v1.0）
