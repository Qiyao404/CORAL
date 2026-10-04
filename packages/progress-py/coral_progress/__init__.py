#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CORAL_PROGRESS 协议 helper（T-105）

通过 stderr 输出单行 JSON，前缀为 [CORAL_PROGRESS]，用于让平台前端获得细粒度进度反馈。

用法：
    from skills._lib.coral_progress import emit_progress, emit_log

    emit_progress("init", "开始处理", percent=0)
    emit_progress("scraping", "[3/8] 佛山政数局 第 1 页",
                  step=3, total=8, percent=37,
                  detail={"site": "佛山政数局", "page": 1})
    emit_progress("done", "全部完成", percent=100)

    emit_log("普通日志（会作为 skill.log 下发到前端）")
    emit_log("出现警告", level="warn")

兼容运行方式：
    1) 通过 CORAL SkillExecutor 调用（stderr 实时被解析）
    2) 直接命令行运行（脚本作者本地调试，progress 会打印到 stderr）

注意：
    · 不要在 stdout 写入除最终 JSON 结果外的任何内容（stdout 是 Skill 的"返回值"通道）。
    · message/detail 中的中文可以原样输出（ensure_ascii=False）。
"""
from __future__ import annotations

import json
import sys
from typing import Any, Optional


def emit_progress(
    phase: str,
    message: str = "",
    step: Optional[int] = None,
    total: Optional[int] = None,
    percent: Optional[float] = None,
    **detail: Any,
) -> None:
    payload: dict[str, Any] = {"phase": phase, "message": message}
    if step is not None:
        payload["step"] = step
    if total is not None:
        payload["total"] = total
    if percent is not None:
        payload["percent"] = max(0, min(100, float(percent)))
    if detail:
        payload["detail"] = detail
    line = "[CORAL_PROGRESS] " + json.dumps(payload, ensure_ascii=False)
    print(line, file=sys.stderr, flush=True)


def emit_log(message: str, level: str = "info") -> None:
    """普通日志（不带协议前缀），平台会作为 skill.log 事件下发"""
    if level in {"warn", "warning"}:
        prefix = "[WARN] "
    elif level in {"err", "error"}:
        prefix = "[ERROR] "
    elif level == "debug":
        prefix = "[DEBUG] "
    else:
        prefix = ""
    print(f"{prefix}{message}", file=sys.stderr, flush=True)


def emit_artifact(
    name: str,
    path: str,
    artifact_type: str = "file",
    preview: Optional[str] = None,
) -> None:
    """显式声明产物 —— 通常会自动检测，但当产物路径不在 stdout result 顶层字段时可手动 emit"""
    payload = {
        "phase": "artifact",
        "message": f"产物: {name}",
        "detail": {
            "_artifact": {
                "name": name,
                "path": path,
                "type": artifact_type,
                "preview": preview,
            }
        },
    }
    print("[CORAL_PROGRESS] " + json.dumps(payload, ensure_ascii=False),
          file=sys.stderr, flush=True)


__all__ = ["emit_progress", "emit_log", "emit_artifact"]
