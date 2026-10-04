#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
information-filter 归一化 + LLM 评估 + 写出 MD/CSV（hybrid 第一阶段脚本）

虽然在 SKILL.md 中声明为 hybrid，但本脚本完整实现了归一化 → LLM 评估 → 写盘三步，
原因：CORAL 平台的 hybrid 是「先脚本归一化，再 LLM 处理；脚本输出会作为 LLM 的输入合并」，
但 LLM 评估本身需要一次性看完所有条目（分批），这部分在脚本里处理更可控。

CORAL stdin JSON：
  {"input": {"md_path": "..."}, "context": {"companyProfile": {...}}}
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import csv
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Optional, Any

# 引入 CORAL helper
_HERE = Path(__file__).resolve().parent
_LIB_PATH = _HERE.parents[2] / '_lib'
if str(_LIB_PATH) not in sys.path:
    sys.path.insert(0, str(_LIB_PATH))
try:
    from coral_progress import emit_progress, emit_log  # type: ignore
except Exception:
    def emit_progress(phase, message="", step=None, total=None, percent=None, **detail):
        payload = {"phase": phase, "message": message}
        if step is not None: payload["step"] = step
        if total is not None: payload["total"] = total
        if percent is not None: payload["percent"] = percent
        if detail: payload["detail"] = detail
        print("[CORAL_PROGRESS] " + json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
    def emit_log(message, level="info"):
        print(message, file=sys.stderr, flush=True)


# ── 输入归一化 ────────────────────────────────────────────

MD_TITLE_RE = re.compile(r"^###\s+(.+?)\s*$")
MD_DATE_RE = re.compile(r"\*\*发布日期\*\*\s*[:：]\s*([0-9\-/年月日.\s]+)")
MD_LINK_RE = re.compile(r"\*\*链接\*\*\s*[:：]\s*<?([^>\s]+)>?")
MD_SOURCE_RE = re.compile(r"\*\*来源\*\*\s*[:：]\s*([^\n]+)")
MD_SECTION_HEADER_RE = re.compile(r"^##\s+(.+?)\s*(?:（\d+\s*条）)?\s*$")


def parse_md(md: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    current_section = ""
    cur: dict[str, Any] | None = None

    def commit():
        if cur and cur.get("title"):
            items.append({
                "title": cur.get("title", ""),
                "date": cur.get("date", ""),
                "source": cur.get("source") or current_section or "",
                "url": cur.get("url", ""),
                "excerpt": cur.get("excerpt", ""),
            })

    for raw in md.splitlines():
        line = raw.rstrip()
        sec = MD_SECTION_HEADER_RE.match(line)
        if sec:
            commit()
            cur = None
            current_section = sec.group(1).strip()
            continue
        title_m = MD_TITLE_RE.match(line)
        if title_m:
            commit()
            cur = {"title": title_m.group(1).strip()}
            continue
        if cur is None:
            continue
        if MD_DATE_RE.search(line):
            cur["date"] = MD_DATE_RE.search(line).group(1).strip()
            continue
        if MD_LINK_RE.search(line):
            cur["url"] = MD_LINK_RE.search(line).group(1).strip()
            continue
        if MD_SOURCE_RE.search(line):
            cur["source"] = MD_SOURCE_RE.search(line).group(1).strip()
            continue
    commit()
    return items


def parse_csv(csv_path: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    try:
        import pandas as pd
        df = pd.read_csv(csv_path, encoding="utf-8-sig")
    except Exception as e:
        emit_log(f"CSV 读取失败: {e}", level="error")
        return []

    aliases = {
        "title": ["标题", "题目", "名称", "政策名称", "title"],
        "date":  ["发布日期", "日期", "时间", "publish_time", "date"],
        "source":["发布部门", "部门", "来源", "发布机构", "发布网站", "source"],
        "url":   ["URL", "链接", "网址", "原文链接", "URL链接", "url"],
    }
    cols = {}
    for std, names in aliases.items():
        for c in df.columns:
            if str(c).strip() in names:
                cols[std] = c
                break
    for _, row in df.iterrows():
        items.append({
            "title": str(row.get(cols.get("title"), "")).strip(),
            "date": str(row.get(cols.get("date"), "")).strip() if cols.get("date") else "",
            "source": str(row.get(cols.get("source"), "")).strip() if cols.get("source") else "",
            "url": str(row.get(cols.get("url"), "")).strip() if cols.get("url") else "",
            "excerpt": "",
        })
    return [it for it in items if it.get("title")]


def fetch_url_meta(url: str, timeout: int = 8) -> dict[str, str]:
    try:
        import requests
        from bs4 import BeautifulSoup
        resp = requests.get(url, timeout=timeout, verify=False)
        resp.encoding = resp.apparent_encoding or 'utf-8'
        soup = BeautifulSoup(resp.text, 'html.parser')
        title = soup.find('title').get_text(strip=True) if soup.find('title') else url
        first_p = soup.find('p')
        excerpt = first_p.get_text(strip=True)[:200] if first_p else ""
        return {"title": title, "excerpt": excerpt, "url": url, "date": "", "source": ""}
    except Exception as e:
        emit_log(f"  抓取 URL 失败: {url} → {e}", level="warn")
        return {"title": url, "excerpt": "", "url": url, "date": "", "source": ""}


def normalize_input(inp: dict) -> list[dict]:
    if inp.get("md_content"):
        return parse_md(inp["md_content"])
    if inp.get("md_path"):
        text = Path(inp["md_path"]).read_text(encoding='utf-8')
        return parse_md(text)
    if inp.get("csv_path"):
        return parse_csv(inp["csv_path"])
    if inp.get("urls"):
        return [fetch_url_meta(u) for u in inp["urls"]]
    if inp.get("text"):
        text = inp["text"]
        title = text.split('\n', 1)[0][:80].strip() or '未命名条目'
        return [{"title": title, "date": "", "source": "", "url": "", "excerpt": text[:600]}]
    return []


# ── LLM 评估 ────────────────────────────────────────────

BATCH_SIZE = 20
MAX_RETRIES = 3


def call_llm(items: list[dict], profile: dict) -> list[dict]:
    """对一批条目调用 LLM，返回 decisions"""
    try:
        from openai import OpenAI
    except ImportError:
        emit_log("openai 包未安装", level="error")
        return [{"index": i["index"], "keep": True, "reason": "LLM 不可用，保守保留"} for i in items]

    base_url = os.environ.get("LLM_BASE_URL") or "https://coding.dashscope.aliyuncs.com/v1"
    api_key = os.environ.get("LLM_API_KEY") or ""
    model = os.environ.get("LLM_MODEL") or "kimi-k2.5"

    if not api_key:
        # 尝试从项目根 .env 读取
        env_path = Path(__file__).resolve().parents[3] / ".env"
        if env_path.exists():
            for line in env_path.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k = k.strip(); v = v.strip()
                if k == 'LLM_API_KEY' and not api_key: api_key = v
                if k == 'LLM_BASE_URL': base_url = v
                if k == 'LLM_MODEL': model = v

    if not api_key:
        emit_log("LLM_API_KEY 未配置，所有条目保守保留", level="warn")
        return [{"index": i["index"], "keep": True, "reason": "API 未配置，保守保留"} for i in items]

    client = OpenAI(base_url=base_url, api_key=api_key, timeout=60)

    industries = ', '.join(profile.get("industries", []))
    core_businesses = ', '.join(profile.get("coreBusinesses", []))
    focus_keywords = ', '.join(profile.get("focusKeywords", []))
    exclude_keywords = ', '.join(profile.get("excludeKeywords", []))
    items_compact = json.dumps(items, ensure_ascii=False)

    prompt = f"""你是一位专业的 {industries} 领域分析师和项目申报专家，熟悉 {core_businesses} 相关的政策与产业生态。

# 公司业务画像
{json.dumps(profile, ensure_ascii=False, indent=2)}

# 评估对象（共 {len(items)} 条）
{items_compact}

# 任务
对每条信息基于"标题 + 摘要"做语义判断，决定保留或剔除，并给出 ≤ 30 字的理由。

## 保留规则
- 实质性政策文件：办法、措施、意见、规划、行动计划、指引、条例
- 项目申报与认定：申报、征集、组织开展、入库、培育
- 公司画像内的关键词命中：{focus_keywords}
- 与公司核心业务（{core_businesses}）相关的重大行业动态

## 剔除规则
- 已有结果：公示、名单、拟认定、通过
- 行政/人事/党建：人事任命、领导、座谈会、值班
- 非政策性公告：单纯采购/招标、统计数据、新闻
- 命中排除关键词：{exclude_keywords}

# 输出（严格 JSON，不要 markdown 代码块）
{{
  "decisions": [
    {{"index": 0, "keep": true,  "reason": "..."}},
    {{"index": 1, "keep": false, "reason": "..."}}
  ]
}}"""

    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=4000,
            )
            content = resp.choices[0].message.content or ""
            content = content.strip()
            if content.startswith("```"):
                content = re.sub(r"^```(?:json)?\s*", "", content)
                content = re.sub(r"\s*```$", "", content)
            data = json.loads(content)
            decisions = data.get("decisions", [])
            return decisions
        except Exception as e:
            last_err = e
            wait = 2 ** (attempt + 1)
            emit_log(f"  批次评估失败（{attempt + 1}/{MAX_RETRIES}），{wait}s 后重试: {e}", level="warn")
            time.sleep(wait)

    emit_log(f"批次评估彻底失败: {last_err}", level="error")
    return [{"index": i["index"], "keep": True, "reason": "评估失败，保守保留"} for i in items]


# ── 输出 ────────────────────────────────────────────────

def write_md(items_with_decision: list[dict], profile: dict, output_path: str) -> None:
    kept = [it for it in items_with_decision if it.get("keep")]
    excluded = [it for it in items_with_decision if not it.get("keep")]

    by_source = {}
    for it in kept:
        by_source.setdefault(it.get("source") or "其他", []).append(it)

    by_topic: dict[str, int] = {}
    for it in kept:
        for kw in profile.get("focusKeywords", []):
            if kw and kw in (it.get("title", "") + it.get("excerpt", "")):
                by_topic[kw] = by_topic.get(kw, 0) + 1

    lines: list[str] = []
    lines.append("# 信息筛选结果")
    lines.append("")
    lines.append(
        f"> 输入 **{len(items_with_decision)}** 条 · 保留 **{len(kept)}** 条 · "
        f"剔除 **{len(excluded)}** 条 · 公司画像 v{profile.get('version', '?')}"
    )
    lines.append(f"> 处理时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    if by_topic:
        lines.append("## 筛选汇总")
        lines.append("")
        lines.append("| 关键关注领域 | 命中条数 |")
        lines.append("|-------------|---------|")
        for k, v in sorted(by_topic.items(), key=lambda x: -x[1]):
            lines.append(f"| {k} | {v} |")
        lines.append("")

    if not kept:
        lines.append("## 保留条目")
        lines.append("")
        lines.append("> 暂无符合公司业务画像的条目。")
        lines.append("")
    else:
        lines.append("## 保留条目")
        lines.append("")
        for src, arr in sorted(by_source.items()):
            lines.append(f"### {src}（{len(arr)} 条）")
            lines.append("")
            for it in arr:
                lines.append(f"#### {it['title']}")
                if it.get('date'):
                    lines.append(f"- **发布日期**：{it['date']}")
                if it.get('source'):
                    lines.append(f"- **来源**：{it['source']}")
                if it.get('url'):
                    lines.append(f"- **链接**：<{it['url']}>")
                if it.get('reason'):
                    lines.append(f"- **筛选理由**：{it['reason']}")
                lines.append("")
            lines.append("")

    if excluded:
        lines.append("## 剔除条目（折叠展示）")
        lines.append("")
        lines.append(f"<details><summary>共 {len(excluded)} 条 — 点击展开</summary>")
        lines.append("")
        lines.append("| 标题 | 来源 | 剔除理由 |")
        lines.append("|------|------|---------|")
        for it in excluded:
            t = it['title'].replace('|', '\\|')
            s = (it.get('source') or '').replace('|', '\\|')
            r = (it.get('reason') or '').replace('|', '\\|')
            lines.append(f"| {t} | {s} | {r} |")
        lines.append("")
        lines.append("</details>")
        lines.append("")

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text("\n".join(lines), encoding='utf-8')


def write_csv(items_with_decision: list[dict], output_path: str) -> None:
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["发布日期", "标题", "发布部门", "URL链接", "保留", "理由"])
        for it in items_with_decision:
            w.writerow([
                it.get('date', ''),
                it.get('title', ''),
                it.get('source', ''),
                it.get('url', ''),
                'Y' if it.get('keep') else 'N',
                it.get('reason', ''),
            ])


def _default_output_dir():
    # 审查 P2：graph run 绑定工作区时产物落工作区（CORAL_OUTPUT_DIR 由平台注入）
    env_dir = os.environ.get("CORAL_OUTPUT_DIR")
    if env_dir:
        os.makedirs(env_dir, exist_ok=True)
        return env_dir
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output")


def coral_main():
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        payload = json.loads(sys.stdin.read())
        inp = payload.get("input", {})
        ctx = payload.get("context", {})
        profile = ctx.get("companyProfile") or {}

        emit_progress("init", "解析输入...", percent=2)
        items = normalize_input(inp)
        if inp.get("dry_run"):
            items = items[:5]
            emit_log("dry_run 模式：仅评估前 5 条（不写文件）", level="info")

        # 给每条加 index
        for i, it in enumerate(items):
            it["index"] = i
            it["excerpt"] = (it.get("excerpt") or "")[:200]

        if not items:
            real_stdout.write(json.dumps({
                "md_path": "",
                "csv_path": "",
                "kept_count": 0,
                "excluded_count": 0,
                "summary_by_topic": {},
                "message": "输入为空",
            }, ensure_ascii=False))
            return

        emit_progress("processing", f"共 {len(items)} 条，开始 LLM 评估", total=len(items), percent=10)

        # 分批
        all_decisions: list[dict] = []
        batches = [items[i:i + BATCH_SIZE] for i in range(0, len(items), BATCH_SIZE)]
        for bi, batch in enumerate(batches):
            # 紧凑视图（只给 LLM 必要字段，节约 token）
            compact = [{
                "index": it["index"],
                "title": it["title"],
                "source": it.get("source", ""),
                "date": it.get("date", ""),
                "excerpt": it.get("excerpt", ""),
            } for it in batch]

            emit_progress("processing",
                          f"批次 {bi + 1}/{len(batches)}（{len(batch)} 条）",
                          step=bi + 1, total=len(batches),
                          percent=round(10 + (bi / max(1, len(batches))) * 80, 1))

            decisions = call_llm(compact, profile)
            all_decisions.extend(decisions)

        # merge decisions back
        decision_by_index = {d["index"]: d for d in all_decisions if isinstance(d, dict) and "index" in d}
        for it in items:
            d = decision_by_index.get(it["index"])
            if d:
                it["keep"] = bool(d.get("keep", True))
                it["reason"] = str(d.get("reason", ""))[:30]
            else:
                it["keep"] = True
                it["reason"] = "未返回决策，保守保留"

        kept_count = sum(1 for it in items if it["keep"])
        excluded_count = len(items) - kept_count

        # 写文件
        emit_progress("writing", "写出 MD/CSV 文件", percent=92)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_dir = _default_output_dir()

        if inp.get('dry_run'):
            real_stdout.write(json.dumps({'ok': True, 'dry_run': True, 'evaluated': len(items), 'note': '试运行不落盘'}, ensure_ascii=False))
            return
        md_out = inp.get("output_path") or os.path.join(out_dir, f"信息筛选_{ts}.md")
        csv_out = os.path.splitext(md_out)[0] + ".csv"

        if not os.path.isabs(md_out):
            project_root = Path(__file__).resolve().parents[3]
            md_out = str(project_root / md_out)
            csv_out = str(project_root / csv_out)

        write_md(items, profile, md_out)
        write_csv(items, csv_out)

        # by_topic
        by_topic: dict[str, int] = {}
        for it in items:
            if not it.get("keep"):
                continue
            for kw in profile.get("focusKeywords", []):
                if kw and kw in (it.get("title", "") + it.get("excerpt", "")):
                    by_topic[kw] = by_topic.get(kw, 0) + 1

        emit_progress("done",
                      f"筛选完成：保留 {kept_count} / 剔除 {excluded_count}",
                      percent=100, kept=kept_count, excluded=excluded_count)

        real_stdout.write(json.dumps({
            "md_path": md_out,
            "csv_path": csv_out,
            "kept_count": kept_count,
            "excluded_count": excluded_count,
            "summary_by_topic": by_topic,
        }, ensure_ascii=False))
    except Exception as e:
        real_stdout.write(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)
    finally:
        sys.stdout = real_stdout


if __name__ == "__main__":
    coral_main()
