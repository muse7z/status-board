# status-board · Hermes 桌面端「状态看板」插件

桌宠式 OS 级浮动看板：点 Hermes 状态栏芯片，弹出一个**无边框、置顶、跨窗口**的赛博朋克小窗，实时显示——

| 项目 | 说明 |
|---|---|
| 任务情况 | 工作中/空闲状态点 + 调用次数 + 费用 |
| 当前模型 | 中文友好名（如 DeepSeek V4 闪速·视觉） |
| Token 消耗 | 输入 / 输出 / 总计 / 调用（会话累计） |
| 缓存命中 | cache_read / cache_write（需要 gateway 补丁，见下） |
| 上下文 | 已用 / 上限 / 剩余 + 进度条（>60% 黄、>80% 红） |

交互：标题栏按住左键拖动（OS 原生）、右上角 ✕ 关闭、再点芯片重新打开（同名单窗口复用）。

## 文件清单

- `plugin.js` — 插件本体（~400 行，热加载）
- `patches/electron-main.ts.patch` — 主进程补丁：`setWindowOpenHandler` 放行 `?win=plugin` 浮窗（无边框/置顶/透明）
- `patches/renderer-routes.patch` — renderer 补丁：浮窗壳（`isPluginOverlayWindow` + 无侧栏 shell）+ 路由占位（防 `:sessionId` 劫持）
- `patches/gateway-usage.patch` — gateway 补丁：`session.usage` 增加 `cache_read/cache_write` 字段

## ⚠️ 依赖（重要）

本插件**不是自足的**：浮窗窗口能力依赖 Hermes 桌面内核的 4 处改动（见 patches/）。
在**本机**（linux-unpacked build，2026-08-31 部署）已全部打好，直接可用。
在**别的机器**上需要：

1. 安装 Hermes 桌面源码版（`apps/desktop`），应用两个 patch（`git apply patches/*.patch`）
2. `npm install --ignore-scripts && npm run build`（vite build + bundle）
3. 若用打包版：官方 `@electron/asar` 重打包 `app.asar`（extract → 替换 `dist/` → pack）
4. gateway 需给 `session.usage` 加 `cache_read/cache_write`（`tui_gateway/server.py` `_get_usage`）

未打补丁时：插件仍会注册（状态栏芯片可见），但点击无法弹出浮窗（旧内核不消费插件路由 / 无窗口通道）。

## 安装（本机）

```bash
mkdir -p ~/.hermes/desktop-plugins/status-board
cp plugin.js ~/.hermes/desktop-plugins/status-board/
```

Hermes 桌面端自动热加载（fs watcher）；重启后常驻。

## 使用

底部状态栏右侧会出现芯片：

`● DeepSeek V4 闪速·视觉 · 12.3M token · 上下文 34%`

点击 → 弹出浮窗看板（浮在最上层，跨窗口）。主窗口切换会话时，看板自动跟随（localStorage 会话桥，2s 兜底轮询 + 3s 数据刷新）。

## 数据链路（架构速览）

```
主窗口芯片（host.state.activeSessionId）
  → localStorage 会话桥（status-board.session-id）
  → 浮窗窗口 session.usage / session.context_breakdown（3s 轮询 + 回合结束即时）
  → 实时渲染（任务状态用 turn 事件通道）
```

## 版本

- v1.0 — 2026-08-31：初版（页面内 → OS 浮窗全链路打通）
