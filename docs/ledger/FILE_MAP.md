# 文件地图 — clawd-starter

> 16 个源文件（12 个 `src/` + 2 个 `hooks/` + 2 个 `scripts/`）全部通读过，职责为实际行为，不是从文件名推测。
> 配了巡检脚本 `node docs/ledger/scripts/check-filemap.js`，可发现「代码里有、台账没记」的文件；它只报告，不改本文件。

## 目录结构

```text
clawd-starter/
├── src/                 Electron 主进程 + 预加载 + 渲染层（全部核心代码）
├── hooks/               Claude Code hook 适配器 + 安装脚本（S4）
├── scripts/             调试工具
├── docs/ledger/         开发台账（本项目文档）
├── preview.html         静态预览页，浏览器直接打开
├── README.md            项目说明与踩坑
├── package.json         依赖（只有 electron）
└── （无运行时文件落盘）
```

> 端点文件已从项目根目录迁到 userData：`%APPDATA%\clawd-starter\clawd-starter.port`（JSON：`{port, token}`）。见 SECURITY.md SEC-02 / SEC-10。

## 源文件职责

| 文件 | 阶段 | 职责 | 备注 |
|---|---|---|---|
| `src/main.js` | S1 / S5 | Electron 主进程：单实例锁、建透明置顶窗口、绑定拖拽与点击穿透 IPC、100ms 采样全局光标算 gaze、锁屏/休眠隐藏窗口、退出时清理；S5 起再管气泡窗口（懒创建 / 定位 / 握手 / 高度回传） | 319 行。三个窗口参数 + `powerMonitor` + **`bubble:ready` 握手**是关键 |
| `src/permission.js` | S5 | 权限裁决台：`POST /permission` 进来后挂起响应，所有结局（allow / deny / 超时 / 关闭 / 退出 / 对端断开）收敛到唯一出口 `settle()`，保证恰好响应一次；入参全限长 | 134 行。三条红线写在文件头：不做决定就 204、不二次响应、只认 allow/deny |
| `src/bubble.html` | S5 | 气泡页面：CSP `default-src 'none'`、圆角卡片、工具名 / 命令 / 来源三行、两个按钮、回落说明 | 「允许」故意不做成主色——防止养成盲批习惯 |
| `src/bubble-renderer.js` | S5 | 气泡渲染层：`textContent` 写入（命令是 agent 给的字符串，绝不当 HTML 解析）、点完立刻置灰防连点、**每次 render 先恢复按钮可用**、量高度回传主进程、Esc = 不表态 | 74 行。恢复正常按钮那两行是修 bug 加的，别删 |
| `src/bubble-preload.js` | S5 | 气泡的上下文桥：只暴露 `onRequest / decide / setHeight / ready` 四个动作 | `ready()` 是握手信号，顺序必须在 `onRequest` 之后 |
| `src/server.js` | S2 / S5 | 本地 HTTP 服务：`/state` 与 `/health` 走四道锁（Host / Origin / Token / Content-Type）；`/permission` **不校 token**（调用方是 Claude Code，带不上）但过 Host / Origin / Content-Type 三道 | `/permission` 比 `/state` 更开放，这是 HTTP hook 架构的固有属性，见 SECURITY.md |
| `src/port-file.js` | S2 | 端点文件唯一真相：按平台算 userData 路径、写 `{port, token}`（0600）、读回并校验格式 | 59 行。`fake-feed.js` 与主进程共用，避免两边路径漂移 |
| `src/state.js` | S2 | 状态机心脏：`EVENT_STATE` 事件映射、`PRIORITY` 优先级仲裁、oneshot 定时回落、25s 发呆 / 60s 入睡、250ms 统一 tick；入参清洗（session_id 64 字符、会话上限 100、cwd 只留 basename） | 196 行。原项目 4098 行里抽出的骨架 |
| `src/renderer.js` | S3 | 渲染层：SVG 白名单清洗（`DOMParser`，剥 `on*`/外部 href/`javascript:`）、状态切换重建 DOM、双图层交叉淡入、按 fps 切帧、瞳孔位移插值、命中判定切穿透 | 219 行。`window.petDebug` 调试入口（含 `svg()` 试清洗、`state()` 查当前状态） |
| `src/visuals.js` | S3 | 视觉数据：**布偶猫**形象，7 个状态共 19 帧的 SVG 帧序列、fps、眼球可动标记；`ragdoll()` 一个函数带全部参数（eyes/fur/point/tail/puff/blush），overlay 挂件（思考气泡/火花/闪光/铃铛/zzz）与形象解耦 | 334 行。换形象必须守住 4 条契约，见文件头注释 |
| `src/preload.js` | S1 | 上下文桥：向渲染层暴露 6 个动作（onState / onGaze / dragStart / dragEnd / setIgnoreMouse / quit） | 13 行。安全边界，不要加 `ipcRenderer` |
| `src/index.html` | S1 | 窗口页面：CSP meta、透明背景样式、双图层容器、加载 visuals.js 与 renderer.js | 88 行。CSP 为 `default-src 'none'` + 白名单 |
| `scripts/fake-feed.js` | S2 | 假数据源：从端点文件读 port+token 后 POST 事件，支持完整剧本 / 单事件 / `--hold` 保持状态 | S4 之后只用于离线调试，真事件由 hook 送 |
| `scripts/verify-electron.js` | S4-前 / S5 | 回归闸门：同时开主进程 inspector(9229) 与渲染进程 CDP(9222)，跑 **55 项断言**——窗口属性、透明、IPC 接线、DOM、帧轮播、gaze、HTTP 四道锁、权限六段（拒绝/允许/超时/跨源/非 JSON/坏 body）、单实例锁、退出收尾、端点清理 | 零第三方依赖（用 Node 内置 `WebSocket`）。`npm run verify:electron`。**主进程 inspector 连上后必须先发 `Runtime.enable`**，否则 evaluate 永远不回显 |
| `hooks/clawd-hook.js` | S4 | Claude Code hook 适配器：读端点文件 → 读 stdin（2s 硬超时 / 1MB 上限）→ 只取 `session_id/event/cwd/tool_name` → POST（1.5s 超时）→ 永远 `exit(0)` | 111 行。三条铁律：不阻塞、不打日志、不抛异常。桌宠没开就走 `readPortFile` 的 catch 直接返回 |
| `hooks/install.js` | S4 / S5 | 多 agent 安装器。`AGENTS` 表驱动 `--agent claude\|codebuddy\|workbuddy`，往对应 `settings.json` 的 `hooks` 段增量合并：观察型 command hook（按 agent 决定是否写 `async: true, timeout: 5`）+ 权限条目（只有 `permission: "http"` 的 agent 才装；WorkBuddy 原生处理权限，装的是死配置）。marker 只认自己的条目，备份 + 临时文件 rename 原子写，支持 `--uninstall` / `--dry-run` / `--file` | 观察型 hook 不能拖住 agent，权限 hook 反过来必须拖住——**两种语义相反，不要统一** |

## 其他文件

| 文件 | 职责 | 备注 |
|---|---|---|
| `preview.html` | 静态预览页，浏览器打开可一次看完所有状态的 SVG 与帧序列 | 不参与运行，纯设计对照用 |
| `docs/ragdoll-states.png` | 布偶猫七状态预览截图，用于设计留档与"改坏了没"的目视对照 | 2026-10-27 形象改造时截的 |
| `README.md` | 项目说明、已验证能力清单、故意的简化对照表、3 条踩坑记录 | 踩坑部分是同类项目最有价值的参考 |
| `package.json` | 只有 `electron ~45.0.0` 一个依赖，`npm start` → `electron .` | 用 `~` 不用 `^`：补丁自动进（安全修复），minor 要人过一遍再升 |
| `package-lock.json` | 依赖锁定，实际安装 45.0.0 | `~45.0.0` 允许 45.0.x 补丁，挡住 45.1+ |
| 端点文件 | 运行时产物，**不在项目内**：`%APPDATA%\clawd-starter\clawd-starter.port` | 内容 `{port, token}`，权限 0600；删除后重启即重新生成 |
| `.gitignore` | 忽略 node_modules / .clawd-port / dist / .idea / `NVIDIA Corporation/` | 最后一项是显卡驱动按 CWD 写的着色器日志，启动 Electron 时会出现 |
| `docs/ledger/*` | 开发台账：PROJECT / PROGRESS / SECURITY / FILE_MAP / DEVLOG | 本目录 |

## 数据流

```text
Claude Code 事件
        │  spawn: node hooks/clawd-hook.js <Event>   （async，不等它退出）
        ▼
  clawd-hook.js：读端点文件 → 读 stdin → 只挑 4 个字段
        │  POST http://127.0.0.1:<port>/state  {session_id, event, cwd, tool_name}
        ▼
   server.js ──► state.js（事件→状态→优先级仲裁→oneshot 回落）
                        │ onChange（visual 变了才发）
                        ▼
                  main.js broadcast
                        │ IPC "state"
                        ▼
                  renderer.js setState ──► visuals.js 取帧序列 ──► SVG 上屏

  主进程 100ms 采样光标 ──IPC "gaze"──► renderer.js 插值 ──► 瞳孔 transform
```

权限链路是**另一条独立的流**，和上面的事件流不共用通道：

```text
Claude Code 要执行工具
        │  type:"http" hook，直接 POST（阻塞，timeout 600s）
        ▼
   server.js  /permission（Host / Origin / Content-Type 三道，不校 token）
        │  交给 permission.js 挂起，HTTP 响应先不回
        ▼
   permission.js create() ──onRequest──► main.js showBubble()
                                              │ 懒创建气泡窗口 + 等 bubble:ready 握手
                                              ▼
                                    bubble-renderer.js render()
                                              │ 用户点「允许」/「拒绝」/ 按 Esc
                                              ▼
                                    IPC "permission:decide"
                                              ▼
                                    permission.js settle()  ← 唯一出口
                                              │ 200 allow / 200 deny / 204 不表态
                                              ▼
                                      响应写回那个还挂着的 socket
```

三条会走到 `settle()` 的非 UI 路径，同样收在 204：超时（默认 120s，比 hook 的 600s 早得多）、
用户关掉气泡、进程 `before-quit`（`dispose()`）。最后一条尤其重要——不然用户关桌宠时
Claude Code 会一直等到 hook 超时。详见 `SECURITY.md`「退出时必须给挂起的请求一个答复」。

> 桌宠没开时：`readPortFile()` 抛错 → hook 在 catch 里直接返回 → `exit(0)`，无输出、无重试。
> 端点文件残留但进程已死（崩溃场景）：POST 得到 `ECONNREFUSED` → `.catch(() => null)` → `exit(0)`。实测 241ms。
