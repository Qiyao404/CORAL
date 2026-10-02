#!/usr/bin/env bash
# CORAL v1.1.0 · macOS / Linux 生产模式启动

set -e
cd "$(dirname "$0")/.."

echo "[构建] 后端..."
npm run build:server

echo "[构建] 前端..."
npm run build:web

echo "[启动] CORAL 后端（生产模式）..."
npm run start -w packages/server
