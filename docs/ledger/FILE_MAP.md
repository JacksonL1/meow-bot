# 文件地图 — clawd-starter

> **21 个源文件 / 7185 行**（`src/` 15 个 = 12 个 `.js` 3635 行 + 3 个 `.html` 497 行；`hooks/` 2 个 528 行；`scripts/` 4 个 2557 行）全部通读过，职责为实际行为，不是从文件名推测。
> 实测 **2026-10-30 15:20**。这行数字被改过五次，五次里有四次不是代码变了、是**数法**变了：
> 最早写「25 个（19+2+4）」，后来有人只数 `src/*.js` 得到 15，再后来又忘了 `src/` 下还有 `.html`。
> 所以现在**连扩展名和行数一起写**——只写一个总数，下次读的人没法判断它过期多久，也没法复查。
> 上一版（10-30 上午）是 25 个 / 8309 行，差的 4 个文件 / 1390 行是信箱整套删掉的（见 DEVLOG 10-30）。
> 配了巡检脚本 `node docs/ledger/scripts/check-filemap.js`，可发现「代码里有、台账没记」的文件；它只报告，不改本文件。

## 目录结构

```text
clawd-starter/
├── src/                 Electron 主进程 + 预加载 + 渲染层（全部核心代码）
│                        三个窗口：桌宠（index.html）/ 权限气泡（bubble.html）/
│                                  会话看板（dashboard.html）
├── themes/              主题包：<id>/theme.json + assets/*.svg（S7）
├── hooks/               agent hook 适配器 + 安装脚本（S4 / S5）
├── scripts/             调试工具 + 回归闸门 + 截图 + 主题打包
├── docs/ledger/         开发台账（本项目文档）
├── preview.html         静态预览页，浏览器直接打开
├── preview-bundle.js    由 themes/ 生成，只给预览页吃
├── README.md            项目说明与踩坑
├── package.json         依赖（只有 electron）
└── （无运行时文件落盘）
```

> 端点文件已从项目根目录迁到 userData：`%APPDATA%\clawd-starter\clawd-starter.port`（JSON：`{port, token}`）。见 SECURITY.md SEC-02 / SEC-10。
> **这就是全部落盘内容**——S8 曾经往同目录的 `mailbox/` 写信，2026-10-30 整套删掉了，所以现在**没有任何用户内容会落盘**（见 DEVLOG 10-30）。

## 源文件职责

| 文件 | 阶段 | 职责 | 备注 |
|---|---|---|---|
| `src/main.js` | S1 / S5 / S6 / S7 / S9 | Electron 主进程：单实例锁、建透明置顶窗口、绑定拖拽与点击穿透 IPC、100ms 采样全局光标算 gaze、锁屏/休眠隐藏窗口、退出时清理；S5 起再管气泡窗口（懒创建 / 定位 / 握手 / 高度回传）；S6 再管看板窗口（懒创建 / toggle / 贴着桌宠定位）与 `dashboard:snapshot` / `dashboard:copy-path`；S7 在建窗口**之前**先定主题，并接 `theme:get` / `theme:list` / `theme:set` 三个 IPC；S8 起管右键菜单（**看板 / 退出** 两项）与 `pet:menu`；S9 接 `pet:hover` → `store.wake()` | **514 行**。三个窗口参数刻意不同 + `powerMonitor` + **`bubble:ready` 握手** + **主题必须先于 createWindow**（渲染层一加载就来拉）。S8 留下的一条：右键原来是**直接退出**，桌宠没标题栏也不进任务栏，"怎么关掉它"唯一能试的动作就是右键——改成菜单之后才有确认这一步。S9 只加一条只有一个消费者的通道：`pet:hover` 无载荷、只调 `store.wake()`，**改状态的权力仍留在主进程**。2026-10-30 信箱整套删掉后：窗口从 4 个回到 3 个、`hideAll()` 少收一个、`store` 从模块级 `let` 退回 `whenReady` 里的 `const`（它当初被提出来是为了给诊断包读 `store.snapshot()`，消费者没了就该退回） |
| `src/permission.js` | S5 | 权限裁决台：`POST /permission` 进来后挂起响应，所有结局（allow / deny / 超时 / 关闭 / 退出 / 对端断开）收敛到唯一出口 `settle()`，保证恰好响应一次；入参全限长 | 134 行。三条红线写在文件头：不做决定就 204、不二次响应、只认 allow/deny |
| `src/bubble.html` | S5 | 气泡页面：CSP `default-src 'none'`、圆角卡片、工具名 / 命令 / 来源三行、两个按钮、回落说明 | 「允许」故意不做成主色——防止养成盲批习惯 |
| `src/bubble-renderer.js` | S5 | 气泡渲染层：`textContent` 写入（命令是 agent 给的字符串，绝不当 HTML 解析）、点完立刻置灰防连点、**每次 render 先恢复按钮可用**、量高度回传主进程、Esc = 不表态 | 74 行。恢复正常按钮那两行是修 bug 加的，别删 |
| `src/bubble-preload.js` | S5 | 气泡的上下文桥：只暴露 `onRequest / decide / setHeight / ready` 四个动作 | `ready()` 是握手信号，顺序必须在 `onRequest` 之后 |
| `src/dashboard.html` | S6 | 会话看板页面：浅色卡片列表，每行 = 状态徽标 + 目录名 + 会话 id 前 12 位 + 闲置时长 + 「复制路径」按钮；顶部计数与「演示模式」开关；空状态提示 | **237 行**。CSP 与主窗口同款 `default-src 'none'`。`.dominant` 用左侧色条标出「桌宠此刻正在演的那条」 |
| `src/dashboard-renderer.js` | S6 | 看板渲染层：1s 轮询快照、按「最吵的排前面」稳定排序（error → … → sleeping，同级按闲置升序）、行节点复用 + `insertBefore` 调序（避免每秒重建导致闪烁和按钮失焦）、演示模式、`fmtIdle()` 人话时长。**2026-10-30 一行从 2 行变 3 行**：标题（最重的位置）／目录／`sid` + 工具名；没拿到标题的行加 `.untitled` 退回两行——**不给它留空的第三行**，那会让每条都多出一段死高度，看着像"还没加载出来" | **229 行**。所有外部字符串一律 `textContent`；演示模式**只掩盖显示**，数据照旧。**演示模式现在连标题一起藏**：标题是用户自己说的第一句话，里面出现客户名的概率比目录名还高 |
| `src/dashboard-preload.js` | S6 | 看板的上下文桥：只暴露 `getSnapshot` / `copyPath` 两个动作 | 18 行。**故意没有「取完整 cwd」的接口**——完整路径只能由主进程在用户显式点击时单条塞进剪贴板（SEC-09 分层） |
| `src/server.js` | S2 / S5 | 本地 HTTP 服务：`/state` 与 `/health` 走四道锁（Host / Origin / Token / Content-Type）；`/permission` **不校 token**（调用方是 Claude Code，带不上）但过 Host / Origin / Content-Type 三道 | `/permission` 比 `/state` 更开放，这是 HTTP hook 架构的固有属性，见 SECURITY.md |
| `src/port-file.js` | S2 | 端点文件唯一真相：按平台算 userData 路径、写 `{port, token}`（0600）、读回并校验格式 | **63 行**。`fake-feed.js` 与主进程共用，避免两边路径漂移 |
| `src/state.js` | S2 / S6 | 状态机心脏：**414 行**。`EVENT_STATE` 事件映射、`PRIORITY` 优先级仲裁、oneshot 定时回落、60s 入睡、250ms 统一 tick；**时长可由 `theme.json.timings` 覆盖**（`createStore({ getTimings })` 收 getter——主进程里 store 先建、主题后解析，传值会永远是 null）；入参清洗（session_id 64 字符、会话上限 100、标题 60、工具名 64）。**SEC-09 两层在这里分开**：`sanitizeCwd()` 存完整路径（限 1024），`publicCwd()` 只出最后一段目录名（限 200）；`snapshot()` 用后者，`fullCwd(id)` 是完整路径的唯一读口 |**2026-10-30：`notification` 的时长语义改了**——它不再是"播一次就走"的闪光，而是"agent 在等你点允许"的**持续状态**（主仓库叫 a real permission hold）。起因是用户在信里写的那句「需要我确认的时候，没有提示我啊」：内置 3200ms（ragdoll 主题还改成 1500ms）让提示闪一下就撤，人抬头看的时候屏幕上什么都没有。现在内置上限是 `NOTIFICATION_MAX_MS = 10 分钟`（对齐主仓库 Kimi 权限 hold 的兜底值），**真正的释放不靠这个计时器，靠下一个事件把它顶掉**；这个数只是"从此再没有事件"时的兜底，否则提示会永远挂着。配套地 `tick()` 的 oneshot 霸屏多了一个前提：**必须还有会话真的处在这个状态**（新增 `sessionsHave()`）——原来只判 `now < oneshot.until`，于是权限通过后 agent 继续干活（working）了，画面上猫还在喊，因为 until 没到。同一个 bug 在 800ms 的 attention 上只是偶尔闪错，在 10 分钟上就是"明明在干活、猫喊了整整十分钟"。**2026-10-29：`SessionStart` 改成"只给新会话定初值"，不许碰已存在的会话**——WorkBuddy 每一轮都会在 `UserPromptSubmit` 之后约 0.1 秒补发一个 `SessionStart`（首轮 source=startup，之后全是 resume），按普通映射（`SessionStart → idle`）处理的结果是把刚进入的 thinking 打回 idle，并且要一直挂到下一个事件才恢复。这段事实不是猜的，主仓库 `hooks/workbuddy-hook.js:264` 把它写在注释里，那里的解法是给 body 加 `preserve_state`；starter 这里直接在语义上修对——一条已经存在的会话收到"开始了"，本来就不该被清空。`how` 记成 `preserved`，排查时能在 `events()` 里一眼看出"它来了但没动手"。**睡着只看 idle 累计**（`stateSince`），不看多久没事件（`lastAt`）——一次跑 40 秒的构建期间没有事件，但 agent 在干活，那时候睡着是错的。另外 `snapshot().recent` 带出最近 30 条 agent 事件（含认不出来的），是排查"为什么变 idle"的唯一手段。**2026-10-30 会话多出两个字段**：`title`（粘的——后来的事件大多不带标题，只有真拿到了才写，否则每来一条 `PreToolUse` 就把好标题抹掉一次）与 `tool`（这一轮最后用到的工具，新一轮 `UserPromptSubmit` 时清掉，免得 thinking 阶段挂着上一轮的工具名）。`tool_name` **本来 hook 就一直在送，但加这两个字段之前它没有任何消费者**——既不存也不显示，等于一个"写对了也不会发生"的字段（硬约束 25）。S9 加了 `wake()`：**只有 sleeping → idle，其余状态一概不碰**（working / thinking 是 agent 的真实进展，鼠标不该改写），并且 `stateSince` 必须一起重置——不重置的话下一个 tick 立刻判定"又闲够了"，表现是碰一下就醒、随即又睡。原项目 4098 行里抽出的骨架。**只留 basename 会顺手砍掉 S6 的「复制路径」——那不是修复，是砍功能** |
| `src/renderer.js` | S3 / S6 / S7 / S9 | 渲染层，**两条路径**：① **骨骼弹簧**（`rigType: ragdoll-spring-v2`）——JS 直接拼一只猫（SVG 模板 + 状态姿势表 + `SpringChannel` 二阶弹簧通道），状态切换靠过冲与滞后跟随而非交叉淡入；working 自带桌面场景（键盘 + 编辑器窗口 + 代码行生长）。② **帧序列**——双图层交叉淡入、按 fps 轮播、瞳孔位移插值。两条都经过 `svgNode()`（`DOMParser` + `ALLOWED_TAGS` + `url()` 出口管控 + `stdDeviation` 钳制）——**骨骼模板本身也走这条路**，不再用 `innerHTML`；`eyeTracking` / `gaze` 统一在分支**之前**算一次 `track`。S8 接管两个手势：**双击 = 开关看板**、**右键 = 弹原生菜单**（原来是"右键直接退出"，没有确认）。2026-10-30 信箱删掉后双击从"写信"改回看板——**手势不能空着**：桌宠没有标题栏，双击是用户唯一能自己试出来的动作。S9 鼠标停在睡着的猫身上 → 发 `pet:hover` 请主进程唤醒（**自己不切画面**），并把睁眼做成弹簧 `eyeOpen` | **1449 行**。帧序列路径新增**表情变体**：一个状态可有多套资产，每次进入状态轮换一套（主资产先出）；`variantCursor` 存**当前选中**槽位——存"下一个"会让 `variant()` 比画面超前一格。`window.petDebug` 有 `setState` / `svg` / `gaze`+`unpinGaze` / `springs` / `eyeTracking` / `states` / `state` / `variant` / `timings` / `desk` / `builds` / `stateLog` / `events` / `wakeSends` / `eyeOpen` 十七个排查入口——**它同时是回归唯一能看到内部状态的窗口，不是便利工具**，而且每个出口都得有一条断言证明它自己有货（`springs()` 曾经因为读了不存在的字段而永远返回 `{}`）。`window.VISUAL_STATES` 是「给外面看进来的」主题镜像，由 `adoptTheme()` 单点维护。**不要改宠物状态来提示用户**：状态在主进程手里，渲染层改成 notification 会被下一个 250ms 的 tick 顶回去（S8 想用这招提示"信寄出了"，被顶回去两次才记下这条）。视觉微调两条（**2026-10-29**，S9 的次日，用户看完界面之后提的）：① 躯体是**手绘 path 不是椭圆**——正椭圆 rx54×ry32 + 头宽 104 + 体宽 108 = 雪人，而完美椭圆弧本身就是"圆"的来源；现在是肩 y112 宽 56（被头盖住）/ 腰 y146 最宽 100 / 底 y177 略平，动它要连看后爪（cx57/143 只露月牙）、前爪（cx68/132 在体内）、working 键盘（y162 起）。② 删掉 `#rig-torso-patch`（cx112 cy134 的米色椭圆）——没描边、比身体暗一档、位置偏右上，读起来就是肚子上的一块污渍。S9 三条：① 醒来的"慢慢"靠**两条曲线**——躯干/头/耳/尾的 28 个弹簧通道本来就有过冲和滞后；眼睛与头顶 zZz 共用 `eyeOpen`（0=闭 1=睁，临界阻尼 ≈0.5s），否则眼睛会"啪"一下睁开而 Z 还挂着；② 眨眼仍然**硬切**（150ms 的事，慢慢眨眼看起来像卡住），睡眠过渡才走弹簧。这两个刻意不一样；③ 胸口大毛领 `#rig-ruff` 2026-10-28 删了（只跟呼吸联动的装饰件，躯干本身仍在呼吸），**删部件要连校验探针一起改**：`verify` 里"每帧都在重算"的探针原本读它，不改就是读 `missing:rig-ruff` |
| `src/theme.js` | S7 | 主题加载器（主进程）：扫 `themes/`、校验 `theme.json`（schemaVersion / 状态名 / fps 范围）、校验资产名与真实路径、限长限量、缺状态用 idle 补齐、全坏时给内置兜底。**只做文件与格式校验，不做内容清洗**（清洗需要 DOM，在渲染层）。透传 `rigType`（渲染分支的选择来自主题声明，不靠 id/name 嗅探）；不认识的状态名收进 `warnings` 而不是静默丢弃 | **478 行**。两件：`timings` 归一化；以及 `variants`（每状态最多 4 套表情变体）——主资产和变体共用 `readSet()`，**规则必须同一份**，否则会分叉成"主资产钳了、变体没钳"，而那种 bug 只在换到第 2 套时才看得见。新增 `timings` 归一化（oneshot 三时长 + sleepAfterMs）：只认 `error`/`notification`/`attention`，**主题没写就返回 `null`**（默认值的真相只在 `state.js` 有一份，这里不存第二份）；超界钳制并进 warnings，在 oneshot 里塞非 oneshot 状态会报「永不会生效」，`timings` 不是对象则整个主题拒绝。**`schemaVersion` 只认 1**——写 2 会被整体拒绝，这一版外部重写就是这么挂的。`motion` / `gags` 两套校验器（约 150 行）已删：消费者先没了，留着校验器等于「写对了也什么都不发生」 |
| `src/preload.js` | S1 / S6 / S7 / S8 / S9 | 主窗口上下文桥：向渲染层暴露 **11** 个动作（onState / onGaze / dragStart / dragEnd / setIgnoreMouse / wake / quit / petMenu / toggleDashboard / getTheme / onTheme） | **24 行**。安全边界，不要加 `ipcRenderer`。动作数被回归钉死了（6 → 7 → 9 → 12 → 13 → **11**），多一个少一个都会红。**13 → 11 是 2026-10-30 信箱整套砍掉时删的**（`openLetter` / `onLetterSent`）——功能下线要连它开的口子一起收，留着一个没有消费者的动作就是安全隐患（硬约束 1）。`petMenu` 上来的是**原生菜单**，回归不能真弹（会阻塞主进程），所以只断言通道接了线。S9 的 `wake()` 是**请求**不是命令：它没有任何载荷，唯一效果是"请示主进程把睡着的会话叫醒" |
| `src/index.html` | S1 / S7 | 窗口页面：CSP meta、透明背景样式、双图层容器、`#hint` 提示条。**S7 起不再引 `visuals.js`**，只加载 `renderer.js`——帧数据走 IPC | **95 行**。CSP 为 `default-src 'none'` + 白名单（曾被整块删过一次，见硬约束 20）。`#hint` 默认文案 `body:hover` 才显形，现在是「拖动我 · 摸头撸猫 · 双击看板 · 右键菜单」——**它把可用手势都写出来了**，因为桌宠没有标题栏，用户没别的地方可看 |
| `scripts/fake-feed.js` | S2 | 假数据源：从端点文件读 port+token 后 POST 事件，支持完整剧本 / 单事件 / `--hold` 保持状态 | S4 之后只用于离线调试，真事件由 hook 送 |
| `scripts/verify-electron.js` | S4-前 / S5 / S6 / S7 / S9 | 回归闸门：同时开主进程 inspector(9229) 与渲染进程 CDP(9222)，跑 **157 条断言（当前 157 PASS / 0 FAIL）** ——窗口属性、透明、IPC 接线、DOM、帧轮播、gaze、瞳孔唯一性、`eyeTracking` 开关、HTTP 四道锁、权限六段、看板九段、SVG 白名单、主题加载与拒绝路径、Notification 噪音过滤、会话标题与工具名 11 条、醒猫与睁眼过渡、单实例锁、退出收尾、端点清理。**两条渲染路径共用同一批断言**，开头读 `petDebug.theme().rig` 得到 `rigMode`，判据分叉：骨骼看不切图层 / 不重建 DOM / layerB 为空 / 眨眼看 opacity / 只有一组瞳孔 / 呼吸类 transform 每帧在变 / 键盘与编辑器窗口在、代码行在长；帧序列看淡入 / 逐帧替换 / 眼睛被压扁 / `VISUAL_STATES` 静态检查| **2135 行**。零第三方依赖（用 Node 内置 `WebSocket`）。`npm run verify:electron`。坑：**主进程 inspector 连上后必须先发 `Runtime.enable`**、清理要 `taskkill /T /F` 杀进程树、要用 `--user-data-dir` 自隔离、**动手改状态前要等启动推送静默**、**页面内跑超过 5 秒的 eval 会被 CDP 超时静默吃掉**（采样必须 Node 侧逐次读）、**期望值别按字符串比**（`style.transform` 经 CSSOM 会把 `3.80px` 序列化成 `3.8px`；同理不透明度改成连续值之后，`=== "0"` 判眨眼永远不成立）；另外它还把台账里的硬约束**变成真断言**（`src/` 下 `innerHTML` 出现 0 次）——约束不落到断言上等于没有。hook 相关的断言放在**起 Electron 之前**（纯 Node，快且干净；此刻端点文件还不存在，正好就是"桌宠没开"的真实场景），hook 一律**真起子进程喂 stdin**——过滤生效的唯一方式是 stdout/stderr 上的真实字节数，不能靠读内部变量猜。S9 分两层验：`store.wake()` 在纯 Node 侧验（含"working 不被鼠标改写"的对照组）；"醒来的过渡"只能在 Electron 侧验，判据是**采到中间值**——一张静态图里慢慢睁开和啪一下睁开长得一模一样 |
| `scripts/preview-shot.js` | S3 / S7 | 把 `preview.html` 渲染成 `docs/<theme>-states.png`（七状态对照图），改完形象后用来目视确认「没改坏」。会先自动重建预览包，再按 `--theme=` 截对应主题；截图前**按 `scrollHeight` 撑开视口**（否则第二行永远被 640 视口切掉） | **249 行**，零第三方依赖。`finally` 里 `taskkill /T /F`——不然 GPU 子进程逃逸，下次启动报 `Unable to move the cache` |
| `scripts/build-preview-bundle.js` | S7 | 把 `themes/` 打成 `preview-bundle.js`。preview.html 是 `file://` 打开的静态页，`fetch` 读不到本地文件，只能打包 | 只给预览用；桌宠运行时不读它，所以包过期不会影响实际形象 |
| `hooks/clawd-hook.js` | S4 | agent hook 适配器，**只走一个方向**：读 stdin（2s 硬超时 / 1MB 上限）→ 只取 `session_id/event/cwd/tool_name/title` → 探端口 → POST（1.5s 超时）→ 永远 `exit(0)`。**不再往 stdout 写一个字节**（S8 的送信 2026-10-30 整套砍掉了）。`title` 由 `deriveTitle()` 在**本地**从 `session_title` 或 `UserPromptSubmit` 的 prompt 第一行推出来——**prompt 原文不进这条链路**，只有那一行派生结果出去；第一行命中 `TITLE_SECRET_RE` 就整个标题都不要 | **212 行**。**2026-10-30：Notification 的生命周期闲聊在源头滤掉**——`IGNORED_NOTIFICATION_TYPES = {idle_prompt, auth_success}`（这两个值抄自主仓库 `hooks/workbuddy-hook.js:30` 的实测注释：`idle_prompt` 是 Stop 之后约 60 秒的"再发一条消息吧"，`auth_success` 是每轮开头都发的登录 toast）。**必须在 hook 侧滤而不是交给状态机**：notification 一旦变成上面那个长状态，一条 `idle_prompt` 挂上来就是"猫凭空喊好几分钟"。是白名单式的（只丢明确列出的），没见过的 `notification_type` 照常放行。**2026-10-29：缺 `session_id` 的事件一律丢弃，绝不合成占位 id**（原来是 `|| "unknown"`）：多条真实会话会被塞进同一条幽灵会话，事件互相覆盖——A 正在 thinking，B 结束发一个 `Stop` → attention 播完回到 idle，**A 的画面就变 idle 了**。主仓库 `hooks/workbuddy-hook.js` 这条带着 bug 编号（#618 / #648），注释的原话是合成 id 会造出一个"后面的事件既更新不了也清除不掉"的幻影会话。`trim()` 之后再判空，否则 `"   "` 是 truthy 字符串会被当成有效会话号；警告走 stderr——**stdout 在 `UserPromptSubmit` 上是协议**（会被宿主收进上下文）。三条铁律：不阻塞、不打日志（**现在连"协议输出"都不存在了**，所以这条就是字面意思：什么都不打印）、不抛异常。stdin 排在探端口之前，这个顺序最初是为送信定的；送信砍掉后它是个**待议项**（单看收这一路，先探端口更省），改之前要想清楚宿主把 payload 写进管道时我们已经退出的后果 |
| `hooks/install.js` | S4 / S5 | 多 agent 安装器。`AGENTS` 表驱动 `--agent claude\|codebuddy\|workbuddy`，往对应 `settings.json` 的 `hooks` 段增量合并：观察型 command hook（按 agent 决定是否写 `async: true, timeout: 5`）+ 权限条目（只有 `permission: "http"` 的 agent 才装；WorkBuddy 原生处理权限，装的是死配置）。marker 只认自己的条目，备份 + 临时文件 rename 原子写，支持 `--uninstall` / `--dry-run` / `--file` | 观察型 hook 不能拖住 agent，权限 hook 反过来必须拖住——**两种语义相反，不要统一** |

## 其他文件

| 文件 | 职责 | 备注 |
|---|---|---|
| `preview.html` | 静态预览页，浏览器打开可一次看完某个主题所有状态的 SVG 与帧序列；顶部有主题下拉框，支持 `?theme=ragdoll` | 不参与运行，纯设计对照用 |
| `preview-bundle.js` | `themes/` 的打包产物（约 125KB），由 `npm run build:preview` 生成。preview.html 通过它读数据 | 生成物，**不要手改**；它过期只影响预览，不影响桌宠 |
| `themes/**` | 主题资产：`<id>/theme.json` + `<id>/assets/*.svg`。现有 `ragdoll`（默认，骨骼弹簧，写了 `timings`）与 `_template`。**crab 已删**（2026-10-28）——它原本是第二个内置主题兼帧序列用例，用户说不需要更多主题（下划线开头 = 不参与主题列表） | 整目录登记，不逐帧列。契约与字段说明见 `themes/README.md` |
| `docs/ragdoll-states.png` | ragdoll 的七状态对照图（crab 的那张随主题一起删了） | 用法见 npm run preview:states。**注意它截的是 `preview.html` 里的帧序列资产，不是骨骼路径那只猫**——删围兜、改身材这类改动都不会反映到它上面，别拿它当"改坏了没"的判据 |
| `README.md` | 项目说明、已验证能力清单、故意的简化对照表、12 条踩坑记录 | 踩坑部分是同类项目最有价值的参考 |
| `package.json` | 只有 `electron ~45.0.0` 一个依赖，`npm start` → `electron .` | 用 `~` 不用 `^`：补丁自动进（安全修复），minor 要人过一遍再升 |
| `package-lock.json` | 依赖锁定，实际安装 45.0.0 | `~45.0.0` 允许 45.0.x 补丁，挡住 45.1+ |
| 端点文件 | 运行时产物，**不在项目内**：`%APPDATA%\clawd-starter\clawd-starter.port` | 内容 `{port, token}`，权限 0600；删除后重启即重新生成。**这是全项目唯一会落盘的东西**，其中没有用户内容 |
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
                  renderer.js setState ──► 骨骼弹簧重算 / 帧序列取帧 ──► SVG 上屏

  主进程 100ms 采样光标 ──IPC "gaze"──► renderer.js 插值 ──► 瞳孔 transform
```

S9 加了一条**上行**支路，方向和事件流相反（渲染层 → 主进程），而且只走一个动作：

```text
鼠标停在猫身上（mousemove → elementFromPoint 命中 #pet）
        │  仅当 currentState === "sleeping"，且距上次 ≥500ms
        │  IPC "pet:hover"（无载荷）
        ▼
   main.js → store.wake()
        │  只把 sleeping 的会话改成 idle，stateSince 一起重置
        │  其余状态一概不碰（working/thinking 是 agent 的真实进展）
        ▼
   tick() → visual 变了才 emit → broadcast → renderer setState("idle")
        │  然后才是画面：躯干/头/耳/尾 28 个弹簧通道过冲跟上，
        ▼  eyeOpen 弹簧把睁眼和头顶 zZz 一起用 0.5s 淡过来
```

**为什么绕这一圈而不是渲染层直接改画面**：`sleeping` 是状态机按"idle 持续多久"推出来的，
渲染层改完会被下一个 250ms 的推送顶回去——那就是"闪一下又睡"。同一类账在 S8 已经记过一次
（不要用改宠物状态来给用户提示），这里只是反方向的同一件事。

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
用户双击桌宠 / 右键菜单里点「会话看板」（两个入口都走同一个 toggle）
        │  IPC "dashboard:toggle"（回归仍走这条通道开看板）
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
> hook 会先读 stdin 再探端口（顺序的来历是个待议项，见上表 `clawd-hook.js` 那行）。

## 曾经有过、现在没有的一条流：送信（S8，2026-10-30 删除）

这条流只活了两天，删掉的理由和"它是怎么设计的"一样值得留下来——
**它解决的是一个不存在的问题**：用户想让 agent 知道什么，直接在对话里说是一跳直达；
经桌宠转交是三跳（写 → 存 → 等下一次提交），还多出一个会丢信的环节。

当初试过的三条路，记录在这里是为了让下一个人**不用再试一遍**：

| 路 | 不通的理由 |
|---|---|
| CLI（`codebuddy -p`） | 要**单独登录一次**（桌面端登录态在 Electron 的加密存储里，CLI 读不到），而且 `-p` 只**开一个新会话**，进不了你正在看的那个 |
| POST `127.0.0.1:51650` | 端口属主确实是 `WorkBuddy.exe`，但那是**未公开的内部接口**：一次更新就崩，还等于绕开它自己的鉴权 |
| hook 的 stdout | 唯一有官方契约的（`UserPromptSubmit` 的 stdout 会进上下文），代价是**信要到下一次提交才送达** |

**最后一条也不是真正的"直达"**——它是 fire-and-forget，宿主从不回执，
所以"有没有送到"根本无法确认。这是整套被砍的第二个理由：
**没有回执的协议里，多一条投递路不是冗余，是黑洞**（2026-10-29 加的 `SessionStart`
第二个投递口，启用一天就吃掉一封信：信被 `take()` 挪走了，而它是否真进了对面上下文永远没人知道）。
