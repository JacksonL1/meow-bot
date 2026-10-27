# clawd-starter

> 从零重搭 Clawd 桌宠的骨架：用 Electron 做一个透明置顶、会跟着鼠标看你的桌面宠物，先把「agent 事件 → 状态机 → 画面」这条数据链路跑通，之后每个阶段都往这条链路上加东西，而不是推倒重来。

| 项 | 内容 |
|---|---|
| 状态 | ACTIVE（S1–S5 完成） |
| 路径 | `E:\JacksonLee\project\clawd-starter` |
| 技术栈 | Electron 45.0.0（`nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`）、Node 原生 `http` + `fs`、渲染层纯手写 SVG 无框架、无构建工具 |
| 入口 | `src/main.js`（主进程） |
| 启动 | `npm install` → `npm start`（即 `electron .`） |
| 端口 | **固定 23333**（与主仓库一致），只绑 `127.0.0.1`。为什么不能随机：权限 HTTP hook 的 url 是安装时写死进 `settings.json` 的，端口漂移就等于 hook 指向死端口。被占用时退回随机端口并显式 warn，但必须重跑 `install:hooks` |
| 端点文件 | `%APPDATA%\clawd-starter\clawd-starter.port`，内容 `{port, token}`，权限 0600 |
| 依赖服务 | 无。不连任何外部服务，只在本机开一个 HTTP 端口接收事件 |
| 版本控制 | git，2 次提交（均 2026-10-26：`first commit` + `安全加固`）。**S4/S5 的全部改动尚未提交** |
| 体积 | 16 个源文件，约 2900 行（`src/` 1633 + `hooks/` 341 + `scripts/` 888） |

## 它解决什么问题

用户同时开着好几个 Claude Code 会话在跑任务，切窗口才知道哪个卡住、哪个在等确认。这个桌宠把「agent 现在在干什么」压缩成一个始终可见的小角色：思考时冒泡、干活时打字、失败时红叹号、跑完冲你笑一下。

不追求「好看的桌宠」，追求**数据链路先通**：一个 hook 进程把事件丢进本地 HTTP 端口，主进程算出一个「当前该显示什么」的状态，渲染层按状态播对应帧。

S5 之后多了一条链路：Claude Code 要执行工具时，桌宠会弹出一张卡片问「这条命令放不放行」。**不点、关掉、退出、超时一律返回 204 不做决定**，自动回落到终端原生提示——这个默认值是整个 S5 最重要的设计。

## 阶段路线

| 阶段 | 内容 | 状态 | 安全状况 |
|---|---|---|---|
| S1 | 透明置顶窗口、无边框、点击穿透、主进程轮询光标实现拖拽 | 已完成 | 1 个 P3（置顶层级，已由锁屏/休眠隐藏缓解） |
| S2 | 本地 HTTP 接收器 + 单会话状态机（事件映射、优先级仲裁、oneshot 回落、闲置入睡） | 已完成 | 4 道锁 + 会话上限 + cwd 脱敏，0 遗留 |
| S3 | 渲染层：状态→帧序列、双图层交叉淡入、眼球追踪插值 | 已完成 | SVG 白名单就位，S7 接外部主题前必须回归 |
| S4 | 接真 hook：解析 stdin JSON、往 `~/.claude/settings.json` 增量合并 8 个观察型事件 | 已完成 | 补了预判漏项：观察型 hook 必须 `async` |
| S5 | 权限气泡：`type:"http"` 阻塞回包，让桌宠替用户批准确认 | 已完成 | 五条要求全部落地；`/permission` 不校 token 是架构固有属性 |
| S6 | 多会话 dashboard（当前只在内存 Map 里仲裁，没有可视化） | 未开始 | 预判 cwd 泄露 |
| S7 | 主题系统：`themes/<name>/theme.json` + 资产目录，替换写死的 `visuals.js` | 未开始 | 预判 XSS 入口 |

安全问题全部记录在 [SECURITY.md](./SECURITY.md)，每阶段开工前先看对应小节。

## 核心模块

| 模块 | 职责 | 关键文件 |
|---|---|---|
| 窗口与进程 | 创建透明置顶窗口、拖拽轮询、眼球追踪采样、气泡窗口生命周期 | `src/main.js` |
| 事件接入 | 本地 HTTP 服务，`GET /health`、`GET /state`、`POST /state`、`POST /permission` | `src/server.js` |
| 状态机 | 事件→状态映射、多会话优先级仲裁、oneshot 自动回落、25s 发呆 / 60s 入睡 | `src/state.js` |
| 权限裁决 | 挂起请求、等待决定、唯一出口 `settle()` 保证恰好响应一次 | `src/permission.js` |
| 权限气泡 | 卡片 UI、两个按钮、Esc 不表态、量高度回传 | `src/bubble.html` + `bubble-renderer.js` + `bubble-preload.js` |
| 渲染 | 双图层交叉淡入、帧轮播、瞳孔位移插值 | `src/renderer.js` |
| 视觉数据 | **布偶猫**形象，7 个状态 19 帧的 SVG 帧序列与 fps，纯数据无逻辑 | `src/visuals.js` |
| 进程间桥 | 只暴露 6 个具体动作，不泄漏 `ipcRenderer` | `src/preload.js` |
| 调试 | 假数据源，三种用法（完整剧本 / 单事件 / 保持某状态） | `scripts/fake-feed.js` |
| 回归闸门 | 主进程 inspector + 渲染进程 CDP，55 项断言 | `scripts/verify-electron.js` |

## 已知限制

- 只认 Claude Code 的事件名，没有多 agent 适配器（那是体力活，等内核稳了再铺）
- 会话只存内存 `Map`，没有持久化与掉电恢复
- 每 250ms 统一 tick，不是事件驱动定时器
- 权限请求只存内存，没有决策历史与审计日志
- 气泡只支持鼠标点 + Esc，没有键盘 Tab/Enter，也没有远程审批
- **不能和主仓库 `clawd-on-desk` 同时运行**：都用 23333，且 hook URL 是安装时写死的
- 命中判定用 `#pet` 的 176×176 包围盒，不是真实 alpha 遮罩——四个角上的透明区会误判为「可点击」
- **真实 Claude Code 会话一次都没跑过**（本机无 `claude` CLI），这是贯穿 S4/S5 的最大缺口

## 硬约束（改代码前先看）

1. **`preload.js` / `bubble-preload.js` 只暴露动作，不暴露 `ipcRenderer`**——这是 Electron 的安全边界，加功能时最容易顺手破坏。
2. **状态名必须存在于 `VISUAL_STATES`**，渲染层靠白名单挡住任意字符串进 DOM。
3. **`transparent: true` 必须同时给 `backgroundColor: '#00000000'` 和 `hasShadow: false`**，缺一个就露底色。
4. 环境里若有 `ELECTRON_RUN_AS_NODE=1`，`electron .` 会退化成纯 Node，表现为 `require('electron')` 返回字符串。启动前 `env -u ELECTRON_RUN_AS_NODE npm start`。
5. **权限的所有结局必须走 `settle()`**——任何绕开它直接写 `res` 的分支都会破坏「恰好响应一次」。
6. **`/permission` 不能加 token 校验**，加了气泡就永远不出现（调用方 Claude Code 读不到端点文件）。
7. **观察型 hook `async: true`，裁决型 hook 绝不写 `async`**——两者语义相反，不要统一。
