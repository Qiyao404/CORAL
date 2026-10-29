#!/usr/bin/env python3
"""PawBench automated 判分 runner：stdin 收 {code, transcript, workspace_path}，
执行任务内嵌的 grade() 并把结果 JSON 打到 stdout。grade() 返回 {"score": 0~1, ...}。"""
import json
import sys

def main():
    payload = json.loads(sys.stdin.read() or "{}")
    code = payload["code"]
    namespace: dict = {}
    exec(code, namespace)  # noqa: S102 — 评测任务自带的判分代码
    grade = namespace.get("grade")
    if not callable(grade):
        print(json.dumps({"error": "grade() not found"}))
        return
    try:
        result = grade(payload.get("transcript", []), payload.get("workspace_path", ""))
        score = result.get("score", 0.0) if isinstance(result, dict) else 0.0
        try:
            score = float(score)
        except (TypeError, ValueError):
            score = 0.0
        print(json.dumps({"score": max(0.0, min(1.0, score)), "raw": result}, default=str))
    except Exception as exc:  # 判分代码自身异常按 0 记
        print(json.dumps({"score": 0.0, "error": str(exc)}))

if __name__ == "__main__":
    main()
