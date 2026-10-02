#!/usr/bin/env bash
# CORAL v1.1.0 · macOS / Linux 一键开发脚本
# 用法：./scripts/dev.sh

set -e

cd "$(dirname "$0")/.."

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  CORAL v1.1.0 — DEV 环境一键启动              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] 未检测到 Node.js（需要 Node 18+）"
    exit 1
fi
echo "[OK] $(node --version)"

if command -v python3 >/dev/null 2>&1; then
    echo "[OK] $(python3 --version)"
elif command -v python >/dev/null 2>&1; then
    echo "[OK] $(python --version)"
else
    echo "[WARN] 未检测到 Python（policy-scraper / policy-to-post 需要）"
fi

if [ ! -d node_modules ]; then
    echo "[INFO] 首次启动：安装 npm 依赖..."
    npm install
fi

if [ ! -f .env ]; then
    echo "[ERROR] 缺少 .env 文件"
    exit 1
fi

mkdir -p data skills

echo ""
echo "[启动] 后端 :3001  + 前端 :5173 (并发)"
echo "[提示] 按 Ctrl+C 停止"
echo ""

npm run dev
