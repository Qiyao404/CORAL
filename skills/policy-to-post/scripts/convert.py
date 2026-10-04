#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
政策信息转推文脚本（v1.1.0）

支持三种输入互斥（任选其一）：
  · md_content : 直接粘贴的 MD 文本（policy-scraper 输出格式或自定义）
  · md_path    : MD 文件路径
  · csv_path   : CSV 文件路径（向后兼容 v1.0.0 的 input_file）

CLI 用法（向后兼容）:
    python convert.py input.csv -o output.md
    python convert.py input.md -o output.md
    python convert.py --md-text "..." -o output.md

CORAL stdin JSON：
    {"input": {"md_path": "..."}}
    {"input": {"csv_path": "..."}}
    {"input": {"md_content": "..."}}
"""

import argparse
import os
import re
import sys
import time
import tempfile
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# 引入 CORAL helper
_HERE = Path(__file__).resolve().parent
_LIB_PATH = _HERE.parents[2] / '_lib'
if str(_LIB_PATH) not in sys.path:
    sys.path.insert(0, str(_LIB_PATH))
try:
    from coral_progress import emit_progress, emit_log  # type: ignore
except Exception:
    import json as _json
    def emit_progress(phase, message="", step=None, total=None, percent=None, **detail):
        payload = {"phase": phase, "message": message}
        if step is not None: payload["step"] = step
        if total is not None: payload["total"] = total
        if percent is not None: payload["percent"] = percent
        if detail: payload["detail"] = detail
        print("[CORAL_PROGRESS] " + _json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
    def emit_log(message, level="info"):
        print(message, file=sys.stderr, flush=True)

import pandas as pd
import requests
from bs4 import BeautifulSoup
from openai import OpenAI

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

try:
    from readability import Document
    HAS_READABILITY = True
except ImportError:
    HAS_READABILITY = False

try:
    import fitz  # PyMuPDF
    HAS_PYMUPDF = True
except ImportError:
    HAS_PYMUPDF = False

try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    HAS_PDFPLUMBER = False


# ── API 配置 ─────────────────────────────────────────────

def load_env_file():
    env_vars = {}
    for candidate in [
        Path(__file__).resolve().parents[3] / ".env",
        Path.cwd() / ".env",
    ]:
        if candidate.exists():
            with open(candidate, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        env_vars[k.strip()] = v.strip()
            break
    return env_vars


_env = load_env_file()

# 同时兼容 SILICONFLOW_* 旧变量
API_BASE_URL = os.environ.get("LLM_BASE_URL") or os.environ.get("SILICONFLOW_BASE_URL") \
    or _env.get("LLM_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1")
API_KEY = os.environ.get("LLM_API_KEY") or os.environ.get("SILICONFLOW_API_KEY") \
    or _env.get("LLM_API_KEY", "")
API_MODEL = os.environ.get("LLM_MODEL") or os.environ.get("SILICONFLOW_MODEL") \
    or _env.get("LLM_MODEL", "kimi-k2.5")


def _detect_http_proxy():
    import urllib.request
    system_proxies = urllib.request.getproxies()
    proxy = system_proxies.get("http") or system_proxies.get("https")
    if proxy and proxy.startswith("https://"):
        proxy = proxy.replace("https://", "http://", 1)
    return proxy


# ── 政府站点直连配置（与 policy-scraper 保持一致） ─────────

NO_PROXY_DOMAINS = [
    d.strip() for d in os.environ.get("POLICY_NO_PROXY_DOMAINS", "gov.cn,foshan.gov.cn,gd.gov.cn").split(",") if d.strip()
]
FORCE_DIRECT = os.environ.get("POLICY_FORCE_DIRECT", "true").lower() in {"1", "true", "yes"}


def _proxies_for(url: str):
    """对 .gov.cn 等域名直连；其他走系统代理"""
    if FORCE_DIRECT:
        try:
            from urllib.parse import urlparse
            host = urlparse(url).hostname or ''
            for dom in NO_PROXY_DOMAINS:
                if host.endswith(dom):
                    return {"http": None, "https": None}
        except Exception:
            pass
    return None


# ── 分类 ────────────────────────────────────────────────

FOSHAN_KEYWORDS = ["佛山", "foshan"]
ENTERPRISE_KEYWORDS = ["科技", "公司", "集团", "企业", "有限公司", "股份"]

COLUMN_ALIASES = {
    "发布日期": ["发布日期", "日期", "发布日", "时间"],
    "标题": ["标题", "题目", "名称", "政策名称"],
    "发布部门": ["发布部门", "部门", "来源", "发布机构", "发布网站"],
    "URL": ["URL", "链接", "网址", "原文链接", "URL链接"],
}


# ── CSV/Excel 读取 ──────────────────────────────────────

def load_csv_excel(file_path: str, has_header: bool = True) -> pd.DataFrame:
    ext = Path(file_path).suffix.lower()
    if ext == ".csv":
        df = pd.read_csv(file_path, encoding="utf-8-sig", header=0 if has_header else None)
    elif ext in (".xlsx", ".xls"):
        df = pd.read_excel(file_path, header=0 if has_header else None)
    else:
        raise ValueError(f"不支持的文件格式: {ext}，请使用 CSV 或 Excel")

    if has_header:
        rename = {}
        for col in df.columns:
            c = str(col).strip()
            for std, aliases in COLUMN_ALIASES.items():
                if c in aliases or c == std:
                    rename[col] = std
                    break
        df = df.rename(columns=rename)
        want = ["发布日期", "标题", "发布部门", "URL"]
        have = [c for c in want if c in df.columns]
        if len(have) < 3:
            df = df.iloc[:, :4]
            df.columns = want
        else:
            for w in want:
                if w not in df.columns:
                    df[w] = ""
            df = df[want]
    else:
        df = df.iloc[:, :4]
        df.columns = ["发布日期", "标题", "发布部门", "URL"]

    df = df.dropna(subset=["标题", "URL"])
    return df


# ── MD 解析（兼容 policy-scraper 输出格式） ──────────────

MD_TITLE_RE = re.compile(r"^###\s+(.+?)\s*$")
MD_DATE_RE = re.compile(r"\*\*发布日期\*\*\s*[:：]\s*([0-9\-/年月日.\s]+)")
MD_LINK_RE = re.compile(r"\*\*链接\*\*\s*[:：]\s*<?([^>\s]+)>?")
MD_SOURCE_RE = re.compile(r"\*\*来源\*\*\s*[:：]\s*([^\n]+)")
MD_SECTION_HEADER_RE = re.compile(r"^##\s+(.+?)\s*(?:（\d+\s*条）)?\s*$")


def parse_md_content(md: str) -> pd.DataFrame:
    """从 MD 文本中提取政策列表（policy-scraper 格式）"""
    rows = []
    lines = md.splitlines()
    current_section = ""
    cur = None  # 正在累积的条目

    def commit():
        if cur and cur.get("标题"):
            rows.append({
                "发布日期": cur.get("发布日期", ""),
                "标题": cur.get("标题", ""),
                "发布部门": cur.get("发布部门") or current_section or "",
                "URL": cur.get("URL", ""),
            })

    for raw in lines:
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
            cur = {"标题": title_m.group(1).strip()}
            continue

        if cur is None:
            continue

        date_m = MD_DATE_RE.search(line)
        if date_m:
            cur["发布日期"] = date_m.group(1).strip()
            continue
        link_m = MD_LINK_RE.search(line)
        if link_m:
            cur["URL"] = link_m.group(1).strip()
            continue
        src_m = MD_SOURCE_RE.search(line)
        if src_m:
            cur["发布部门"] = src_m.group(1).strip()
            continue

    commit()

    if not rows:
        return pd.DataFrame(columns=["发布日期", "标题", "发布部门", "URL"])

    df = pd.DataFrame(rows)
    df = df.dropna(subset=["标题", "URL"])
    return df


# ── 网页抓取 + 附件 ─────────────────────────────────────

def fetch_page_content(url: str) -> tuple:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    try:
        resp = requests.get(url, headers=headers, timeout=20, verify=False, proxies=_proxies_for(url))
        resp.encoding = resp.apparent_encoding or "utf-8"
        html = resp.text
    except Exception as e:
        return "", f"[抓取失败: {e}]", ""

    if HAS_READABILITY:
        try:
            doc = Document(html)
            title = doc.title() or ""
            summary = doc.summary()
            soup = BeautifulSoup(summary, "html.parser")
            text = soup.get_text(separator="\n", strip=True)
            return title, text, html
        except Exception:
            pass

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()
    text = soup.get_text(separator="\n", strip=True)
    title = ""
    t = soup.find("title")
    if t:
        title = t.get_text(strip=True)
    return title, text[:15000], html


def find_attachment_links(html: str, base_url: str) -> list:
    soup = BeautifulSoup(html, "html.parser")
    ext_pat = re.compile(r"\.(pdf|doc|docx)(\?|$)", re.I)
    links = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not ext_pat.search(href):
            continue
        if href.startswith("/"):
            parsed = urllib.parse.urlparse(base_url)
            full = f"{parsed.scheme}://{parsed.netloc}{href}"
        elif href.startswith("http"):
            full = href
        else:
            full = urllib.parse.urljoin(base_url, href)
        links.add(full)
    return list(links)


def download_attachment(url: str) -> Optional[str]:
    try:
        resp = requests.get(url, timeout=30, stream=True, verify=False, proxies=_proxies_for(url))
        resp.raise_for_status()
        ext = ".pdf"
        if ".doc" in url.lower():
            ext = ".doc"
        if ".docx" in url.lower():
            ext = ".docx"
        fd, path = tempfile.mkstemp(suffix=ext)
        with os.fdopen(fd, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        return path
    except Exception:
        return None


def extract_pdf_text(path: str) -> str:
    if HAS_PYMUPDF:
        try:
            doc = fitz.open(path)
            text = "".join(page.get_text() for page in doc)
            doc.close()
            return text.strip()
        except Exception:
            pass
    if HAS_PDFPLUMBER:
        try:
            text = ""
            with pdfplumber.open(path) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        text += t + "\n"
            return text.strip()
        except Exception:
            pass
    return ""


def extract_docx_text(path: str) -> str:
    try:
        import zipfile
        with zipfile.ZipFile(path, "r") as z:
            xml = z.read("word/document.xml")
        soup = BeautifulSoup(xml, "lxml-xml")
        return "".join(p.get_text() for p in soup.find_all("w:t")).strip()
    except Exception:
        return ""


def extract_attachment_text(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".pdf"):
        return extract_pdf_text(path)
    if lower.endswith(".docx"):
        return extract_docx_text(path)
    return ""


# ── LLM 调用 ────────────────────────────────────────────

def call_llm(web_content: str, att_text: str, title: str, department: str, max_retries: int = 3) -> str:
    if not API_KEY:
        return "[API 密钥未配置，请在 .env 中设置 LLM_API_KEY]"

    timeout_cfg = httpx.Timeout(60.0, connect=30.0) if HAS_HTTPX else 60.0
    http_client = None
    if HAS_HTTPX:
        proxy_url = _detect_http_proxy()
        http_client = httpx.Client(
            timeout=timeout_cfg,
            verify=False,
            **({"proxy": proxy_url} if proxy_url else {}),
        )
    client = OpenAI(base_url=API_BASE_URL, api_key=API_KEY, timeout=timeout_cfg, http_client=http_client)

    parts = [
        f"以下是一则政策/新闻的网页正文，标题为：{title}，发布部门：{department}",
        "\n【网页正文】\n",
        web_content[:12000] if web_content else "（无正文）",
    ]
    if att_text and att_text.strip():
        parts.append("\n【附件内容摘要】\n")
        parts.append(att_text[:8000])
    parts.append(
        "\n\n请用 1-3 段话概括该政策/新闻的**核心内容**，要求："
        "1）语言简洁专业；2）突出时间、主体、关键举措、截止时间等；"
        "3）控制在 150-300 字；4）直接输出核心内容，不要加「核心内容」等前缀。"
    )

    prompt = "".join(parts)

    for attempt in range(max_retries):
        try:
            resp = client.chat.completions.create(
                model=API_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=800,
                temperature=0.3,
            )
            content = resp.choices[0].message.content
            return content.strip() if content else ""
        except Exception as e:
            if attempt < max_retries - 1:
                wait = (attempt + 1) * 2
                emit_log(f"  API 重试 ({attempt + 1}/{max_retries})，{wait}s 后...", level="warn")
                time.sleep(wait)
            else:
                msg = str(e)
                if "connection" in msg.lower() or "timeout" in msg.lower():
                    return "[API 解读失败: 网络超时]"
                return f"[API 解读失败: {msg[:100]}]"

    return "[API 解读失败]"


# ── 分类与格式化 ─────────────────────────────────────────

def classify(department: str) -> str:
    if not department or not isinstance(department, str):
        return "全国要闻"
    d = str(department).strip()
    for kw in FOSHAN_KEYWORDS:
        if kw in d:
            return "佛山要闻"
    for kw in ENTERPRISE_KEYWORDS:
        if kw in d:
            return "企业锋向"
    return "全国要闻"


def format_date(val) -> str:
    if pd.isna(val):
        return ""
    if isinstance(val, datetime):
        return val.strftime("%Y 年 %m 月 %d 日").replace(" 0", " ")
    if isinstance(val, (int, float)):
        try:
            epoch = datetime(1899, 12, 30)
            dt = epoch + timedelta(days=int(val))
            return dt.strftime("%Y 年 %m 月 %d 日").replace(" 0", " ")
        except Exception:
            return str(val)
    s = str(val).strip()
    if not s:
        return ""
    for fmt in ["%Y-%m-%d", "%Y/%m/%d", "%Y年%m月%d日", "%Y.%m.%d", "%Y-%m-%d %H:%M:%S"]:
        try:
            dt = datetime.strptime(s[:19].strip(), fmt)
            return dt.strftime("%Y 年 %m 月 %d 日").replace(" 0", " ")
        except ValueError:
            continue
    return s


def process_row(row: pd.Series, idx: int) -> dict:
    url = str(row["URL"]).strip()
    title = str(row["标题"]).strip()
    department = str(row["发布部门"]).strip() if pd.notna(row["发布部门"]) else ""
    pub_date = format_date(row["发布日期"])

    page_title, web_content, html = fetch_page_content(url)
    att_urls = find_attachment_links(html, url) if html else []

    att_texts = []
    temp_files = []
    for att_url in att_urls[:3]:
        local = download_attachment(att_url)
        if local:
            temp_files.append(local)
            text = extract_attachment_text(local)
            if text:
                att_texts.append(text[:4000])
    for f in temp_files:
        try:
            os.unlink(f)
        except Exception:
            pass

    att_text = "\n\n".join(att_texts)
    core_content = call_llm(web_content, att_text, title, department)

    return {
        "section_id": idx,
        "title": title,
        "department": department,
        "pub_date": pub_date,
        "url": url,
        "core_content": core_content,
        "category": classify(department),
    }


# ── Markdown 推文生成 ────────────────────────────────────

def _infer_period_date(items: list) -> str:
    for item in items:
        d = item.get("pub_date", "")
        m = re.search(r"(\d{4})\s*年\s*(\d{1,2})\s*月", d)
        if m:
            return f"{m.group(1)}年{m.group(2)}月"
    return f"{datetime.now().year}年{datetime.now().month}月"


def build_markdown(items: list, period_title: str = "各局办相关最新政策及科技企业动态快讯") -> str:
    foshan = [x for x in items if x["category"] == "佛山要闻"]
    national = [x for x in items if x["category"] == "全国要闻"]
    enterprise = [x for x in items if x["category"] == "企业锋向"]

    sections = [(n, lst) for n, lst in [("佛山要闻", foshan), ("全国要闻", national), ("企业锋向", enterprise)] if lst]

    date_str = _infer_period_date(items)

    lines = [
        f"### {date_str}上{period_title}",
        "#",
        "",
        '<p style="text-align: right;">',
        f'  <span style="color: #4274c7; font-weight: bold;">{date_str}上半期</span>',
        "</p>",
        "",
        "### 目录",
        "## 政策要闻",
        "",
    ]

    counter = 0
    toc_blocks = []
    body_blocks = []

    for cat_name, lst in sections:
        toc_items = []
        body_items = []
        for item in lst:
            counter += 1
            sid = f"section{counter}"
            toc_items.append(f'  - [{item["title"]}](#{sid})')
            body_items.append((sid, item))
        toc_blocks.append((f"- **{cat_name}**  ", toc_items))
        body_blocks.append((cat_name, body_items))

    for label, toc_items in toc_blocks:
        lines.append(label)
        lines.extend(toc_items)
        lines.append("")
    lines.extend(["", "### 政策要闻", ""])

    for cat_name, body_items in body_blocks:
        lines.append(f"## {cat_name}")
        for sid, item in body_items:
            lines.append(f'<h2 id="{sid}"></h2>')
            lines.append("")
            lines.append(f'#### {item["title"]}')
            lines.append("")
            if item["department"]:
                lines.append(f'*发布部门*：{item["department"]}')
                lines.append("")
            if item["pub_date"]:
                lines.append(f'*发布时间*：{item["pub_date"]}')
                lines.append("")
            lines.append(f'*核心内容*：{item["core_content"]}')
            lines.append("")
            lines.append(f'<a href="{item["url"]}" target="_blank">*📘阅读原文*</a>')
            lines.append("")
        lines.append("")

    return "\n".join(lines)


# ── 主入口 ───────────────────────────────────────────────

def _default_output_dir():
    # 审查 P2：graph run 绑定工作区时产物落工作区（CORAL_OUTPUT_DIR 由平台注入）
    env_dir = os.environ.get("CORAL_OUTPUT_DIR")
    if env_dir:
        os.makedirs(env_dir, exist_ok=True)
        return env_dir
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output")


def _load_input_dataframe(*, md_content=None, md_path=None, csv_path=None) -> pd.DataFrame:
    """归一化三种输入到统一的 DataFrame；md_content > md_path > csv_path"""
    if md_content:
        emit_progress("init", "解析 MD 文本", percent=2)
        return parse_md_content(md_content)
    if md_path:
        emit_progress("init", f"读取 MD 文件: {md_path}", percent=2)
        text = Path(md_path).read_text(encoding='utf-8')
        return parse_md_content(text)
    if csv_path:
        emit_progress("init", f"读取 CSV/Excel 文件: {csv_path}", percent=2)
        return load_csv_excel(csv_path)
    raise ValueError("必须提供 md_content / md_path / csv_path 三者之一")


def _process_and_build(df: pd.DataFrame, output_file: str, period_title: str,
                       limit: int = 0, delay: float = 2.0):
    if df.empty:
        emit_log("输入无有效数据", level="warn")
        return None, 0, 0

    if limit > 0:
        df = df.head(limit)

    items = []
    failed = 0
    total = len(df)
    emit_progress("processing", f"共 {total} 条政策待处理", total=total, percent=5)

    for i, (_, row) in enumerate(df.iterrows()):
        title = str(row['标题'])[:50]
        emit_progress("processing", f"[{i + 1}/{total}] {title}",
                      step=i + 1, total=total,
                      percent=round(5 + (i / max(1, total)) * 90, 1),
                      detail={"title": title})
        try:
            item = process_row(row, i + 1)
            items.append(item)
        except Exception as e:
            failed += 1
            emit_log(f"  错误: {e}", level="error")
        if i < total - 1:
            time.sleep(delay)

    if not items:
        emit_log("未处理到任何有效条目", level="warn")
        return None, 0, failed

    emit_progress("writing", "生成 MD 文件...", percent=96)
    md = build_markdown(items, period_title)
    out = Path(output_file)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(md, encoding="utf-8")
    emit_progress("done", f"完成: {len(items)} 条成功 / {failed} 条失败", percent=100,
                  detail={"path": str(out), "success": len(items), "failed": failed})
    return str(out), len(items), failed


def main():
    parser = argparse.ArgumentParser(description="政策信息转 Markdown 推文 (v1.1.0)")
    parser.add_argument("input", nargs="?", help="输入文件路径 (CSV/Excel/MD)，与 --md-text 互斥")
    parser.add_argument("--md-text", default=None, help="直接粘贴的 MD 文本")
    parser.add_argument("-o", "--output", default="output.md", help="输出 Markdown 路径")
    parser.add_argument("--period", default="各局办相关最新政策及科技企业动态快讯", help="期刊标题")
    parser.add_argument("--limit", type=int, default=0, help="限制处理条数 (0=全部)")
    parser.add_argument("--delay", type=float, default=2, help="API 调用间隔秒数")
    parser.add_argument("--no-header", action="store_true", help="输入文件无表头")
    args = parser.parse_args()

    emit_log(f"API 配置: {API_BASE_URL} model={API_MODEL}")
    if not API_KEY:
        emit_log("API 密钥未配置！", level="warn")

    df = None
    if args.md_text:
        df = parse_md_content(args.md_text)
    elif args.input:
        if not os.path.exists(args.input):
            print(f"错误: 文件不存在 — {args.input}", file=sys.stderr)
            sys.exit(1)
        ext = Path(args.input).suffix.lower()
        if ext == '.md':
            df = parse_md_content(Path(args.input).read_text(encoding='utf-8'))
        else:
            df = load_csv_excel(args.input, has_header=not args.no_header)
    else:
        print("错误: 必须提供输入文件或 --md-text", file=sys.stderr)
        sys.exit(1)

    _process_and_build(df, args.output, args.period, limit=args.limit, delay=args.delay)


def coral_main():
    """CORAL skill executor 入口：从 stdin 读取 JSON，结果写入 stdout。"""
    import json as _json

    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    try:
        payload = _json.loads(sys.stdin.read())
        inp = payload.get("input", {})

        md_content = inp.get("md_content")
        md_path = inp.get("md_path")
        csv_path = inp.get("csv_path") or inp.get("input_file")  # 兼容老字段
        period_title = inp.get("period_title", "各局办相关最新政策及科技企业动态快讯")

        # 标准化 path 为绝对路径（相对路径基于项目根目录）
        project_root = Path(__file__).resolve().parents[3]
        if md_path and not os.path.isabs(md_path):
            md_path = str(project_root / md_path)
        if csv_path and not os.path.isabs(csv_path):
            csv_path = str(project_root / csv_path)

        # 三选一校验
        if not (md_content or md_path or csv_path):
            real_stdout.write(_json.dumps({"error": "必须提供 md_content / md_path / csv_path 三者之一"}, ensure_ascii=False))
            sys.exit(1)

        if md_path and not os.path.exists(md_path):
            real_stdout.write(_json.dumps({"error": f"MD 文件不存在: {md_path}"}, ensure_ascii=False))
            sys.exit(1)
        if csv_path and not os.path.exists(csv_path):
            real_stdout.write(_json.dumps({"error": f"CSV 文件不存在: {csv_path}"}, ensure_ascii=False))
            sys.exit(1)

        df = _load_input_dataframe(md_content=md_content, md_path=md_path, csv_path=csv_path)

        output_file = inp.get("output_path") or inp.get("output_file")
        if output_file and not os.path.isabs(output_file):
            output_file = str(project_root / output_file)
        if not output_file:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_file = os.path.join(_default_output_dir(), f"推文_{timestamp}.md")

        md_path_out, item_count, failed_count = _process_and_build(df, output_file, period_title)

        if md_path_out:
            result = {
                "md_path": md_path_out,
                "item_count": item_count,
                "failed_count": failed_count,
                "input_count": int(df.shape[0]),
            }
        else:
            result = {
                "md_path": "",
                "item_count": 0,
                "failed_count": failed_count,
                "message": "未处理到有效条目",
            }
        real_stdout.write(_json.dumps(result, ensure_ascii=False))
    except Exception as e:
        real_stdout.write(_json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)
    finally:
        sys.stdout = real_stdout


if __name__ == "__main__":
    if len(sys.argv) > 1 or not sys.stdin.isatty():
        # 有参数或者 stdin 有内容（被管道喂入）→ 检测
        try:
            if not sys.stdin.isatty() and len(sys.argv) <= 1:
                coral_main()
            else:
                main()
        except SystemExit:
            raise
    else:
        main()
