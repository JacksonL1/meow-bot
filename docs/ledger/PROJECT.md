# clawd-starter

> 从零重搭 Clawd 桌宠的骨架：用 Electron 做一个透明置顶、会跟着鼠标看你的桌面宠物，先把「agent 事件 → 状态机 → 画面」这条数据链路跑通，之后每个阶段都往这条链路上加东西，而不是推倒重来。

| 项 | 内容 |
|---|---|
| 状态 | ACTIVE（S1–S7 完成） |
| 路径 | `E:\JacksonLee\project\clawd-starter` |
| 技术栈 | Electron 45.0.0（`nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`）、Node 原生 `http` + `fs`、渲染层纯手写 SVG 无框架、无构建工具 |
| 入口 | `src/main.js`（主进程） |
| 启动 | `npm install` → `npm start`（即 `electron .`） |
| 端口 | **固定 23333**（与主仓库一致），只绑 `127.0.0.1`。为什么不能随机：权限 HTTP hook 的 url 是安装时写死进 `settings.json` 的，端口漂移就等于 hook 指向死端口。被占用时退回随机端口并显式 warn，但必须重跑 `install:hooks` |
| 端点文件 | `%APPDATA%\clawd-starter\clawd-starter.port`，内容 `{port, token}`，权限 0600 |
| 依赖服务 | 无。不连任何外部服务，只在本机开一个 HTTP 端口接收事件 |
| 版本控制 | git，**5 次提交**（截至 `修改一下形象，添加会话看板窗口`）。**S7 主题系统 + 这批台账改动尚未提交** |
| 体积 | 22 个源文件，约 4600 行（`src/` 2518 + `hooks/` 427 + `scripts/` 1658），另有 `themes/` 下 39 个 SVG 资产 |

## 它解决什么问题

用户同时开着好几个 Claude Code 会话在跑任务，切窗口才知道哪个卡住、哪个在等确认。这个桌宠把「agent 现在在干什么」压缩成一个始终可见的小角色：思考时冒泡、干活时打字、失败时红叹号、跑完冲你笑一下。

不追求「好看的桌宠」，追求**数据链路先通**：一个 hook 进程把事件丢进本地 HTTP 端口，主进程算出一个「当前该显示什么」的状态，渲染层按状态播对应帧。

S5 之后多了一条链路：Claude Code 要执行工具时，桌宠会弹出一张卡片问「这条命令放不放行」。**不点、关掉、退出、超时一律返回 204 不做决定**，自动回落到终端原生提示——这个默认值是整个 S5 最重要的设计。

S6 把隐藏状态摊开了：状态机里一直有一张多会话仲裁表，但用户只看到桌宠演「最吵的那一条」。双击桌宠弹出看板，能看到每条会话各自在干什么、闲了多久、在哪个项目里。

S7 把形象从代码里搬了出来：`themes/<id>/` 下放 `theme.json` 和一堆 SVG，双击看板底部就能换。**但换的必须是"能通过白名单的东西"**——这一步的难点不是加载文件，是决定"第三方文件里哪些标签允许进 DOM"。

## 阶段路线

| 阶段 | 内容 | 状态 | 安全状况 |
|---|---|---|---|
| S1 | 透明置顶窗口、无边框、点击穿透、主进程轮询光标实现拖拽 | 已完成 | 1 个 P3（置顶层级，已由锁屏/休眠隐藏缓解） |
| S2 | 本地 HTTP 接收器 + 单会话状态机（事件映射、优先级仲裁、oneshot 回落、闲置入睡） | 已完成 | 4 道锁 + 会话上限 + cwd 脱敏，0 遗留 |
| S3 | 渲染层：状态→帧序列、双图层交叉淡入、眼球追踪插值 | 已完成 | SVG 白名单就位，S7 接外部主题前必须回归 |
| S4 | 接真 hook：解析 stdin JSON、往 `~/.claude/settings.json` 增量合并 8 个观察型事件 | 已完成 | 补了预判漏项：观察型 hook 必须 `async` |
| S5 | 权限气泡：`type:"http"` 阻塞回包，让桌宠替用户批准确认 | 已完成 | 五条要求全部落地；`/permission` 不校 token 是架构固有属性 |
| S6 | 多会话看板：双击桌宠弹出窗口，把内存里那张仲裁表摊开成人能看的列表 | 已完成 | SEC-09 分层兑现：存储层留完整路径、快照层只出 basename、完整路径只在显式点击时单条释放 |
| S7 | 主题系统：`themes/<id>/theme.json` + `assets/*.svg`，**删掉写死的 `visuals.js`** | 已完成 | 白名单先于加载器；放行 3 个标签 + 9 个图元，拒 5 类；校验分主进程（文件/格式）与渲染层（内容）两段 |

安全问题全部记录在 [SECURITY.md](./SECURITY.md)，每阶段开工前先看对应小节。

## 核心模块

| 模块 | 职责 | 关键文件 |
|---|---|---|
| 窗口与进程 | 创建透明置顶窗口、拖拽轮询、眼球追踪采样、气泡窗口生命周期 | `src/main.js` |
| 事件接入 | 本地 HTTP 服务，`GET /health`、`GET /state`、`POST /state`、`POST /permission` | `src/server.js` |
| 状态机 | 事件→状态映射、多会话优先级仲裁、oneshot 自动回落、25s 发呆 / 60s 入睡 | `src/state.js` |
| 权限裁决 | 挂起请求、等待决定、唯一出口 `settle()` 保证恰好响应一次 | `src/permission.js` |
| 权限气泡 | 卡片 UI、两个按钮、Esc 不表态、量高度回传 | `src/bubble.html` + `bubble-renderer.js` + `bubble-preload.js` |
| 会话看板 | 独立窗口、双击开关、1s 轮询快照、按「最吵的排前面」排序、演示模式、复制路径 | `src/dashboard.html` + `dashboard-renderer.js` + `dashboard-preload.js` |
| 渲染 | 双图层交叉淡入、帧轮播、瞳孔位移插值、SVG 白名单清洗 | `src/renderer.js` |
| 主题 | 扫目录、校验 schema 与资产、缺状态补齐、全坏兜底（主进程）；换主题 = 换帧数据 + 重画 | `src/theme.js` + `themes/<id>/theme.json` |
| 进程间桥 | 只暴露具体动作，不泄漏 `ipcRenderer` | `src/preload.js`（主窗口 9 个）+ `src/dashboard-preload.js`（看板 5 个）|
| 调试 | 假数据源，三种用法（完整剧本 / 单事件 / 保持某状态）；形象对照截图；主题打包 | `scripts/fake-feed.js`、`preview-shot.js`、`build-preview-bundle.js` |
| 回归闸门 | 主进程 inspector + 渲染进程 CDP，92 项断言 | `scripts/verify-electron.js` |

## 已知限制

- **真实 agent 会话一次都没跑过**（本机无 `claude` CLI，WorkBuddy/CodeBuddy 也没实测过 hook 是否真触发），这是贯穿 S4/S5/S6 的最大缺口
- 事件名以 Claude Code 为基准；`hooks/install.js` 已能装到 CodeBuddy / WorkBuddy，但**WorkBuddy 是否支持 hooks 未经证实**（官方文档无 hooks 章节，装的是按 CodeBuddy 契约推的）
- 会话只存内存 `Map`，没有持久化与掉电恢复
- 每 250ms 统一 tick，不是事件驱动定时器
- 看板 1s 轮询，不是推送——`idleMs` 天然随时间变，这是故意的取舍
- 权限请求只存内存，没有决策历史与审计日志
- 气泡只支持鼠标点 + Esc，没有键盘 Tab/Enter；看板也没有键盘导航，也没有远程审批
- **不能和主仓库 `clawd-on-desk` 同时运行**：都用 23333，且 hook URL 是安装时写死的
- 命中判定用 `#pet` 的 176×176 包围盒，不是真实 alpha 遮罩——四个角上的透明区会误判为「可点击」
- 看板的「复制路径」在回归里验的是返回值 + 剪贴板内容（实测能拿到完整路径）；但**环境不具备时**（某些会话读不到剪贴板）会降级成一条警告，不做假断言
- 看板不能跳转终端——`fullCwd()` 已经留好了，只是没做动作按钮
- **主题只支持 SVG**。GIF / APNG / WebP 要写图片解码器，没做（主仓库有，用的是动画解码 + 资产缓存）
- **主题不能用 `<style>` 做 CSS 动画**，只能靠帧序列。这是刻意让渡：`<style>` 里能写 `@import`、能覆盖整页
- 状态时长（25s 发呆 / 60s 入睡）仍写死在 `state.js`，没进 `theme.json`
- 没有在线主题目录，主题只能手工放进 `themes/`。换来的是供应链攻击面为零

## 硬约束（改代码前先看）

1. **`preload.js` / `bubble-preload.js` 只暴露动作，不暴露 `ipcRenderer`**——这是 Electron 的安全边界，加功能时最容易顺手破坏。
2. **状态名必须存在于 `VISUAL_STATES`**，渲染层靠白名单挡住任意字符串进 DOM。
3. **`transparent: true` 必须同时给 `backgroundColor: '#00000000'` 和 `hasShadow: false`**，缺一个就露底色。
4. 环境里若有 `ELECTRON_RUN_AS_NODE=1`，`electron .` 会退化成纯 Node，表现为 `require('electron')` 返回字符串。启动前 `env -u ELECTRON_RUN_AS_NODE npm start`。
5. **权限的所有结局必须走 `settle()`**——任何绕开它直接写 `res` 的分支都会破坏「恰好响应一次」。
6. **`/permission` 不能加 token 校验**，加了气泡就永远不出现（调用方 Claude Code 读不到端点文件）。
7. **观察型 hook `async: true`，裁决型 hook 绝不写 `async`**——两者语义相反，不要统一。
8. **一帧 SVG 里只允许存在一个 `<g class="pupils">`**。渲染层是 `querySelector(...).setAttribute()`，它只改第一个匹配，所以两只眼的瞳孔必须收在同一个组里——各包一层就会出现「只有一只眼跟着你转」。这条 bug 真发生过，回归里有永久断言。
9. **`dashboard-preload.js` 不许加「取完整 cwd」的接口**。完整路径只能在用户显式点「复制路径」时由主进程单条释放（SEC-09 分层）。快照层永远只出 basename。
10. **主题的白名单顺序不许反**：先定 `ALLOWED_TAGS`，再写加载器。反过来写，等主题加载不出来时才放宽白名单，动机就变成"让它能跑"而不是"这样安全"。
11. **`url()` 目标校验只能收紧不能放松**。放行 `filter` / `clip-path` / `mask` 之后，这条是唯一的出口管控——它们的值天生就是 `url()`。任何"顺手也允许相对路径"的改动，等于把主题变成 SSRF 探针。
12. **主题必须在 `createWindow()` 之前定好**。渲染层一加载就 `invoke("theme:get")`，晚一步第一帧就是空白——而桌宠没有任务栏入口，空白窗口用户不知道怎么关。
