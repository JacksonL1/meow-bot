# clawd-starter

> 从零重搭 Clawd 桌宠的骨架：用 Electron 做一个透明置顶、会跟着鼠标看你的桌面宠物，先把「agent 事件 → 状态机 → 画面」这条数据链路跑通，之后每个阶段都往这条链路上加东西，而不是推倒重来。

| 项 | 内容 |
|---|---|
| 状态 | ACTIVE |
| 路径 | `E:\JacksonLee\project\clawd-starter` |
| 技术栈 | Electron 41.10.7（`nodeIntegration: false` + `contextIsolation: true`）、Node 原生 `http` + `fs`、渲染层纯手写 SVG 无框架、无构建工具 |
| 入口 | `src/main.js`（主进程） |
| 启动 | `npm install` → `npm start`（即 `electron .`） |
| 端口 | 随机分配（`listen(0)`），只绑 `127.0.0.1`，端口写入 `.clawd-port` |
| 依赖服务 | 无。不连任何外部服务，只在本机开一个 HTTP 端口接收事件 |
| 版本控制 | git，1 次提交（2026-10-26 `first commit`） |
| 体积 | 8 个源文件，约 800 行代码 |

## 它解决什么问题

用户同时开着好几个 Claude Code 会话在跑任务，切窗口才知道哪个卡住、哪个在等确认。这个桌宠把「agent 现在在干什么」压缩成一个始终可见的小角色：思考时冒泡、干活时打字、失败时红叹号、跑完冲你笑一下。

不追求「好看的桌宠」，追求**数据链路先通**：一个 hook 进程把事件丢进本地 HTTP 端口，主进程算出一个「当前该显示什么」的状态，渲染层按状态播对应帧。

## 阶段路线

| 阶段 | 内容 | 状态 | 安全状况 |
|---|---|---|---|
| S1 | 透明置顶窗口、无边框、点击穿透、主进程轮询光标实现拖拽 | 已完成 | 1 个 P3（置顶层级） |
| S2 | 本地 HTTP 接收器 + 单会话状态机（事件映射、优先级仲裁、oneshot 回落、闲置入睡） | 已完成 | 3 个 P2 + 1 个 P3 |
| S3 | 渲染层：状态→帧序列、双图层交叉淡入、眼球追踪插值 | 已完成 | 1 个 P2 + 2 个 P3 |
| S4 | 接真 hook：解析 stdin JSON、往 `~/.claude/settings.json` 追加安装项 | 未开始 | 预判 4 类风险，见 SECURITY.md |
| S5 | 权限气泡：`/permission` 阻塞回包，让桌宠替用户批准确认 | 未开始 | **P0 最高危**，见 SECURITY.md |
| S6 | 多会话 dashboard（当前只在内存 Map 里仲裁，没有可视化） | 未开始 | 预判 cwd 泄露 |
| S7 | 主题系统：`themes/<name>/theme.json` + 资产目录，替换写死的 `visuals.js` | 未开始 | 预判 XSS 入口 |

安全问题全部记录在 [SECURITY.md](./SECURITY.md)，每阶段开工前先看对应小节。

## 核心模块

| 模块 | 职责 | 关键文件 |
|---|---|---|
| 窗口与进程 | 创建透明置顶窗口、拖拽轮询、眼球追踪采样、生命周期清理 | `src/main.js` |
| 事件接入 | 本地 HTTP 服务，`GET /health`、`GET /state`、`POST /state`，请求体限 256KB | `src/server.js` |
| 状态机 | 事件→状态映射、多会话优先级仲裁、oneshot 自动回落、25s 发呆 / 60s 入睡 | `src/state.js` |
| 渲染 | 双图层交叉淡入、帧轮播、瞳孔位移插值 | `src/renderer.js` |
| 视觉数据 | 6 个状态的 SVG 帧序列与 fps，纯数据无逻辑 | `src/visuals.js` |
| 进程间桥 | 只暴露 6 个具体动作，不泄漏 `ipcRenderer` | `src/preload.js` |
| 调试 | 假数据源，三种用法（完整剧本 / 单事件 / 保持某状态） | `scripts/fake-feed.js` |

## 已知限制

- 只认 Claude Code 的事件名，没有多 agent 适配器（那是体力活，等内核稳了再铺）
- 会话只存内存 `Map`，没有持久化与掉电恢复
- 端口文件开发期写项目根目录，打包后才进 `userData`
- 每 250ms 统一 tick，不是事件驱动定时器
- 无权限气泡（S5 才有）
- 命中判定用 `#pet` 的 176×176 包围盒，不是真实 alpha 遮罩——四个角上的透明区会误判为「可点击」

## 硬约束（改代码前先看）

1. **`preload.js` 只暴露动作，不暴露 `ipcRenderer`**——这是 Electron 的安全边界，加功能时最容易顺手破坏。
2. **状态名必须存在于 `VISUAL_STATES`**，渲染层靠白名单挡住任意字符串进 DOM。
3. **`transparent: true` 必须同时给 `backgroundColor: '#00000000'` 和 `hasShadow: false`**，缺一个就露底色。
4. 环境里若有 `ELECTRON_RUN_AS_NODE=1`，`electron .` 会退化成纯 Node，表现为 `require('electron')` 返回字符串。启动前 `env -u ELECTRON_RUN_AS_NODE npm start`。
