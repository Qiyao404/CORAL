# 发布指南（M3-3）

两个 SDK 包与协议规范一起构成 CORAL 的对外发布面。**发布前先读版本化规则**
（`docs/PROGRESS_PROTOCOL.md` §4）。

## 1. `@coral/progress` → npm

```bash
cd packages/progress

# 1) 确认已登录（需要 npm 账号 + 已执行 npm login）
npm whoami

# 2) 发布（prepublishOnly 自动跑测试 + 构建 dist）
npm publish --access public
```

要点：
- 包内容只有 `dist/`（`files` 字段控制）；入口 `dist/index.js`（ESM）+ `.d.ts` 类型
- `@coral/progress` 是 scope 包名 — 若你的 npm 账号没有 `coral` scope，要么在 npm 建立
  `coral` organization，要么把 `package.json` 的 `name` 改为无 scope 的 `coral-progress`
  （Python 侧同名已占用检查：`npm view coral-progress` 确认可用性）
- 版本号与协议版本对齐习惯：协议 v1.x 期间 SDK 从 `1.x.y` 起步

## 2. `coral-progress` → PyPI

```bash
cd packages/progress-py

# 1) 构建（需要 pip install build）
python -m build

# 2) 上传（需要 pip install twine + PyPI 账号/token）
python -m twine upload dist/*
```

要点：
- 源文件 `coral_progress/__init__.py` 与 `skills/_lib/coral_progress.py` **同源** —
  修改任意一侧后必须同步另一侧（_lib 头部有注明）
- 先在 TestPyPI 演练：`twine upload --repository-url https://test.pypi.org/legacy/ dist/*`

## 3. 发布前检查清单

- [ ] `packages/progress`：`npm test` 绿；`npm run build` 产出 dist 且 `node -e "import('./dist/index.js')"` 可用
- [ ] `packages/progress-py`：`python -c "from coral_progress import emit_progress"` 可用
- [ ] 双侧 `emit_progress/emit_log/emit_artifact` 行为一致（对照 PROGRESS_PROTOCOL.md 的示例）
- [ ] 协议有变更则先升 `docs/PROGRESS_PROTOCOL.md` 的版本号并写明变更点
- [ ] 两个包版本号 + CHANGELOG（M4-6 落地前先用 git log 代劳）

## 4. 版本升级流程

1. 改 `packages/progress/package.json` 的 `version` 与 `packages/progress-py/pyproject.toml` 的 `version`（保持一致）
2. `docs/PROGRESS_PROTOCOL.md` 若涉及协议行为变更则同步升版本
3. 按 §1/§2 分别发布；打 git tag：`git tag sdk-v<版本> && git push --tags`
