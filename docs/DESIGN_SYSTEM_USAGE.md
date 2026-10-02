# CORAL v1.1.0 视觉设计系统使用指南

> 给前端开发者：在 packages/web 中如何使用统一的设计 tokens 和 UI 组件

---

## 1. 设计哲学

- **科技感**：深色主背景 (#020617) + 强对比 CTA 绿 (#22C55E)
- **层次感**：Glassmorphism（毛玻璃 + 半透明描边）
- **生命感**：运行态用呼吸动效暗示"系统在思考"
- **克制**：动效服务于反馈而非装饰，遵循 `prefers-reduced-motion`

---

## 2. 调色板（Tailwind tokens）

| Token | 用途 |
|-------|------|
| `bg-bg-base` | 页面底色 (#020617) |
| `bg-bg-panel` | 一级面板 (#0F172A) |
| `bg-bg-raise` | 浮起卡片 (#1E293B) |
| `bg-bg-elev` | 悬停态 (#334155) |
| `text-fg-primary` | 主文字 (#F8FAFC) |
| `text-fg-secondary` | 次要文字 (#CBD5E1) |
| `text-fg-muted` | 弱化文字 (#94A3B8) |
| `text-fg-disabled` | 禁用文字 (#64748B) |
| `bg-brand` / `text-brand` | 主 CTA (#22C55E) |
| `bg-brand-soft` | 主色淡背景 |
| `text-status-info / success / warn / danger / pending` | 状态色 |
| `border-glass-border` | Glass 描边（rgba 白色 10%）|
| `border-glass-borderStrong` | Glass 强描边（18%）|

---

## 3. 字体

```css
font-heading  /* Poppins */
font-body     /* Open Sans（默认） */
font-mono     /* JetBrains Mono / Fira Code */
```

中文回退到 PingFang SC / Microsoft YaHei。

---

## 4. 公共组件（`packages/web/src/components/ui`）

```tsx
import {
  Button, Card, Tag, ProgressBar, StatusIcon, Skeleton, EmptyState,
  Modal, Drawer, Input, Textarea, Select, ConnectionDot,
} from '../components/ui';
```

### Button

```tsx
<Button variant="primary | secondary | ghost | danger"
        size="sm | md | lg"
        loading={false}
        icon={<X className="w-4 h-4" />}
        onClick={...}>
  文字
</Button>
```

### Card

```tsx
<Card interactive onClick={...}>...</Card>
// 自动应用 .glass + glass-hover
```

### Tag

```tsx
<Tag variant="default | success | warn | danger | info | brand">标签</Tag>
```

### ProgressBar

```tsx
<ProgressBar value={62} status="running | completed | failed | pending"
             compact={false} showText={true} />
```

`status="running"` 时自动套 `.progress-bar-fill` 流光动画。

### Modal / Drawer

```tsx
<Modal open={open} onClose={() => setOpen(false)}
       title="标题"
       footer={<><Button variant="ghost">取消</Button><Button>确认</Button></>}>
  内容
</Modal>
```

### EmptyState

```tsx
<EmptyState
  title="暂无数据"
  description="去对话页提交一个任务"
  icon={<Sparkles className="w-12 h-12" />}
  action={<Button>新建</Button>}
/>
```

### Skeleton

```tsx
<Skeleton height="h-8" width="w-64" />
// 自动套 .skeleton 闪烁动画
```

---

## 5. 自定义 Glass 卡片

如果不用 `<Card>`，可以直接套 `.glass` class：

```tsx
<div className="glass rounded-2xl p-5 glass-hover">
  ...
</div>
```

---

## 6. 动效规范

| 场景 | 时长 | 实现 |
|------|------|------|
| 卡片悬停上浮 | 200ms | `glass-hover` class |
| 按钮 hover 提亮 | 150ms | `Button` variant 内置 |
| 按钮 active 凹陷 | 80ms | `Button` 内置 `active:scale-[0.98]` |
| 页面切换 | 250ms | `animate-fade-in-up` |
| 进度条流光 | 1.8s loop | `.progress-bar-fill` |
| 节点脉冲 | 1.6s alt | `.node-running` / `animate-node-pulse` |
| 骨架屏 | 1.2s loop | `.skeleton` |

---

## 7. 图标体系（Lucide）

```tsx
import { CheckCircle2, AlertTriangle, PlayCircle, Loader2 } from 'lucide-react';

<CheckCircle2 className="w-4 h-4 text-status-success" />
```

> **禁止用 emoji 当 UI 图标**（仅作为内容文本时可用，如对话气泡内容）。

---

## 8. 响应式断点

```
375px  · 移动端（最小目标）
768px  · 平板
1024px · 桌面
1440px · 大屏
```

侧边栏 / DAG / 表格在 `<768px` 应改为可滚或抽屉式（待 P1 完善）。

---

## 9. 可访问性自检

发布前请：

- [ ] 所有可点击元素有 `cursor-pointer` 与 hover 反馈
- [ ] 所有 hover 不导致布局抖动（用 `transform` / `opacity`，不用 `width` / `height` / `margin`）
- [ ] 颜色对比度 ≥ 4.5:1
- [ ] 关键动效在 `prefers-reduced-motion: reduce` 下禁用
- [ ] 图标全部用 SVG（Lucide / Heroicons），无 emoji
- [ ] 所有 `<img>` 有 `alt` 属性
- [ ] 表单 `<input>` 有 `<label>`

---

## 10. 已知限制（P2）

- DAG 可视化在 ≤ 20 节点时性能良好；> 50 节点时建议改用纯文本或分页
- Web Speech API 仅 Chrome / Edge 支持，Firefox/Safari 自动隐藏麦克风按钮
- Monaco/CodeMirror 暂未引入（SkillBuilder 使用 textarea + 字体等宽简易呈现）
