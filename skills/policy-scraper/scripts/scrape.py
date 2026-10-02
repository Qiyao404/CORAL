#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
政策信息抓取脚本（v1.1.0）

支持：
  · 通过 [CORAL_PROGRESS] 协议向平台流式上报进度（站点级 + 页码级 + 整体百分比）
  · 同时输出 MD 与 CSV（FR-D2）
  · `--sites` 参数指定站点 ID 子集（FR-D7）
  · 代理穿透：默认强制对 *.gov.cn 直连（绕开本地 HTTP 代理，避免代理污染政府站点）

CLI 用法:
  python scrape.py --year 2026 --month 3
  python scrape.py --year 2026 --month 3 --sites gdii,fszj
  python scrape.py --year 2026 --month 3 --output-dir ./output

CORAL stdin JSON：
  {"input": {"year": 2026, "month": 3, "sites": ["gdii"]}}
"""

import argparse
import csv
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

# 统一引入 CORAL helper（兼容 import path：从 skills/_lib 与 当前目录）
_HERE = Path(__file__).resolve().parent
_LIB_PATH = _HERE.parents[2] / '_lib'
if str(_LIB_PATH) not in sys.path:
    sys.path.insert(0, str(_LIB_PATH))
try:
    from coral_progress import emit_progress, emit_log  # type: ignore
except Exception:
    # 本地降级：没有 helper 时直接用 stderr 打印
    def emit_progress(phase, message="", step=None, total=None, percent=None, **detail):
        payload = {"phase": phase, "message": message}
        if step is not None: payload["step"] = step
        if total is not None: payload["total"] = total
        if percent is not None: payload["percent"] = percent
        if detail: payload["detail"] = detail
        print("[CORAL_PROGRESS] " + json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
    def emit_log(message, level="info"):
        print(message, file=sys.stderr, flush=True)

import requests
from bs4 import BeautifulSoup
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
    from selenium.common.exceptions import TimeoutException, NoSuchElementException

    try:
        from webdriver_manager.chrome import ChromeDriverManager
        USE_WEBDRIVER_MANAGER = True
    except ImportError:
        USE_WEBDRIVER_MANAGER = False
    SELENIUM_AVAILABLE = True
except ImportError:
    SELENIUM_AVAILABLE = False
    USE_WEBDRIVER_MANAGER = False

# ── 默认配置 ──────────────────────────────────────────────

SITE_TIMEOUT = 300
SELENIUM_PAGE_TIMEOUT = 60
SELENIUM_ACTION_TIMEOUT = 10

# 站点定义（id → name + url），与 reference.md 中的 site_aliases 保持一致
SITES = [
    {"id": "fszsj",    "name": "佛山政数局",   "url": "https://www.foshan.gov.cn/fszsj/gkmlpt/index"},
    {"id": "fszj",     "name": "佛山住建局",   "url": "https://fszj.foshan.gov.cn/gkmlpt/index"},
    {"id": "fsjtys",   "name": "佛山交通局",   "url": "https://jtys.foshan.gov.cn/gkmlpt/index"},
    {"id": "fsdr",     "name": "佛山发改局",   "url": "http://fsdr.foshan.gov.cn/gkmlpt/index"},
    {"id": "fskjj",    "name": "佛山科技局",   "url": "http://fskjj.foshan.gov.cn/gkmlpt/index"},
    {"id": "gdii",     "name": "广东工信厅",   "url": "https://gdii.gd.gov.cn/gkmlpt/index"},
    {"id": "zfsg",     "name": "广东政数局",   "url": "https://zfsg.gd.gov.cn/gkmlpt/index"},
    {"id": "zfcxjst",  "name": "广东住建厅",   "url": "https://zfcxjst.gd.gov.cn/gkmlpt/index"},
]

SITE_BY_ID = {s["id"]: s for s in SITES}
SITE_BY_HOST = {urlparse(s["url"]).hostname: s for s in SITES}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.8,en-US;q=0.6,en;q=0.4",
    "Accept-Encoding": "gzip, deflate, sdch",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

# 默认对政府站点直连（绕过代理）
NO_PROXY_DOMAINS = [
    d.strip() for d in os.environ.get("POLICY_NO_PROXY_DOMAINS", "gov.cn,foshan.gov.cn,gd.gov.cn").split(",") if d.strip()
]
FORCE_DIRECT = os.environ.get("POLICY_FORCE_DIRECT", "true").lower() in {"1", "true", "yes"}


def _direct_proxies():
    """对政府站点禁用代理（避免本地代理污染）"""
    return {"http": None, "https": None}


def _detect_http_proxy():
    """检测系统 HTTP 代理（修正 Windows https→http 协议问题）"""
    import urllib.request
    system_proxies = urllib.request.getproxies()
    proxy = system_proxies.get("http") or system_proxies.get("https")
    if proxy and proxy.startswith("https://"):
        proxy = proxy.replace("https://", "http://", 1)
    return proxy


def _is_no_proxy_url(url: str) -> bool:
    """url 是否命中 NO_PROXY 列表（如 .gov.cn）"""
    try:
        host = urlparse(url).hostname or ''
    except Exception:
        return False
    for dom in NO_PROXY_DOMAINS:
        if host.endswith(dom):
            return True
    return False


# ── 工具函数 ──────────────────────────────────────────────

def get_site_name(url):
    host = urlparse(url).hostname
    if host and host in SITE_BY_HOST:
        return SITE_BY_HOST[host]["name"]
    # 回退：foshan.gov.cn/fszsj 这种特殊路径
    for s in SITES:
        if s["url"].split("//")[1].split("?")[0] in url:
            return s["name"]
    return host or "未知网站"


def build_full_link(href, base_url):
    if href.startswith("http"):
        return href
    if href.startswith("//"):
        return base_url.split("/")[0] + href
    if href.startswith("/"):
        domain = base_url.split("/")[0] + "//" + base_url.split("/")[2]
        return domain + href
    return base_url.rsplit("/", 1)[0] + "/" + href


def extract_items_from_page(soup, base_url, target_prefix):
    items = []
    date_months = []

    for row in soup.find_all("tr"):
        link_tag = row.find("a")
        if not link_tag:
            continue
        title = link_tag.get_text(strip=True)
        href = link_tag.get("href", "")
        if not title or len(title) < 5:
            continue

        publish_date = "未知"
        for cell in row.find_all("td"):
            ds = cell.get_text(strip=True)
            if len(ds) == 10 and ds[4:5] == "-" and ds[7:8] == "-":
                publish_date = ds
                break

        if publish_date != "未知":
            date_months.append(publish_date[:7])
        if publish_date.startswith(target_prefix):
            items.append({
                "date": publish_date,
                "title": title,
                "link": build_full_link(href, base_url),
                "site_name": get_site_name(base_url),
            })

    if items:
        return items, date_months

    for li in soup.find_all("li"):
        link_tag = li.find("a")
        if not link_tag:
            continue
        title = link_tag.get_text(strip=True)
        href = link_tag.get("href", "")
        if not title or len(title) < 5:
            continue

        publish_date = "未知"
        date_tag = li.find(
            ["span", "div", "time"],
            class_=lambda x: x and ("date" in x.lower() or "time" in x.lower()),
        )
        if date_tag:
            ds = date_tag.get_text(strip=True)
            if len(ds) == 10 and ds[4:5] == "-" and ds[7:8] == "-":
                publish_date = ds

        if publish_date != "未知":
            date_months.append(publish_date[:7])
        if publish_date.startswith(target_prefix):
            items.append({
                "date": publish_date,
                "title": title,
                "link": build_full_link(href, base_url),
                "site_name": get_site_name(base_url),
            })

    if items:
        return items, date_months

    for link in soup.find_all("a", href=True):
        title = link.get_text(strip=True)
        href = link.get("href", "")
        if not title or len(title) < 5:
            continue

        publish_date = "未知"
        parent = link.parent
        if parent:
            match = re.search(r"(\d{4}-\d{2}-\d{2})", parent.get_text())
            if match:
                publish_date = match.group(1)

        if publish_date != "未知":
            date_months.append(publish_date[:7])
        if publish_date.startswith(target_prefix):
            items.append({
                "date": publish_date,
                "title": title,
                "link": build_full_link(href, base_url),
                "site_name": get_site_name(base_url),
            })

    return items, date_months


# ── Selenium 抓取 ────────────────────────────────────────

def scrape_with_selenium(base_url, target_prefix, stop_prefix, timeout, site_idx, site_total):
    if not SELENIUM_AVAILABLE:
        emit_log("Selenium 不可用，跳过", level="warn")
        return []

    results = []
    driver = None
    start = time.time()
    site_name = get_site_name(base_url)

    try:
        opts = Options()
        opts.add_argument("--headless")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--window-size=1920,1080")
        opts.add_argument(
            "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )

        # 关键：政府站点强制直连（不走系统代理）
        if FORCE_DIRECT and _is_no_proxy_url(base_url):
            opts.add_argument("--no-proxy-server")
            opts.add_argument("--proxy-bypass-list=*")
            emit_log(f"[{site_name}] 已为该站点关闭浏览器代理（直连）", level="info")
        else:
            sys_proxy = _detect_http_proxy()
            if sys_proxy:
                opts.add_argument(f"--proxy-server={sys_proxy}")

        emit_progress("scraping", f"[{site_idx}/{site_total}] {site_name} · 启动浏览器",
                      step=site_idx, total=site_total,
                      percent=round(((site_idx - 1) / site_total) * 100, 1),
                      detail={"site_id": _site_id_of(base_url), "stage": "browser_start"})
        try:
            if USE_WEBDRIVER_MANAGER:
                try:
                    service = Service(ChromeDriverManager().install())
                    driver = webdriver.Chrome(service=service, options=opts)
                except Exception:
                    driver = webdriver.Chrome(options=opts)
            else:
                driver = webdriver.Chrome(options=opts)
        except Exception as e:
            emit_log(f"[{site_name}] Chrome 启动失败: {e}", level="error")
            return results

        emit_progress("scraping", f"[{site_idx}/{site_total}] {site_name} · 访问页面",
                      step=site_idx, total=site_total,
                      detail={"url": base_url, "stage": "page_open"})
        try:
            driver.set_page_load_timeout(SELENIUM_PAGE_TIMEOUT)
            driver.get(base_url)
            time.sleep(3)
        except TimeoutException:
            emit_log(f"[{site_name}] 页面加载超时，继续尝试...", level="warn")
        except Exception as e:
            emit_log(f"[{site_name}] 访问失败: {e}", level="error")
            return results

        wait = WebDriverWait(driver, SELENIUM_ACTION_TIMEOUT)
        time.sleep(2)

        found_target = False
        page_num = 0

        while True:
            page_num += 1
            if time.time() - start > timeout:
                emit_log(f"[{site_name}] 超时 {timeout}s，停止", level="warn")
                break

            emit_progress("scraping",
                          f"[{site_idx}/{site_total}] {site_name} · 第 {page_num} 页",
                          step=site_idx, total=site_total,
                          detail={"page": page_num, "stage": "page_scan"})

            try:
                wait.until(EC.presence_of_element_located((By.TAG_NAME, "body")))
                time.sleep(1)
            except Exception:
                emit_log(f"[{site_name}] 第 {page_num} 页加载失败，停止", level="warn")
                break

            soup = BeautifulSoup(driver.page_source, "html.parser")
            page_items, date_months = extract_items_from_page(soup, base_url, target_prefix)
            results.extend(page_items)

            if page_items:
                found_target = True
            emit_log(f"[{site_name}] 第 {page_num} 页找到 {len(page_items)} 条目标数据")

            should_stop = False
            if date_months:
                unique = set(date_months)
                if stop_prefix in unique and found_target:
                    emit_log(f"[{site_name}] 遇到停止月份 {stop_prefix}，已有目标数据，停止")
                    should_stop = True
                elif unique and all(m <= stop_prefix for m in unique):
                    emit_log(f"[{site_name}] 本页均为旧数据，停止")
                    should_stop = True

            if should_stop:
                break

            next_btn = None
            for method in [
                lambda: driver.find_element(
                    By.XPATH,
                    "//a[contains(text(),'下一页') or contains(text(),'>') or contains(text(),'下页')]",
                ),
                lambda: driver.find_element(
                    By.XPATH,
                    "//a[contains(@class,'next') or contains(@class,'page-next')]",
                ),
                lambda: driver.find_element(
                    By.XPATH, f"//a[contains(text(),'{page_num + 1}')]"
                ),
            ]:
                try:
                    next_btn = method()
                    break
                except (NoSuchElementException, Exception):
                    pass

            if not next_btn:
                emit_log(f"[{site_name}] 无翻页按钮，停止")
                break

            if time.time() - start > timeout:
                break

            try:
                driver.execute_script("arguments[0].scrollIntoView(true);", next_btn)
                time.sleep(0.5)
                try:
                    driver.execute_script("arguments[0].click();", next_btn)
                except Exception:
                    next_btn.click()
                time.sleep(2)
            except Exception as e:
                emit_log(f"[{site_name}] 翻页失败: {e}", level="warn")
                break

    except Exception as e:
        emit_log(f"[{site_name}] Selenium 错误: {e}", level="error")
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass

    emit_log(f"[{site_name}] 耗时 {time.time() - start:.1f}s, 结果 {len(results)} 条")
    return results


def _site_id_of(url: str) -> str:
    host = urlparse(url).hostname
    if host and host in SITE_BY_HOST:
        return SITE_BY_HOST[host]["id"]
    return ""


# ── API 抓取（备用） ─────────────────────────────────────

def scrape_with_api(base_url, target_prefix, stop_prefix):
    results = []
    site_name = get_site_name(base_url)

    proxies = _direct_proxies() if (FORCE_DIRECT and _is_no_proxy_url(base_url)) else None
    try:
        resp = requests.get(base_url, headers=HEADERS, timeout=15, verify=False, proxies=proxies)
        resp.encoding = "utf-8"
        if resp.status_code != 200:
            return results
    except Exception as e:
        emit_log(f"[{site_name}] API 模式页面请求失败: {e}", level="warn")
        return results

    app_url = ""
    try:
        m = re.search(r"APP_URL:\s*['\"]([^'\"]+)['\"]", resp.text)
        if m:
            app_url = m.group(1)
    except Exception:
        pass

    endpoints = [
        base_url.replace("/index", "/web/list"),
        base_url.replace("/index", "/api/list"),
        base_url.replace("/gkmlpt/index", "/gkmlpt/web/list"),
    ]
    if app_url:
        endpoints.append(app_url + "/gkmlpt/web/list")

    for api_url in endpoints:
        try:
            for page_num in range(1, 6):
                payload = {"page": page_num, "size": 20, "order": "publish_time desc"}
                api_resp = requests.post(api_url, json=payload, headers=HEADERS, timeout=8, verify=False, proxies=proxies)
                if api_resp.status_code != 200:
                    if page_num == 1:
                        break
                    continue
                try:
                    data = api_resp.json()
                except json.JSONDecodeError:
                    break
                items = []
                if "data" in data:
                    d = data["data"]
                    if isinstance(d, list):
                        items = d
                    elif isinstance(d, dict):
                        items = d.get("items") or d.get("list") or []
                else:
                    items = data.get("items") or data.get("list") or []
                if not items:
                    break
                for item in items:
                    title = item.get("title") or item.get("name") or ""
                    pt = item.get("publish_time") or item.get("pub_date") or item.get("date") or ""
                    url = item.get("url") or item.get("link") or item.get("href") or ""
                    if not title or not pt:
                        continue
                    pub_date = pt.split(" ")[0] if " " in pt else pt
                    if pub_date.startswith(target_prefix):
                        results.append({
                            "date": pub_date,
                            "title": title,
                            "link": build_full_link(url, base_url) if url else "",
                            "site_name": site_name,
                        })
            if results:
                return results
        except Exception:
            continue

    return results


# ── 主流程 ───────────────────────────────────────────────

def scrape_all(year, month, sites=None, timeout=SITE_TIMEOUT):
    target_prefix = f"{year}-{month:02d}"
    stop_month = month - 1
    stop_year = year
    if stop_month <= 0:
        stop_month = 12
        stop_year = year - 1
    stop_prefix = f"{stop_year}-{stop_month:02d}"

    selected_sites = _resolve_sites(sites)
    site_total = len(selected_sites)
    if site_total == 0:
        emit_log("没有可用站点", level="error")
        return [], {"failed_sites": []}

    emit_progress("init", f"开始采集 {year}年{month}月，共 {site_total} 个站点", percent=0,
                  detail={"sites": [s["id"] for s in selected_sites]})

    all_data = []
    failed_sites = []
    for i, site in enumerate(selected_sites):
        idx = i + 1
        url = site["url"]
        site_start = time.time()

        emit_progress("scraping", f"[{idx}/{site_total}] {site['name']} 开始",
                      step=idx, total=site_total,
                      percent=round(((idx - 1) / site_total) * 100, 1),
                      detail={"site_id": site["id"], "stage": "site_start"})

        data = []
        try:
            if SELENIUM_AVAILABLE:
                data = scrape_with_selenium(url, target_prefix, stop_prefix, timeout, idx, site_total)

            if not data:
                remaining = timeout - (time.time() - site_start)
                if remaining > 10:
                    emit_log(f"[{site['name']}] 尝试 API 方式...")
                    data = scrape_with_api(url, target_prefix, stop_prefix)
        except Exception as e:
            emit_log(f"[{site['name']}] 抓取异常: {e}", level="error")
            failed_sites.append({"id": site["id"], "name": site["name"], "error": str(e)})

        all_data.extend(data)
        emit_progress("scraping", f"[{idx}/{site_total}] {site['name']} 完成，找到 {len(data)} 条",
                      step=idx, total=site_total,
                      percent=round((idx / site_total) * 100, 1),
                      detail={"site_id": site["id"], "stage": "site_done", "items": len(data)})
        time.sleep(1)

    # 去重
    seen = set()
    unique = []
    for item in all_data:
        key = item["link"] or item["title"]
        if key not in seen:
            seen.add(key)
            unique.append(item)

    unique.sort(key=lambda x: x["date"], reverse=True)

    emit_progress("done", f"采集完成: 共 {len(unique)} 条", percent=100,
                  detail={"count": len(unique), "failed": len(failed_sites)})

    return unique, {"failed_sites": failed_sites}


def _resolve_sites(sites):
    """sites 可以是 None/空数组/逗号字符串/id 列表，返回站点对象数组"""
    if not sites:
        return list(SITES)
    if isinstance(sites, str):
        sites = [s.strip() for s in sites.split(",") if s.strip()]
    if not isinstance(sites, list):
        return list(SITES)

    out = []
    invalid = []
    for sid in sites:
        s = SITE_BY_ID.get(sid)
        if s:
            out.append(s)
        else:
            invalid.append(sid)
    if invalid:
        emit_log(f"未识别的站点 ID: {invalid}（可用：{list(SITE_BY_ID.keys())}）", level="error")
    return out


# ── 输出 ─────────────────────────────────────────────────

def export_csv(data, output_path):
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    with open(output_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["发布日期", "标题", "发布网站", "URL链接"])
        writer.writeheader()
        for item in data:
            writer.writerow({
                "发布日期": item["date"],
                "标题": item["title"],
                "发布网站": item["site_name"],
                "URL链接": item["link"],
            })
    emit_log(f"[CSV] 已导出: {output_path}（{len(data)} 条）")


def export_md(data, output_path, year, month, summary=None):
    """按机构分组的 MD 报告（FR-D2/D3）"""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    by_site = {}
    for item in data:
        by_site.setdefault(item["site_name"], []).append(item)
    for arr in by_site.values():
        arr.sort(key=lambda x: x["date"], reverse=True)

    lines = []
    lines.append(f"# 政策信息汇总（{year} 年 {month} 月）")
    lines.append("")
    lines.append(f"> 共 **{len(data)}** 条，采集自 **{len(by_site)}** 个机构，生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    lines.append("## 汇总")
    lines.append("")
    lines.append("| 机构 | 条数 |")
    lines.append("|------|------|")
    for site_name, items in sorted(by_site.items(), key=lambda x: -len(x[1])):
        lines.append(f"| {site_name} | {len(items)} |")
    lines.append("")

    if summary and summary.get("failed_sites"):
        lines.append("## 失败站点")
        lines.append("")
        for f in summary["failed_sites"]:
            lines.append(f"- {f.get('name', f.get('id', ''))}: {f.get('error', '')}")
        lines.append("")

    lines.append("---")
    lines.append("")

    for site_name, items in sorted(by_site.items()):
        lines.append(f"## {site_name}（{len(items)} 条）")
        lines.append("")
        for item in items:
            lines.append(f"### {item['title']}")
            lines.append(f"- **发布日期**：{item['date']}")
            lines.append(f"- **来源**：{item['site_name']}")
            if item.get("link"):
                lines.append(f"- **链接**：<{item['link']}>")
            lines.append("")
        lines.append("")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    emit_log(f"[MD] 已导出: {output_path}")


def _default_output_dir():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "output")


def main():
    parser = argparse.ArgumentParser(description="政策信息抓取工具")
    parser.add_argument("--year", type=int, required=True, help="目标年份")
    parser.add_argument("--month", type=int, required=True, help="目标月份 (1-12)")
    parser.add_argument("--output-dir", default=None, help="输出目录")
    parser.add_argument("--timeout", type=int, default=SITE_TIMEOUT, help="单站超时秒数")
    parser.add_argument("--sites", default=None, help="站点 ID 子集（逗号分隔，例如 gdii,fszj），默认全部")
    args = parser.parse_args()

    if not (2000 <= args.year <= 2100):
        print("错误: 年份应在 2000-2100 之间", file=sys.stderr)
        sys.exit(1)
    if not (1 <= args.month <= 12):
        print("错误: 月份应在 1-12 之间", file=sys.stderr)
        sys.exit(1)

    sites = args.sites
    data, summary = scrape_all(args.year, args.month, sites=sites, timeout=args.timeout)

    if not data:
        emit_log("未采集到任何数据", level="warn")

    output_dir = args.output_dir or _default_output_dir()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = f"政策信息_{args.year}年{args.month}月_{timestamp}"
    csv_path = os.path.join(output_dir, base + ".csv")
    md_path = os.path.join(output_dir, base + ".md")

    export_csv(data, csv_path)
    export_md(data, md_path, args.year, args.month, summary)

    print(json.dumps({
        "csv_path": csv_path,
        "md_path": md_path,
        "count": len(data),
        "summary": {"by_site": _summary_by_site(data), "failed_sites": summary.get("failed_sites", [])},
    }, ensure_ascii=False))


def _summary_by_site(data):
    out = {}
    for x in data:
        out[x["site_name"]] = out.get(x["site_name"], 0) + 1
    return out


def coral_main():
    """CORAL skill executor 入口：从 stdin 读取 JSON，结果写入 stdout。"""
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    try:
        payload = json.loads(sys.stdin.read())
        inp = payload.get("input", {})
        year = inp.get("year")
        month = inp.get("month")
        sites = inp.get("sites")

        if not year or not month:
            real_stdout.write(json.dumps({"error": "缺少 year 或 month 参数"}, ensure_ascii=False))
            sys.exit(1)

        year, month = int(year), int(month)
        data, summary = scrape_all(year, month, sites=sites)

        output_dir = _default_output_dir()
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base = f"政策信息_{year}年{month}月_{timestamp}"
        csv_path = os.path.join(output_dir, base + ".csv")
        md_path = os.path.join(output_dir, base + ".md")

        export_csv(data, csv_path)
        export_md(data, md_path, year, month, summary)

        result = {
            "csv_path": csv_path,
            "md_path": md_path,
            "count": len(data),
            "summary": {
                "by_site": _summary_by_site(data),
                "failed_sites": summary.get("failed_sites", []),
            },
        }
        real_stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        real_stdout.write(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)
    finally:
        sys.stdout = real_stdout


if __name__ == "__main__":
    if len(sys.argv) > 1:
        main()
    else:
        coral_main()
