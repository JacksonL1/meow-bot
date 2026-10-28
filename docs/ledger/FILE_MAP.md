# 文件地图 — clawd-starter

> 22 个源文件（15 个 `src/` + 2 个 `hooks/` + 5 个 `scripts/`）全部通读过，职责为实际行为，不是从文件名推测。
> 配了巡检脚本 `node docs/ledger/scripts/check-filemap.js`，可发现「代码里有、台账没记」的文件；它只报告，不改本文件。

## 目录结构

```text
clawd-starter/
├── src/                 Electron 主进程 + 预加载 + 渲染层（全部核心代码）
│                        三个窗口：桌宠（index.html）/ 权限气泡（bubble.html）/ 会话看板（dashboard.html）
├── themes/              主题包：<id>/theme.json + assets/*.svg（S7）
├── hooks/               agent hook 适配器 + 安装脚本（S4 / S5）
├── scripts/             调试工具 + 回归闸门 + 截图 + 主题打包/迁移
├── docs/ledger/         开发台账（本项目文档）
├── preview.html         静态预览页，浏览器直接打开
├── preview-bundle.js    由 themes/ 生成，只给预览页吃
├── README.md            项目说明与踩坑
├── package.json         依赖（只有 electron）
└── （无运行时文件落盘）
```

> 端点文件已从项目根目录迁到 userData：`%APPDATA%\clawd-starter\clawd-starter.port`（JSON：`{port, token}`）。见 SECURITY.md SEC-02 / SEC-10。

## 源文件职责

| 文件 | 阶段 | 职责 | 备注 |
|---|---|---|---|
| `src/main.js` | S1 / S5 / S6 / S7 | Electron 主进程：单实例锁、建透明置顶窗口、绑定拖拽与点击穿透 IPC、100ms 采样全局光标算 gaze、锁屏/休眠隐藏窗口、退出时清理；S5 起再管气泡窗口（懒创建 / 定位 / 握手 / 高度回传）；S6 再管看板窗口（懒创建 / toggle / 贴着桌宠定位）与 `dashboard:snapshot` / `dashboard:copy-path`；S7 在建窗口**之前**先定主题，并接 `theme:get` / `theme:list` / `theme:set` 三个 IPC | 486 行。三个窗口参数刻意不同 + `powerMonitor` + **`bubble:ready` 握手** + **主题必须先于 createWindow**（渲染层一加载就来拉） |
| `src/permission.js` | S5 | 权限裁决台：`POST /permission` 进来后挂起响应，所有结局（allow / deny / 超时 / 关闭 / 退出 / 对端断开）收敛到唯一出口 `settle()`，保证恰好响应一次；入参全限长 | 134 行。三条红线写在文件头：不做决定就 204、不二次响应、只认 allow/deny |
| `src/bubble.html` | S5 | 气泡页面：CSP `default-src 'none'`、圆角卡片、工具名 / 命令 / 来源三行、两个按钮、回落说明 | 「允许」故意不做成主色——防止养成盲批习惯 |
| `src/bubble-renderer.js` | S5 | 气泡渲染层：`textContent` 写入（命令是 agent 给的字符串，绝不当 HTML 解析）、点完立刻置灰防连点、**每次 render 先恢复按钮可用**、量高度回传主进程、Esc = 不表态 | 74 行。恢复正常按钮那两行是修 bug 加的，别删 |
| `src/bubble-preload.js` | S5 | 气泡的上下文桥：只暴露 `onRequest / decide / setHeight / ready` 四个动作 | `ready()` 是握手信号，顺序必须在 `onRequest` 之后 |
| `src/dashboard.html` | S6 | 会话看板页面：浅色卡片列表，每行 = 状态徽标 + 目录名 + 会话 id 前 12 位 + 闲置时长 + 「复制路径」按钮；顶部计数与「演示模式」开关；空状态提示 | 222 行。CSP 与主窗口同款 `default-src 'none'`。`.dominant` 用左侧色条标出「桌宠此刻正在演的那条」 |
| `src/dashboard-renderer.js` | S6 | 看板渲染层：1s 轮询快照、按「最吵的排前面」稳定排序（error → … → sleeping，同级按闲置升序）、行节点复用 + `insertBefore` 调序（避免每秒重建导致闪烁和按钮失焦）、演示模式、`fmtIdle()` 人话时长 | 156 行。所有外部字符串一律 `textContent`；演示模式**只掩盖显示**，数据照旧 |
| `src/dashboard-preload.js` | S6 | 看板的上下文桥：只暴露 `getSnapshot` / `copyPath` 两个动作 | 18 行。**故意没有「取完整 cwd」的接口**——完整路径只能由主进程在用户显式点击时单条塞进剪贴板（SEC-09 分层） |
| `src/server.js` | S2 / S5 | 本地 HTTP 服务：`/state` 与 `/health` 走四道锁（Host / Origin / Token / Content-Type）；`/permission` **不校 token**（调用方是 Claude Code，带不上）但过 Host / Origin / Content-Type 三道 | `/permission` 比 `/state` 更开放，这是 HTTP hook 架构的固有属性，见 SECURITY.md |
| `src/port-file.js` | S2 | 端点文件唯一真相：按平台算 userData 路径、写 `{port, token}`（0600）、读回并校验格式 | 59 行。`fake-feed.js` 与主进程共用，避免两边路径漂移 |
| `src/state.js` | S2 / S6 | 状态机心脏：`EVENT_STATE` 事件映射、`PRIORITY` 优先级仲裁、oneshot 定时回落、60s 入睡、250ms 统一 tick；**时长可由 `theme.json.timings` 覆盖**（`createStore({ getTimings })` 收 getter——主进程里 store 先建、主题后解析，传值会永远是 null）；入参清洗（session_id 64 字符、会话上限 100）。**SEC-09 两层在这里分开**：`sanitizeCwd()` 存完整路径（限 1024），`publicCwd()` 只出最后一段目录名（限 200）；`snapshot()` 用后者，`fullCwd(id)` 是完整路径的唯一读口 | 252 行。原项目 4098 行里抽出的骨架。**只留 basename 会顺手砍掉 S6 的「复制路径」——那不是修复，是砍功能** |
| `src/renderer.js` | S3 / S6 / S7 | 渲染层，**两条路径**：① **骨骼弹簧**（`rigType: ragdoll-spring-v2`）——JS 直接拼一只猫（SVG 模板 + 状态姿势表 + `SpringChannel` 二阶弹簧通道），状态切换靠过冲与滞后跟随而非交叉淡入；working 自带桌面场景（键盘 + 编辑器窗口 + 代码行生长）。② **帧序列**——双图层交叉淡入、按 fps 轮播、瞳孔位移插值。两条都经过 `svgNode()`（`DOMParser` + `ALLOWED_TAGS` + `url()` 出口管控 + `stdDeviation` 钳制）——**骨骼模板本身也走这条路**，不再用 `innerHTML`；`eyeTracking` / `gaze` 统一在分支**之前**算一次 `track` | **1331 行**。`window.petDebug` 有 `setState` / `svg` / `gaze`+`unpinGaze` / `springs` / `eyeTracking` / `states` / `state` / `theme` / `timings` / `desk` / `builds` / `stateLog` 十二个排查入口——**它同时是回归唯一能看到内部状态的窗口，不是便利工具**，而且每个出口都得有一条断言证明它自己有货（`springs()` 曾经因为读了不存在的字段而永远返回 `{}`）。`window.VISUAL_STATES` 是「给外面看进来的」主题镜像，由 `adoptTheme()` 单点维护 |
| `src/theme.js` | S7 | 主题加载器（主进程）：扫 `themes/`、校验 `theme.json`（schemaVersion / 状态名 / fps 范围）、校验资产名与真实路径、限长限量、缺状态用 idle 补齐、全坏时给内置兜底。**只做文件与格式校验，不做内容清洗**（清洗需要 DOM，在渲染层）。透传 `rigType`（渲染分支的选择来自主题声明，不靠 id/name 嗅探）；不认识的状态名收进 `warnings` 而不是静默丢弃 | **436 行**。新增 `timings` 归一化（oneshot 三时长 + sleepAfterMs）：只认 `error`/`notification`/`attention`，**主题没写就返回 `null`**（默认值的真相只在 `state.js` 有一份，这里不存第二份）；超界钳制并进 warnings，在 oneshot 里塞非 oneshot 状态会报「永不会生效」，`timings` 不是对象则整个主题拒绝。**`schemaVersion` 只认 1**——写 2 会被整体拒绝，这一版外部重写就是这么挂的。`motion` / `gags` 两套校验器（约 150 行）已删：消费者先没了，留着校验器等于「写对了也什么都不发生」 |
| `src/preload.js` | S1 / S6 / S7 | 主窗口上下文桥：向渲染层暴露 **9** 个动作（onState / onGaze / dragStart / dragEnd / setIgnoreMouse / toggleDashboard / getTheme / onTheme / quit） | 19 行。安全边界，不要加 `ipcRenderer`。动作数被回归钉死了（6 → 7 → 9），多一个少一个都会红 |
| `src/index.html` | S1 / S7 | 窗口页面：CSP meta、透明背景样式、双图层容器。**S7 起不再引 `visuals.js`**，只加载 `renderer.js`——帧数据走 IPC | 95 行。CSP 为 `default-src 'none'` + 白名单（曾被整块删过一次，见硬约束 20） |
| `scripts/fake-feed.js` | S2 | 假数据源：从端点文件读 port+token 后 POST 事件，支持完整剧本 / 单事件 / `--hold` 保持状态 | S4 之后只用于离线调试，真事件由 hook 送 |
| `scripts/verify-electron.js` | S4-前 / S5 / S6 / S7 | 回归闸门：同时开主进程 inspector(9229) 与渲染进程 CDP(9222)，跑 **112 条断言（当前 112 PASS / 0 FAIL）** ——窗口属性、透明、IPC 接线、DOM、帧轮播、gaze、瞳孔唯一性、`eyeTracking` 开关、HTTP 四道锁、权限六段、看板七段、SVG 白名单、主题加载与拒绝路径、单实例锁、退出收尾、端点清理。**两条渲染路径共用同一批断言**，开头读 `petDebug.theme().rig` 得到 `rigMode`，判据分叉：骨骼看不切图层 / 不重建 DOM / layerB 为空 / 眨眼看 opacity / 只有一组瞳孔 / 呼吸类 transform 每帧在变 / 键盘与编辑器窗口在、代码行在长；帧序列看淡入 / 逐帧替换 / 眼睛被压扁 / `VISUAL_STATES` 静态检查| 1505 行。零第三方依赖（用 Node 内置 `WebSocket`）。`npm run verify:electron`。坑：**主进程 inspector 连上后必须先发 `Runtime.enable`**、清理要 `taskkill /T /F` 杀进程树、要用 `--user-data-dir` 自隔离、**动手改状态前要等启动推送静默**、**页面内跑超过 5 秒的 eval 会被 CDP 超时静默吃掉**（采样必须 Node 侧逐次读）、**期望值别按字符串比**（`style.transform` 经 CSSOM 会把 `3.80px` 序列化成 `3.8px`）；另外它还把台账里的硬约束**变成真断言**（`src/` 下 `innerHTML` 出现 0 次）——约束不落到断言上等于没有|
| `scripts/generate-ragdoll-assets.js` | S7-后 | **一次性的素材生成器**，不是运行时依赖：把 25 张全身姿势帧（8 状态 × 1~4 帧）用参数化函数画出来，输出到 `themes/ragdoll/assets/`。这些帧在**弹簧渲染器下根本不被读取**（那一路是 JS 拼的），它们服务于①非骨骼路径的示例、②`preview:states` 静态对照图、③主题资产校验的存在性检查 | 222 行。**跑了会覆盖同名的 `-1.svg`**（手工调过的会被冲掉）——改帧前先备份，或者干脆别跑 |
| `scripts/preview-shot.js` | S3 / S7 | 把 `preview.html` 渲染成 `docs/<theme>-states.png`（七状态对照图），改完形象后用来目视确认「没改坏」。会先自动重建预览包，再按 `--theme=` 截对应主题；截图前**按 `scrollHeight` 撑开视口**（否则第二行永远被 640 视口切掉） | **249 行**，零第三方依赖。`finally` 里 `taskkill /T /F`——不然 GPU 子进程逃逸，下次启动报 `Unable to move the cache` |
| `scripts/build-preview-bundle.js` | S7 | 把 `themes/` 打成 `preview-bundle.js`。preview.html 是 `file://` 打开的静态页，`fetch` 读不到本地文件，只能打包 | 只给预览用；桌宠运行时不读它，所以包过期不会影响实际形象 |
| `scripts/migrate-visuals-to-theme.js` | S7 | **一次性**迁移脚本：把 `visuals.js` 里的帧字符串拆成 `themes/<id>/assets/*.svg` + `theme.json`。两个主题都是它跑出来的（ragdoll 取自 `src/visuals.js`，crab 取自 `git show 85c094a`） | 手抄 19 帧必然出错，且抄完没法证明"和原来一样"。**不要在日常流程里跑**，会覆盖手改过的主题 |
| `hooks/clawd-hook.js` | S4 | Claude Code hook 适配器：读端点文件 → 读 stdin（2s 硬超时 / 1MB 上限）→ 只取 `session_id/event/cwd/tool_name` → POST（1.5s 超时）→ 永远 `exit(0)` | 111 行。三条铁律：不阻塞、不打日志、不抛异常。桌宠没开就走 `readPortFile` 的 catch 直接返回 |
| `hooks/install.js` | S4 / S5 | 多 agent 安装器。`AGENTS` 表驱动 `--agent claude\|codebuddy\|workbuddy`，往对应 `settings.json` 的 `hooks` 段增量合并：观察型 command hook（按 agent 决定是否写 `async: true, timeout: 5`）+ 权限条目（只有 `permission: "http"` 的 agent 才装；WorkBuddy 原生处理权限，装的是死配置）。marker 只认自己的条目，备份 + 临时文件 rename 原子写，支持 `--uninstall` / `--dry-run` / `--file` | 观察型 hook 不能拖住 agent，权限 hook 反过来必须拖住——**两种语义相反，不要统一** |

## 其他文件

| 文件 | 职责 | 备注 |
|---|---|---|
| `preview.html` | 静态预览页，浏览器打开可一次看完某个主题所有状态的 SVG 与帧序列；顶部有主题下拉框，支持 `?theme=crab` | 不参与运行，纯设计对照用 |
| `preview-bundle.js` | `themes/` 的打包产物（约 125KB），由 `npm run build:preview` 生成。preview.html 通过它读数据 | 生成物，**不要手改**；它过期只影响预览，不影响桌宠 |
| `themes/**` | 主题资产：`<id>/theme.json` + `<id>/assets/*.svg`。现有 `ragdoll`（默认，写了 `timings`）、`crab`（**故意不写 `timings`**，是回归里「用内置默认」的对照组）、`_template`（下划线开头 = 不参与主题列表） | 整目录登记，不逐帧列。契约与字段说明见 `themes/README.md` |
| `docs/ragdoll-states.png` / `docs/crab-states.png` | 两套主题的七状态对照图，用于设计留档与"改坏了没"的目视对照 | `npm run preview:states` / `node scripts/preview-shot.js --theme=crab` |
| `README.md` | 项目说明、已验证能力清单、故意的简化对照表、12 条踩坑记录 | 踩坑部分是同类项目最有价值的参考 |
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

看板是**第三条流**，方向和其他两条相反——是渲染进程主动来要，不是推：
```text
用户双击桌宠（renderer 认落在 #pet 上的 dblclick）
        │  IPC "dashboard:toggle"
        ▼
   main.js toggleDashboard()：懒创建窗口 / 已可见则 hide
        │  贴着桌宠定位，上方放不下就翻到下方
        ▼
   dashboard-renderer.js  setInterval(tick, 1000)
        │  invoke "dashboard:snapshot"
        ▼
   state.js snapshot()   ← SEC-09 快照层：cwd 只是 basename
        │  排序（error 优先）→ 复用行节点 → insertBefore 调序
        ▼
   看板 DOM

  用户点某行「复制路径」
        │  invoke "dashboard:copy-path", id
        ▼
   main.js：store.fullCwd(id)（存储层，完整路径）→ clipboard.writeText
            伪造 id 拿到 undefined → 返回 false，什么都不写
```

为什么要轮询而不是推送：`idleMs` 本来就随时间变，即使没人发事件也得刷新。推的话还要维护
一套「什么时候该推」，而轮询一个本地 IPC 的代价近似为零。

主题是**第四条流**，它在状态流之前发生，而且分成主进程/渲染层两段校验：

```text
启动
  │
  ▼
 theme.js resolveTheme()：环境变量 → 命令行 → 上次选的 → 内置默认(ragdoll)
  │  ① 只认 readdir 出来的真实目录名（外部传什么都不拼进路径）
  │  ② theme.json 字段校验（schemaVersion / 状态名 / fps 范围）
  │  ③ 资产名白名单正则 + 解析后仍在 assets/ 内（双保险防穿越）
  │  ④ 单文件 256KB / 主题 4MB / 单状态 12 帧
  ▼
 currentTheme（含全部帧字符串）──► createWindow()
                                       │
                    渲染层 getTheme() ◄─┘   （拉，不是推）
                                       │
                                       ▼
                    applyTheme()：换成新的帧数据，强制重画当前状态
                                       │
                                       ▼
                    sanitizeSvg()：② 内容闸门在渲染层
                       · 标签白名单
                       · on* / 非本地 href / javascript: 属性
                       · 任何非 url(#id) 的 url()
                       · stdDeviation 钳到 40
```

**为什么校验分两段**：主进程没有 DOM，做不了标签级清洗；渲染层不该碰文件系统。
两段串联，任一段单独失效都不至于直接变成 XSS。
**为什么主题是拉不是推**：S5 的第一个权限气泡就是「推早了被静默丢弃」，同一个坑不踩第二次。

> 桌宠没开时：`readPortFile()` 抛错 → hook 在 catch 里直接返回 → `exit(0)`，无输出、无重试。
> 端点文件残留但进程已死（崩溃场景）：POST 得到 `ECONNREFUSED` → `.catch(() => null)` → `exit(0)`。实测 241ms。
