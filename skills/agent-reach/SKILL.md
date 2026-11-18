---
name: agent-reach
version: "1.0.0"
description: "互联网触达工具箱：通过 agent-reach CLI 搜索和阅读 B站/小红书/Reddit/Twitter/YouTube/V2EX/雪球/GitHub 等 13 个平台。当用户问到这些平台的内容时优先使用本技能（比 http_fetch 更结构化、更可靠）。需要用户已安装 agent-reach。"
domain: web
capabilities: [web_access, platform_search, video_transcript]
input_schema:
  type: object
  required: [command]
  properties:
    command: { type: string, description: "完整的 agent-reach CLI 命令（如 bilibili search 大模型）" }
output_schema:
  type: object
  properties:
    result: { type: string }
execution_mode: llm_only
status: stable
tags: [检索, 多平台]
source: builtin
---

# Agent-Reach：互联网触达工具箱

当用户需要搜索或阅读以下平台的内容时，优先使用 `agent-reach` 命令行工具（通过 shell_run 调用），而非直接 http_fetch：

| 平台 | 命令前缀 | 能做什么 | 需要什么 |
|---|---|---|---|
| B站 | `agent-reach bilibili` | 搜索、视频信息、热门、**字幕** | 无（字幕需登录） |
| GitHub | `agent-reach github` | 搜仓库、读 README、读 issue/PR 及评论 | 无 |
| YouTube | `agent-reach youtube` | 视频信息、搜索、**字幕**、语音转文字 | 无 |
| V2EX | `agent-reach v2ex` | 热门、节点、帖子和回复 | 无 |
| 网页 | `agent-reach web` | 网页搜索、网页阅读（保底） | 无 |
| 小红书 | `agent-reach xiaohongshu` | 搜笔记、读正文、看评论 | 登录 |
| Reddit | `agent-reach reddit` | 搜帖子、读正文、看评论 | 登录 |
| Twitter/X | `agent-reach twitter` | 搜推文、用户资料、读推文串 | 登录 |
| 雪球 | `agent-reach xueqiu` | 实时行情、搜股票、热帖 | 行情免费 |
| Boss直聘 | `agent-reach boss` | 搜职位和 JD | 登录 |
| LinkedIn | `agent-reach linkedin` | 搜职位、读详情 | 公开免费 |
| 小宇宙 | `agent-reach xiaoyuzhou` | 播客转文字 | Groq Key |
| Instagram | `agent-reach instagram` | 搜用户、主页、帖子 | 登录 |

## 怎么用

通过 shell_run 执行，命令格式：

```
agent-reach <渠道> <动作> [参数]
agent-reach read <URL>          # 按链接自动选渠道
agent-reach channels            # 列出所有可用渠道
```

### 常用示例

```bash
# B站搜索
agent-reach bilibili search "大模型"

# B站视频信息 + 字幕
agent-reach bilibili info BV1xx411c7mD
agent-reach bilibili subtitle BV1xx411c7mD

# GitHub 搜仓库
agent-reach github search "agent framework"

# GitHub 读 issue 及评论
agent-reach github issues --repo Qiyao404/CORAL --state open

# YouTube 视频字幕
agent-reach youtube subtitle https://www.youtube.com/watch?v=dQw4w9WgXcQ

# YouTube 搜索
agent-reach youtube search "machine learning tutorial"

# Reddit 搜帖子
agent-reach reddit search "best programming language 2026"

# Twitter 搜推文
agent-reach twitter search "AI agent"

# 网页阅读（比 http_fetch 更好的正文提取）
agent-reach web read https://example.com/article

# V2EX 热帖
agent-reach v2ex hot

# 雪球查行情
agent-reach xueqiu quote AAPL
```

## 输出格式

每次调用输出一个 JSON 信封：

```json
{
  "schema_version": 1,
  "ok": true,
  "channel": "bilibili",
  "action": "search",
  "backend": "bili-cli",
  "items": [...],
  "meta": {...}
}
```

**处理错误**：当 `ok` 为 `false` 时，根据 `error.code` 处理：

| 错误码 | 含义 | 你该怎么做 |
|---|---|---|
| NEED_SETUP | 工具未安装 | 告诉用户运行 `agent-reach doctor` |
| NEED_LOGIN | 需要登录 | 告诉用户运行 `agent-reach login <渠道>` |
| RATE_LIMITED | 被限流 | 等待 `meta.retry_after_seconds` 后重试 |
| NOT_FOUND | 内容不存在 | 换关键词或确认链接 |
| PLATFORM_BLOCKED | 平台风控 | 停止重试，告知用户 |
| UPSTREAM_BROKEN | 上游工具故障 | 尝试备选方案或告知用户 |

## 何时优先用 agent-reach 而非 http_fetch

- **平台在上表中** → 优先 agent-reach（结构化 JSON，比解析 HTML 可靠得多）
- **需要视频字幕** → 必须 agent-reach（http_fetch 拿不到字幕）
- **需要登录内容**（小红书/Reddit/Twitter）→ 必须 agent-reach
- **普通网页** → 都可以，agent-reach web read 通常比 http_fetch 的正文提取更好
- **agent-reach 未安装** → 降级到 http_fetch，并告知用户可以安装 agent-reach 获得更好体验

## 安装检测

如果 shell_run 报 `command not found`，说明用户未安装 agent-reach。告诉用户：

> 你可以安装 Agent-Reach 来解锁 B 站/YouTube 字幕/Reddit 等平台的搜索能力。只需对我说：
> "帮我安装 Agent Reach：https://raw.githubusercontent.com/Panniantong/Agent-Reach/main/docs/install.md"
