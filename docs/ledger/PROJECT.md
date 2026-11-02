# clawd-starter

> 从零重搭 Clawd 桌宠的骨架：做一个透明置顶、会跟着鼠标看你的桌面宠物（2026-11-02 起容器有 Electron 和 Tauri 两套），先把「agent 事件 → 状态机 → 画面」这条数据链路跑通，之后每个阶段都往这条链路上加东西，而不是推倒重来。

| 项 | 内容 |
|---|---|
| 状态 | ACTIVE（S1–S10 完成；S10-5 容器换成 Rust） |
| 路径 | `E:\JacksonLee\project\clawd-starter` |
| 技术栈 | **两套容器，同一套渲染层**：① Electron 45.0.0（`nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`）+ Node 原生 `http`/`fs`；② Tauri 2.12.5 + WebView2（Rust `tiny_http` + `regex` + `windows-sys`，**不用任何 `tauri-plugin-*`**）。渲染层纯手写 SVG 无框架、无构建工具 |
| 入口 | Electron：`src/main.js`；Tauri：`src-tauri/src/main.rs` |
| 启动 | `npm install` → `npm start`（`electron .`）；或 `npm run start:tauri`（`cargo run --release`） |
| 端口 | **固定 23333**（与主仓库一致），只绑 `127.0.0.1`。为什么不能随机：权限 HTTP hook 的 url 是安装时写死进 `settings.json` 的，端口漂移就等于 hook 指向死端口。被占用时退回随机端口并显式 warn，但必须重跑 `install:hooks` |
| 端点文件 | `%APPDATA%\clawd-starter\clawd-starter.port`，内容 `{port, token}`，权限 0600 |
| 依赖服务 | 无。不连任何外部服务，只在本机开一个 HTTP 端口接收事件 |
| 版本控制 | git，远端 `github.com/JacksonL1/meow-bot`，分支 `main`，与 origin 同步。S7 之后的每一次改动都已入库，最新一批是 S10-5：`081921f 容器换成 Rust：迁到 Tauri`（代码）+ `616cd41 台账：S10-5 Tauri 迁移`。**这一格不再写提交总数**：写下一个数字的那个提交本身会让数字 +1，改一次错一次——上一版写着「5 次提交、S7 尚未提交」，从 S7 烂到 S10-5 整整一个月没人对过账。要看数就 `git log --oneline \| wc -l`。**台账里凡是带计数的字段都有这个毛病**（体积那年改了七次，六次是在改数法），要么连口径和实测时间一起写，要么不写 |
| 体积 | **37 个源文件，12756 行**（`src/` 17 个 = 14 js 4555 + 3 html 621、`src-tauri/` 11 个 = 7 rs 3318 + `build.rs` 3 + 2 json 34、`hooks/` 2 个 645、`scripts/` 7 个 3580；`Cargo.lock` 4445 行是生成物不计），另有 `themes/` 下 22 个 SVG 资产。**2026-11-02 10:30 实测**。这条被改了七次，七次里六次不是代码变了、是**数法**变了（漏 html、漏 `src-tauri`、把 JSON 不算源文件、生成物混进来）。写体积时必须**连文件数、口径、实测时间一起写**，只写总数没法被复查 |

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
| S6 | 多会话看板：右键菜单里打开窗口，把内存里那张仲裁表摊开成人能看的列表 | 已完成 | SEC-09 分层兑现：存储层留完整路径、快照层只出 basename、完整路径只在显式点击时单条释放 |
| S7 | 主题系统：`themes/<id>/theme.json` + `assets/*.svg`，**删掉写死的 `visuals.js`** | 已完成 | 白名单先于加载器；放行 3 个标签 + 9 个图元，拒 5 类；校验分主进程（文件/格式）与渲染层（内容）两段 |
| S8 | ~~跟桌宠说话：双击写信 → 落磁盘信箱 → 下次 `UserPromptSubmit` 由 hook 写进 `additionalContext`~~ **2026-10-30 整套删除**（它解决的是一个不存在的问题：想让 agent 知道什么，直接在对话里说是一跳直达，经桌宠转交是三跳还多一个丢信环节）。**这一阶段留下的东西只有右键菜单**（看板 / 退出）和双击手势，两者现在都开关看板 | 已删除 | 删它时踩的反面教材已记进硬约束 1：功能下线要**连校验层和文档一起删**。当时误删了 `IGNORED_NOTIFICATION_TYPES` 常量而使用还在，`ReferenceError` 被 `catch(() => {})` 吞掉 → 所有 Notification 静默发不出、零报错 |
| S9 | 鼠标叫醒：停在睡着的猫身上 → `pet:hover` → `store.wake()`（只认 sleeping），眼睛与 zZz 走同一条 `eyeOpen` 弹簧慢慢淡过来 | 已完成 | SEC-13（P3 记录在案）：第一条渲染层请求改状态的通道，无载荷；边界是**渲染层只能请求，改状态永远是主进程的事** |
| S10 | 三条需求一次做完：① **分身 + 头巾**——≥2 条会话时同窗口横排多只猫（有重叠、点击切聚焦、久不接任务淡出 1600ms），每只猫的头巾上写 hook 侧抽出来的一个词；② **命令风险评级**——气泡里显示「风险 低/中/高/极高」+ 人能读懂的理由（`rm -rf /`、密钥读写、管道执行、多行 shell）；③ 资源瘦身的**前半段**：判据与迁移方案定案（Tauri，保住前端资产） | 已完成 | S10 四条新风险逐条挡法见 SECURITY.md；硬规则：**评级只影响显示，critical 也不自动 deny，超时仍 204** |
| S10-5 | **容器换成 Rust**：Tauri 2.12.5 + WebView2。后端（HTTP / 状态机 / 主题 / 裁决 / 风险评级）用 Rust 重写，三个窗口与托盘改 `WebviewWindow` / `TrayIconBuilder`，Win32 四件事自己写（`sys.rs`）。渲染层靠 `src/tauri-bridge.js` **一行没改**。新增 `scripts/verify-tauri.js`（65 条），Electron 那份仍 191 条 | 已完成 | 三处没变（动作面 / SVG 白名单 / 四道锁）、**一处变松**（`withGlobalTauri` 把 `core.invoke` 放到 `window` 上，已记录为让渡）、两处已知差异（无 `res.on(close)`、无单实例锁） |
| S10-6 | **收尾 S10-5 留下的四条**：① 单实例锁（`single.rs`：命名互斥量 + 命名事件，回归 65 → 68 条）；② 关 `withGlobalTauri` + 每窗口命令白名单（回归 68 → 73 条，3 条越权断言直连 `__TAURI_INTERNALS__`）；③ 锁屏从 2s 轮询换成 `WTSRegisterSessionNotification` 事件（回归 73 → 74 条）；④ 打包分发：NSIS 安装包 1.57MB + `verify-bundle.js` 25 条（真装/真卸）。改动逐项单独入库 | 已完成 | 每项都带判据：单实例看**端点文件字节未变**（不是"进程退了没"）；命令白名单看**越权调用返回 forbidden**；锁屏看 **`/health` 的 `lock` 字段是 `event`**（`hide/show` 那一段靠人工锁屏验）；打包看**装出来的 exe 与裸 exe 逐字节相同**（只允许 bundler 那 3 字节补丁）+ 装完 `/health` 仍是 `event` |

安全问题全部记录在 [SECURITY.md](./SECURITY.md)，每阶段开工前先看对应小节。

## 核心模块

| 模块 | 职责 | 关键文件 |
|---|---|---|
| 窗口与进程 | 创建透明置顶窗口、拖拽轮询、眼球追踪采样、气泡窗口生命周期 | `src/main.js` |
| 事件接入 | 本地 HTTP 服务，`GET /health`、`GET /state`、`POST /state`、`POST /permission` | `src/server.js` |
| 状态机 | 事件→状态映射、多会话优先级仲裁、oneshot 自动回落、闲置 60s 入睡、`wake()`（鼠标唤醒，只认 sleeping） | `src/state.js` |
| 权限裁决 | 挂起请求、等待决定、唯一出口 `settle()` 保证恰好响应一次 | `src/permission.js` |
| 权限气泡 | 卡片 UI、两个按钮、Esc 不表态、量高度回传 | `src/bubble.html` + `bubble-renderer.js` + `bubble-preload.js` |
| 会话看板 | 独立窗口、双击开关、1s 轮询快照、按「最吵的排前面」排序、演示模式、复制路径 | `src/dashboard.html` + `dashboard-renderer.js` + `dashboard-preload.js` |
| 渲染 | **两条路径**：① 骨骼弹簧（`rigType: ragdoll-spring-v2`，JS 直接拼 SVG + 二阶弹簧阻尼通道，60fps）；② 帧序列（双图层交叉淡入、帧轮播、瞳孔位移插值）。两条都共用 `svgNode()` 白名单出口 | `src/renderer.js` |
| 主题 | 扫目录、校验 schema 与资产、校验 `motion`/`gags` 规则、缺状态补齐、全坏兜底（主进程）；换主题 = 换帧数据 + 重画 | `src/theme.js` + `themes/<id>/theme.json` |
| 进程间桥 | 只暴露具体动作，不泄漏 `ipcRenderer` | `src/preload.js`（主窗口 13 个）+ `src/dashboard-preload.js`（看板 5 个）|
| 调试 | 假数据源，三种用法（完整剧本 / 单事件 / 保持某状态）；形象对照截图；主题打包 | `scripts/fake-feed.js`、`preview-shot.js`、`build-preview-bundle.js` |
| 回归闸门 | 主进程 inspector + 渲染进程 CDP，**191 条断言；当前 191 PASS / 0 FAIL**（剪贴板那条环境不可读时 `[warn]` 降级）；两条渲染路径用同一批断言、`rigMode` 分叉判据 | `scripts/verify-electron.js` |
| 容器（Rust 侧） | 与上面每一行同构的 Rust 实现：HTTP（`server.rs`）、状态机（`state.rs`）、主题（`theme.rs`）、裁决（`permission.rs`）、风险评级（`risk.rs`）、窗口与线程（`main.rs`）、Win32（`sys.rs`） | `src-tauri/src/*.rs` |
| Tauri 桥 | 在 `window` 上装出与 `preload.js` 形状相同的 `clawd` / `bubble` / `dashboard` | `src/tauri-bridge.js` |
| 回归闸门（Tauri） | WebView2 CDP（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=`），**74 条断言；当前 74 PASS / 0 FAIL** | `scripts/verify-tauri.js` + 共用的 `scripts/cdp.js` |
| 打包闸门 | NSIS 安装包，**25 条断言；当前 25 PASS / 0 FAIL**（10 条只读 + 15 条真装/真跑/真卸） | `scripts/verify-bundle.js` + `src-tauri/tauri.conf.json` 的 `bundle` 段 |

## 已知限制

- **真实 agent 会话验证刚开始**：用户在 WorkBuddy 上实测过 S1–S7 的链路（hook 确实触发了，状态会跟着变），并报回三个问题——其中"working 中途睡着"已修，"thinking 显示成 idle"根因未定（诊断口 `petDebug.events()` 已就位）。**"WorkBuddy 把 `UserPromptSubmit` 的 stdout 并进消息"这一步仍未经证实**
- 事件名以 Claude Code 为基准；`hooks/install.js` 已能装到 CodeBuddy / WorkBuddy，但**WorkBuddy 是否支持 hooks 未经证实**（官方文档无 hooks 章节，装的是按 CodeBuddy 契约推的）
- 会话只存内存 `Map`，没有持久化与掉电恢复
- 每 250ms 统一 tick，不是事件驱动定时器
- 看板 1s 轮询，不是推送——`idleMs` 天然随时间变，这是故意的取舍
- 权限请求只存内存，没有决策历史与审计日志
- 气泡只支持鼠标点 + Esc，没有键盘 Tab/Enter；看板也没有键盘导航，也没有远程审批
- **常驻内存压不到 15MB，而且不可能压到**。实测两次（2026-11-02，Windows，release，同机同日）：Electron 45 **370.1 → 350.8MB** RSS（私有 221.2 → 203.1MB，4 进程）；Tauri **383.4 → 379.6MB**（私有 213.6 → 211.8MB，7 进程），其中 Rust 宿主 **34.3 → 33.9MB / 私有 11.2 → 10.4MB**，其余是 6 个 WebView2 子进程。**差值的波动（±30MB）比两者的差距更大，所以能说的只有"持平"**——不要让单次采样变成"换容器更省内存"的证据。**Rust 宿主自己达标，整机不达标**——窗口里跑的还是 Chromium。要到 15MB 只有原生自绘（GDI/Direct2D 手画每一帧）一条路
- **单实例锁已补（S10-6）**：`single.rs` 用命名互斥量，第二份进程在 `Builder::build` 之前就退出。
  **纠一条本台账写错过的**：S10-5 说"开第二份 hook 仍然打给第一份（端口没变）"是错的——
  `write_port_file()` 无条件执行，第二份会拿随机端口**覆盖**端点文件，
  于是 hook 改打第二份、用户看的是第一份，画面永远不动且不报错。
  锁名带端点文件路径的哈希，所以回归能在"用户正开着桌宠"时照跑
- **回归脚本不能并行跑**：两套都用 CDP 9333、都要占 23333，同时开会互相踩。踩出来的现象很有误导性——第二个进程会因为 CDP 端口被占而 panic（exit 101），看起来像"单实例锁坏了"
- **改前端也要 `cargo build`**：`frontendDist` 是编译期嵌进二进制的，不是 Electron 那种即改即看。改一版形象要等一次链接

- **锁屏已换成事件（S10-6③）**：`WTSRegisterSessionNotification` + `HWND_MESSAGE` 消息窗口，
  2s 轮询降级为"注册失败时的兜底"。`/health` 里带 `"lock":"event"|"poll"`，
  两种模式失败的样子一模一样，不写出来没法问诊。**hide/show 那十行没有自动验证**——
  真锁屏不能进回归，靠人工锁一次屏验
- **已有 NSIS 安装包（S10-6④）**：`src-tauri/target/release/bundle/nsis/clawd-starter_0.1.0_x64-setup.exe`
  （1.57MB，`installMode: currentUser`，装到 `%LOCALAPPDATA%\clawd-starter`，不提权）。
  两条限制要记住：**没有代码签名**（双击会看到 SmartScreen「未知发布者」，只能买证书解决）；
  `webviewInstallMode` 是默认的 `downloadBootstrapper`，**没有 WebView2 的离线机器装不上**
- **不能和主仓库 `clawd-on-desk` 同时运行**：都用 23333，且 hook URL 是安装时写死的
- 命中判定用 `#pet` 的 176×176 包围盒，不是真实 alpha 遮罩——四个角上的透明区会误判为「可点击」
- 看板的「复制路径」在回归里验的是返回值 + 剪贴板内容（实测能拿到完整路径）；但**环境不具备时**（某些会话读不到剪贴板）会降级成一条警告，不做假断言
- 看板不能跳转终端——`fullCwd()` 已经留好了，只是没做动作按钮
- **主题只支持 SVG**。GIF / APNG / WebP 要写图片解码器，没做（主仓库有，用的是动画解码 + 资产缓存）
- **主题不能用 `<style>` 做 CSS 动画**。动画只能靠 `motion` 声明 + 渲染层插值，或画多帧逐帧替换（那条路已经证明是频闪）。这是刻意让渡：`<style>` 里能写 `@import`、能覆盖整页
- **working 的桌面场景只存在于骨骼渲染器里**（键盘 + 编辑器窗口 + 代码行生长），是 `renderer.js` 里写死的，不是主题数据。彩蛋（`gags`）已经整体删除：用户把 working 从「钓鱼」改回「敲键盘」之后，鱼和拖鞋就没有存在的理由了，留着只会变成没人走的死路径
- ~~状态时长写死在 `state.js`~~ → 已进 `theme.json.timings`（2026-10-28）。**主题只能改已有的四个数，改不了状态机的形状**
- 没有在线主题目录，主题只能手工放进 `themes/`。换来的是供应链攻击面为零
- **桌宠到 agent 是单向的**（2026-10-30 起）。曾经有过一条反向通道（写信 → 下次 `UserPromptSubmit` 时进上下文），整套删了：它解决的是一个不存在的问题，而它唯一有官方契约的那条路（hook stdout）是 fire-and-forget、宿主从不回执，"有没有送到"根本没有确认手段。三条试过的路都记在 `FILE_MAP.md` 末尾，别再试一遍
- **鼠标必须"动"才算经过**：唤醒挂在 `mousemove` 上，光标一动不动地压在睡着的猫身上不会把它叫醒（想叫醒就摸一下）。反过来，鼠标停在猫身上超过 60s 它会再睡回去——这和"没人理它就睡"是同一套逻辑，没有为"手停在那里"做特例
- **醒来的时长写死在渲染层**（`eyeOpen` 弹簧 k=110 c=21，约 0.5s），不进 `theme.json.timings`。主题能改的只有状态时长，改造型曲线会引出"60fps 弹簧参数要不要开放给主题"这一整串问题，暂时不碰

## 硬约束（改代码前先看）

1. **`preload.js` / `bubble-preload.js` / `dashboard-preload.js` 只暴露动作，不暴露 `ipcRenderer`**——这是 Electron 的安全边界，加功能时最容易顺手破坏。主窗口的动作数被回归钉死（现在 **12** 个），多一个少一个都会红。
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
13. **别用多帧去换流畅度**。逐帧替换是离散采样，6~8fps 一定是频闪（看着像卡顿，其实是台阶）。要顺就上 `motion` 让渲染层插值到 60fps。**帧数多 ≠ 流畅**：ragdoll 从 19 帧降到 7 帧，反而更顺。
14. **被动画的部件外层 `<g class="m-xxx">` 不许自带 `transform`**。渲染层每帧 `setAttribute("transform", …)` 会覆盖它，静态角度必须放内层 `<g>`。写错的后果是"这个部件不动"，画面上一点提示都没有——回归里用"motion 声明的部件必须存在"兜这一条。
15. **`motion.part` 是选择器片段**，会拼进 `querySelector(".m-" + part)`。必须过 `PART_RE`，不要因为"反正只有自己写的主题"就省掉——主题本来就是外部输入。
16. **`gags` 里有两处选择器片段**：外层 `parts[]`（放行/回收哪些部件）和内层 `steps[].part`（动画目标）。两处都走 `PART_RE`。这是 `motion` 那条的加强版，也是最容易只改一处的地方。
17. **彩蛋演完必须"恢复原值"而不是"一律隐藏"**。彩蛋的部件有两种来源：天生藏着的（鱼、拖鞋，写死 `display="none"`）和本来就露着的（`pupils`，被拉进彩蛋只是为了"跟着看一眼"）。一律 `display:none` 会把猫的瞳孔一起抹掉。`restoreGagParts()` 里存的是**开演前的属性快照**，别简化成常量。
18. **一个部件同一时刻只能被一个 `transform` 源控制**。`motion` 每帧都在写，所以彩蛋**不要去动 `motion` 已经占用的部件**（比如 `head`）；同一个部件要同时位移和缩放，就在 SVG 里**再套一层 `<g class="m-xxx">`**，外层管位移、内层管缩放。写在同一层会互相覆盖，表现为"只有一个生效"，且不会报错。
19. **`src/` 下 `innerHTML` 的出现次数必须是 0**（回归里已有一条机械检查在查这条，2026-10-28 补）。主题内容只能走 `svgNode()`（`DOMParser` + `ALLOWED_TAGS`）。这条是可机械检查的，别靠"我记得用清洗函数"——上一版重写把整个非骨骼路径改回了 `innerHTML = frames.join("")`，白名单函数还在文件里但已不在任何路径上（见 SECURITY「两道闸是怎么被无声拆掉的」）。
20. **`index.html` 必须带 CSP meta**。删它要单独一次提交并在 SECURITY 留记录。**放宽同理**——S10-5 把 `connect-src` 从 `'none'` 改到 `ipc: http://ipc.localhost`（Tauri 的 IPC 是 fetch），理由写在 meta 注释里。判据是「加了一个具体值，还是放宽了一整类」：前者可以在注释里说清，后者一律不许。它平时看起来是"一行没用的配置"——因为它挡的东西今天一个都不在；它挡的是明天漏过白名单的那一个。
21. **架构重写后必须比对回归通过数**。任何一项掉红都要能说出原因；"测试过时了，先放着"是这次 49 条断言集体失效时的第一反应，也是差点把三道防线一起放过去的反应。
22. **主题自报 `rigType`，不要靠 id / name 嗅探渲染器**。`id === "ragdoll"` 的兜底意味着任何叫 ragdoll 的主题都会掉进"画死在 JS 里的那只猫"。加载器透传 `rigType`，未知字段可忽略，但**渲染分支的选择必须来自主题声明**。
23. **每个 `petDebug` 出口都要有一条断言证明它自己有货**。`ragdollRig.springs` vs 实际的 `this.sp` 只差一个名字，结果是 `return {}`——不报错、不崩溃、调用方看不出来。观测窗口没有自检，它就只是装饰（见 SECURITY「骨骼弹簧重写」第四节）。
24. **断言的期望值不要按精确字符串比中间层会改写的量**。`style.transform` 经 CSSOM 序列化会把尾零吃掉（写 `3.80px`、读 `3.8px`），凡是经过 Web API 序列化的值，一律用**数值 + 容差**判据。
25. **一个功能下线，要把它的「校验层」和「文档」一起删**。彩蛋删掉之后，`theme.js` 里还在校验 `gags`、`themes/README.md` 里还写着完整的 `gags` schema——主题作者照着写会**校验通过、加载成功、什么都不发生**。比删掉更难查，因为它长得像能用。判据只有一个：**这个字段还有消费者吗**。没有就连校验带文档一起删。
26. **`hooks/clawd-hook.js` 不往 stdout 写一个字节**（2026-10-30 起）。送信砍掉之后 stdout 不再是协议通道，连"例外"都没有了，所以铁律「hook 绝不打日志」回归字面意思：什么都不打印，要抱怨就走 stderr。
27. **stdin 读在探端口之前**（顺序的来历是个待议项，见 `FILE_MAP.md` 的 `clawd-hook.js` 那行）。单看"收"这一路，先探端口更省；改之前要想清楚宿主把 payload 写进管道时我们已经 `exit(0)` 的后果。
28. **给新内容定隐私口径，先列全部归宿，再按最严的那处定标准**（这条从被删的 SEC-15 里抢救出来的通用结论）。当时的诊断文本有两个归宿——进 agent 上下文 + 留用户磁盘，只看一处等于默许它在另一处泄漏。配套动作：**隐私断言要做敏感性抽查**，故意注入一次确认它真会红；一条从没红过的隐私断言等于没有。
29. **没有回执的协议里，"多一条路"不是冗余是风险**。hook 是 fire-and-forget（写完 stdout 就 `exit(0)`，宿主从不回执），所以"投递成功"根本没有确认手段。加第二个投递口（`SessionStart`）的结果是启用一天吃掉一封信——`take()` 一 rename 信就消失，而它是否真进了对面上下文永远没人知道。**先问：这条路失败了，我看得见吗？**
30. **状态的主权在主进程，渲染层只能"请求"**。渲染层擅自 `renderState()` 会被下一个 250ms 的推送顶回去，表现是"闪一下又变回来"——S8 想用改状态来提示"信寄出了"时踩过，S9 想用它来"唤醒"时差点再踩一次。两个正当出口：改文案（`#hint` 提示条，归渲染层自己管），或发一条**无载荷**的 IPC 请主进程改（`pet:hover` → `store.wake()`）。同一条也约束主进程侧：`wake()` 只认 `sleeping`，**不许顺手把 working 也"唤醒"**——那是用户鼠标改写 agent 的真实进展。
31. **删部件/换部件，要连"读它的探针"一起改**。外观改动看起来只动 SVG，但回归里有断言在读具体部件（"每帧都在重算"读的是 `rig-body-group` / 胡须 / 尾巴的 transform）。删掉 `#rig-ruff` 而不改探针，报告不会红——它会变成读 `missing:rig-ruff`，字符串照旧在变，于是**一条永远为真的断言换掉了一条真的**。这是硬约束 25 的姊妹条：那个讲"留着的校验器"，这个讲"留着的探针"。
32. **窗口不能在 `#[tauri::command]` 里建**（同步 command 跑在主线程上，建窗会卡死在 WebView2 的创建回调；`app.exit()` 同理，消息循环正卡在那一帧里没人泵）。要建窗、要退出，先进 `std::thread::spawn`。判据不是「能不能建窗」，是**从哪个线程建**——同一段代码从 HTTP 线程调就是好的。
33. **「先存起来等握手」之前，必须先把窗体出来**。`bubble.html` 要先加载才会发 `bubble_ready`，窗口不建出来这个信号永远不会到，请求就一直躺在槽里挂到超时——而界面上什么都不发生。这条的隐蔽性在于：**第二次请求也不会好**，它不是竞态，是死锁。
34. **「算 change」和「推 change」之间要有一根显式的线**。`apply()` 内部调了 `tick()`，`tick()` 顺手更新了 `last_visual`；心跳再 tick 时比的是「新值 vs 新值」→ 返回 false → 这次变化永远推不出去。Rust 侧把这两件事分到了两个文件（`state.rs` 算、`server.rs` 推），拆的时候没人负责那根线。跨文件拆分状态机时，**先确认「谁负责通知」有名字**。
35. **两套容器的「渲染层能做什么」必须逐条对齐**。Electron 的 `preload.js` 和 Tauri 的 `tauri-bridge.js` 是同一份契约的两个实现，动作名、参数、返回值都得一一对应（回归里两边的键名清单是硬写的）。换容器时最容易漏的不是功能，是**边界**：`withGlobalTauri` 顺手就把 `core.invoke` 放到了 `window` 上，那不叫「等价迁移」。
36. **JS 侧关不干净的东西，边界就放到 Rust 侧**。S10-6② 关掉 `withGlobalTauri` 之后，`window.__TAURI_INTERNALS__.invoke` 还在（描述符 `writable:false` + `configurable:false`，删不掉），所以 16 条命令逐条加了 `only(&window, ...)`。**新增命令必须同时加这一句**——漏了不会报错，只会静默地多出一个越窗口的口子。
37. **先确认目标能不能被方案满足，再动手**。用户的原始目标是「常驻 15MB 以内」，而 Tauri 在 Windows 上仍然是 WebView2（Chromium）。实测：Rust 宿主私有内存 **11.2MB**（达标），WebView2 子进程 **202.4MB**，整机 **383MB**——和 Electron 的 **370MB** 基本持平。**这不是执行不到位，是目标与方案互斥**。遇到这种要先说清楚，不要把 383MB 描述成「接近 15MB」。
38. **打包/搬运类操作的判据不是"哈希相同"，是"逐字节相同，且允许的差异能指名道姓"**。tauri-bundler 会把二进制里的 `__TAURI_BUNDLE_TYPE_VAR_UNK` 打成 `_NSS`（3 个字节），所以"装出来的 exe 与裸 exe sha256 必须相等"这条判据本身是错的——第一次跑就红了，而它指向的是一个不存在的 bug。同理，**卸载的验收要等所有痕迹都消失**：NSIS 删开始菜单 `.lnk` 比删 exe 晚一步，只查一次会把失败推到下一轮，看起来像"上一轮卸干净了"。
