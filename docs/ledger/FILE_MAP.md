# 文件地图 — clawd-starter

> **2026-11-03 起只有一套容器：Tauri**（`src-tauri/` 下的 Rust）+ 一套渲染层（`src/` 下的
> HTML/JS，靠 `src/tauri-bridge.js` 把 `window.clawd` 装回去）。Electron 的 9 个文件已整套 `git rm`，
> 需要考古从 git 历史里找。
>
> **33 个源文件 / 10369 行**：
> `src/` 9 个 = 6 个 `.js` 2855 行 + 3 个 `.html` 621 行；
> `src-tauri/` 12 个 = 8 个 `.rs` 3972 行 + `build.rs` 3 行 + `Cargo.toml` 56 行 +
> `tauri.conf.json` 37 行 + `capabilities/default.json` 13 行（`Cargo.lock` **生成物不计**）；
> `hooks/` 2 个 644 行；`scripts/` 10 个 2168 行。
> 实测 **2026-11-04**（S10-9 删掉 Electron 之后；11-03 首记的 34 个 / 10361 有两处加法错，
> 已逐项 `wc -l` 复算：`src-tauri/` 实为 12 个、`scripts/` 实为 2168 行）。
> 上一次是 41 个 / 14328 行（2026-11-02 16:45，S10-7③ 之后）。**差 −8 个文件 / −3959 行基本全是删容器**：
> 9 个 Electron 文件走掉（`verify-electron.js` 2411 + `main.js` 555 + `state.js` 435 + `risk.js` 375 +
> `permission.js` 140，另加 `server.js` / `preload.js` 27 / 两份 preload）；同期 `scripts/preview-shot.js`
> 换宿主重写（249 行，结构完全不同）、新增 `scripts/sign-release.js`（128 行）。
> 另有 `src-tauri/target/`（约 4.5 GB，含打包产物 `bundle/nsis/*.exe`）与 `src-tauri/gen/` 两个纯生成目录，
> **都不进台账也不进 git**。
> 配了巡检脚本 `node docs/ledger/scripts/check-filemap.js`，可发现「代码里有、台账没记」的文件；它只报告，不改本文件。

## 目录结构

```text
clawd-starter/
├── src/                 渲染层（全部前端代码，无框架无构建）
│                        三个窗口：桌宠（index.html）/ 权限气泡（bubble.html）/
│                                  会话看板（dashboard.html）
│                        tauri-bridge.js 是 Tauri 侧的桥；port-file.js 是端点约定（含默认端口）
├── src-tauri/           Tauri 容器：Rust 后端 + capabilities + 图标
│                        src/{main,state,theme,risk,permission,server,sys,single}.rs
│                        build.rs 把 ../src 整个嵌进 exe；gen/ 与 target/ 是纯生成目录
├── themes/              主题包：<id>/theme.json + assets/*.svg（S7）
├── hooks/               agent hook 适配器 + 安装脚本（S4 / S5）
├── scripts/             调试工具 + 回归闸门 + 打包验收 + 签名 + 截图 + 主题打包 + 图标生成
├── docs/ledger/         开发台账（本项目文档）
├── preview.html         静态预览页，浏览器直接打开
├── preview-bundle.js    由 themes/ 生成，只给预览页吃
├── README.md            项目说明、使用手册、代码签名、踩坑
├── package.json         0 依赖，只有脚本（`dependencies` / `devDependencies` 都空）
└── （无运行时文件落盘）
```

> 端点文件已从项目根目录迁到 userData：`%APPDATA%\clawd-starter\clawd-starter.port`（JSON：`{port, token}`）。见 SECURITY.md SEC-02 / SEC-10。
> **hook 侧一行不用改的原因**：端点文件的路径规则与格式从 Electron 时代起就没动过（`port-file.js` 把它写成"纯 Node 也能算出来"）。
> **这就是全部落盘内容**——S8 曾经往同目录的 `mailbox/` 写信，2026-10-30 整套删掉了，所以现在**没有任何用户内容会落盘**（见 DEVLOG 10-30）。

## 源文件职责

| 文件 | 阶段 | 职责 | 备注 |
|---|---|---|---|
| `src/bubble.html` | S5 | 气泡页面：CSP `default-src 'none'`、圆角卡片、工具名 / 命令 / 来源三行、两个按钮、回落说明 | 「允许」故意不做成主色——防止养成盲批习惯 |
| `src/bubble-renderer.js` | S5 | 气泡渲染层：`textContent` 写入（命令是 agent 给的字符串，绝不当 HTML 解析）、点完立刻置灰防连点、**每次 render 先恢复按钮可用**、量高度回传主进程、Esc = 不表态 | **94 行**。恢复正常按钮那两行是修 bug 加的，别删 |
| `src/dashboard.html` | S6 | 会话看板页面：浅色卡片列表，每行 = 状态徽标 + 目录名 + 会话 id 前 12 位 + 闲置时长 + 「复制路径」按钮；顶部计数与「演示模式」开关；空状态提示 | **237 行**。CSP 与主窗口同款 `default-src 'none'`。`.dominant` 用左侧色条标出「桌宠此刻正在演的那条」 |
| `src/dashboard-renderer.js` | S6 | 看板渲染层：1s 轮询快照、按「最吵的排前面」稳定排序（error → … → sleeping，同级按闲置升序）、行节点复用 + `insertBefore` 调序（避免每秒重建导致闪烁和按钮失焦）、演示模式、`fmtIdle()` 人话时长。**2026-10-30 一行从 2 行变 3 行**：标题（最重的位置）／目录／`sid` + 工具名；没拿到标题的行加 `.untitled` 退回两行——**不给它留空的第三行**，那会让每条都多出一段死高度，看着像"还没加载出来" | **229 行**。所有外部字符串一律 `textContent`；演示模式**只掩盖显示**，数据照旧。**演示模式现在连标题一起藏**：标题是用户自己说的第一句话，里面出现客户名的概率比目录名还高 |
| `src/port-file.js` | S2 / S10-9 | 端点文件唯一真相：按平台算 userData 路径、写 `{port, token}`（0600）、读回并校验格式；**S10-9 起 `DEFAULT_PORT = 23333` 也住在这里** | **69 行**。删掉 Electron 时 `server.js` 整份没了，但这个数字还有消费者——`hooks/install.js` 装 hook 时要用它拼端点 URL。放在 `port-file.js` 而不是某个容器里是对的：它属于"端点约定"，与谁开这个端口无关。**别改这个数**：改了之后已装好的 hook 会全部指向旧端口 |
| `src/renderer.js` | S3 / S6 / S7 / S9 / S10 | 渲染层，**两条路径**：① **骨骼弹簧**（`rigType: ragdoll-spring-v2`）——JS 直接拼一只猫（SVG 模板 + 状态姿势表 + `SpringChannel` 二阶弹簧通道），状态切换靠过冲与滞后跟随而非交叉淡入；working 自带桌面场景（键盘 + 编辑器窗口 + 代码行生长）。② **帧序列**——双图层交叉淡入、按 fps 轮播、瞳孔位移插值。两条都经过 `svgNode()`（`DOMParser` + `ALLOWED_TAGS` + `url()` 出口管控 + `stdDeviation` 钳制）——**骨骼模板本身也走这条路**，不再用 `innerHTML`；`eyeTracking` / `gaze` 统一在分支**之前**算一次 `track`。S8 接管两个手势：**双击 = 开关看板**、**右键 = 弹原生菜单**（原来是"右键直接退出"，没有确认）。2026-10-30 信箱删掉后双击从"写信"改回看板——**手势不能空着**：桌宠没有标题栏，双击是用户唯一能自己试出来的动作。S9 鼠标停在睡着的猫身上 → 发 `pet:hover` 请主进程唤醒（**自己不切画面**），并把睁眼做成弹簧 `eyeOpen` | **1813 行**（S10-5 加了 `gazePushes` 探针 +4、注释 +5）。帧序列路径新增**表情变体**：一个状态可有多套资产，每次进入状态轮换一套（主资产先出）；`variantCursor` 存**当前选中**槽位——存"下一个"会让 `variant()` 比画面超前一格。`window.petDebug` 有 `setState` / `svg` / `gaze`+`unpinGaze` / `springs` / `eyeTracking` / `states` / `state` / `variant` / `timings` / `desk` / `builds` / `stateLog` / `events` / `wakeSends` / `gazePushes` / `eyeOpen` / `cast` / `solo` / `setKeyword` 十九个排查入口（`gazePushes` 是 S10-5 加的：容器换成 Rust 之后 gaze 走的是 `GetCursorPos` + 独立线程，瞳孔位置证明不了链路通不通，只有计数能）——**它同时是回归唯一能看到内部状态的窗口，不是便利工具**，而且每个出口都得有一条断言证明它自己有货（`springs()` 曾经因为读了不存在的字段而永远返回 `{}`）。`window.VISUAL_STATES` 是「给外面看进来的」主题镜像，由 `adoptTheme()` 单点维护。**不要改宠物状态来提示用户**：状态在主进程手里，渲染层改成 notification 会被下一个 250ms 的 tick 顶回去（S8 想用这招提示"信寄出了"，被顶回去两次才记下这条）。视觉微调两条（**2026-10-29**，S9 的次日，用户看完界面之后提的）：① 躯体是**手绘 path 不是椭圆**——正椭圆 rx54×ry32 + 头宽 104 + 体宽 108 = 雪人，而完美椭圆弧本身就是"圆"的来源；现在是肩 y112 宽 56（被头盖住）/ 腰 y146 最宽 100 / 底 y177 略平，动它要连看后爪（cx57/143 只露月牙）、前爪（cx68/132 在体内）、working 键盘（y162 起）。② 删掉 `#rig-torso-patch`（cx112 cy134 的米色椭圆）——没描边、比身体暗一档、位置偏右上，读起来就是肚子上的一块污渍。S9 三条：① 醒来的"慢慢"靠**两条曲线**——躯干/头/耳/尾的 28 个弹簧通道本来就有过冲和滞后；眼睛与头顶 zZz 共用 `eyeOpen`（0=闭 1=睁，临界阻尼 ≈0.5s），否则眼睛会"啪"一下睁开而 Z 还挂着；② 眨眼仍然**硬切**（150ms 的事，慢慢眨眼看起来像卡住），睡眠过渡才走弹簧。这两个刻意不一样；③ 胸口大毛领 `#rig-ruff` 2026-10-28 删了（只跟呼吸联动的装饰件，躯干本身仍在呼吸），**删部件要连校验探针一起改**：`verify` 里"每帧都在重算"的探针原本读它，不改就是读 `missing:rig-ruff`。**S10 三条**：① **头巾** `#rig-bandana`（tail/knot/band/高光/`#rig-bandana-text`，画在头部轮廓之后、腮红之前），`setKeyword()` 没词就把整条 `display:none`——留一条空布带看着像随机装饰；字号按字数分档（2 字 16px → 7 字 9px）。② **分身** `applySessions()` 是唯一总开关：≥2 条会话每条一只猫（横排，`OVERLAP_RATIO` 0.32 重叠，点击 `focusCat()` 切聚焦），≤1 条**完全走原单猫路径**，`castMode` 保证两条路不同时在场；多只猫的渐变 id 必须带 uid 后缀——`url(#id)` 是**全文档**查找不是 svg 内，两份同名渐变平时没差别，改其中一份就变成"只有第一只猫变色"且不报错。③ **退场分两种**：会话还在（太久没动静 / 被 `MAX_CATS` 挤掉）→ 淡出 1600ms；会话不在了（`SessionEnd` / 清场）→ 立刻收。两个调用点都传 `immediate=true` 的那版里，CSS 那条过渡是**死代码**，谁也没见过"慢慢消失" |
| `src/theme.js` | S7 | 主题加载的 **JS 侧残留**：`listThemeIds()` / `loadTheme()`，只被 `scripts/build-preview-bundle.js` 用（把 `themes/` 打成预览数据包）。**运行时不走这里**——桌宠的主题由 Rust 侧 `theme.rs` 校验，经 IPC 交给渲染层 | **478 行**。删容器时特意保留：它不是 Electron 专属，是"预览构建"的依赖。校验规则与 `theme.rs` 必须同步，两边分叉的表现是"预览里好好的、桌宠上加载失败"（或反过来） |
| `src/tauri-bridge.js` | S10-5 / S10-6② / S11 | **Tauri 侧的上下文桥**：S10-6 起自己拼 `__TAURI_INTERNALS__.invoke` + `plugin:event|listen`（`withGlobalTauri` 已关）在 `window` 上装出与 `preload.js` 形状相同的 `clawd`（15 个动作；S10-10 加了 `setHitRects` / `hitState`，S11 加了 `dshState`）/ `bubble`（4 个）/ `dashboard`（5 个）。Electron 下第一行就 `return`（没有 `__TAURI__`），所以**三份 HTML 两边共用一份** | **179 行**。两处不能照抄 Electron：① `listen` 是异步的，而 `ipcRenderer.on` 是同步的——三个渲染层都是「先 on、后 ready」的顺序假设，所以每条通道在**脚本加载时**就挂上、`ready()` 再显式等一次那条 Promise（气泡握手靠这个，否则第一个权限请求会在监听器挂上之前被 emit 掉）；② `send` 必须吞异常——`ipcRenderer.send` 从不 reject，渲染层因此一行 catch 都没写，而 `invoke` 会 reject。还刻意**没有把 `__TAURI__.core.invoke` 挂出去**：漏了它渲染层就等于拿到一个「调用任意命令」的通用口子，19 个命令的边界全白设（回归有一条断言钉这个） |
| `src/index.html` | S1 / S7 | 窗口页面：CSP meta、透明背景样式、双图层容器、`#hint` 提示条。**S7 起不再引 `visuals.js`**，只加载 `renderer.js`——帧数据走 IPC | **95 行**。CSP 为 `default-src 'none'` + 白名单（曾被整块删过一次，见硬约束 20）。`#hint` 默认文案 `body:hover` 才显形，现在是「拖动我 · 摸头撸猫 · 双击看板 · 右键菜单」——**它把可用手势都写出来了**，因为桌宠没有标题栏，用户没别的地方可看 |
| `scripts/fake-feed.js` | S2 | 假数据源：从端点文件读 port+token 后 POST 事件，支持完整剧本 / 单事件 / `--hold` 保持状态 | S4 之后只用于离线调试，真事件由 hook 送 |
| `scripts/cdp.js` | S10-5 | 极简 CDP 客户端（Node 22 内置 `WebSocket`），**两个回归脚本共用**。`eval(expr)` 只做 `Runtime.evaluate` + `returnByValue`；`on(method, fn)` 收 `Runtime.exceptionThrown` 这类事件 | **104 行**。共用是刻意的：两个脚本比的是同一套判据，连「怎么把表达式丢进页面」都得是同一段代码，否则两边的绿没有可比性。`on()` 是这次加的——没有它，「页面抛过异常」这件事在只看 DOM 的断言里完全看不见 |
| `scripts/verify-tauri.js` | S10-5 / S10-6 / S10-7 / S10-9 | **唯一一道 UI 闸门**：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=` 开 CDP，跑 **80 条断言（当前 80 PASS / 0 FAIL）** ——桥的形状与「没漏 invoke」、`__TAURI__` 已不存在且 `__TAURI_INTERNALS__` 不可配置、三条越权调用被 Rust 白名单拒、单实例锁（第二份 5s 内退出 / 端点文件字节未变 / 原 token 仍 200）、主题经 IPC 拉回（证明 CSP 放行对了）、DOM 与弹簧在跑、HTTP 四道锁、`POST /state` 之后**画面真的跟着变**、分身/头巾/聚焦切换/上限、gaze 至少推过一次、权限气泡全链路（建窗 → 握手 → 投递 → 点按钮 → 回包文案固定）、critical 超时仍 204、看板与快照（含 SEC-09 不漏完整路径）、退出 204 收尾 + 端点文件删除；**陈旧二进制守卫**（源码 mtime 比 exe 新就拒跑） | **762 行**。`npm run verify:tauri`（跑 release）。S10-9 减掉一条（"自启的 Electron 侧与 Rust 侧对齐"随 `main.js` 一起失去对象），76 → 75；同轮把 gaze 的"造变化"从 3px 改 8px——阈值是 `0.02 × 260 = 5.2px`，3px 永远够不着（DEVLOG 2026-11-03）。**S10-10 补 5 条**（命中区签名 / hitState 三字段 / 盖住光标→关穿透 / 离开→恢复穿透 / gaze 线程节拍），75 → 80；同时加了 `SKIP` 机制：环境调不动系统光标时响亮跳过，不冒充 PASS |
| `scripts/preview-shot.js` | S3 / S7 | 把 `preview.html` 渲染成 `docs/<theme>-states.png`（七状态对照图），改完形象后用来目视确认「没改坏」。会先自动重建预览包，再按 `--theme=` 截对应主题；截图前**按 `scrollHeight` 撑开视口**（否则第二行永远被 640 视口切掉） | **249 行**，零第三方依赖。`finally` 里 `taskkill /T /F`——不然 GPU 子进程逃逸，下次启动报 `Unable to move the cache` |
| `scripts/build-preview-bundle.js` | S7 | 把 `themes/` 打成 `preview-bundle.js`。preview.html 是 `file://` 打开的静态页，`fetch` 读不到本地文件，只能打包 | 只给预览用；桌宠运行时不读它，所以包过期不会影响实际形象 |
| `scripts/diag-events.js` | S10-7② | 两个用法：**诊断**（读正在跑的实例 `GET /state` 的 `recent`，把 `how` 的六种取值翻成人话并给结论；端点文件在但没进程在听时会点名让你删哪个文件）；**回放**（`--replay` 起临时实例，把现场观察到的整轮事件序列照原样喂回去，每步拿显式期望值对照**服务端快照**与**渲染层画面**两个读数） | **241 行**。`npm run verify:diag` / 诊断模式 `npm run diag:events`。它是问题 1 的定案证据：thinking 掉 idle 与压缩后掉 idle 是同一个根因（补发 `SessionStart` 清空已有会话），10 步全中期望。**第一版报过假警报**——在 `petDebug` 挂上之前就读渲染层，把自己的时序读成了 bug（硬约束 40）。回放序列里特意放了两条 `SessionStart`（补发 + `source=compact`），它们是这条回归的靶心 |
| `scripts/make-icons.js` | S10-5 / S10-7③ | 零依赖手写 PNG（zlib + CRC32）+ ICO（内嵌 PNG），产出 `src-tauri/icons/{icon.ico(16/20/24/32/48/64/256),tray.png(32),icon.png(256)}`。tauri-build 在 Windows 上要一个 `.ico` 当资源图标，本机没有 PIL | **186 行**。S10-7③ 从"逐像素非黑即白"改成 **4× 超采样 + 覆盖率降采样**（RGB 只对覆盖样本平均，alpha = 覆盖率——直接全样本平均会把透明像素的黑色混进轮廓），≤24px 走**简化几何**（眼放大 1.6×、去鼻去内耳、耳加厚外移）——抗锯齿救不了"特征小于一个像素"（16px 时眼睛半径 0.94px）。仍是脚本画、不是设计稿 |
| `scripts/probe-tauri-surface.js` | S10-6② | 诊断：起一份临时实例，用 CDP 读「页面上还剩哪些能调后端的入口」——`__TAURI__` / `__TAURI_INTERNALS__` 及其属性描述符 / `window.clawd` 动作数 / 越权调一条命令看有没有被拒 | **95 行**。`node scripts/probe-tauri-surface.js --release`。留着它的理由：`withGlobalTauri` 关掉之后「通用口子还在不在」这个结论**不能靠读文档回答**，而且会随 Tauri 版本变；这个脚本一分钟能重测一遍 |
| `scripts/verify-bundle.js` | S10-6④ | 打包验收：配置（`active` / `targets` / `.ico` / `currentUser`）、产物（体积 / 版本号 / MZ 头），加 `--install` 再**真装 → 真跑 → 真卸**，25 条断言（当前 25 PASS / 0 FAIL） | **303 行**。`npm run verify:bundle`（只读）/ `npm run verify:bundle:install`（会改这台机器状态）。三条判据都是踩出来的：①「装出来的 exe 与裸 exe sha256 相同」是错的——bundler 会把 `__TAURI_BUNDLE_TYPE_VAR_UNK` 打成 `_NSS`（3 个字节），且文件里有 **6 处**同名占位符（`match` 的 6 个分支），要取**最后一处**；② 卸载后开始菜单 `.lnk` 比 exe **晚删**，必须等两个痕迹都消失再断言，否则下一轮的基线断言会红；③ 本想用注册表 `Uninstall` 子键判断卸干净，但本机安全策略拦 `reg.exe`，改用「安装目录 + 快捷方式来去」两个落盘痕迹（**没有**用 PowerShell 的注册表 provider 绕过） |
| `scripts/sign-release.js` | S10-9 | 发布物签名：被 `bundle.windows.signCommand` 以 `../scripts/sign-release.js %1` 调用（**cwd 是 `src-tauri/`**），也支持手工 `--verify <文件>`。证书来源看环境变量：`CLAWD_SIGN_PFX`(+密码) 或 `CLAWD_SIGN_THUMBPRINT`；强制 `/tr http://timestamp.digicert.com /td sha256` | **128 行**。两条硬规则写在文件头：**一个都没配 = 响亮跳过（退出 0）**，**配了却签失败 = 退出非 0 让打包红**——不允许"以为签了其实没签"。日志一律 ASCII（stdout 会被 makensis 的管道重编码，中文变乱码）。`findSigntool()` 从 Windows SDK 按版本号倒序找 |
| `src-tauri/Cargo.toml` | S10-5 | Rust 依赖清单：`tauri`（`tray-icon` + `image-png`）、`serde`/`serde_json`、`regex`、`tiny_http`、`windows-sys`（6 个 Win32 feature） | **每多一个插件就多一块常驻内存**——这是选择不用 `tauri-plugin-*` 系列的理由，需要的能力都自己用 `windows-sys` 写（`sys.rs` 一共 91 行）。`tiny_http` 而不是 axum/tokio：同步阻塞模型对两个端点足够，省掉整个 async 运行时。release profile 开了 `lto` / `codegen-units=1` / `opt-level=s` / `panic=abort` / `strip` |
| `src-tauri/tauri.conf.json` | S10-5 / S10-6 | `frontendDist: ../src`（**前端资源编译期嵌进二进制**）、`windows: []`（三扇窗全部代码里建）、`withGlobalTauri: false`（S10-6② 关掉）、`bundle.active: true` + `targets: ["nsis"]` + `installMode: currentUser`（S10-6④ 打开） | 33 行。~~`withGlobalTauri` 是桥接的前提~~——S10-6② 已关掉，桥改成直接用 `window.__TAURI_INTERNALS__`（那个摘不掉，见 SECURITY 第二节）。打包侧：`currentUser` = 不要管理员权限；没配 `webviewInstallMode`，走默认的 `downloadBootstrapper`（**离线机器装不上，见 PROJECT 已知限制**）。**代价要记住：改一行前端也要 `cargo build`**，不是 Electron 那种即改即看 |
| `src-tauri/capabilities/default.json` | S10-5 | Tauri v2 的权限清单：只给 `core:default` + `set-ignore-cursor-events` / `start-dragging` / `set-position` / `outer-position` 四个窗口能力 | 13 行。**刻意不给 fs / shell / http**——渲染层需要的每一样能力都是自己写的 command，漏给一个 fs 就等于把整个文件系统开给页面 |
| `src-tauri/src/main.rs` | S10-5 / S10-6 / S10-7① / S10-10 / S11 | Rust 侧的主进程：组装 `AppState`、19 条 `#[tauri::command]`、7 个后台线程（250ms 心跳 / 1s 分身 / **1s DSH 探测** / 100ms gaze / **60ms 命中看门狗** / 16ms 拖动轮询 / 2s 锁屏）、托盘（S10-7① 起含「开机自启」`CheckMenuItem`，勾从注册表读回、写成功才动勾）、退出清理 | **1065 行**（S10-6 加了每窗口命令白名单，16 条命令各多一个 `window: WebviewWindow` 参数 + 一句 `only()`；S10-7① 加托盘勾选项与 `toggle_autostart()`；S11 加 DSH 探测线程与 `dsh_state`）。和 `main.js` 的对应关系写在文件头（`ipcMain.on/handle` → command、`webContents.send` → `emit`、`screen.getCursorScreenPoint` → `GetCursorPos`、`powerMonitor` → 轮询 `OpenInputDesktop`）。**三条硬教训**：① 同步 command 跑在主线程上，**在里面建窗会卡死在 WebView2 的创建回调**（`dashboard_toggle`），`app.exit()` 也会因为消息循环没人泵而失效（`app_quit`）——两处都改成 `std::thread::spawn`；② `show_bubble` 在 `bubble_ready == false` 时**必须先把窗建出来**，否则页面永远不加载、永远收不到 ready、请求挂到超时（权限气泡在「第一次使用」时是死的）；③ DSH 线程**必须自己 emit**：`Store::apply()` 内部会调 `tick()`，而 `tick()` 顺手把 `last_visual` 更新了，所以 250ms 那个心跳线程比较时看不到这次变化，不在这里推就永远不发出去 |
| `src-tauri/src/state.rs` | S10-5 / S10-9 / S11 | `state.js` 的等价重写（**2026-11-03 起唯一实现**）：`Visual` 枚举 + `priority()`、`EVENT_STATE` 映射、oneshot、入睡、`tick()`、`snapshot()`、入参清洗与 SEC-09 两层（`cwd` 存全、快照只出 basename） | **632 行**，7 条单测。**`oneshot_ms` 被提成自由函数 `oneshot_ms_with(&Timings, Visual)`**：做成方法的话，`sessions.values_mut()` 循环里就再也借不到 `&self`（E0502）。同理 `tick()` 先 `clone()` 时长表、`apply()` 先算 `target_oneshot`。`snapshot()` 按 id 排序——HashMap 迭代顺序不稳定，回归要可比。S11 新增 `Meta` 事件：只带元数据、**不动状态**（DSH 的标题是一轮进行中回填的，落地时没有状态变化可搭载）；`apply()` 里 title 的赋值本来就在 match 之前，所以它天然只改元数据，要做的只是别当未知事件报警 |
| `src-tauri/src/dsh.rs` | S11 | **DSH 适配层**：读 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`（一会话一文件），把观测**翻译**成既有 hook 事件词汇（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Stop` / `SessionEnd` / `Meta`）交回 `state.rs`——**不另起状态机** | **852 行**，14 条单测。三层：`parse_session()`（纯函数，只认 `{version, record:{identity, rows}}`，拿不到就 `None`）、`Probe::refresh()`（扫目录，按 `(mtime,size)` 只重读变过的那个）、`Probe::reconcile()`（判变化 → 出事件）。四个跑出来才知道的事实：① 同级 `session_projcache.json` 是 **0.1.x 遗留**（读它不报错、只安静地一只猫不显示）；② **会话 id 只在文件名里**，record 内没有；③ `openStep` 在步骤之间也会变 null，所以「这一轮结束」要 **2 拍去抖**；④ `headless` 会话**没有 `sessionStats`/`sessionListMetadata`**，`lastPromptAt` 缺失时回退文件 mtime。**刻意不读 `session.v4.jsonl.zstd`**（多帧 zstd，要引解压依赖）。v1 只有「看」，没有工具名（`pendingCalls` 是 `callId → 时刻`） |
| `src-tauri/src/risk.rs` | S10-5 / S10-9 | `risk.js` 的等价重写，**2026-11-03 起是唯一实现**（JS 版随 Electron 删除） | **761 行**，5 条单测，其中 `levels_match_the_js_cases` 用的是历史上与 `verify-electron.js` 同源的 16 条用例——**JS 侧没了，这批用例就是判据的存档**，改名之前先想清楚它在守什么。**`regex` crate 不支持环视**，两处否定前瞻必须改成显式逻辑：`(?:^|[^>])>(?!>)` → `has_single_gt()` 逐字符扫；`DELETE FROM (?!…WHERE)` → `is_delete_without_where()` 两步。全部正则用 `OnceLock<Regex>` 惰性编译 |
| `src-tauri/src/theme.rs` | S10-5 / S10-9 | `theme.js` 的等价重写（**运行时唯一实现**；`src/theme.js` 只剩预览构建在用）：扫 `themes/`、校验 `theme.json`、资产名白名单 + `canonicalize()` 双保险、`timings` 归一化、缺失状态用 idle 兜底、全坏给内置兜底 | **543 行**，warnings 文案与 JS 版逐字对齐。`themes_dir()` 探测顺序：`CLAWD_THEMES_DIR` → cwd → exe 旁边 → `../../themes` → `CARGO_MANIFEST_DIR/../themes` |
| `src-tauri/src/permission.rs` | S10-5 | 裁决台：`Entry { view, tx: Sender<Outcome> }`，HTTP 线程拿 `Receiver` 阻塞等待；`settle()` 是唯一出口（`pending.remove` 保证二次点击落空） | **289 行**，4 条单测（决定只送达一次 / 超时不是 deny / risk 快照进 view / dispose 清空）。**已知差异**：tiny_http 没有 `res.on(close)`，对端掐断只能等超时兜底（结论仍是 204）。`create()` 里**只登记不等待**——在那里等会把 accept 循环卡死 |
| `src-tauri/src/server.rs` | S10-5 / S10-6③ | 本地 HTTP 服务（tiny_http）：`/state` `/health` 四道锁、`/permission` 三道；固定 23333，被占回退随机并告警；端点文件格式与 `port-file.js` 完全一致 | **329 行**，3 条单测。`/health` 多一个 `"lock":"event"|"poll"` 字段（S10-6③）：两种模式的失败长得一模一样，而"锁屏后没藏窗口"这类问题没法当场复现，有这个字段能一眼分清是注册失败还是隐藏逻辑坏了。**每条请求一个线程**（`/permission` 会阻塞到用户点为止，不分开第二条就被挡在门外）。`random_token()` 用 `RandomState` + 纳秒熵凑 64 位十六进制，不引入 rand crate。**`OnChange` 回调是这次补的**：`apply()` 内部已经调过 `tick()`，`tick()` 顺手更新了 `last_visual`，心跳再 tick 时比的是「新值 vs 新值」→ 变化永远推不出去 |
| `src-tauri/src/sys.rs` | S10-5 / S10-6③ / S10-7① | Win32 六件事：`cursor_pos()`／`work_area()`／`set_clipboard_text()`／`watch_session()`（消息专用窗口 + `WTSRegisterSessionNotification` + 自己的消息循环）／`is_locked()`（降级成兜底轮询）／`autostart_enabled()` + `autostart_set()`（S10-7①：HKCU `Run` 项，**值带引号**；删不存在的值返回 `ERROR_FILE_NOT_FOUND` 也算成功，"关"必须幂等） | **387 行**。锁屏从 2s 轮询换成事件：`HWND_MESSAGE` 建的消息专用窗口不显示、不进任务栏、不参与 Z 序，所以**不碰 tao 的消息循环**（框架的 WndProc 不归我们改，硬塞等于跟它抢消息）。只认 `WTS_SESSION_LOCK/UNLOCK`，同族的 REMOTE_DISCONNECT / LOGOFF 一律忽略——用户还在，只是换了显示通道。回调放在全局 `Mutex` 里：WndProc 是 C 函数指针，除了全局没有干净的地方放闭包，而一个进程只需要一个会话通知窗口。自启不用 `tauri-plugin-autostart`（连带 11 个包），只给 `windows-sys` 加一个 `Win32_System_Registry` feature + 五个 API。测试只默认验「关」：自启是进程外全局状态，测试崩溃会留真条目，「开」的往返要 `CLAWD_AUTOSTART_TEST=1` 点名 |
| `src-tauri/src/single.rs` | S10-6 | 单实例锁：`CreateMutexW` 抢命名互斥量（`acquire`）、第二份进程 `SetEvent` 捅第一份（`wake_first`）、第一份起线程死等（`watch`）。3 条单测 | **189 行**。选互斥量而不是锁文件：进程被强杀 / 崩溃 / 断电后锁文件会留下，pid 还会被复用；互斥量的句柄归内核，进程怎么消失都会被释放，**不需要任何清理逻辑**。**锁名带端点文件路径的 FNV 哈希**——不是洁癖：回归脚本用 `CLAWD_PORT_FILE` 指临时文件，就是为了能在"用户正开着桌宠"时跑；名字固定的话回归一启动就被自己拦住。哈希用 FNV-1a 而不是 `DefaultHasher`：后者输出没有跨版本保证，升一次 Rust 就可能换个锁名，那属于"能开两份"的隐形 bug |
| `src-tauri/build.rs` | S10-5 | `tauri_build::build()` 一行调用，编译期把 `tauri.conf.json` 和 capabilities 编译成 ACL 表，并把 `frontendDist` 指向的 `src/` 嵌进二进制 | 3 行。**它才是把前端塞进 exe 的那一步**——`tauri.conf.json` 只是声明；改了 `src/` 里的文件必须重跑 `cargo build`，只重启 exe 看到的还是旧页 |
| `src-tauri/Cargo.lock` | S10-5 | 锁定的依赖树 | 4445 行，**不计入行数统计**（生成物，但命令行程序必须提交，`cargo build --release` 才对所有人生成同一棵依赖树）。看一眼就有用的数字：`window_vibrancy` 在里面——透明/毛玻璃不是我手写的 |
| `hooks/clawd-hook.js` | S4 | agent hook 适配器，**只走一个方向**：读 stdin（2s 硬超时 / 1MB 上限）→ 只取 `session_id/event/cwd/tool_name/title` → 探端口 → POST（1.5s 超时）→ 永远 `exit(0)`。**不再往 stdout 写一个字节**（S8 的送信 2026-10-30 整套砍掉了）。`title` 由 `deriveTitle()` 在**本地**从 `session_title` 或 `UserPromptSubmit` 的 prompt 第一行推出来——**prompt 原文不进这条链路**，只有那一行派生结果出去；第一行命中 `TITLE_SECRET_RE` 就整个标题都不要 | **212 行**。**2026-10-30：Notification 的生命周期闲聊在源头滤掉**——`IGNORED_NOTIFICATION_TYPES = {idle_prompt, auth_success}`（这两个值抄自主仓库 `hooks/workbuddy-hook.js:30` 的实测注释：`idle_prompt` 是 Stop 之后约 60 秒的"再发一条消息吧"，`auth_success` 是每轮开头都发的登录 toast）。**必须在 hook 侧滤而不是交给状态机**：notification 一旦变成上面那个长状态，一条 `idle_prompt` 挂上来就是"猫凭空喊好几分钟"。是白名单式的（只丢明确列出的），没见过的 `notification_type` 照常放行。**2026-10-29：缺 `session_id` 的事件一律丢弃，绝不合成占位 id**（原来是 `|| "unknown"`）：多条真实会话会被塞进同一条幽灵会话，事件互相覆盖——A 正在 thinking，B 结束发一个 `Stop` → attention 播完回到 idle，**A 的画面就变 idle 了**。主仓库 `hooks/workbuddy-hook.js` 这条带着 bug 编号（#618 / #648），注释的原话是合成 id 会造出一个"后面的事件既更新不了也清除不掉"的幻影会话。`trim()` 之后再判空，否则 `"   "` 是 truthy 字符串会被当成有效会话号；警告走 stderr——**stdout 在 `UserPromptSubmit` 上是协议**（会被宿主收进上下文）。三条铁律：不阻塞、不打日志（**现在连"协议输出"都不存在了**，所以这条就是字面意思：什么都不打印）、不抛异常。stdin 排在探端口之前，这个顺序最初是为送信定的；送信砍掉后它是个**待议项**（单看收这一路，先探端口更省），改之前要想清楚宿主把 payload 写进管道时我们已经退出的后果 |
| `hooks/install.js` | S4 / S5 | 多 agent 安装器。`AGENTS` 表驱动 `--agent claude\|codebuddy\|workbuddy`，往对应 `settings.json` 的 `hooks` 段增量合并：观察型 command hook（按 agent 决定是否写 `async: true, timeout: 5`）+ 权限条目（只有 `permission: "http"` 的 agent 才装；WorkBuddy 原生处理权限，装的是死配置）。marker 只认自己的条目，备份 + 临时文件 rename 原子写，支持 `--uninstall` / `--dry-run` / `--file` | 观察型 hook 不能拖住 agent，权限 hook 反过来必须拖住——**两种语义相反，不要统一** |

## 其他文件

| 文件 | 职责 | 备注 |
|---|---|---|
| `preview.html` | 静态预览页，浏览器打开可一次看完某个主题所有状态的 SVG 与帧序列；顶部有主题下拉框，支持 `?theme=ragdoll` | 不参与运行，纯设计对照用 |
| `preview-bundle.js` | `themes/` 的打包产物（约 125KB），由 `npm run build:preview` 生成。preview.html 通过它读数据 | 生成物，**不要手改**；它过期只影响预览，不影响桌宠 |
| `themes/**` | 主题资产：`<id>/theme.json` + `<id>/assets/*.svg`。现有 `ragdoll`（默认，骨骼弹簧，写了 `timings`）与 `_template`。**crab 已删**（2026-10-28）——它原本是第二个内置主题兼帧序列用例，用户说不需要更多主题（下划线开头 = 不参与主题列表） | 整目录登记，不逐帧列。契约与字段说明见 `themes/README.md` |
| `src-tauri/icons/**` | `icon.ico`（Windows 资源图标，tauri-build 编译期要，S10-7③ 起 **7 个尺寸** 16/20/24/32/48/64/256）/ `icon.png` / `tray.png`（托盘）。**三个都由 `scripts/make-icons.js` 生成**，不是设计稿 | 整目录登记。图案是猫头——要换真图标就改 `make-icons.js` 重跑，别手改 PNG |
| `src-tauri/gen/**` | Tauri 构建期生成的 ACL schema 快照（`schemas/{acl-manifests,capabilities,desktop-schema,windows-schema}.json`） | 整目录登记。**每次 `cargo build` 都会重写**，不手改、不进 git（已写进 `.gitignore`） |
| `docs/ragdoll-states.png` | ragdoll 的七状态对照图（crab 的那张随主题一起删了） | 用法见 npm run preview:states。**注意它截的是 `preview.html` 里的帧序列资产，不是骨骼路径那只猫**——删围兜、改身材这类改动都不会反映到它上面，别拿它当"改坏了没"的判据 |
| `README.md` | 项目说明、已验证能力清单、故意的简化对照表、12 条踩坑记录 | 踩坑部分是同类项目最有价值的参考 |
| `package.json` | S10-9 | **0 依赖**（`dependencies` / `devDependencies` 都是空的），只有脚本：构建、打包（含签名）、hook 安装、三道闸门、预览、图标 | 删掉 Electron 之后 `npm install` 只剩一个空壳——这是刻意的：**装一个桌宠不该先装一坨 node_modules**。`bundle` 末尾串了补签裸 exe 那一刀（原因见 README「打包时的两个硬性事实」） |
| `package-lock.json` | S10-9 | 依赖锁定，现在**不含任何包**（electron 计数归 0） | 留着它是为了"将来真要加 devDependency 时行为一致"，不是为了好看 |
| 端点文件 | 运行时产物，**不在项目内**：`%APPDATA%\clawd-starter\clawd-starter.port` | 内容 `{port, token}`，权限 0600；删除后重启即重新生成。**这是全项目唯一会落盘的东西**，其中没有用户内容 |
| `.gitignore` | 忽略 node_modules / .clawd-port / dist / .idea / `NVIDIA Corporation/` / `src-tauri/target/` / `src-tauri/gen/`；**S10-9 加 `*.pfx` / `*.p12` / `signing.local.json`** | 签名私钥落在仓库外的 `~/.clawd-signing/`，这几条是防手滑把私钥导进项目 |
| `docs/ledger/*` | 开发台账：PROJECT / PROGRESS / SECURITY / FILE_MAP / DEVLOG | 本目录 |

## 数据流

```text
Claude Code 事件
        │  spawn: node hooks/clawd-hook.js <Event>   （async，不等它退出）
        ▼
  clawd-hook.js：读端点文件 → 读 stdin → 只挑 4 个字段
        │  POST http://127.0.0.1:<port>/state  {session_id, event, cwd, tool_name}
        ▼
   server.rs ──► state.rs（事件→状态→优先级仲裁→oneshot 回落）
                        │ OnChange 回调（visual 变了才发）
                        ▼
                  main.rs emit("state")
                        │ IPC "state"
                        ▼
                  renderer.js setState ──► 骨骼弹簧重算 / 帧序列取帧 ──► SVG 上屏

  主进程 100ms 线程采样光标（GetCursorPos）──emit "gaze"──► renderer.js 插值 ──► 瞳孔 transform
```

**S11 起有两个事件来源，都汇进同一个 `state.rs`**（这是刻意的：另写一套状态机
等于把「同一 agent 演出两幅画面」重新造出来）。下面这条完全不走 HTTP：

```text
  $DSH_HOME/storages/session_projcache/sessions/<id>.json（一会话一文件）
        │  主进程 1s 线程：扫目录 → 按 (mtime,size) 只重读变过的
        ▼
   dsh.rs：openStep / firstTokenTime / pendingCalls / plan.active / title / cwd
        │  翻译成既有词汇：SessionStart / UserPromptSubmit / PreToolUse / Stop / SessionEnd / Meta
        ▼
   state.rs Store::apply()（与上面那条**同一个**状态机）
        │  ⚠ 这条支路必须自己 emit：apply() 内部会调 tick()，
        │    而 tick() 顺手更新了 last_visual，250ms 心跳线程因此看不到这次变化
        ▼
   main.rs emit("state")
```

S9 加了一条**上行**支路，方向和事件流相反（渲染层 → 主进程），而且只走一个动作：

```text
鼠标停在猫身上（mousemove → elementFromPoint 命中 #pet）
        │  仅当 currentState === "sleeping"，且距上次 ≥500ms
        │  IPC "pet:hover"（无载荷）
        ▼
   main.rs pet_hover() → state.wake()
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
   server.rs  /permission（Host / Origin / Content-Type 三道，不校 token）
        │  交给 permission.rs 挂起，HTTP 响应先不回
        ▼
   permission.rs create() ──onRequest──► main.rs show_bubble()
                                              │ 懒创建气泡窗口 + 等 bubble:ready 握手
                                              ▼
                                    bubble-renderer.js render()
                                              │ 用户点「允许」/「拒绝」/ 按 Esc
                                              ▼
                                    IPC "permission:decide"
                                              ▼
                                    permission.rs settle()  ← 唯一出口
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
   main.rs toggle_dashboard()：懒创建窗口 / 已可见则 hide
        │  贴着桌宠定位，上方放不下就翻到下方
        ▼
   dashboard-renderer.js  setInterval(tick, 1000)
        │  invoke "dashboard:snapshot"
        ▼
   state.rs snapshot()   ← SEC-09 快照层：cwd 只是 basename
        │  排序（error 优先）→ 复用行节点 → insertBefore 调序
        ▼
   看板 DOM

  用户点某行「复制路径」
        │  invoke "dashboard:copy-path", id
        ▼
   main.rs dashboard_copy_path()：store.full_cwd(id)（存储层，完整路径）→ 剪贴板
            伪造 id 拿到 None → 返回 false，什么都不写
```

为什么要轮询而不是推送：`idleMs` 本来就随时间变，即使没人发事件也得刷新。推的话还要维护
一套「什么时候该推」，而轮询一个本地 IPC 的代价近似为零。

主题是**第四条流**，它在状态流之前发生，而且分成主进程/渲染层两段校验：

```text
启动
  │
  ▼
 theme.rs 解析：环境变量 → 命令行 → 上次选的 → 内置默认(ragdoll)
  │  ① 只认 readdir 出来的真实目录名（外部传什么都不拼进路径）
  │  ② theme.json 字段校验（schemaVersion / 状态名 / fps 范围）
  │  ③ 资产名白名单正则 + 解析后仍在 assets/ 内（双保险防穿越）
  │  ④ 单文件 256KB / 主题 4MB / 单状态 12 帧
  ▼
 currentTheme（含全部帧字符串）──► 建窗（main.rs）
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
