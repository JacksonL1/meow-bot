# 进度 — clawd-starter

> 阶段划分见 PROJECT.md。每完成一格，同步更新下面的「安全状态」表——**安全和功能一起算完成，不算两件事**。

## 当前目标

S1–S10 全部完成。**2026-11-02 补上 S10-5：容器从 Electron 换成 Rust（Tauri 2.12.5）**，
渲染层一行没改（靠 `src/tauri-bridge.js` 把 `window.clawd` 装回去）。
同一天做完 **S10-6 收尾四项**：单实例锁、关掉 `withGlobalTauri` + 每窗口白名单、
锁屏改事件、**打出 NSIS 安装包并真装真卸验过**。

**2026-11-03：Electron 容器整套删除，Tauri 成为唯一容器**（S10-9，见下方「已完成」）；
同一天接上发布物签名（自签名证书已在本机跑通端到端）。
现在只剩**一道 UI 闸门**，原来那行 Electron 的 193–194 已成为历史注脚。

四道闸门同时是绿的，前两道**判据同源**（后两道管的是"用户装不装得上 / 状态掉不掉"，判据天然不同源）：

| 闸门 | 脚本 | 结果 | 断言数 |
|---|---|---|---|
| Tauri 2.12.5 + WebView2 | `npm run verify:tauri` | **106 PASS / 0 FAIL** | 106 |
| Rust 单测 | `cd src-tauri && cargo test` | **43 passed / 0 failed** | 43 |
| 打包（NSIS 安装包） | `npm run verify:bundle:install` | **25 PASS / 0 FAIL** | 25 |
| 状态回放（真实事件序列） | `npm run verify:diag` | **10 步全中期望** | 10 |
| Rust 依赖审计 | `cargo audit`（见 SECURITY「依赖审计」） | **0 漏洞 / 2 条警告**（都不在 Windows 构建图里） | 1402 条公告 / 425 个依赖 |

`verify:diag` 的位置特殊：它**起一份临时 Tauri 实例，把现场观察到的一轮事件
照原样喂回去**（SessionStart → UserPromptSubmit → 补发 SessionStart → 工具 →
PreCompact → 压缩后的 SessionStart → UserPromptSubmit → Stop → SessionEnd），
每一步都拿「期望值」对照**服务端快照**和**渲染层画面**两个读数。
它钉死的就是用户报的问题 1：thinking 不许掉、压缩后不许回 idle。

**75 这个数比迁移当天少 1，是因为删掉了一条依赖 Electron 的断言**（见 S10-9）：
原来有一条"自启的 Electron 侧与 Rust 侧是否对齐"，`src/main.js` 没了，这条判据失去了对象。
其余的减法都发生在迁移当天：Electron 的 191 条里有 12 条打的是主进程 Node inspector 的
`BrowserWindow` 属性，Rust 侧没有对应物，迁移时就没有搬。
两边共用 `scripts/cdp.js`——同一套判据必须用同一段代码丢进页面，否则两边的绿没有可比性。

> 历史（Electron 时代，2026-11-03 前的读数）：`npm run verify:electron` **193–194 PASS / 0 FAIL**。
> 那个区间不是笔误：`剪贴板拿到的是完整路径` 要先读回主进程写进剪贴板的值，而 Windows 上只要有
> 别的进程（剪贴板管理器、另一个 Electron）正握着剪贴板，`readText()` 就返回空串。重试 6 次
> 仍不一致时会做一次"能不能读写"的探针，探针也失败就**打印** `[warn] 本环境读不到剪贴板内容，
> 跳过校验` 然后少跑一条——跳过是响的，不是静默的。看闸门认的是 **FAIL=0**，不是 PASS 的绝对值。

打包那 25 条里，只有 10 条是随时可跑的（读配置 + 看产物）；另外 15 条要往这台机器上
真装一份再卸掉，所以挂在 `--install` 后面。**"装得上"和"跑得对"是两件事**，
`cargo build` 绿说明不了任何一条。

**内存这件事必须说清楚**（用户原目标是"常驻 15MB 以内"）。同一个 release 构建测了两次，
**两次互有高低**，所以两次都列出来：

| 测量 | | 进程数 | RSS | 私有内存 |
|---|---|---|---|---|
| 上午（S10-6② 后） | Electron 45 | 4 | 370.1 MB | 221.2 MB |
| | Tauri 合计 | 7 | 383.4 MB | 213.6 MB |
| | └ Rust 宿主 | 1 | **34.3 MB** | **11.2 MB** |
| | └ WebView2 子进程 | 6 | 349.1 MB | 202.4 MB |
| 12:10（S10-6④ 后） | Electron 45 | 4 | 350.8 MB | 203.1 MB |
| | Tauri 合计 | 7 | 379.6 MB | 211.8 MB |
| | └ Rust 宿主 | 1 | **33.9 MB** | **10.4 MB** |
| | └ WebView2 子进程 | 6 | 345.7 MB | 201.4 MB |

**差值（两次合计 ±30MB）比两者的差距还大**，所以能说的只有一句：**整机基本持平，
谁也省不出量级**。上午那组 Tauri 略重、下午那组 Electron 略轻，都不是结论，
是噪声——写台账时不要拿单次采样去证明"换容器更省内存"。

**Rust 宿主自己 10–11MB，达标；整机没达标，而且不可能达标**——窗口里跑的还是 Chromium。
换容器换掉的是"多一层 Node 运行时"，不是"多一层浏览器"。要到 15MB 只有原生自绘一条路，
用户已经明确否掉了。这个结论写在 `PROJECT.md` 的取舍里，不要下次再当新问题重开一遍。

布偶猫主题按用户反馈改了三轮，第三版是一版外部重写（60fps 弹簧物理渲染器）。
**working 最终定为「桌前敲键盘」**。**内核到此为止**。
S9 是第一条**上行**通道：鼠标停到睡着的猫身上，它慢慢睁眼醒过来。

S8 的「跟桌宠说话」**2026-10-30 整套删掉了**（理由见下方被划掉的那一节），它留下的只有右键菜单和双击手势——现在两者都开关看板。

**真实 agent 会话验证这件事已经开始了**——用户在 WorkBuddy 上实测，报回三个问题：
1. thinking 时显示成 idle、压缩上下文时变 idle（**根因未定**，见「待办」）
2. working 中途睡着（**已修**：睡意只能从 idle 累计）
3. 双击有什么用 / 能不能跟桌宠说话（**已关闭**：试过之后确认做不到"直接发送"，写信这条路也一并砍了。双击现在开关看板）

剩下的：
- 主题再做就超出"骨架"范围了：需要图片解码器（GIF/APNG）、缩略图、在线目录，那是产品

## 进行中

- **问题 1 的根因**：等用户把 `petDebug.events()` 的输出发来。已定位两个最可能的元凶：`SessionEnd`（删会话后 `dominant()` 直接返回 idle）、或 `EVENT_STATE` 漏映射（漏的事件会进 `recent` 里标 `ignored`，并被终端告警）

## 待办

### 已验证但未覆盖真实环境的部分

- [x] ~~**问题 1 的根因未定**：thinking / 压缩上下文时掉成 idle~~ → **S10-7② 已定案**（见下）：
      两个症状同一个根因——补发的 `SessionStart` 把已有会话清空，S10-6③ 的
      "preserved" 修复就是根因修复；回放一轮真实事件序列 10 步全中期望值，
      并落成第 5 道闸门 `npm run verify:diag`。诊断脚本第一版报的
      "UserPromptSubmit 也掉了"是**脚本自己读太早**（`petDebug` 还没挂上），不是产品 bug
- [ ] WorkBuddy 安装待用户在自己终端执行：`npm run install:hooks:workbuddy`（沙箱写不了 `~/.workbuddy/settings.json`）
- [ ] **看板上的「模型」与「上下文用量」**：WorkBuddy 的 hook payload 只有 7 个字段，两样都没有。主仓库证明它们来自 **Claude Code 的 `statusLine.command`**（`hooks/claude-statusline.js` 读 `model` / `context_window` / `rate_limits`），而那条 hook **只注册给 Claude**（`install.js` 的 `STATUSLINE_MARKER`）。要做就得单开一个阶段：装一条接管终端状态行的脚本，契约是"必须永远快速打印点东西、绝不抛异常"。**在此之前不硬写空字段**（硬约束 25）

### 已知的能力让渡（不是 bug，是选择）

- [ ] 主题只支持 SVG。GIF / APNG / WebP 要写解码器，没做
- [ ] 主题不能用 `<style>` 做 CSS 动画（只能用帧序列）。换来的是「主题文件里没有可执行的样式入口」
- [ ] 没有在线主题目录，主题只能手工放进 `themes/`。换来的是供应链攻击面为零
- [x] ~~状态时长（25s 发呆 / 60s 入睡）仍写死在 `state.js`~~ → **已进 `theme.json.timings`**（2026-10-28）。注意原来写的「25s 发呆」是个误会：那个 `IDLE_AFTER_MS` **从头没有消费者**，连配置项都算不上，已删（见 DEVLOG）。搬过去的是 `oneshot` 三个时长 + `sleepAfterMs`

## 已完成

### S11 接上 DeepSeek Harness：先只要「看」（2026-11-04）

用户放弃 WorkBuddy 接入线，改用 **DeepSeek Harness（DSH）**，明确要求「**先保证能看，后面视情况再加说**」。
所以本轮只做**读**，一个字都不往 DSH 里送。「说」的可行性已探明（见下），但不落地。

**架构决定：翻译，而不是另起一套状态机。**

DSH 的观测被翻成已有的 hook 事件词汇（`SessionStart` / `UserPromptSubmit` / `PreToolUse` /
`Stop` / `SessionEnd` / `Meta`），灌进 `Store::apply()`。这样优先级、oneshot 时长、睡意计时、
多会话仲裁**一行都不用重写**。反过来说，另写一套状态机就是把 2026-11-03 刚消灭掉的
「同一 agent 演出两幅画面」重新造出来。

**数据源：`$DSH_HOME/storages/session_projcache/sessions/<id>.json`（一会话一文件）。**

这条路径是**踩了坑才找对的**，三个事实都不在文档里：

1. 同级的 `session_projcache.json`（单文件、全量）是 **0.1.x 的遗留**，本机那份停在 2026-08-31。
   读它不会报错，只会安静地一只猫都不显示——**比报错更难查**。
2. 0.2.x 改成目录 + 每会话一个文件，形状 `{ version: 7, record: { identity, rows } }`，
   **会话 id 只存在于文件名**，record 里没有。
3. 每会话一个文件反而更好：按 `(mtime, size)` 只重读变过的那个，目录里躺几十个也不心疼。

**刻意不读 `session.v4.jsonl.zstd`**：那是 append-only 的多帧 zstd（每追加一次一个 frame，
单次解压只出第一帧——实测 14095 字节只解出 1 行，按 magic `28 B5 2F FD` 切帧后才是 42 帧 / 85 行）。
解压要引 zstd/ruzstd，而本项目的取舍一贯是「每多一块依赖就多一块常驻内存」。
投影缓存已经够画一只猫了，**唯一拿不到的是工具名**（`pendingCalls` 是 `callId → 派发时刻`，
不含名字），所以看板上那一格在 DSH 下是空的——这是诚实的缺口。

**状态怎么推（都是事实，不是猜）**：
- `lastPromptAt` 前进 → 新一轮 → `UserPromptSubmit`（thinking）
- `openStep` 存在但 `firstTokenTime` 为空 → 在等首字 → thinking；落地了 → working
- `pendingCalls` 非空 / `plan.active` → working（工具期 `openStep` 可能已是 null，靠它补）
- 连续 2 拍 idle → 这一轮结束 → `Stop`（attention）

**那个 2 拍去抖不是保险，是必需的**：`openStep` 的官方注释写着「null outside a step
**or after its message assembled**」——一轮里只要有工具调用，步骤之间 `openStep` 会短暂变 null。
不去抖就会在轮内反复喊「做完了」，猫一闪一闪。

**新增 `Meta` 事件**（`state.rs` 里约 10 行）：DSH 的标题是一轮进行中由 LLM 生成后回填的，
落地那一刻**没有任何状态变化可以搭载**。`apply()` 里 title 的赋值本来就在 match 之前，
所以这条事件天然只改元数据——要做的只是别把它当未知事件报警。没有它，气泡和看板
要到下一轮才会有标题。

**诊断出口** `window.clawd.dshState()`，与 `hitState` 同一个用途：「接上了但猫不动」时一次说清
死在哪一步——`installed=false` 是路径不对，`polls` 涨而 `reads` 不涨是文件真没变，
`reads` 涨而 `feeds=0` 是会话全 blank 或全在活跃窗口外。

**覆盖面的实话**：`dsh web` / 桌面版投影行齐全，状态完整；`dsh headless "…"` 的投影里
**只有 title，没有 `sessionStats` / `sessionListMetadata`**，连 `lastPromptAt` 都没有——
这类会话靠**文件 mtime** 兜底判「最近动过」，状态只能是 idle（它本来就是跑完就退的东西）。

**闸门**：`verify:tauri` 80 → **92**（+12：`dshState` 形状、`DSH_HOME` 覆盖生效、线程节拍、
缓存可读、四个字段解析、进状态机、变 working、标题与关键词、结束发 Stop、不再挂 working、
撤掉后收尾），`cargo test` 23 → **38**（+15）。**DSH 那段用临时 `DSH_HOME` 夹具**，
不拿本机真实缓存做断言——真实缓存里有几个会话、是否还在活跃窗口内由用户历史决定，
拿它断言等于让闸门看运气（第一版就是这么红的：本机所有会话都超过 30 分钟没动静，
那是**正确行为**）。夹具现造现撤，撤掉并等一拍再往下走，否则那只多出来的猫会把
后面「场上有几只猫」「attention 播完回 idle」全部带偏。

**「说」的结论（已实测，仍未落地）**：`dsh --profile headless --session-id <id> "消息"`
可以 adopt 已有会话并发一个新 turn，同一 sessionId 下 turn 从 1 递增，退出码 0/1 +
`turn_end.reason.kind`（`completed` / `aborted` / `interrupted` / `error`）构成**完整回执**。
所以它与当年被砍掉的「写信」**性质不同**——hook 是 fire-and-forget、永远 exit 0，
而这条路失败看得见，不落进硬约束 29 的陷阱。

#### 并发双写：DSH 有独占写句柄，**安全拒绝**而不是交错写

2026-11-04 实测。这是接「说」之前的唯一前置风险（Web UI 开着的时候再 headless 注入）。

**实验方法**：`dsh headless --patch <假端点> --session-id <S>`，假端点只接不回，
把 turn 卡在 LLM 调用上，于是「另一个进程同时写同一会话」的窗口从几十毫秒变成无限长。

| 实验 | 结果 |
|---|---|
| A 挂住，4s 后 B 抢同一会话 | B 立刻退出：`session "…" is already owned by an active write handle`，退出码 1 |
| **8 个进程同时抢** | **恰好 1 个拿到句柄**（`turn_start`），其余 7 个同一条错误、退出码 1 |
| 被拒的 7 个有没有污染日志 | **一个字都没写**：日志里只有胜者的 `user/message` |
| 日志完整性 | 10 帧全解开 / 24 行全合法 JSON / `seq` 0 重复 0 倒退 |
| A 被 `timeout` 强杀后，C 再进场 | **正常接管**（turn 接上），**没有僵尸锁** |
| 强杀留下的悬空 turn | 下次打开时被补成 `turn/end(reason: interrupted)`（`dsh-session` 的 repair 机制） |

两条结论：**① 并发不会被写坏，被拒的一方明确报错**——所以接「说」不会毁用户会话；
**② 强杀不留死锁**，但会留下悬空 `openStep`，要等下次打开会话才被 repair 收尾。

②顺带在桌宠侧补了一道闸：`dsh.rs` 的 `STEP_STALE_MS`（30 分钟），按
`openStep.startTime` / `pendingCalls` 的**派发时刻**判活，判死就当 idle。
不加这道闸的话，一条被强杀的 web 会话会让猫永远显示「正在干活」——
正是用户报过的「没有任务，但桌宠一直在工作」。注意它只对 `dsh web` / 桌面版有意义：
`dsh headless` 根本不写 `sessionStats`，那条路上的会话永远只显示 idle。

`cargo test` 38 → **42**（+4：悬空步骤、悬空工具调用、时间戳缺失按活着算、解析 startTime/pendingCalls）。

#### 头巾换成消息泡泡：状态改从「猫身上」搬到「猫头顶」（2026-11-04）

用户原话：「不要头巾了，也不要胸前的 RAG。任务状态直接以消息泡泡的方式弹出，
如果有多个就在消息泡泡中列出标题，用户可以点选，查看具体进度。」

**删掉的两样**：`#rig-bandana`（头巾上的关键词）与躯干上那行金色衬线字 `RAG`
（它解释不了任何事——品牌？代号？某个功能在跑？唯一效果是每次有人问「这是什么意思」）。
猫身上从此没有一个需要解释的字。

**换上的一样**：`#bubble-wrap`。三条约束都是用户定的，落地时各对应一处代码：

| 用户要的 | 落地 |
|---|---|
| 任务状态「弹出」 | 常驻（不是悬停/角标）：有活跃会话就挂着，`renderBubble()` 每次名单推来都同步一次 |
| 多条就列标题，前面带状态 | 一行一条：`● working  登录页重构`。状态词**用英文原样**（`working` / `thinking`），因为排查问题时用户脑子里就是这组词；中文放在展开的详情里 |
| 点选查看具体进度 | 点行 = `focusCat(id)`（那只猫顶到最前）+ 手风琴展开详情 |

**详情里有什么**：任务（完整标题——行里是截断的，展开必须能看全）、阶段（中文 + 英文）、
当前工具、已跑多久（`ageMs`，为此给 `Session` 加了 `born`）、工作目录。

**刻意没有百分比**：agent 侧不存在这个东西。编一个「73%」出来第一天很懂事，
第三天就会开始骗人（显示 90% 卡二十分钟）。所以只显示事实。

三个几何/实现的坑，都是截图与断言逼出来的：

1. **泡泡里出现了一条不该有的滚动条**。原因不是内容多，是尖角写成 `#bubble::after`
   （`bottom:-7px`）——绝对定位的后代会把**可滚动溢出区**撑大 7px，于是四条任务也滚。
   改成兄弟节点 `#bubble-tail`。
2. **尾巴指着空气**。分身时每只猫只有 88px 且沉在 pet 盒底部，单猫时 176px 撑满，
   两者头顶相差近百像素；写死一个 `bottom` 必然在一种情况下露出缝。
   改成 `placeBubble()` 按**当前那只猫的耳尖**实时算（量 `#rig-ear-l`，不量盒子——
   `#pet` 是方形盒，画的猫只占下半截）。
3. **量到了正在淡出的幽灵猫**。分身退回单猫时，退场的 `.cat` 还在 `#cast` 里留 1.6 秒，
   而 `#cast` 排在 `#layerA` 前面 → `querySelector("#rig-ear-l")` 先命中那只缩小下移的幽灵，
   泡泡停在半空。改成按「当前真正在台上的 rig」取（有 `cast` 用 `cast`，否则用 `ragdollRig.svg`）。

**窗口从 240×240 变成 240×460**。为什么不另开一个泡泡窗口（权限气泡就是那样做的）：
泡泡要跟着猫走、跟着猫变大变小、拖动时一起移动——两个窗口做这件事得同步位置，
同步永远慢一帧，慢一帧看起来就是「泡泡在飘」。同一窗口里它天然钉在头顶。
多出来的 220px 是透明的，**只有猫和泡泡的矩形会关掉穿透**，点那片空气等于点桌面；
猫在屏幕上的位置也没变——窗口往上长，底边不动。

`verify:tauri` 92 → **106**（删掉 5 条头巾断言，新增 19 条：泡泡出现/行数/状态与猫一致/
标题就是会话标题/命中区含泡泡/泡泡在耳尖之上/间距 0–40px 贴住/点行聚焦/点行展开/
详情有阶段·已跑·目录/再点收起且不撤聚焦/行数跟着 4 只上限/没任务就收起）。
`cargo test` 42 → **43**（+1：`age_survives_state_migrations_while_idle_resets`——
`idleMs` 每个事件清零，`ageMs` 不能，否则跑了半小时的任务只要刚有动作就显示「跑了 0 秒」）。

### S10-10 修「整窗永久穿透」：拖不动、点不了（2026-11-04）

用户原话：「我运行 exe 后，目前无法拖拽，也没有交互了」。画面对（眼睛还在追光标），
但拖、点、双击、右键全哑——**输入根本没进过窗口**。

**根因**：迁移时照抄了 Electron 的「启动先整窗穿透 → 页面收到 mousemove 命中猫再关掉」。
这套写法在 Electron 上成立，因为它在 Windows 上装了低级鼠标钩子转发 mousemove（`forward: true`）；
Tauri（tao 0.37.2）只做一件事：

```rust
style_ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED;   // platform_impl/windows/window_state.rs
```

`WS_EX_TRANSPARENT` = 不参与命中测试，鼠标消息直接给下层窗口。于是页面**一条 mousemove 都收不到**，
"收到就关掉穿透"永远等不到触发条件 → 自我死锁。

**修法**：判定搬到还在转的那一侧。
- 渲染层每 200ms 上报猫的矩形（`hit_rects`，分身时每只 `.cat` 一个，**不合并**——合并会让猫之间的空隙变成挡板）
- 宿主每 60ms 读 `GetCursorPos`，落在矩形里 → `set_ignore_cursor_events(false)`，离开 → `true`
- **拖动中强制不穿透**：窗口追光标慢半拍的那一拍会把 `pointerup` 吃掉，`dragging` 卡死
- 诊断出口 `window.clawd.hitState()`：一次看清 `ignore` / `inside` / `local` / 宿主侧 gaze 计数

**为什么四道闸门全绿时它还在**：CDP 的 `Input.dispatchMouseEvent` 直接注入渲染进程、绕过 OS 命中测试，
合成事件照常触发 DOM 监听。75 条断言全过，真人用鼠标却什么都点不到。
回归这次补了 5 条（命中区签名、`hitState` 三个字段、盖住光标 → 关穿透、离开 → 恢复穿透、
gaze 线程节拍计数），并给闸门加了 `SKIP` 机制：环境调不动系统光标时**响亮地跳过**、不冒充 PASS。
**但这 5 条证明的是判据连着，不证明"真机拖得动"**——那一下只能人工试，已写进 README 与硬约束 42。

**顺带**：gaze 那条断言此前靠"自己挪光标"造变化，某些环境下挪不动就会红。现在拆成
「线程在跑（宿主计数，永远可判）」+「真的推过一次（挪不动就 SKIP）」两条。

### S10-9 删掉 Electron 容器 + 接上发布物签名（2026-11-03）

用户原话：「现在有两个容器 Electron 与 Tauri，删掉 Electron。然后把整个使用说明与项目介绍更新到 README 上」，
前置问的是「如何获取代码签名？帮我获取」。

#### ① 删容器：先画依赖拓扑，再按删除键

`git rm` 了 9 个文件（`main.js` / `preload.js` / `bubble-preload.js` / `dashboard-preload.js` /
`state.js` / `risk.js` / `permission.js` / `server.js` / `verify-electron.js`），
`package.json` 清空 `devDependencies`（`npm uninstall electron` 后 `found 0 vulnerabilities`，
`package-lock.json` 里 electron 计数归 0）。现在 `src/` 只剩 9 个文件，全部是渲染层 + 端点约定：

| 必须先迁出/确认的 | 处理 |
|---|---|
| `src/server.js` 里的 `DEFAULT_PORT = 23333`（`hooks/install.js` 用它拼 URL） | 迁进 `src/port-file.js` |
| `src/theme.js`（`scripts/build-preview-bundle.js` 用） | 原位保留，与容器无关 |
| `scripts/preview-shot.js`（整份基于 Electron 的临时 app） | 移植到 Tauri：起 release exe + CDP `Page.navigate` |

`preview-shot` 是唯一"会被一起带走的功能"：七状态对照图靠它出。移植后实测七个状态全画出（目视确认）。
`verify-tauri.js` 减掉 1 条（"自启的 Electron 侧与 Rust 侧对齐"失去对象），**75 PASS / 0 FAIL**。

#### ② 签名：端到端跑通（证书 = 自签名，仅本机）

- `scripts/sign-release.js`：被 `bundle.windows.signCommand` 调用，也支持手工 `--verify`
- 证书来源由环境变量决定（`CLAWD_SIGN_PFX` + `_PASSWORD` / `CLAWD_SIGN_THUMBPRINT`），
  **一个都没配时响亮跳过**（打印警告、退出 0），**配了却签失败退出非 0**，让打包直接红
- 时间戳 `/tr http://timestamp.digicert.com /td sha256` 不是可选项：没有它，证书一过期，
  旧安装包立刻变成无效签名
- 本机自签名：`CN=clawd-starter (local dev)`，指纹 `20ECA7320CC89439C5C1928AA6B1B3444966C265`，
  PFX 与密码在**仓库外**的 `~/.clawd-signing/`（`.gitignore` 另加了 `*.pfx` / `*.p12` 防手滑）
- 实测：安装包与裸 exe 都能签上，`Get-AuthenticodeSignature` 显示
  `StatusMessage: 已处理证书链，但是在不受信任提供程序信任的根证书中终止`（自签名预期）+
  `TimeStamperCertificate: CN=DigiCert SHA256 RSA4096 Timestamp Responder`（时间戳生效）

#### ③ 两个硬性事实（都是实测，详细复盘在 DEVLOG 2026-11-03）

1. `signCommand` 的 **cwd 是 `src-tauri/`**，脚本路径必须写 `../scripts/sign-release.js`
2. **`cargo tauri build` 结束后裸 exe 不带签名**——打包器在签名后又覆写了它（日志说签了、产物是 `NotSigned`）。
   安装包不受影响。所以 `npm run bundle` 里串了一次补签

#### ④ 顺手修掉一条"永远够不着阈值"的断言

`gaze` 那条原来靠"挪 3px 光标"造变化，而阈值是 `0.02 × 260 = 5.2px` → 必然红。
改 8px（≈0.031）后稳定通过。一道会看心情变红的闸门会训练人忽略红色。

#### ⑤ README 重写

按"使用者先看、开发者后看"重排：这是什么 → 三分钟跑起来 → **代码签名**（三条路的价格、
可用地区、SmartScreen 的真实行为）→ 接 agent → 怎么用 → 端点协议 → 主题 → 回归 → 结构 → 内存实话 →
限制 → 踩坑。旧 README 里 `npm install` / `npm start`（指向已删的 Electron）那一套整段作废。

### S10-5 容器换成 Rust：Tauri 迁移（2026-11-02）

用户原话：「我装了 Rust。装工具链后迁 Tauri」。
这是三条需求里第二条（"把后端与窗口容器用 Rust 重写"）的落地；
第一条（分身 + 头巾）和第三条（风险评级）在 S10 已经完成。

#### 迁了什么、没迁什么

| 迁过去了 | 留在原地 |
|---|---|
| 本地 HTTP 服务（`tiny_http` 替 `node:http`） | 三份 HTML + 三个渲染层（**一行没改**） |
| 状态机 / 主题加载 / 权限裁决台 / 风险评级（Rust 重写） | `themes/` 下的主题包格式 |
| 三个窗口的创建与定位（`WebviewWindow`） | `hooks/` 下的适配器（**完全不用改**：端点文件路径、格式、路由都没变） |
| 托盘（`TrayIconBuilder`）、Win32 四件事（`sys.rs`） | 回归脚本的判据（新增一份 Tauri 版，判据同源） |

**hook 侧零改动**是这次最省事的地方，也是当初 `port-file.js` 把路径规则写成
"纯 Node 也能算出来"的回报——Rust 侧照抄同一套规则，端点文件落在同一个位置。

#### 三个 bug，都是"接口通、画面不动"

这三个全部**没有任何报错**：HTTP 200、invoke 返回 ok、控制台干净。
详细复盘在 DEVLOG 2026-11-02，这里只留结论：

1. **`POST /state` 的 `changed` 被丢掉**。`apply()` 内部调过 `tick()`，`tick()` 顺手更新了
   `last_visual`；心跳再 tick 时比的是"新值 vs 新值"，永远返回 false。
   → 补 `server::OnChange` 回调。
2. **第一条权限请求永远不弹窗**。`bubble_ready == false` 时只把请求塞进待投槽，
   **没人建窗** → 页面不加载 → 永远收不到 ready → 挂到超时 204。
   → `show_bubble` 里补 `ensure_bubble`。
3. **在命令线程里建窗 → 死锁**，顺带把 `app.exit()` 一起弄哑（消息循环卡在那一帧里）。
   → 建窗与退出都挪进 `std::thread::spawn`；`quit` 从"8 秒不退"变成 **201ms**。

#### 动了 CSP，理由写在 meta 里

`connect-src` 由 `'none'` 放宽到 `ipc: http://ipc.localhost`。
Tauri v2 的 IPC 是 `fetch("ipc://localhost/<cmd>")`，Windows 上落成 `http://ipc.localhost`，
**是标准网络请求，会被 CSP 拦**。只放行这一个假域名。

#### 还没做的

> S10-6 收尾进度：单实例锁 ✅ / 关 `withGlobalTauri` ✅ / 锁屏换事件 ✅ / 打包分发 ✅

- [x] **打包分发**：`bundle.active` 现在是 `true`，NSIS 出 `clawd-starter_0.1.0_x64-setup.exe`（1.57MB），
      `installMode: currentUser`（不提权）、装到 `%LOCALAPPDATA%\clawd-starter`
      → **S10-6 已做**（验收脚本 `verify-bundle.js` 25 条，含真装/真卸，见下）
- [x] **单实例**：Electron 版靠 `requestSingleInstanceLock()`，
      Tauri 侧没做等价物——现在开第二份会抢 23333 端口，回退随机端口并告警
      → **S10-6 已补**（`single.rs`，命名互斥量 + 命名事件，见下）
- [x] **开机自启**：**一直没做，Electron 版也没有**。原来这条和"单实例"写在一行，
      容易看成两件都做了（`PROGRESS.md:132` 的 `[x]` 就写错过一次）。
      → **S10-7 已做**（两边同日补齐，见下）。Tauri：`sys::autostart_set()` 直写
      HKCU `Run` 项（带引号的完整 exe 路径），托盘勾选菜单的勾**从注册表读回来**，
      写成功才动勾；Electron：`app.setLoginItemSettings()` + 右键菜单 checkbox，
      同样是"改完立刻读回系统实际状态"。默认关。
- [x] **锁屏检测**是 2s 轮询 `OpenInputDesktop`，Electron 版是 `powerMonitor` 事件。
      轮询在锁屏后仍会跑（便宜，但确实在跑）
      → **S10-6 已换**（`WTSRegisterSessionNotification`，轮询降为注册失败时的兜底，见下）
- [x] ~~**托盘图标**是脚本手画的 PNG（`scripts/make-icons.js`），不是设计稿~~
      → **S10-7③ 重绘**：4× 超采样抗锯齿 + 小尺寸简化几何，16/20/24/32/48/64/256
      七个尺寸同一几何生成（见上）。仍是脚本画、不是设计稿——但小尺寸终于能认出是猫了

### S10-6 收尾四项（2026-11-02，S10-5 之后同一天）

S10-5 收尾时留下的四条"还没做"，逐条关掉。顺序按"风险从低到高、依赖从少到多"：
单实例锁 → 关 `withGlobalTauri` → 锁屏换事件 → 打包分发（打包放最后，因为它要求前面三样都稳定）。

#### ① 单实例锁（`src-tauri/src/single.rs`，189 行）

**先纠一条台账自己的错**：S10-5 写的是"开第二份 → 回退随机端口 → 影响是桌面上出现两只猫、
hook 仍然打给第一只（端口没变）"。**后半句不成立**——`server::start()` 里
`write_port_file()` 是无条件执行的（`server.rs:234`），第二份进程拿着它的随机端口
**覆盖**端点文件。真实后果是 **hook 改打第二份、用户看的是第一份**：事件全落进没人看的进程，
画面永远不动。这比"两只猫"严重得多，而且完全没有报错。

做法：
- `CreateMutexW` 抢命名互斥量，名字 `Local\com.clawd.starter.singleton.v1`。
  为什么不是锁文件：进程被强杀 / 崩溃 / 断电后锁文件会留下，靠 pid 查活又会被 pid 复用坑，
  两种都得写清理逻辑，而清理逻辑本身会出错。互斥量的句柄归内核，进程怎么消失都会被释放。
- 抢不到 → `wake_first()`（`SetEvent` 那个命名事件）+ `return`。**位置在 `Builder::build` 之前**，
  所以端口、端点文件、托盘、三个窗口一个都不会被碰。
- 第一份在 setup 里 `watch()` 起一个线程死等那个事件，等到就 `poke()` —— 让猫醒一下。
  Electron 的 `second-instance` 是 focus 窗口，但桌宠窗口是 `skip_taskbar` + `focused(false)`，
  抢焦点等于打断用户；醒一下是同一个意思又不动别人的鼠标。

**锁名带端点文件路径的 FNV 哈希**，这是本轮最容易被当成洁癖的一处，理由在 `single.rs` 注释里：
回归脚本用 `CLAWD_PORT_FILE` 指临时文件，就是为了能"在用户正开着桌宠的时候跑"。
名字要是固定的，回归一启动就被自己拦住，68 条断言会变成"进程秒退、全挂"。

判据不是"第二份退没退"，而是**端点文件一个字节都没变**——那条更接近真实需求。
回归 +3 条（`verify-tauri.js` 65 → 68），单测 +3 条（18 → 21）。

一个没测到的链接要说清楚：`watch(move || poke(&h))` 这两行**没有回归断言**。
`wake()` 只在"某只猫正在 Sleeping"时才返回 true，而进入 Sleeping 要等 `sleepAfterMs`
（默认几十秒）。为了这条断言去加一个环境变量覆盖睡眠时长，等于为了让测试好写而改产品代码，
所以分层处理：事件机制本身由单测 `wake_first_reaches_watcher` 覆盖
（`SetEvent` → `WaitForSingleObject` → 回调，全链路真跑），只留这两行接线靠人工。

#### ② 关掉 `withGlobalTauri` + 每窗口命令白名单（`tauri.conf.json` / `tauri-bridge.js` / `main.rs`）

`tauri.conf.json` 的 `withGlobalTauri` 改 `false`，`window.__TAURI__` 整套消失
（回归断言钉着）。`src/tauri-bridge.js` 从"调 `T.core.invoke` / `T.event.listen`"
改成自己拼——8 行：

```js
const I = window.__TAURI_INTERNALS__;
const invoke = I.invoke.bind(I);
function listen(name, cb) {
  return invoke("plugin:event|listen", {
    event: name,
    target: { kind: "Any" },          // EventTarget 是 #[serde(tag = "kind")]
    handler: I.transformCallback(cb), // 要的是回调 id，不是函数
  });
}
```

`listen` 的三个参数一个都不能少，`handler` 尤其容易写成函数——它要的是
`transformCallback` 发出来的**数字 id**。参数形状是抄 tauri 2.12.5 的
`src/event/plugin.rs`（`listen(webview, event, target: EventTarget, handler: CallbackFn)`），
不是猜的。

**然后是最重要的一条：这一步并没有关掉通用的口子。**
`window.__TAURI_INTERNALS__` 仍在，描述符实测是
`{ writable: false, enumerable: false, configurable: false }`——删不掉、覆盖不了。
所以：

- 关掉 `withGlobalTauri` 缩小的是**可发现面**；
- 真正的边界只能放在 Rust 侧。

于是 16 条命令全部加了 `window: WebviewWindow` 参数 + 进门 `only(&window, W_*)?`：

| 窗口 | 条数 | 命令 |
|---|---|---|
| `main` | 8 | `drag_start` `drag_end` `mouse_ignore` `pet_hover` `app_quit` `pet_menu` `dashboard_toggle` `theme_get` |
| `bubble` | 4 | `permission_decide` `bubble_ready` `bubble_height` `bubble_dismiss` |
| `dashboard` | 4 | `dashboard_snapshot` `dashboard_copy_path` `theme_list` `theme_set` |

回归 68 → 73 条，新增 5 条：`__TAURI__` 不存在 / `__TAURI_INTERNALS__` 不可配置 /
主调气泡被拒 / 主调看板被拒 / 看板调主被拒。**三条越权断言都绕过 `window.clawd`
直连 `__TAURI_INTERNALS__.invoke`**——要测的是 Rust 拦不拦得住，不是桥拦不拦。

白名单解决的是"越窗口"，不是"同窗口内的越权"：主窗口真被注入了脚本，它照样能调
主窗口那 8 条（含 `app_quit`）。这条 Electron 版一模一样，不要以为加了白名单就安全了。

顺手留了个诊断脚本 `scripts/probe-tauri-surface.js`：一分钟内把"页面上还剩哪些
能调后端的入口"重新测一遍。结论会随 Tauri 版本变，这个脚本不会撒谎。

#### ③ 锁屏从 2s 轮询换成事件（`sys.rs` / `main.rs` / `server.rs`，91 → 302 行）

SEC-07 要求"锁屏时把猫藏起来"。Electron 版用 `powerMonitor` 事件，Tauri 迁移时先落成
`OpenInputDesktop` 每 2 秒问一次——**能工作，但语义是"最多晚 2 秒才藏"**。
锁屏本身就是"你不在，别让旁边的人看见屏幕上的东西"，晚 2 秒正好落在那 2 秒里。

换成事件：`WTSRegisterSessionNotification` + 自建消息专用窗口。

- 为什么自己开窗口，而不是把消息塞进 tao 的消息循环：`WM_WTSSESSION_CHANGE` 是投给
  **某个 HWND** 的，注册时就得交出一个句柄。塞进 tao 那条循环意味着要 hook 它的 wndproc
  （Tauri 没开这个口子），而且那个窗口一旦被销毁重建，注册就静默失效。
- 消息专用窗口：`HWND_MESSAGE` 当父窗口，不显示、不进任务栏、不参与 Z 序，
  自己那条线程跑 `GetMessageW` 循环。**和 tao 完全不相交**，它出问题不会拖累画面。

只认两个参数，其余一律返回 0 不动：

| `wParam` | 含义 | 处理 |
|---|---|---|
| `WTS_SESSION_LOCK` (7) | 锁屏 | 藏 |
| `WTS_SESSION_UNLOCK` (8) | 解锁 | 显 |
| `REMOTE_DISCONNECT` (3) / `CONSOLE_DISCONNECT` (4) / `LOGOFF` (5) | 换显示通道 / 注销 | **忽略** |

忽略那三条是刻意的：远程桌面断开时用户还在（只是换了块屏幕），注销是进程本来就该退，
两者都不该触发"藏起来"——按 `!= UNLOCK` 一刀切会把这类场景全算成锁屏。

`WndProc` 里只做一件事：把锁/解锁交给回调，立刻返回。回调里再 `spawn` 一次才去
hide/show——那两个 API 要把请求投递到主线程并等回执，在 WndProc 里等就是卡住这条消息线程。

**降级是有意留的**：注册失败（非交互会话、以后换权限模型都可能）就退回原来的 2s 轮询，
并打一行日志。理由写在 `main.rs` 里——**宁可 2 秒后才藏，也不要一直亮在锁屏界面上**。

`/health` 因此多了个字段：

```json
{ "ok": true, "lock": "event" }
```

不是为了好看。"锁屏后没藏窗口"这种问题没法当场复现，而事件和轮询**失败的样子一模一样**，
不把模式写在探针上，就只能靠猜。回归里这条断言实测拿到 `event`。

编译/结构上踩了两处：

- `RegisterClassW` / `WNDCLASSW` 被 `Win32_Graphics_Gdi` feature 门禁挡着（结构体里带
  `HICON` / `HBRUSH`），报 `E0432`。加 feature，注释写明"我们只是建消息专用窗口，一个像素都不画"。
- `let app = app.clone()` 之后又在 `if !wired` 里用 `app` → `E0382`。改名 `watcher_app`。

测试按"能被自动验证到哪一步"分层：

- 单测 1 条 `session_messages_drive_the_callback`：直接投 `WM_WTSSESSION_CHANGE`，
  验 LOCK → true / UNLOCK → false / 那三条 → 不触发。**合成一个测试而不是拆三个**，
  因为 `SESSION_CB` / `SESSION_HWND` 是进程级单例，cargo 默认并行跑会把回调互相覆盖。
- 回归 +1 条：`/health` 的 `lock === "event"`。
- **没被自动验证的一段**：事件 → `apply_lock()` → 窗口 hide/show。真锁屏没法放进回归
  （会把跑测试的人踢出桌面），单测只覆盖到"消息 → 回调"为止，后面那十行调 Tauri API 的
  代码靠**人工锁一次屏**验。这条写在这里，是因为 74 条全绿很容易被读成"锁屏行为整个被覆盖了"。

`cargo test` 21 → **22 passed**，回归 73 → **74 PASS / 0 FAIL**。

#### ④ 打包分发：NSIS（`tauri.conf.json` + 新增 `scripts/verify-bundle.js`）

这一项不是"改个配置"，是**第一次让别人能装上**。`bundle.active` 从 `false` 打开。

**为什么是 NSIS 不是 WiX**：`tauri build` 的 MSI 通道要系统装 WiX 3，本机没有；
NSIS 是 Tauri 2 自带下载的（落到 `%LOCALAPPDATA%\tauri\NSIS\`，makensis 3.13），
一条命令就能出安装包。Windows 上这是唯一不用先装构建依赖的路径。

配置里每一条都不是装饰：

| 配置 | 值 | 为什么 |
|---|---|---|
| `installMode` | `currentUser` | 桌宠要什么管理员权限。装到 `%LOCALAPPDATA%\clawd-starter`，不提权 |
| `icon` | `.ico` + `.png` | NSIS 的安装器图标只认 `.ico`，给 png 会直接失败 |
| `shortDescription` / `longDescription` | 中文 | 开始菜单和「应用和功能」里显示的就是这两行 |
| `languages` | SimpChinese + English | 安装器界面跟着系统语言走 |

产物：`clawd-starter_0.1.0_x64-setup.exe`，**1.57 MiB**（裸 exe 4.49MB，lzma 整包压）。

**验收脚本 `scripts/verify-bundle.js`，25 条**（10 条只读 + 15 条 `--install`）。
只读那部分可以每次提交前跑；`--install` 会真的装一份、跑起来、卸掉，所以默认不开。

三条判据全是跑出来才定对的，写在这里比写在脚本注释里更该被看见：

1. **"装出来的 exe 与裸 exe 的 sha256 相同"是错的判据。** 第一次跑就红了 3 个字节：
   tauri-bundler 的 `patch_binary()` 会把二进制里的 `__TAURI_BUNDLE_TYPE_VAR_UNK`
   改成 `__TAURI_BUNDLE_TYPE_VAR_NSS`（运行时 `tauri_utils::platform::bundle_type()` 读它）。
   打包**不是纯复制**。改成"除这 3 个字节之外逐字节相同"。
2. **这个占位符在文件里有 6 处。** `bundle_type()` 的 `match` 六个分支各是一份字面量
   （DEB / RPM / APP / MSI / NSS / UNK），真正被打补丁的是**最后一处**那个 `static mut`。
   第一版用 `indexOf` 取到的是 `_DEB`，于是断言报"占位符被改成了 DEB"——一个纯属自己找错的假失败。
3. **卸载后开始菜单的 `.lnk` 比 exe 晚删。** 只看 exe 会读到"exe 没了、快捷方式还在"，
   然后在**下一轮**的"安装前无残留"基线上炸出来。改成等两个痕迹都消失再断言，连跑两轮才稳。

真装/真卸的实测：装 → `%LOCALAPPDATA%\clawd-starter\clawd-starter.exe` 逐字节对上 →
启动 → `/health` 200 且 `lock: event` → 卸 → 目录空、快捷方式无。连跑两轮，机器上没有残留。

**一条没能按原计划做的**：本来想用注册表 `HKCU\...\Uninstall` 子键的增删判断"卸干净"，
本机的安全策略拦了 `reg.exe`。**没有用 PowerShell 的注册表 provider 绕过去**——
那是同一个动作换个壳。判据换成两个不需要注册表的落盘痕迹（安装目录、开始菜单快捷方式）。

打包本身带出两条**已知限制**（不是 bug，是现在的选择）：

- **安装包没有代码签名**。用户第一次双击会看到 SmartScreen 的"未知发布者"。要消除得买证书
  （EV 或 OV），这不是代码能解决的
- `webviewInstallMode` 用默认的 `downloadBootstrapper`：机器上没有 WebView2 运行时会去微软下载，
  **离线机器装不上**（会 `Abort`）。要离线得换 `offlineInstaller`，安装包从 1.57MB 涨到 ~130MB

`cargo tauri build` 输出里那两条 `warning 6040: LangString "choowHowToInstall" is not set`
**不是我们的问题**：那是 Tauri NSIS 模板里给旧拼写留的兼容兜底（模板自己也有 TODO 注释），
在 `installMode: currentUser` 下根本走不到那个页面。

**判据**：装出来的 exe 与裸 exe 逐字节相同（除 bundler 那 3 字节）+ 安装版 `/health` 是 `event`。
前者证明"用户拿到的是刚验过的那一份"，后者证明"打包没把能力弄丢"。

**S10-6 收尾完成（4/4）**。收尾这一次把所有闸门重跑了一遍，四份同时绿：
Electron **191** / Tauri **74** / `cargo test` **22** / 打包 **25**，外加台账巡检 `[ok] 一致`。
打包改了 `tauri.conf.json` 和 `build.rs` 的产物之后，**Electron 那份 191 条一条没掉**——
两套容器共用渲染层这件事，到这里才算真被验证过一次（之前只是"应该没问题"）。

这一步之后仍然开着的，都**不属于 S10-6**，别混在一起看：

| 遗留 | 状态 |
|---|---|
| 「thinking 显示成 idle」的根因 | 未定，诊断口已就位，等现场数据 |
| WorkBuddy 上的 hook 安装 | 沙箱写不了 `~/.workbuddy/settings.json`，要用户自己跑一条命令 |
| 托盘图标 | ~~脚本手画的占位物~~ → S10-7③ 超采样重绘，16px 起可辨认 |
| `cargo audit` | ~~本机没装，从没跑过~~ → S10-7④ 跑过：0 漏洞 / 2 条警告（都不在 Windows 构建图里） |
| 安装包签名 / 离线安装 | 见 ④：`downloadBootstrapper` + 无签名，都是明确的选择 |

### S10-7 把还开着的所有事项做完（2026-11-02，S10-6 同日的最后一轮）

#### ① 开机自启（Tauri + Electron 两边同日补齐）

这条的来历先记一笔：S10-5 的台账把它和"单实例"写在**同一行**、且标了 `[x]`，
导致上一版功能清单里它被当成已交付——这是台账自己的错，不是代码的。
现在两边都真的有了：

- **Tauri**：`sys.rs` 新增 `autostart_enabled()` / `autostart_set(bool)`，
  直写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（值名 `clawd-starter`，
  值是**带引号**的 `current_exe()` 完整路径）。托盘菜单加 `CheckMenuItem`
  「开机自启」，勾**从注册表读回来**（不是本地变量），写成功才动勾，
  同时 `emit("autostart", …)`。不用 `tauri-plugin-autostart`（连带 11 个包），
  只给 `windows-sys` 加一个 `Win32_System_Registry` feature。
- **Electron**：右键菜单加 checkbox，`app.setLoginItemSettings()` 改完
  **立刻读回** `getLoginItemSettings()`，读回什么显示什么；
  写入未生效（组策略 / dev 环境）时 stderr 告警，不假装成功。
- **默认关**。测试只默认验「关」（幂等、不留痕迹）；「开」的往返
  要 `CLAWD_AUTOSTART_TEST=1` 显式点名——自启是进程外全局状态，
  测试崩溃会留一条真条目，下次登录自己弹一只猫。

闸门：`cargo test` 23（autostart 两条合成一条，单例状态不能并行测）；
Electron 193–194（+3）；Tauri 76（+2：两套容器的自启能力互为镜像的静态对齐断言）。

#### ② 问题 1 定案：两个症状一个根因，S10-6③ 已经修对了

用户报的两个症状——「thinking 时显示成 idle」和「压缩上下文时变 idle」——
**是同一个 bug 的两次出现**：WorkBuddy 在 `UserPromptSubmit` 之后约 0.1s **补发**
`SessionStart`（每轮都发），压缩完成后也会再发一个 `source=compact` 的
`SessionStart`。它们都落在**一条已经存在的会话**上，按普通映射处理就是把
thinking/working 清回 idle。S10-6③ 的「SessionStart 只给新会话定初值、
已有会话记 `preserved` 不动手」就是根因修复——本轮缺的只是**证据**。

证据由新建的 `scripts/diag-events.js` 补上：起一份临时 Tauri 实例，
把现场观察到的**整轮事件序列照原样回放**，每步同时读服务端快照和渲染层画面、
对照显式期望值。10 步全中，包括压缩那条路径。挂成 `npm run verify:diag`
进了 `verify:all`。

**过程中先抓到的是自己的 bug**：诊断脚本第一版报「UserPromptSubmit 也掉成了
idle」，追下去发现是**脚本在页面还没挂上 `petDebug` 时就去读**——
观测窗口自己没就绪，把时序读成了结论。修法是回放前先等
`typeof window.petDebug === 'object'`（教训进了硬约束 40）。
顺手堵的第二个坑：`verify-tauri.js` 默认用 `target/debug` 的二进制，
而它是几小时前编的——`withGlobalTauri`、IPC 白名单、`/health` 的 lock 字段
全是编译期定死的，拿旧二进制跑出 8 条假 FAIL，指向的是不存在的 bug。
现在开跑前比对源码与 exe 的 mtime，旧了直接拦下来并打印该跑的命令（硬约束 39）。

#### ③ 托盘图标超采样重绘

`scripts/make-icons.js` 原来是"每个像素问一次点在不在形状里"，非黑即白。
256px 上看不出问题，但托盘真正被用的尺寸是 16~24px：猫脸半径只剩 6 个像素，
耳朵退化成两块直角三角，眼睛摊成一层雾——远看像颗花椰菜。

- **4× 超采样 + 覆盖率降采样**：每个像素在 4×4 个子样本上判覆盖，
  RGB 取**覆盖样本**的平均、alpha = 覆盖率（数学上等价于预乘 alpha 再除回去）。
  直接按全部样本平均会把透明像素的 (0,0,0) 混进边缘——半透明轮廓发灰发脏。
- **≤24px 走简化几何**：抗锯齿解决"锯齿"，解决不了"特征小于一个像素"
  （16px 时眼睛半径只有 0.94px）。小尺寸把眼睛放大 1.6 倍、去掉鼻子和内耳、
  耳朵加厚外移——保住"能认出是猫"的那三个特征，细节全部让位。
- ICO 从 5 个尺寸扩到 **7 个**（16/20/24/32/48/64/256）；
  重编 release 后资源管理器、托盘、NSIS 安装包三处同源。
  小尺寸放大检查过（最近邻 8× 拼图），16px 起耳朵和眼睛都还在。

#### ④ 依赖审计：`cargo audit` 第一次跑

这条在待办里挂了很久（"本机没装，从没跑过"）。补上了，结论 **0 漏洞 / 2 条警告**：

- 工具 `cargo-audit 0.22.2`（官方预编译包，本机源码编译 40 分钟没完）；
  公告库浅克隆 `RustSec/advisory-db` 1402 条。
- 2 条警告是 `proc-macro-error 1.0.4`（unmaintained）与 `glib 0.18.5`（unsound），
  依赖链都挂在 `tray-icon` 的 **Linux** 分支（`libappindicator`/GTK）上。
  `cargo tree --target x86_64-pc-windows-msvc -i` 对两者都是 `nothing to print`——
  **发出去的 Windows 二进制里没有这块代码**。将来做 Linux 构建要先处理它们。
- 方法论记进 SECURITY：审计报告按 crate 名报、不看 target，
  读报告的最后一步永远是 `cargo tree --target <要发的那个 target> -i <crate>`。

### S9 鼠标经过，把睡着的猫叫醒（2026-10-28，紧接 S8 之后，同一天）

用户原话：「鼠标经过布偶猫的时候，如果处于睡觉状态，就慢慢让她变为 idle 状态，能有过度吗？」
关键词是最后那个"过渡"（用户写的是"过度"）——**这不是一个状态切换的需求，是一个曲线的需求**。

#### 两件事必须分开做

1. **谁来改状态**：`sleeping` 是 `state.js` 的 `tick()` 按"idle 持续多久"推出来的。
   渲染层擅自把画面切成 idle，下一个 250ms 的推送就把它顶回去——那是"闪一下又睡"。
   所以加了一条上行通道：`mousemove` 命中 `#pet` 且**当前确实是 sleeping** → `pet:hover`
   → `store.wake()`。wake 只动 sleeping，**working / thinking / error 一概不碰**——
   用户鼠标不该改写 agent 的真实进展。并且 `stateSince` 必须一起重置，否则下一个 tick
   立刻判定"又闲够了"，表现是碰一下就醒、随即又睡。
2. **怎么"慢慢"**：分两半。
   - 躯干/头/耳/尾的弹簧通道本来就有过冲和滞后（`bodyY` 8.5 → 0、`headY` 13.5 → 0），
     这段不用写代码，`setTarget()` 就是过渡。
   - 但眼睛原来是**布尔切换**（`eyeMode` 是字符串，opacity 直接 0/1），会"啪"一下睁开。
     所以新增弹簧通道 `eyeOpen`（0=闭 1=睁，临界阻尼 k=110 c=21，约 0.5s），
     睁眼层 / 弯月闭眼层 / 笑眼层各按权重交叉淡入，头顶的 zZz 也读同一个值淡出——
     两处各算一遍会出现"眼睛已经睁开、Z 还挂在头上"。
   - **眨眼仍然是硬切**：150ms 的事，慢慢眨眼看起来像卡住了。这两个刻意不一样。

#### 顺手删掉胸口大毛领

用户此前没提，但它是只跟呼吸联动的装饰件（躯干本身仍在呼吸，删了没有视觉落差），
省下每帧一次 `style.transform` 写入。**删部件要连校验探针一起改**——
回归里"每帧都在重算"的探针原本读 `rig-ruff` 的缩放，不改就会变成读 `missing:rig-ruff`。

#### 回归踩到的两处

- **`=== "0"` 判眨眼失效**：不透明度改成连续值之后写的是 `0.000`，按字符串比永远不相等，
  "明明在眨"被判成没眨。改成数值比较。（这类失败比没有断言更费时间，因为报告是红的但功能是好的）
- **"过渡"没法用单点采样证明**：一张静态图里慢慢睁开和啪一下睁开长得一模一样。
  判据改成**采到中间值**：连采 6 次，至少有 2 个落在 0.05~0.95 之间，且单调上升；
  再加一条"zZz 和眼睛走同一条曲线"（`|1-eyeOpen - fxSleeping.opacity| < 0.02`）。

回归 **159 → 171 PASS / 0 FAIL**，新增 12 条。

### ~~S8 跟桌宠说话：猫只做邮差~~（2026-10-28 做，**2026-10-30 整套删除**）

> ⚠️ **这一节记录的功能已经不存在了**，留着是为了让下一个人不用重走一遍。
> 删除的直接触发是用户一句判断：**「如果不能直接发送给 workbuddy，信箱就没有存在的必要了。」**
> 而"直接发送"这条路确实走不通（CLI 要单独登录且只开新会话、桌面端端口是未公开接口、
> hook stdout 是 fire-and-forget 且没有回执）。
> 更根本的理由：**它解决的是一个不存在的问题**——用户想让 agent 知道什么，
> 直接在对话里说是一跳直达；经桌宠转交是三跳（写 → 存 → 等下一次提交），还多一个会丢信的环节。
> 代码层已删干净（`mailbox.js` / `letter.*` 四个文件、`main.js` 里全套窗口与 IPC、
> `preload.js` 两个动作、`hook` 的送信段、`verify` 的 49 条断言），
> 文档与台账同步删（硬约束 1：功能下线要连校验层和文档一起删）。
> 回归 **195 → 146 PASS / 0 FAIL**。

用户的原话是「双击有什么作用？能不能直接和桌宠说，然后给我发送到 WorkBuddy 上？」，
并且明确选了要做到哪一步：「**不回答我任何问题，只做消息的搬运工。猫只是把我说的话，
用写信的方式传递给了 WorkBuddy。**」这句话框定了整个功能——**猫不生成任何文字**。

#### 先花了半轮把"立刻送进去"这条路走死

| 试过的路 | 结果 |
|---|---|
| `codebuddy -p` 调 CLI | CLI 能用（`--version` → 2.165.0），但 `EADDRINUSE 127.0.0.1:51650`；加 `--port` 后报 **`Authentication required`**——桌面端登录态在 Electron 的加密存储里，CLI 读不到，要用户单独登录一次。而且就算登录了，`-p` 只会**开一个新会话**，进不了你正在看的那个 |
| 直接 POST 桌面端本地端口 `127.0.0.1:51650` | 它确实是 WorkBuddy 自己的服务（PID 属主是 `WorkBuddy.exe`）。但那是未公开的内部接口，拿它做投递一次更新就崩，而且等于绕开它自己的鉴权 |
| **hook 的 stdout** | **官方文档写死的契约**：「退出码 0：stdout 一般只显示给用户，但 `UserPromptSubmit` 和 `SessionStart` 是例外，其中 stdout 会添加到上下文中」。零依赖、零登录、零端口 |

所以投递机制是：**信落到磁盘 → 下次 `UserPromptSubmit` 时 hook 把它写进 `additionalContext`**。
代价是"信要到下一次提交才送达"，这是选 hook 换来的，已写进 UI 文案（`信会在你下次在 WorkBuddy 里说话时一起送到`）。

#### 做了什么

- **`src/mailbox.js`**（224 行，纯 Node，主进程与 hook 共用）：`put` / `listPending` / `take` / `prune` / `format`。空信、4000 字上限、待投递 5 封上限、24h 过期、坏文件与超大文件跳过、文件名过 `ID_RE` 才拼路径
- **信纸三件套**：`letter.html` + `letter-renderer.js` + `letter-preload.js`，CSP 与气泡同款，`sandbox: true`。空信/超长时「寄出」禁用，失败原因就地显示
- **`main.js`**：信纸窗口（懒创建 / 贴桌宠 / `did-finish-load` 后投递）、`letter:send` 落盘、锁屏一起 hide
- **两个手势换岗**：**双击 = 写信**（原来开看板），**右键 = 原生菜单**（写信 / 看板 / 退出）。顺手修掉「右键直接退出、没有确认」这个误触隐患——桌宠没有标题栏，想关掉它的人唯一会试的就是右键
- **`hooks/clawd-hook.js`**：`deliverLetters()`。三处顺序不能改——stdin 必须在探端口之前读、送信必须在探端口之前、输出必须 `await` 写完再退

#### 回归抓到一个真 bug

「取信按写入顺序」这条红了。原因不是测试写错，是**同一毫秒写的几封信排序只能拿 UUID 当兜底**——
于是"先写的先寄出"这个用户唯一能感知的语义变成了随机顺序。手写根本碰不到（人的手速不会同毫秒），
但它是真的错了。修法：`createdAt` 至少比现有最晚那封晚 1ms。并补了一条断言直接验**严格递增**这个不变量
（只验"第一封排前面"不够：同毫秒时它也可能碰巧对）。

回归 **123 → 159 PASS / 0 FAIL**，新增 36 条。

### 全仓盘点 + 删 crab + 表情变体（2026-10-28）

用户一句「重新梳理所有文件，删除没有必要的文件和不再使用的方法，crab 也可以删掉了，暂时不需要更多的主题」。

#### 删掉的
- **`themes/crab/`（19 个 SVG）+ `docs/crab-states.png`** —— 第二个内置主题，用户说暂时不需要更多
- **`scripts/migrate-visuals-to-theme.js`**（94 行）—— 一次性迁移脚本。它的输入 `src/visuals.js` 早就没了，使命完成，且没有任何 npm script 引用
- **`scripts/generate-ragdoll-assets.js`**（213 行）—— 一次性素材生成器。生成的那 21 帧在弹簧渲染器下**根本不被读取**（那一路是 JS 拼的），跑了还会覆盖手工改过的资产
- **`IDLE_AFTER_MS`**（上一轮）、**两处失效的 `petDebug.motion()` 调用**（见上一节）

#### 盘点的方法与结论
- **留下来的都确认有消费者**：9 个 preload 动作、13 个 IPC handler、src/ 下的顶层函数逐个 grep 过，没有孤儿
- **帧序列渲染路径保留**：它的活消费者是**内置兜底画面**和第三方主题（它们都不写 `rigType`）
- **删之前先问"它在测试里扮演什么角色"**：crab 除了是主题，还是「第二主题」「多帧帧序列样本」「timings 对照组」。三个角色全部由回归临时创建的 `probe` 主题接手（`finally` 里删），一条防线都没丢

#### 表情变体（内核最后一格）
`states.<name>.variants`：一个状态可有多套资产，每次**进入**轮换一套（第一次播的恒为主资产，所以没写的主题行为不变）。选**轮换**而不是随机——随机没法断言，那样的测试是**在赌时序**。
主资产和变体共用同一个 `readSet()`：规则必须同一份，否则会分叉成"主资产钳了、变体没钳"，而那种 bug 只在换到第 2 套时才看得见。

回归 **112 → 118**（+1 两条路径 / +1 补齐 / -1 旧的"眼睛压扁" / +4 表情变体 / +2 帧序列轮播与路径）。**所有连带改动跑完 0 FAIL。**

### 状态时长进 theme.json（2026-10-28）

台账里挂了很久的一条：「状态时长（25s 发呆 / 60s 入睡）仍写死在 `state.js`，没进 `theme.json`」。
动手才发现**这条待办本身写错了**：那个 25 秒的 `IDLE_AFTER_MS` **从头到尾没有消费者**，
它旁边那行注释甚至自己写着"目前没有被任何逻辑使用"。它连配置项都算不上，只是一段被注释掉的设想。

所以真正搬的是另外两组：`ONESHOT`（error 2600 / notification 3200 / attention 2400）和 `SLEEP_AFTER_MS`（60 秒）。

- **注入而不是传值**：`main.js` 里 store 在 302 行建、主题在 331 行才解析，构造时拿不到主题。
  所以 `createStore({ getTimings })` 收一个 getter，每次判断时长都重新问一次——换主题后新时长立刻生效，不用重建 store。
- **默认值的真相只有一份**：主题没写 `timings`，`theme.js` 如实返回 `null`，由 `state.js` 用内置默认。
  加载器不存第二份默认——两边各写一套，分叉是静默的（`timings=null` 这条本身也有断言）。
- **主题改不了状态机的形状**：`oneshotMs(state)` 只在 `ONESHOT[state]` 本来就有定义时才允许主题覆盖。
  否则一个主题给 `working` 配个时长，就能让"工作中"播 2 秒消失——那是行为，不是外观。
- **写错了要说出来**：在 `oneshot` 里塞 `working` / `sweeping`，加载警告会报「永不会生效」；
  超界钳制并说明；`timings` 不是对象则**整个主题加载失败**，不悄悄按默认跑。
- **断言带对照组**（9 条新断言）：只证明"写了 60ms 就退回"是**不够的**——它可能本来就短。
  所以每条都配一个"不写会怎样"：没写时 220ms 仍在 attention（默认 2400）、仍是 working（默认 60 秒）。
- `IDLE_AFTER_MS` 删了，但它那个没解决的问题留在了 `state.js` 的注释里：
  **长工具调用（跑 40 秒的构建）期间没有任何事件，会被误判成闲置**。真要做，先回答这个再回来加消费者。

回归 **102 → 112**（新增 9 条；剪贴板那条这次也读到了，所以是 103+9）。

### 骨骼弹簧重写：把它救回来（2026-10-28）

用户拿了一版外部重写的布偶猫（「60fps 骨骼弹簧物理版」）进来说加载失败。
这一版不是改主题数据，是**换掉整个渲染架构**：`src/renderer.js` 里用 JS 直接拼一只猫
（242 行 SVG 模板 + 576 行姿势表 + 二阶弹簧阻尼通道），主题系统对这个主题等于架空。

它确实好看——状态姿势差异大、切换是弹簧过冲而不是硬切。所以**救，不回退**。
但救的时候把被一起拆掉的东西补了回来：

- [x] **加载链条**：`schemaVersion: 2` → `1`（它用到的全是 v1 字段，「2」是自封的）；
      跑 `generate-ragdoll-assets.js` 生成缺失的 18 帧（脚本写了但没执行过）
- [x] **CSP 补回** `index.html`。它是最后一道闸，不该因为「新版看起来不需要」就删
- [x] **白名单补回**：非骨骼路径从 `innerHTML = frames.join("")` 改成逐帧 `svgNode()`
      （`DOMParser` + `ALLOWED_TAGS` + `url()` 出口管控），坏帧单张丢弃不连累状态
- [x] **`petDebug` 补回**（`setState` / `svg` / `gaze`+pin / `springs` / `theme` / `builds` / `stateLog`）。
      它不是便利工具，是**唯一能让回归看到内部状态的窗口**
- [x] **`window.VISUAL_STATES` 补回**，收成单一 `adoptTheme()` 入口
- [x] **`eyeTracking` 真的生效**（rig 分支原来无条件跟眼）；working 改回 `false`
- [x] **疲惫眼**：`eyelidTop` 1.8 → 11
- [x] **`rigType` 透传** + 未知状态名告警（`walking` 就是这么发现是死配置的）

**救回来之后又改的（第三轮：把摸鱼拆掉，改回敲键盘）**：

- [x] **working 从水边垂钓改回桌前敲键盘**：删掉水面 / 弯竿 / 鱼线 / 浮标，换成键盘（两排键 + 呼吸灯）
      + 深色编辑器窗口（红黄绿三点 + 三条代码行，宽度按时间生长、末尾淡出换下一行）
- [x] **彩蛋删干净**，不是停用：`GAG_DEFS` / `GAG_EASES` / `GAG_ORIGIN` / `sampleGagTrack` /
      `sampleGagInner` / `scheduleGag` / `playGag` / `renderGag` / `gagLook` / `#rig-fish` / `#rig-slipper` /
      `petDebug.gagNames|gag|gagState` / `docs/ragdoll-gags.png`，一处不留。
      **停用版等于留一条没人走的死路径**，那正是这个项目踩过四次的东西
- [x] **连校验层和文档一起删**：`theme.js` 里 `normalizeMotion` / `normalizeGags`（约 150 行）、
      `themes/README.md` 里两整节 schema 说明。消费者没了还留着校验器，主题作者写对了也什么都不发生
- [x] **回归里那条「motion 声明的部件在 SVG 里都存在」删掉**：`def.motion` 永远是 `undefined`，
      循环一次都不进 → **永远为真**。永远为真的断言比没有更糟，它在报告里长得像一道防线
- [x] **`innerHTML` 归零 + 落地成机械断言**：`renderer.js` 里 `rootLayer.innerHTML = createRigged…()`
      这条一直违反硬约束 19、却因为没人查而活了整轮。模板改走 `svgNode()`（白名单只挡 `on*` / 外部 `url`，
      放行 `style` 属性，rig 的 `transform-origin` 不受影响），并加了一条扫 `src/*.js|*.html` 的断言
- [x] **疲惫眼的尺度跟着改**：`eyelidTop` 11 → 7。11 是"打盹"（眼球基本被盖掉，读成睡着了还在敲键盘）；
      赶工得让蓝眼睛看得见
- [x] 回归 105 → **103**（删 7 条彩蛋 + 1 条假 motion，加 6 条：桌面部件存在 / 亮出 / 收起 /
      前爪交替敲 / 代码行在长 / `innerHTML` 为零）

**已经不在的东西**：`motion` 引擎与 `gags` 配置能力（两者都随各自的重写/删除失去了消费者）。
要恢复「主题作者也能写动画 / 彩蛋」，得先有渲染层的消费者，再谈 schema——
顺序反了就会得到「校验通过、加载成功、什么都不发生」。

**这个代价值得记下来**：重写拿走了三样东西，全都**不报错、不崩、看着也正常**——
CSP、白名单、`VISUAL_STATES`。功能代码写得越好，这些「没用的闸」越容易被当成冗余删掉。
这一轮修完还发现第四个：`petDebug.springs()` 读的是 `ragdollRig.springs`，而通道表实际叫 `sp`，
于是它**永远返回空对象**——外部窗口写了不等于接上了。

### 活猫感第二轮：疲惫 / 毛边 / 彩蛋（2026-10-27）

第一轮把"卡顿"从架构上解决了（`motion` + rAF 插值），但用户看到的还是"基本都是在 idle 基础上加一个东西"。
这一轮不再是换架构，是**把每个状态画成它自己该有的样子**，并补上第一轮没做的一层：一次性的小动作。

- [x] **sleeping**：身体从 `ellipse` 换成锯齿轮廓（`fuzzy(cx,cy,rx,ry,spikes,amp)`）+ 4 撮毛簇；前爪挪到头部之后画，只露出压在下巴底下的爪尖
- [x] **thinking**：头 `cy` 90 → 97，身体 `cy` 148 `ry` 30，两者重叠 14px，脖子缝消失
- [x] **working**：疲惫半睁眼（眼睑是一块从眼角压下来的实心弧，颜色取**面具色**）+ 眼下动纹；`eyeTracking: false`
- [x] **working 的彩蛋**：鱼与拖鞋各一条 `gags`，`display="none"` 藏在图里，靠渲染层随机排期放出来
- [x] 渲染层两个新引擎分层：`motion`（循环，状态级）与 `gags`（一次性，事件级）；写 `transform` 的那一段（`writeTransform`）**两边共用**，只差 `k` 怎么算
- [x] 回归从 92 → 103 项，新增的 9 项全是这一轮真踩过的坑（见上表）

**为什么彩蛋要单开一层而不是塞进 `motion`**：`motion` 是 `period` + `phase` 的无限循环，
它的语义是"一直这样动"。"隔一阵来一次，来的那一次分三段演"（浮上来 / 停住盯着 / 吃掉）
在循环语义里根本表达不出来——硬塞只能靠 `period` 演成"每 10 秒准时钓上来一条"，那是最不像活物的节奏。
所以：**循环的归 `motion`，一次性的归 `gags`**，两层都在同一个 rAF 上跑。

**为什么彩蛋不用 CSS 动画**：跟第一轮同一个理由（白名单拒 `<style>`/SMIL），但这里多一层好处——
彩蛋的"放出来、演完收回去"必须能被断言。CSS 动画只能靠 `animationend` 猜，而 `gags` 的每一次
`display` 变化都在我们的代码里，回归才能问出"鱼到底被放出来了吗、演完收回去了吗"。

### S7 主题系统（2026-10-27）

S3 之后形象是写死的 19 帧 SVG。S7 把它拆成 `themes/<id>/theme.json` + `assets/*.svg`，**`src/visuals.js` 整个删掉**——不是"改成从文件读"，是"不再有那个文件"。

**动手顺序刻意反过来**：先写白名单定案（`SECURITY.md`「S7 白名单定案」），再写加载器。反过来的话，等第一个主题加载不出来时才去放宽白名单，那时候放宽的动机已经变成"让这个主题能跑起来"。

- [x] `src/theme.js`（325 行）：扫目录、校验 schema、读资产、缺状态补齐、全坏给兜底
- [x] `themes/ragdoll/`：默认主题，19 帧从原 `visuals.js` 用脚本拆出来，不是手抄
- [x] `themes/crab/`：原版螃蟹，从 `git show 85c094a:src/visuals.js` 取。**第二个主题的意义是证明"能换形象"，不是"能换配置"**
- [x] `themes/_template/`：脚手架。下划线开头 → `ID_RE` 不匹配 → 不会出现在主题列表里，零特殊分支
- [x] `themes/README.md`：三条硬契约（viewBox / 唯一 pupils 组 / 白名单标签）+ 资产规则
- [x] 渲染层 `applyTheme()`：换主题 = 换一份帧数据 + 强制重画当前状态，不重开窗口
- [x] 主题是**拉**回来的（`getTheme` invoke），不是推的——S5 的第一个气泡就是"推早了被静默丢弃"
- [x] 看板底部加主题下拉框，切换立即生效；加载失败的主题也会列出来（禁用 + 说明），因为作者改完 `theme.json` 第一件事就是来看这里
- [x] 偏好写 `%APPDATA%\clawd-starter\clawd-starter.theme`，重启还是上次那个；`--theme=` 与 `CLAWD_THEME` 可临时覆盖
- [x] 内置兜底画面（灰色「?」）：主题全坏时窗口不会变成一片空白。桌宠没有任务栏入口，空白等于"一个看得见进程、找不到退出按钮"
- [x] `preview.html` 加主题选择器；`scripts/build-preview-bundle.js` 从 themes/ 打包（file:// 下 fetch 读不到本地文件）
- [x] `scripts/migrate-visuals-to-theme.js`：一次性迁移脚本，保留是为了说明 themes/ 怎么来的

**白名单的定案**（完整理由见 SECURITY.md）：

| 处置 | 内容 |
|---|---|
| 放行 | `clipPath` `mask` `filter` |
| 逐个放行 | `feGaussianBlur` `feOffset` `feDropShadow` `feColorMatrix` `feBlend` `feComposite` `feFlood` `feMerge` `feMergeNode`（**不用 `fe*` 通配**） |
| 拒 | `feImage`（唯一用途是从 href 拉外部图）、`feTurbulence` / `feDisplacementMap`（CPU 炸弹）、`style` 标签、`foreignObject`、`animate` / `set`（运行时改 href） |

加了这三个标签之后，`url()` 目标校验从"锦上添花"变成**唯一的出口管控**——`filter` / `clip-path` / `mask` 的值天生就是 `url()`。另外补了一条 `stdDeviation ≤ 40`，因为 Chrome 对超大模糊半径是同步算的。

### S6 多会话看板（2026-10-27）

S2 起状态机里就有一个 `Map` 在做多会话仲裁，但**用户看不见它**——只能看到桌宠演"最吵的那一条"。S6 把这块内存摊开成一张表：谁在跑、跑到什么状态、闲了多久、目录叫什么。

- [x] `src/dashboard.html` + `dashboard-renderer.js` + `dashboard-preload.js`：独立窗口，222/156/18 行
- [x] **双击桌宠开/关看板**（`renderer.js`）。做成 toggle 不是"只开"：桌宠没有任务栏入口，`frame: true` 的看板一旦被关掉，用户就再也找不回来
- [x] 双击判定**只认落在 `#pet` 上的双击**——单击必须留给拖拽，否则拖一下就弹窗
- [x] 窗口参数与桌宠/气泡**刻意相反**：420×460、有边框、不透明（`#faf9f5`）、`alwaysOnTop: false`。那两个是"突然出现在你屏幕上"，这个是你主动要看
- [x] 定位贴着桌宠放；上方放不下就翻到下方（`y < area.y ? py + WIN_H + 12`），并且 clamp 进工作区
- [x] 1s 轮询快照。**不用推送**：`idleMs` 本来就随时间变，没人发事件也得刷新；轮询一个本地 IPC 比维护一套"何时该推"简单得多
- [x] 排序按「最吵的排前面」：error → notification → working → thinking → attention → idle → sleeping，同级按闲置时间升序
- [x] 行节点复用（`rows` Map）+ `insertBefore` 调序，避免每秒重建导致闪烁和按钮失焦
- [x] 当前正在演的那一条用左侧色条标出（`.dominant`）
- [x] 演示模式：只隐藏目录名，状态与时间照旧。它掩盖的是**显示**不是数据，真要彻底隐藏得在宿主侧不采集
- [x] 锁屏/休眠 `hideAll()` 把看板一起 hide——看板比桌宠泄露得多（整张项目列表）
- [x] CSP 与主窗口同款 `default-src 'none'`；所有外部字符串一律 `textContent`

**SEC-09 在 S6 才真正兑现**。S2 当时的做法是「cwd 只留 basename」——那其实是**砍功能**换安全，因为看板要做「复制路径」「跳转终端」就必须有完整路径。S6 把它拆成两层：

| 层 | 存什么 | 谁看得见 |
|---|---|---|
| 2026-10-28 | 修复 | **主题加载失败**：一版外部重写把 `schemaVersion` 写成 `2`，而加载器只认 `1`——它引用的 **18 个帧文件也一个都没生成**（生成脚本写了但从没跑过）。链条上两处断点，报错只暴露第一处 |
| 2026-10-28 | 安全 | 重写把 **CSP 整块删了**，并把非骨骼路径改成 `nextEl.innerHTML = frames.join("")`——**一行绕过整个 SVG 白名单**。白名单还在文件里、注释还在，但已不在任何一条路径上。两条都补回 |
| 2026-10-28 | 修复 | `window.VISUAL_STATES` 被删 → 回归里十几条断言**集体静默失效**（读 `undefined` 不报错，只是查不到）。补回为「给外面看进来的窗口」，收成单一 `adoptTheme()` 入口 |
| 2026-10-28 | 修复 | `eyeTracking` **第二次**变成死字段：rig 分支无条件 `setGaze()`，主题写 `false` 照样跟眼。上一轮修过一模一样的 bug，重写又带回来——「新写的分支不读老字段」是重写最常见的漏 |
| 2026-10-28 | 功能 | working 补回疲惫感：`eyelidTop` 1.8 → 11（1.8 在 28px 高的眼睛上只压 4.5px，肉眼看不见）。眼睑仍必须取面具色 `#967866`，取身体色会在脸上糊白块 |
| 2026-10-28 | 修复 | 主题写了 `walking` 但状态机只有 7 个状态 → **那 4 帧永远播不到**，加载却一切正常。加载器现在把不认识的状态名收进 `warnings`：静默丢弃的东西，作者永远不会发现 |
| 2026-10-28 | 修复 | `rigType` 不再靠 id/name 嗅探：加载器透传、渲染层优先读。原来 `id === "ragdoll"` 兜底意味着**任何叫 ragdoll 的主题都会掉进「画死在 JS 里的那只猫」** |
| 2026-10-28 | 工具 | 回归 54 → 92（补回 `petDebug` 与 `VISUAL_STATES` 救回 38 条）。剩余 11 项是断言假设过时，见「待办」 |
| 2026-10-27 | 功能 | **布偶猫第二轮反馈**：sleeping 身体从椭圆改成锯齿毛边轮廓 + 4 撮毛簇（原话"太圆滑，加点毛"）；thinking 头下移 7px 与身体重叠，消掉脖子缝（原话"头和身体分离了"）；working 换**疲惫半睁眼**（眼睑必须取面具色 `#967866`，取身体色会在脸上糊白块） |
| 2026-10-27 | 功能 | **彩蛋引擎 `gags`**：`motion` 是循环的，写不出"隔一阵钓上来一条鱼"，所以单开一层 `{name, parts, every, duration, steps[]}`——渲染层随机排期、`display` 收放部件、按 `at/span` 一次性插值。working 配两条：**鱼**（浮上来 → 盯着看 0.9s → 加速收进嘴边并缩小）、**拖鞋**（浮上来 → 翻个个儿 → 甩出画面 → 嫌弃地撇开眼）。`pupils` 也参与，猫是真的在看自己钓上来的东西 |
| 2026-10-27 | 修复 | `eyeTracking` 是**写了不生效的死字段**：`theme.js` 校验它、状态对象里带着它，渲染层却从没读过——主题写 `false` 照样跟眼。改成 `applyGaze()` 先看 `currentDef.eyeTracking`；并给 working 的瞳孔补回单个 `.pupils` 组，让这个 `false` **有对象可管、有断言可测**（否则"不跟眼"只是"图里恰好没有瞳孔层"） |
| 2026-10-27 | 修复 | 彩蛋第一段永远"没动"：**还没到点的后续步骤被钳在 `from` 上照写一遍**，覆盖掉正在演的那段（实测鱼在水下时读到 `translate(0.00 0.00)`）。改成"没到点的步骤直接跳过"，语义变成"当前有效的那段说了算"——也正是时间线的直觉 |
| 2026-10-27 | 修复 | 彩蛋收尾把猫的眼睛一起藏了：鱼/拖鞋是天生 `display="none"`，瞳孔是**本来露着**的，一律隐藏就抹掉双眼。改成开演前记录 `{display, transform}` 原值，收尾按原值恢复 |
| 2026-10-27 | 修复 | 睡觉的两只前爪读成"一副眼镜"：两个一样大的完整白椭圆摆在脸正下方。挪到头部**之后**画（被脑袋盖住上半截）、下移、缩小，才是"压在身下的爪尖" |
| 2026-10-27 | 安全 | `gags` 是 `motion` 那类输入的**第二个入口**，且同一彩蛋里有两处选择器片段（`parts[]` 与 `steps[].part`），都走 `PART_RE`；`ease` 走 `EASES` 白名单（未知缓动 = `NaN` 插值 = 部件消失）；`span` 夹到 `duration - at` 以内。结论写进 SECURITY.md，硬约束加第 16–18 条 |
| 2026-10-27 | 工具 | 回归 92 → **103 项**：彩蛋"声明得到 / 部件都画了 / 放得出来 / 真的在动 / 演完收回去 / 瞳孔没被一起藏掉"，以及 `working` 不跟眼 + `idle` 跟眼（对照组） |
| 2026-10-27 | 工具 | `preview:states` 改按**内容高度**取景：原来只截 640 的视口，七状态对照图第二行永远被切一半。顺带让标注写出"跟眼/不跟眼"和"几条彩蛋"——彩蛋 7~28 秒才来一次，静图上永远看不到，不标容易被当成没做 |
| 存储层（`state.js` 的 `sessions` Map） | 完整 cwd，清洗控制字符、限长 1024 | 只在主进程内存里 |
| 快照层（`snapshot()` → IPC → 渲染进程 → 屏幕） | 只有 `publicCwd()` 出来的最后一段目录名，限长 200 | 看板 DOM、投屏、截图 |

完整路径唯一的出口是 `dashboard:copy-path`：用户显式点某一行的「复制路径」，主进程**单条**释放给剪贴板。preload **故意没有**「取完整 cwd」的接口——回归里专门用伪造 id `'../../etc/passwd'` 验证拿不到。

### 接入层国内化：一个安装器，三种 agent（2026-10-27）

原来 `hooks/install.js` 写死 Claude Code。三家 hook **格式**兼容（都是 `{matcher, hooks:[{type, command|url}]}`），
但契约有三处实质差异，照抄会装出"装好了却不触发"或"重复触发"的结果：

| 差异 | Claude Code | CodeBuddy | WorkBuddy |
|---|---|---|---|
| 事件名 | 有 `PostToolUseFailure` | 无，但有 `PreCompact` | 同 CodeBuddy |
| `matcher` | `"*"` | `""`（主仓库一致） | `""` |
| `async` 字段 | 支持，观察型必加 | 官方安装器从不写 | 官方安装器从不写 |
| PermissionRequest | ✓ 真会 POST | ✓ 真会 POST | **✗ 原生沙箱 + GUI 自己处理，永不调用外部端点** |

最后一条是硬事实，来自主仓库源码注释（`workbuddy-install.js:180`）——它甚至专门写代码去清理
早期版本给 WorkBuddy 装下的死 URL。所以 `AGENTS.workbuddy.permission = "none"`，**给 WorkBuddy 装权限 hook 是纯垃圾配置**。

- [x] `AGENTS` 表驱动：`--agent claude|codebuddy|workbuddy`，默认 claude（保持旧行为不变）
- [x] 观察型 hook 按 agent 决定要不要写 `async`；权限 hook 按 agent 决定装不装
- [x] 卸载时即使 `permission: "none"` 也会清理自己留下的残条
- [x] 新增 npm 脚本 `install:hooks:workbuddy` / `:codebuddy` 及对应卸载
- [x] 验证「不破坏别人配置」：拿主仓库留下的备份当输入跑 dry-run，
      主仓库 8 条 command hook **全部保留**，只追加我们自己的 9 条

**共存的两条代价（必须记住）**：CodeBuddy 上两套 hook 并存时，
① 每个事件会跑两次 node（它不支持 async，无法像 Claude 那样甩掉冷启动）；
② `PermissionRequest` 会有两条 http hook 指向同一个 23333 → **一次请求弹两个气泡**。
所以真要长期用 starter 接 CodeBuddy，应当把主仓库那套卸掉，而不是叠着。

### 形象改造：螃蟹 → 布偶猫（2026-10-27）

只换了 `src/visuals.js` 一个文件，`renderer.js` / `state.js` / `main.js` 一行没动——这正是 S3 把"状态机"和"画什么"分开的回报。

- [x] `ragdoll()` 完全对齐原 `crab()` 的接口：`{ eyes, overlay, fur/point, tail, dx, dy, puff, blush }`，`viewBox` 仍是 `0 0 200 200`
- [x] 品种三要素：**蓝宝石虹膜 + 竖瞳**（圆瞳会立刻变成狗/人）、奶油白长毛、深棕重点色（耳/尾/白手套）
- [x] 状态差异化不只靠眼睛：尾巴有 5 种姿势（垂/甩/竖/绕/炸），error 额外炸毛并让毛色泛红
- [x] attention 加**腮红**——这是被截图逼出来的：`^ ^` 的弯眼和 sleeping 的闭眼弧太像，扫一眼分不出来
- [x] 静态契约校验器（临时脚本）：7 状态 19 帧，全部只使用白名单标签，eyeTracking 帧都含 `.pupils`
- [x] 回归 55/55 不变，`gaze` 在新形象上仍收敛（`translate(3.60 -2.60)`）
- [x] 预览截图留档 `docs/ragdoll-states.png`

**白名单的硬约束**（换主题 / 接 S7 时会再撞一次）：`renderer.js` 的 `ALLOWED_TAGS` **没有 `clipPath` / `mask` / `filter`**。
所以蓬松感不能靠滤镜，只能用「粗描边 + 圆角端点」堆出来；尾巴就是一条 `stroke-width=21` 的曲线。

### S5 权限气泡（2026-10-27）

开工前把预判读了一遍，**发现原五条要求里有四条建立在错误假设上**（以为走 command hook，实际是 `type:"http"` 的 HTTP hook），已改写为真实契约版五条，详见 `SECURITY.md`。

- [x] `src/permission.js`：裁决台。所有结局（allow / deny / 超时 / 用户关闭 / 进程退出 / 对端断开）收敛到唯一出口 `settle()`，保证恰好响应一次
- [x] `src/server.js`：`/permission` 端点。不校 token（Claude Code 带不上），但过 Host / Origin / Content-Type 三道锁
- [x] **不做决定的结局返回 204**（不是 deny）—— deny 会让工具静默失败，用户还以为自己批准过
- [x] `src/bubble.html` + `bubble-renderer.js` + `bubble-preload.js`：气泡窗口，懒创建、贴在桌宠上方 12px、宽度固定 360、高度由渲染层量完回传
- [x] 气泡显示工具名 + 完整命令 + cwd + 会话前缀；**「允许」故意不做成主色**，两按钮视觉权重接近
- [x] `hooks/install.js` 增加 `PermissionRequest` 的 HTTP hook：**故意不写 `async`**（它必须阻塞等决定），`timeout: 600`
- [x] 退出收尾：`before-quit` 里 `permissions.dispose()` 把挂起请求全部以 204 结束
- [x] 轮换不适用：本地 HTTP hook 无需 nonce（请求即响应同 socket），nonce 只留给将来的远程审批
- [x] 回归脚本从 37 项扩到 **55 项**，新增权限 A~F 六段 + 退出收尾两段

实现期被自动化测出来的两个 bug（都会让用户莫名其妙，但都不报错）：

- [x] 启动后**第一个**权限请求必定丢失 → 加 `bubble:ready` 握手 + `bubblePendingEntry` 暂存
- [x] 气泡只能点一次（后续按钮全灰） → `render()` 开头恢复按钮可用

### S4-前 Electron 升级（2026-10-27）

- [x] SEC-08：`41.10.7 → 45.0.0`，`npm audit` 8 条公告 → 0
- [x] 新增回归脚本 `scripts/verify-electron.js`（`npm run verify:electron`），37 项断言，零第三方依赖
- [x] 先在旧版跑出 36/36 基线，再对 42.11.18 与 45.0.0 跑同一套判据，三个版本结果对比留档
- [x] 覆盖到「窗口真透明」——用 `desktopCapturer` 比窗口内外相邻像素，实测差值 0
- [x] `petDebug` 补 `state()`：联调时唯一能确认「现在播的是哪个状态」的入口

### S4 接真 hook（2026-10-26）

- [x] S4-1 `hooks/clawd-hook.js`：读 stdin（2s 硬超时 / 1MB 上限，超时按空对象继续）→ 映射事件名 → 只挑 4 个字段 → POST（1.5s 超时）→ 永远 `exit(0)`
- [x] S4-2 `hooks/install.js`：marker 增量合并 + 备份 + 临时文件 `rename` 原子写，支持 `--uninstall` / `--dry-run` / `--file`
- [x] S4-3 端到端联调：七类事件 + oneshot 回落 + 多会话仲裁，**17 项断言全过**
- [x] 桌宠未启动场景：端点文件不存在 → `readPortFile` 抛错 → 静默 `exit(0)`
- [x] 崩溃残留场景：端点文件在、进程已死 → `ECONNREFUSED` → 静默 `exit(0)`，实测 241ms
- [x] 退出时清理端点文件（`before-quit` 里 `unlinkSync`），避免 hook 拿旧端口连空
- [x] **hook 改 `async: true`**：观察型 hook 不再让 agent 白等 node 冷启动

### S1–S3

- [x] S1 透明置顶窗口：无边框 + `backgroundColor: '#00000000'` + `hasShadow: false` 三件套跑通
- [x] S1 点击穿透：默认全体穿透，renderer 命中 `#pet` 时关掉
- [x] S1 拖拽：放弃 `app-region`，改主进程 16ms 轮询全局光标（窗口跟手后收不到 mousemove）
- [x] S2 `POST /state` 接收器，随机端口 + 端口文件发现，256KB 请求体上限
- [x] S2 单会话状态机：事件映射、优先级仲裁（error 压过 working）、oneshot 播完回落
- [x] S2 闲置机制：25s 发呆、60s 睡着，统一 250ms tick
- [x] S3 状态→帧序列映射，每状态可含多帧按 fps 轮播
- [x] S3 双图层交叉淡入，切换不闪白
- [x] S3 眼球追踪：主进程采样 → 归一化 gaze → 渲染层 0.25 系数插值

## S4 联调实测数据

hook 单次耗时拆解（Windows，本机实测）：

| 阶段 | 累计 | 说明 |
|---|---|---|
| `node` 进程启动 | ~200ms | **环境地板，不是我们代码的成本** |
| + 读端点文件 | ~196ms | 噪声，≈0 |
| + `fetch` POST 到桌宠 | 235ms | fetch 自身 ≈35ms |
| 完整 hook（空 stdin） | 236ms | |
| 完整 hook（带 payload） | ~280ms | |

结论：**hook 自身只加 ~35ms，剩下的都是 node 冷启动**。所以 `async: true` 不是优化，是必需品——不加的话每次工具调用白付 200ms。
（误判记录：用 `spawnSync` 连发测得稳定的 ~950ms，那是父进程阻塞 + 子进程连发的测量假象，不要拿它当真实开销。）

状态流转实测（全部 PASS）：

| 事件 | visual | 回落 |
|---|---|---|
| `SessionStart` | idle | — |
| `UserPromptSubmit` | thinking | — |
| `PreToolUse` | working | — |
| `PostToolUseFailure` | error | 2600ms → idle ✔ |
| `Notification` | notification | 3200ms → idle ✔ |
| `Stop` | attention | 2400ms → idle ✔ |
| `SessionEnd` | 会话从表中移除 | — |

多会话仲裁：A=working 时 B 报 error → 显示 error（8 > 3）；B 的 error 播完后回到 A 的 working ✔

**未覆盖**：本机没有 `claude` CLI，真实的 Claude Code 会话没能跑。已用与官方字段形状一致的 payload 走完真 hook 进程 → 真 HTTP → 真状态机 → 真快照，缺的是「宿主怎么调这个 hook」这一段。装完 hook 后第一次真会话要重点看：`async` 是否被宿主认、`matcher: "*"` 是否把非工具事件也触发、stdin 里 `hook_event_name` 是否总存在。

退出清理实测（不是脚本模拟，是关窗口后的真实退出，exit 0）：

| 检查项 | 结果 |
|---|---|
| 端点文件是否被删除 | 已删除 ✔（`before-quit` 的 `unlinkSync` 生效） |
| electron 残留进程 | 无 ✔ |
| 关闭后跑 hook | exit 0，244ms，无输出 ✔（244ms 全是 node 冷启动，`readPortFile` 抛错是瞬时的） |

## S5 联调实测数据

三种结局的响应实测（回归脚本里跑出来的真值，不是设计意图）：

| 触发方式 | 状态码 | 响应体 | 耗时 |
|---|---|---|---|
| 点「允许」 | 200 | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | 即时 |
| 点「拒绝」 | 200 | 同上，`decision:{behavior:"deny",message:"用户在桌宠气泡里拒绝了这个操作"}` | 即时 |
| 没人点 | 204 | 空 | 6001ms（回归把默认 120s 压到 6s） |
| 退出时仍挂起 | 204 | 空 | 随 `app.quit()` 一起，<100ms |
| 退出时排队中 | 204 | 空 | 同上 |

拒绝路径的边界（全部为拒绝，且**都不产生气泡**）：

| 变形 | 结果 |
|---|---|
| 带 `Origin: https://evil.example` | 403 空响应 |
| `content-type: text/plain` | 415 |
| body 是数组而非对象 | 400 |

气泡几何实测：`{"x":2192,"y":910,"width":360,"height":190}`；桌宠窗口顶边 1112，气泡底边 1100，**间距 12px 不重叠**。高度不是写死的——渲染层量 `#card` 的 `getBoundingClientRect()` 后回传，长命令会自动变高。

**未覆盖**：本机没有 `claude` CLI，真实 Claude Code 会话依然没跑过。已用官方字段形状的 payload 走完真 HTTP → 真裁决台 → 真气泡 → 真回写，缺的仍是「宿主怎么调这个 HTTP hook」。装上后第一次真会话要重点看三件事：`type:"http"` 的 hook 是否被这个版本的 Claude Code 认、`timeout: 600` 的单位是秒还是毫秒、宿主对 204 的处理是否真的回落到原生提示。

**已知部署隐患（装之前必须先决定）**：我们的服务固定用 **23333**，和主仓库 `clawd-on-desk` 完全一样。而 `install.js` 是把 URL **写死**进 `settings.json` 的。两个后果：

1. 两个项目**同时运行**时，后启动的那个会 `EADDRINUSE` → 退到随机端口（`server.js` 里有明确 warn），但 `settings.json` 里的 hook URL 仍是 23333 → **权限请求会打到先启动的那个项目**，弹出的是别人的气泡。表现为"桌宠不弹了，另一个窗口在弹"。
2. 服务退回随机端口后，必须**重跑一次 `npm run install:hooks`** 才能让 URL 跟上；不重跑就是打到死端口。

目前的取舍是「跟随主仓库的端口，便于对照」，代价是不能和主仓库共存。真要并存，得让 `install.js` 从端点文件取当前真实端口并在启动时校对——这条留给 S6 一起做。

**hooks 尚未装进真实 `~/.claude/settings.json`**（2026-10-27 决定暂缓）。`npm run preview:hooks` 已确认生成的 JSON 形状与主仓库一致（`matcher: ""` + `type: "http"` + `timeout: 600`，另带 `via=clawd-starter` 标记），但本机没有 `claude` CLI，装进去也无法验证；而「端点没开时 HTTP hook 会怎样」正是上面列的未知项，在没验证之前不适合让它影响所有真实会话。要装随时 `npm run install:hooks`（会先备份），撤销用 `npm run uninstall:hooks`。

## S6 联调实测数据

回归里的看板段（7.7）跑出来的真值：

| 断言 | 实测 |
|---|---|
| 双击桌宠能打开会话看板 | 通过（`waitForUrl` 认出 `dashboard.html` 的 target） |
| 看板列出了会话（≥2 行） | 行数 **3** |
| 目录只显示 basename | `proj-alpha\|（未知目录）\|proj-beta` |
| 完整路径没有泄露到看板 DOM | `basename=true 盘符=false` |
| 演示模式隐藏全部目录名 | `项目已隐藏\|项目已隐藏\|项目已隐藏` |
| 复制路径只对真实会话生效 | `真实=true 伪造=false` |
| 再次双击能收起看板 | `可见=false` |

**行数 3 不是 bug，而且顺带验证了一条边界**：脚本只 seed 了 2 个会话（`sess-alpha` / `sess-beta`），第三行来自更早那次 `POST /state`（`session_id: "upgrade-check"`）——**那次没带 `cwd`**。所以「（未知目录）」这一格正是 `cwd` 缺失分支的实证：没有崩、没有空白格、没有把 `undefined` 打成字符串。这个用例是白捡的，写清楚免得以后有人把它当成"泄漏了第三条会话"。

**剪贴板那一条是唯一没验成的**：`copyPath` 返回 `true`/`false` 是准的（伪造 id 拿到 `false` 就是证据），但 `clipboard.readText()` 在本环境**始终返回空串**——连「自己写 `PROBE-OK` 再读回」都拿不到，说明是这台机器/这个会话访问不到 Windows 剪贴板，不是我们的写入逻辑坏了。所以只记 warn 不断言：**假装断言通过比不测更糟**。要确认内容，手工双击桌宠 → 点某行「复制路径」→ 粘一次。

**测试自隔离（这轮最重要的工程改进）**：

之前「用户开着桌宠」和「跑回归」是互斥的——单实例锁 + 固定端口 23333 会让测试进程直接退出，表现为「渲染进程 15s 内没起来」。这轮给回归加了两道隔离：

```js
const TMP_ROOT = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "clawd-verify-"));
const USER_DATA_DIR = path.join(TMP_ROOT, "userdata");
process.env.CLAWD_PORT_FILE = path.join(TMP_ROOT, "clawd-starter.port");
// spawn 加 --user-data-dir=${USER_DATA_DIR}，第二实例测试也用同一个
```

`requestSingleInstanceLock()` 是按 userData 目录分实例的，所以换了 `--user-data-dir` 就等于另一个应用。现在**用户开着桌宠也能跑 64/64**。

配套修的是清理方式：`child.kill()` 只杀主进程，GPU / utility 子进程逃逸后会继续占着缓存目录，下一次启动就报 `Unable to move the cache: 拒绝访问`。`preview-shot.js` 和 `verify-electron.js` 的 `finally` 都改成按进程树杀：

```js
spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
```

**一次险些误杀**：为了跑回归我先 `taskkill /IM electron.exe`，靠 `Get-CimInstance Win32_Process` 查命令行才确认其中一个 PID 是**用户自己开着的桌宠**。教训是——**别按镜像名杀进程，按 PID + 命令行确认后再杀**，尤其这个项目自己就叫 electron。

## S7 联调实测数据

回归从 64 项扩到 **92 项**，重复运行都是 92/92（其中主题与白名单相关 26 项）。

| 断言 | 实测 |
|---|---|
| 主题已加载到渲染层 / 默认是 ragdoll | `id=ragdoll` |
| 帧数完整 | 19 帧（7 状态），换主题后仍是 19 |
| 白名单剥 script / style / foreignObject | 清洗后标签 = `filter,clippath,rect,rect,rect` |
| 白名单剥 feImage / feTurbulence | 同上，两个图元都不见了 |
| 放行 clipPath / filter | 同上，都在 |
| `on*` 属性被剥 | `onclick=false` |
| `url(http…)` 被剥 | `fill=null` |
| `url(#c)` 保留 | `clip-path="url(#c)"` |
| stdDeviation 钳制 | 输入 9999 → `40` |
| 看板列出的主题都能加载 | `ok=probe,ragdoll 坏的=0`（probe 是回归临时建的第二主题） |
| 看板切主题后立刻生效 | `id=probe`，缺状态由 idle 补齐成 7×3=21 帧 |
| 加载器拒绝路径 | schemaVersion 错 / `../escape.svg` / 资产不存在 / 非法 JSON / 没有 idle / id 含 `../../` —— 六类全拒 |
| 全坏时兜底 | `id=__fallback__`，7 状态齐全，原因字符串带出来 |

### 这轮测出来并修掉的四个真问题

1. **默认主题变成了"名字最小的主题"**。`resolveTheme` 没有显式默认，就退化成按字母序取第一个可用的 → `crab` 成了默认。加 `DEFAULT_THEME_ID = "ragdoll"` 进候选人末尾。
2. **剪贴板断言把自己的证据覆盖掉了**。上一版是「先写 `PROBE-OK` 探针，再读」——探针能跑通时读到永远是 `PROBE-OK`。改成**先读真值**，不等才做能力探测（并把原值写回去）。这一改也**推翻了上一轮的错误结论**：所谓「本环境访问不到剪贴板」是假的，现在实测能拿到 `E:\work\proj-alpha`。
3. **启动时连推两次 idle**。状态机 tick 的 250ms 周期已经把 `lastVisual` 从 null 推成 idle 并 emit 过，300ms 的「首帧保险」又推一遍同样的东西。加 `pushedAnyState` 只在没推过时才补。
4. **透明检测被别的窗口干扰**。原方法是「窗口矩形内侧 vs 外侧」比色，只要有个窗口压在同一位置（比如用户自己开着的那只桌宠），"外侧"采到的就是别人的像素。改成**同一区域拍两次：显示一次、隐藏一次**，背景变量被消掉。四角差值从 `[8,0,3,27]` 变成 `[0,0,0,0]`。

### 测试稳定性这次是硬指标

第 3 个问题一开始表现为**间歇性失败**：4 次跑有 2 次挂在「换状态时切换图层」。第一反应是渲染层的 bug，实际是**测试和状态机的两条时间线交叉**——测试在启动推送落地前就改了状态，半秒后主进程把 idle 推回来。

定位靠的是新加的 `petDebug.stateLog()`（最近 20 次推送的时间线），一次就读出 `[{t:197,visual:"idle"},{t:309,visual:"idle"}]`——两次 idle，112ms 间隔。没有这个记录，只能靠猜。

修法有两条，都做了：
- **应用侧**：去掉重复推送（问题 3）
- **测试侧**：动手改状态前先等推送静默 400ms，并加断言「换一次状态只重建一次」

后者是永久性防线：重建次数翻倍就意味着有东西在重复触发，而画面上**完全看不出来**。

## 安全状态

| 阶段 | P0 | P1 | P2 | P3 | 结论 |
|---|---|---|---|---|---|
| 全局依赖 | 0 | 0 | 0 | 0 | SEC-08 已修：`electron 41.10.7 → 45.0.0`，`npm audit` 0 漏洞。回归现已扩到 **64/64**（升级当时是 37/37，41.10.7 与 42.11.18 也都跑过作对照） |
| S1 窗口 | 0 | 0 | 0 | 1 | SEC-07 部分修（锁屏/休眠隐藏窗口），气泡内容脱敏留到 S5；窗口透明已由回归脚本像素级验证 |
| S2 服务 + 状态机 | 0 | 0 | 0 | 0 | SEC-01/02/04/09 已修：Host/Origin/Token/Content-Type 四道锁 + 会话上限 + cwd 脱敏 |
| S3 渲染 | 0 | 0 | 0 | 1 | SEC-03/06 已修；SEC-05 SVG 白名单清洗器就位，S7 接外部主题前必须回归 |
| S4 接 hook | 0 | 0 | 0 | 0 | 预判点全部落地：备份 + 原子写 + marker 只动自己 + 不落盘 + 静默退出。**补了一条预判里没写的：观察型 hook 必须 `async: true`**，否则每次事件阻塞 agent ~200ms |
| S5 权限回包 | 0 | 0 | 0 | 1 | 五条要求全部落地并各有断言（见 SECURITY.md「S5 落地核对」）。`/permission` 不校 token 是 HTTP hook 架构的固有属性，风险收敛到 Host/Origin/Content-Type + UI 不盲批。**P3 遗留**：本机进程仍可伪造气泡诱骗点击，但增量风险有限（见威胁模型） |
| S6 会话看板 | 0 | 0 | 0 | 0 | SEC-09 在这里才真正兑现：**存储层留完整 cwd，快照层只出 basename，完整路径只在用户显式点「复制路径」时由主进程单条释放**。preload 没有「取完整 cwd」的接口，伪造 id 拿不到。看板自己也是一个新窗口，`sandbox: true` + CSP `default-src 'none'` + 全部 `textContent` 写入；锁屏/休眠时和桌宠一起 hide |
| S7 主题系统 | 0 | 0 | 0 | 0 | SEC-05 从"就位"变成"真的在挡东西"：白名单收窄到 3 个新标签 + 9 个 filt 图元，拒 feImage / feTurbulence / style / foreignObject / animate。`url()` 目标校验升级为唯一出口管控，`stdDeviation` 钳到 40。**校验分两段**：主进程管文件与格式（路径双保险防穿越），渲染层管内容。**没有下载器**，主题只能手工放进 `themes/`——供应链攻击面为零 |
| ~~S8 送信~~ | — | — | — | — | **2026-10-30 整套删除**，SEC-12 / SEC-15 随之删除：它们描述的是一条**已经不存在的输入通道**，留着会让下次审计的人以为"有一份用户内容需要保护"。**现在没有任何用户内容会落盘**，唯一落盘的是端点文件 `{port, token}`。删除时踩的反面教材：误删 `IGNORED_NOTIFICATION_TYPES` 常量而使用还在，`ReferenceError` 被 hook 的 `catch(() => {})` 吞掉 → 所有 Notification 静默发不出、零报错 |
| （原 S8 内容） | 0 | 0 | 0 | 0 | 以下为**删除前**的边界记录，仅作历史：**信是全项目唯一落盘的用户内容**（`0600`、24h 过期、上限 5 封 / 4000 字），也是唯一一条能改写 agent 上下文的输入通道。三条明确不做：不代答（一旦它"帮你整理成一封信"，那封信就不是用户的话了，而 agent 会当成用户说的）、信里不能带命令、不碰桌面端那个未公开端口。路径穿越由「文件名和 `id` 都必须过 `ID_RE`」挡住，回归里有一条专门造 `id: "../../../../etc/passwd"` 的信，断言它既没被列出也没被挪走。信纸窗口 `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`，CSP `default-src 'none'` |
| S9 鼠标唤醒 | 0 | 0 | 0 | 0 | **SEC-13 记录在案（P3，不是漏洞）**：`pet:hover` 是第一条"渲染层要求改状态"的通道。风险上限是"猫不肯睡"（劣化的渲染层可以无限请求唤醒），代价是零——但它确立了边界：**渲染层只能请求，改状态的权力永远在主进程**，且 `wake()` 只认 sleeping，working / thinking / error 一概不碰（回归有对照组断言）。通道无载荷，因此没有可清洗的输入面 |
| S10 风险评级 + 分身 | 0 | 0 | 0 | 0 | **无新增 SEC 编号**（核对全节见 SECURITY.md「S10 风险评级：落地核对」，回归 191/191，`npm audit` 0/0/0）。往 S5 链路加"说服性元素"的四条新风险各有挡法：① 假阴性（`rm -rf ~` 标成低，用户以为机器替看过了）→ `RANK` 取所有命中最大值 + 误报方向偏严，`rm -rf /`、fork bomb、`mkfs`、`curl \| sh` 全部 critical；② 假阳性→警报疲劳 → 判定核心改成**先认命令词再判参数**，`low` 必须占多数（第一版四类误报已重写修掉）；③ 评级依据 ≠ 用户看到的 → `command` 只算一次、同时喂气泡与 `assessRisk()`，`risk` 在 entry 创建时**快照锁进条目**；④ 评级把命令二次送进渲染层 → `reasons[].text` 全来自固定文案表，`renderRisk()` 一律 `createElement` + `textContent`。**硬规则未变：critical 也不自动 deny**，不点/超时/气泡不可用仍是 204（超时用例的命令特意改成 `rm -rf /` 钉死这条）。头巾关键词按 SEC-16 口径（用户原话的派生、过滤在源头、命中 `TITLE_SECRET_RE` 整条丢弃）。顺带修掉一个真实穿透缺陷：1600ms 淡出的猫"看不见但还在 DOM"会**凭空吃掉一块点击穿透**，回归补了"1.9 秒后真的从 DOM 消失"。评级本身**不是安全边界**（agent 有一万种办法骗过关键字检测），这是刻意取舍不是遗留 |

| S10-5 容器换 Rust | 0 | 0 | 0 | 1 | **Tauri 没有换掉安全基线，但有一处必然变松**（核对全节见 SECURITY.md「S10-5 容器换成 Rust」）：渲染层动作面 12 个没变、主题 SVG 白名单没变、本地 HTTP 四道锁逐条照搬、单实例锁已在 S10-6 补齐。**变松的只有一处**：`withGlobalTauri` 关掉后仍摘不掉 `__TAURI_INTERNALS__`，渲染层理论上还能自己 `invoke` 任意命令——但桥刻意不把 `core.invoke` 挂出去（回归有断言钉着），16 个命令的边界仍按"只能调具体动作"守。两处已知差异不是漏洞：`/permission` 挂起中浏览器被关掉时没有 `res.on("close")` 等价物，只能等超时兜底（结论仍是 204）；CSP 显式放行 `ipc: http://ipc.localhost`（硬约束 20 的一次显式例外，只放这一个假域名） |
| S10-6 收尾 + 打包 | 0 | 0 | **1** | 0 | **新增一条 P2：安装包没有代码签名**（SECURITY.md「打包分发（S10-6④）」）——用户无法验证"这个安装包确实来自这个项目"，SmartScreen 会报「未知发布者」，要对外分发必须解决。这条不是回归能挡的，属于发布流程缺口。其余四项都是收紧：单实例锁补上（`single.rs` 命名互斥量 + 命名事件）、`withGlobalTauri` 关掉 + 每窗口命令白名单、锁屏从 2s 轮询换成 WTS 会话事件且失败退回轮询、`installMode: currentUser` 不提权。**另一条已知限制不是安全问题但影响可用性**：`webviewInstallMode` 默认 `downloadBootstrapper`，离线机器装不上 |
| S10-7 自启 + 诊断 | 0 | 0 | 0 | 0 | **无新增 SEC 编号**。开机自启是第一条**会在进程外留全局状态**的功能（`HKCU\...\Run` 一条值），按最小面实现：默认关、写的是**带引号**的当前 exe 完整路径（不拼参数、不接用户输入）、勾选状态从注册表读回来而不是本地变量、写入未生效时告警不假装成功。其余两项是观测能力（`diag-events.js` 只读 `GET /state` 的 `recent`，回放用临时实例）与构建期守卫（陈旧二进制拦截），都不扩大渲染层可达面 |
| S10-9 删容器 + 签名 | 0 | 0 | **1** | 0 | **依赖面归零，签名只补了一半**。① 删掉 Electron 之后 `dependencies` / `devDependencies` 均为空、`package-lock.json` 里 electron 计数 0，SEC-08 从"已升到 45.0.0"变成**已消除**（SECURITY.md 修复记录表）——这是本项目最大的一笔攻击面削减：为一个桌宠的几张 SVG 引进 300+ 传递依赖这件事不再成立。② S10-6 那条 **P2「安装包没有代码签名」只解决一半**：本期接上的是**自签名证书**（`CN=clawd-starter (local dev)`，仅本机受信），对外的「未知发布者 / SmartScreen」提示**仍在**，要消除仍需 OV/EV 或 Azure 制品签名。私钥落在**仓库外**的 `~/.clawd-signing/`，`.gitignore` 另加 `*.pfx` / `*.p12` / `signing.local.json` 防手滑；签名的判据是"配了证书却签失败必须让打包红"，不产出"没签成功却看起来签了"的安装包 |

下一阶段开工前，先看 [SECURITY.md](./SECURITY.md) 里该阶段的预判小节。

## 变更时间线

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-11-04 | 改版 | **头巾 + 胸前 RAG 删掉，换成猫头顶的消息泡泡**（S11 追加，见上方「已完成」）。用户原话：「任务状态直接以消息泡泡的方式弹出，如果有多个就在消息泡泡中列出标题，用户可以点选，查看具体进度。」泡泡常驻、一行一条（`● working 登录页重构`），点一行那只猫顶到最前并展开「任务 / 阶段 / 当前工具 / 已跑多久 / 目录」。**刻意不做百分比**——agent 侧没有这个东西，编出来的进度第三天就会开始骗人。窗口 240×240 → 240×460（多出来的 220px 是透明的，只有猫和泡泡的矩形关穿透；猫在屏幕上的位置不变，窗口往上长）。三个坑：绝对定位伪元素会把可滚动溢出区撑大 7px（四条任务也滚）→ 尖角改成兄弟节点；写死 `bottom` 会让尾巴指着空气（单猫 176px / 分身 88px 头顶差近百像素）→ `placeBubble()` 按当前耳尖实时算；分身退回单猫时 `#cast` 里还有淡出中的幽灵猫，量到它的耳朵 → 按「当前真正在台上的 rig」取。`verify:tauri` 92 → **106**，`cargo test` 42 → **43**（新增 `ageMs`：`idleMs` 每个事件清零，跑了半小时的任务只要刚有动作就会显示「跑了 0 秒」） |
| 2026-11-04 | 测试 | **DSH 并发双写：独占写句柄，安全拒绝而非交错写**（S11 追加，见上方「已完成」）。用「只接不回的假端点」把 turn 卡住，把并发窗口从几十毫秒撑成无限长：**8 个进程同时抢同一会话 → 恰好 1 个拿到句柄，其余 7 个报 `already owned by an active write handle` 并退出 1，一个字都没写进日志**；日志 10 帧全解开 / 24 行全合法 / `seq` 0 重复 0 倒退；`timeout` 强杀后 C 能正常接管（**无僵尸锁**），悬空 turn 在下次打开时被 repair 成 `turn/end(interrupted)`。顺带补了 `STEP_STALE_MS` 闸：按 `openStep.startTime` 判活，防止被强杀的 web 会话让猫永远显示 working（用户报过「没有任务但桌宠一直在工作」）。`cargo test` 38 → 42 |
| 2026-11-04 | 新增 | **接上 DeepSeek Harness，先只做「看」**（S11，见上方「已完成」）。放弃 WorkBuddy 接入线。`src-tauri/src/dsh.rs`（约 700 行含注释与 14 条测试）把 DSH 的投影缓存**翻译**成既有 hook 事件词汇灌进 `Store::apply()`，状态机一行没改——另起一套就是把刚消灭的「同一 agent 两幅画面」重造。**数据源踩了三个坑才找对**：同级 `session_projcache.json` 是 0.1.x 遗留（本机停在 8-31，读它不报错、只安静地一只猫不显示）；0.2.x 改成目录 + 一会话一文件 `{version:7, record:{identity,rows}}`；**会话 id 只在文件名里**。刻意不读多帧 zstd 会话日志（要引解压依赖，取舍见硬约束）。新增 `Meta` 事件让「回填标题」能只改元数据不动状态；`openStep` 步骤间会变 null，所以「这一轮结束」要 2 拍去抖。`verify:tauri` 80→**92**、`cargo test` 23→**38**。DSH 断言**用临时 `DSH_HOME` 夹具**而非本机真实缓存——第一版拿真实缓存做断言，本机所有会话都超 30 分钟窗口，于是必然红，而那其实是正确行为 |
| 2026-11-03 | 新增 | **README 整体重写**（S10-9 ⑤，`2c6ec41`，+496 / −347）。旧版是 S1–S9 时期写的，开头还是 `npm install` / `npm start`（指向**已经删掉的 Electron**），大半篇幅在讲"每个阶段做了什么"。改成「使用者先看、开发者后看」：这是什么 → 三分钟跑起来 → **代码签名**（新增一章：Authenticode 三层、三条路的价格与地区、Azure/OV/EV 各自能不能立刻不弹 SmartScreen、环境变量怎么配、`--verify` 怎么读、自签名怎么进受信根）→ 接 agent（三家 matcher 差异）→ 怎么用 → 端点 → 主题 → 回归 → 内存实话 → 限制 → 踩坑。**文档里留一条指向已删容器的命令，比没有文档更坏**：照着抄的人第一步就失败 |
| 2026-11-03 | 新增 | **发布物接上签名**（S10-9 ②，`8a4a9bd`）。`scripts/sign-release.js`（128 行）由 `bundle.windows.signCommand` 以 `../scripts/sign-release.js %1` 调用，证书走 `CLAWD_SIGN_PFX`(+密码) 或 `CLAWD_SIGN_THUMBPRINT`，强制 RFC3161 时间戳（没有它证书一过期，旧安装包立刻变无效签名）。两条硬规则：**一个都没配 = 响亮跳过（退出 0）**，**配了却签失败 = 退出非 0 让打包红**——不允许"以为签了其实没签"。两条跑出来才知道的硬性事实：`signCommand` 的 cwd 是 `src-tauri/`（写相对路径会找不到脚本）；`cargo tauri build` 结束后**裸 exe 不带签名**（打包器在签名后又覆写了它，日志说签了、产物 `NotSigned`），`npm run bundle` 末尾因此串了一刀补签。本机用自签名证书端到端验过，**P2 只解决一半**（见安全状态表 S10-9 行） |
| 2026-11-03 | 重构 | **删掉 Electron 容器，Tauri 成为唯一容器**（S10-9 ①，`8a4a9bd`）。先画依赖拓扑再按删除键，`git rm` 9 个文件（`main.js` / `preload.js` / `bubble-preload.js` / `dashboard-preload.js` / `state.js` / `risk.js` / `permission.js` / `server.js` / `verify-electron.js`），`dependencies` 与 `devDependencies` 双双归零。**三处会连带坏掉的地方都先查了**：`DEFAULT_PORT = 23333` 从 `server.js` 迁进 `port-file.js`（`hooks/install.js` 要用它拼端点 URL，跟着删就等于把已装好的 hook 指向 `undefined`）；`theme.js` 原位保留（`build-preview-bundle.js` 在用，与容器无关）；`preview-shot.js` 整份是 Electron 写的，移植到 Tauri 后七状态对照图实测能重画。`verify-tauri` 减 1 条（"自启的 Electron 侧与 Rust 侧对齐"失去对象）76 → 75；同轮把 gaze 的"造变化"从 3px 改成 8px——阈值是 `0.02 × 260 = 5.2px`，**3px 永远够不着**，一道会看心情变红的闸门只会训练人忽略红色 |
| 2026-11-03 | 安全 | **`cargo audit` 第一次跑：0 漏洞 / 2 条警告**（S10-7④，详见 SECURITY.md「依赖审计」）。425 个依赖、1402 条公告；两条警告 `proc-macro-error 1.0.4`（unmaintained）与 `glib 0.18.5`（unsound）经 `cargo tree --target x86_64-pc-windows-msvc -i` 确认**都不在 Windows 构建图里**（来自 `tray-icon` 的 Linux/GTK 分支），发出去的二进制不含这块代码；将来做 Linux 构建要先处理。工具用官方预编译的 `cargo-audit 0.22.2`（zip sha256 `0a73165…710ab`），因为本机源码编译 40 分钟没完；公告库让工具自己 fetch 会 failed to consume the pack（libgit2），换 `git clone --depth 1` 五秒完成 |
| 2026-11-03 | 修复 | **verify-tauri 的 gaze 断言不再依赖"有人碰鼠标"**（`7c1b35a`）。gaze 线程有变化检测（位移 < 0.02 不 emit，省 IPC 省电），光标静止时 0 条推送**是正确行为**，可断言写的是"这一轮至少推过一次"——于是它的成败取决于测试期间有没有人动鼠标。复跑时红了一条，看着像回归。修法不是放宽判据（`>=1` 已最松），是**让测试自己造条件**：光标没动就挪 3px 再挪回去（PowerShell 调 `System.Windows.Forms.Cursor`，Node 没有 user32 入口），等 400ms 再读，稳定 `累计 5 次`。**一条断言如果需要外部世界配合，它测的就不是代码，是运气** |
| 2026-11-02 | 新增 | **托盘图标超采样重绘**（S10-7③，`d2e277d`）。`make-icons.js` 原来是「每个像素问一次点在不在形状里」，256px 上看不出问题，但托盘真正用的是 16~24px：猫脸半径只剩 6 个像素、耳朵退化成两块直角三角、眼睛摊成一层雾——**远看像颗花椰菜**。改 **4× 超采样 + 覆盖率降采样**：RGB 取**覆盖样本**的平均、alpha = 覆盖率（按全部样本平均会把透明像素的 (0,0,0) 混进边缘，半透明轮廓发灰发脏）；**≤24px 走简化几何**（眼睛放大 1.6 倍、去鼻子和内耳、耳朵加厚外移）——抗锯齿解决"锯齿"，解决不了"特征小于一个像素"（16px 时眼睛半径只有 0.94px）。ICO 从 5 个尺寸扩到 7 个（16/20/24/32/48/64/256），最近邻 8× 拼图检查过 16px 起耳朵和眼睛都还在 |
| 2026-11-02 | 修复 | **「thinking 掉 idle / 压缩上下文后掉 idle」定案：同一个 bug 的两次出现**（`53353d4`）。根因是 WorkBuddy 在 `UserPromptSubmit` 之后约 0.1s **每轮补发** `SessionStart`（压缩完还会再发一条 `source=compact`），它们都落在**一条已经存在的会话**上，按普通映射处理就是把 thinking/working 清回 idle；S10-6③ 的「SessionStart 只给新会话定初值、已有会话记 `preserved`」已经是根因修复，本轮缺的只是**证据**——新建 `scripts/diag-events.js`，起临时 Tauri 实例把现场观察到的整轮事件序列**照原样回放**，每步同时读服务端快照与渲染层画面、对照显式期望值，10 步全中（含压缩那条路径），挂成第 5 道闸门 `npm run verify:diag` 进 `verify:all`。**过程中先抓到的是自己的 bug**：诊断脚本第一版报「UserPromptSubmit 也掉 idle」，其实是**页面还没挂上 `petDebug` 就去读**，观测窗口自己没就绪（硬约束 40）；顺手堵掉 `verify-tauri.js` 默认用几小时前编的 `target/debug` 二进制、跑出 8 条假 FAIL 的坑（陈旧二进制守卫，硬约束 39） |
| 2026-11-02 | 新增 | **开机自启两边同日补齐**（`7c3f879`）。来历先记一笔：S10-5 的台账把「自启 / 单实例」写在**同一行**且标了 `[x]`，于是它被当成已交付——**是台账自己的错，不是代码的**。Tauri 侧 `sys.rs` 直写 `HKCU\...\Run`（值名 `clawd-starter`，值是**带引号**的 exe 完整路径），托盘 `CheckMenuItem` 的勾**从注册表读回来**而不是本地变量，写成功才动勾；Electron 侧 `setLoginItemSettings` 改完立刻 `getLoginItemSettings()` 读回，写入未生效（组策略 / dev）时 stderr 告警、不假装成功。**默认关**：测试只默认验「关」（幂等、不留痕迹），「开」的往返要 `CLAWD_AUTOSTART_TEST=1` 显式点名——自启是进程外全局状态，测试崩溃会留一条真条目，下次登录自己弹一只猫。回归 Electron 194 / Tauri 76 / cargo 23 |
| 2026-11-02 | 部署 | **打出 NSIS 安装包，并真装真卸验过**（`8f4c6ad`）。`bundle.active: false → true`、`targets: ["nsis"]`（Windows 上唯一不用先装 WiX 3 的通道）、`installMode: currentUser`（装到 `%LOCALAPPDATA%\clawd-starter`，不提权），产物 1.57MB（裸 exe 4.49MB，lzma 整包压）。新增 `scripts/verify-bundle.js` 303 行 / 25 条断言：10 条只读（配置 / 产物 / 版本号 / MZ 头）随时可跑，`--install` 再加 15 条（静默安装 → 逐字节比对 → 启动 → `/health` 200 且 `lock=event` → 静默卸载 → 目录清空 → 快捷方式删除），连跑两轮机器无残留。**三条判据是跑出来才定对的**：①「装出来的 exe 与裸 exe sha256 相同」是错的，tauri-bundler 的 `patch_binary()` 会把 `__TAURI_BUNDLE_TYPE_VAR_UNK` 打成 `_NSS`；②该占位符有 6 处，`indexOf` 会拿到 `_DEB`，必须 `lastIndexOf`；③卸载后开始菜单 `.lnk` 比 exe 晚删，只查一次会把假失败推到下一轮。一条没按原计划做：本想用注册表 Uninstall 子键判断卸干净，本机安全策略拦了 `reg.exe`，判据改成「安装目录 + 快捷方式」两个落盘痕迹。已知限制：**安装包没有代码签名**（P2）、`webviewInstallMode` 默认 `downloadBootstrapper`（离线机器装不上） |
| 2026-11-02 | 重构 | **S10-6 收尾四项**（`9bb41ce` 单实例锁 → `90b8c69` 关掉 `withGlobalTauri` + 每窗口命令白名单 → `8b4a04b` 锁屏改 WTS 会话事件 → `8236ea6` 全量四道闸门）。锁屏从 2s 轮询换成 `WTSRegisterSessionNotification` + `HWND_MESSAGE` 消息专用窗口，自己一条线程跑 `GetMessageW`、与 tao 的消息循环完全不相交（故障不扩散）；只认 `WTS_SESSION_LOCK`/`UNLOCK`，`REMOTE_DISCONNECT`/`CONSOLE_DISCONNECT`/`LOGOFF` 一律忽略——**用户还在，只是换了显示通道**；注册失败退回 2s 轮询（宁可晚 2 秒，也不要一直亮在锁屏界面），`/health` 用 `{"lock":"event"\|"poll"}` 把模式写出来——两种模式失败的样子一模一样，不写出来只能靠猜。收尾全量：Electron 191 / Tauri 74 / cargo 22 / 打包 25 / `check-filemap` 一致，**打包改了配置与产物后 Electron 那 191 条一条没掉**，两套容器共用渲染层到这里才真被验证过一次。内存改成「两次都列」：上午 370.1 vs 383.4、12:10 350.8 vs 379.6，两次差 20–30MB 比两者差距还大，只能写「整机基本持平」，站得住的只有"Rust 宿主自己 10–11MB" |
| 2026-11-02 | 重构 | **容器换成 Rust：迁到 Tauri 2.12.5**（`081921f`，台账 `616cd41`）。前端资产一行没改，`src-tauri/` 下 7 个 `.rs` 3318 行重写了 state / theme / risk / permission / server 五个模块，外加 Win32 的 `sys.rs`；渲染层靠 `src/tauri-bridge.js` 用 `invoke` + `listen` 复刻 `preload.js` 的 `clawd`/`bubble`/`dashboard`，`renderer.js` 里那些 `if (window.clawd)` 原样可用。**三个 bug 只有真跑起来才浮出来**：① 同步 `#[tauri::command]` 跑在主线程，在里面建窗会卡死在 WebView2 创建回调（dashboard 永远 `about:blank`），`app.exit()` 同样失效、8s 超时退不掉 → 两处改 `std::thread::spawn` 后退出 201ms；② `bubble_ready == false` 时只塞 pending 不建窗，页面永远不加载、永远收不到 ready，**第一条权限请求必然挂到超时**（权限气泡在"第一次使用"时是死的）；③ `server.rs` 缺变更回调，心跳再 `tick()` 比的是"新值 vs 新值"，`POST /state` 之后画面永远不更新。CSP 只放行 `connect-src ipc: http://ipc.localhost`（Tauri 的 IPC 在 Windows 上落成这个假域名）。回归 Electron 191 / Tauri 65 / cargo 18，判据同源（`scripts/cdp.js` 两边共用，`risk.rs` 的 16 条用例与 `verify-electron.js` 逐条对应）。内存照实写：Rust 宿主 34.3MB RSS / 11.2MB 私有达标，但 WebView2 还有 6 个子进程共 349MB、整机 383MB ≈ Electron 370MB——**换容器不等于换渲染引擎** |
| 2026-10-30 | 功能 | **S10 三件套：权限风险评级 + 头巾关键词 + 多猫分身**（158 → **180 PASS / 0 FAIL**，新增 22 条断言）。① **风险评级**（`src/risk.js`，纯函数）：命令先归一化（`${IFS}` 绕过 / 反斜杠续行）再按 shell 分隔符切段、**先认命令词再判参数**——第一版拿正则糊整条字符串，`cat ~/.ssh/id_rsa` 被判成"发起网络连接"（`.ssh` 里的 ssh 前后都是单词边界）、`rm -rf ./build` 被判成删根目录（`\.` 没加边界）、"这个测试跑不过"里的"测试"被当动词切掉。分四级 low/medium/high/critical。**评级只进 UI、绝不改变默认行为**：超时用例的命令特意改成 `rm -rf /`（极高危），断言没人点时**仍然是 204**——critical 也不许自动 deny（硬约束 5）。② **头巾**：`UserPromptSubmit` 的 prompt 在 **hook 侧**抽一个关键词 POST 过来（原文照旧不进链路），骨骼渲染器加 `#rig-bandana`，默认 `display="none"`——没词时留一条空布带看起来像随机装饰。隐私口径按最严归宿定（硬约束 28）：它**一直挂在屏幕上**，比只在开看板时才出现的标题更暴露，所以复用标题的密钥正则，命中整条丢弃。③ **多猫分身**：≤1 条会话走原单猫路径（既有行为与断言零改动），≥2 条时每条会话一只猫，横排重叠、点击切换聚焦、5 分钟没动静慢慢淡出（至少留一只，全空了用户会以为进程挂了）。会话名单走**独立的 1s 通道 `cast`**（preload 11 → 12 个动作）——塞进 `state` 那条线两头都不行：state 只在 visual 变化时推（分身会饿着），改成每秒推又会让帧序列主题每次重建全部帧。多只猫的渐变 id 必须加 uid 后缀：`url(#id)` 是**全文档**查找不是 svg 内，两份一样的渐变今天看不出差别，改了其中一份就是"只有第一只猫变色"且无报错。**截图验证过**：`登录页面` 清晰写在头巾上；三只猫各戴各的词、各演各的状态。**资源实测**：常驻 4 进程 WorkingSet 439.6MB / Private 297MB（主 99.8 / GPU 128.8 / 渲染 159.6 / 网络服务 50.9）——比用户预估的 100~200MB 高一倍，最大一块是**桌宠根本用不上的 GPU 进程**；Tauri 迁移（任务 5）未开工，本机无 Rust 工具链 |
| 2026-10-30 | 修复 | **「接不到任务就慢慢消失」原来是死代码**（180 → **191 PASS / 0 FAIL**，新增 11 条）：`.cat.leaving` 写着 1600ms 过渡，但 `retireCat` 的两个调用点**都传了 `immediate=true`**，谁也没见过淡出——CSS 写对了不代表它在跑，所以新增的断言**不读 CSS**，走真实链路让它退场后看它在不在 DOM 里、停了多久（半秒后仍在、1.9 秒后移除）。现在按「会话还在不在」分流：还在（太久没动静或被 4 只上限挤掉）→ 淡出；不在了（`SessionEnd` / 清场）→ 立刻收。退回单猫那条路（`fadeOutCast`）同理——**2 只变 1 只是最常见的收敛**，硬删的话这个效果永远只存在于代码里。顺手修两个真 bug：① 排序比较器写成 `a.idleMs 或 0 - b.idleMs`，被解析成 `a.idleMs 或 (0 - b.idleMs)`，只要 a 有值就直接返回它，**同优先级的排序不自洽**——画面上只是"左右顺序偶尔不对"，没人会报，是回归里 `fast,mid,slow` 那条把它逼出来的；② 点选聚焦的猫会在下一秒被更吵的猫挤出 4 只上限，看起来像点击没生效（那条断言**偶发失败**就是它的症状，不是测试不稳），现在 `pickCast(sessions, keepId)` 保住聚焦的那只——但真到了淡出阈值照样淡出，聚焦不能拿来续命 |
| 2026-10-30 | 调研 | **用户要的"模型 + 上下文用量"在 WorkBuddy 上拿不到**（硬约束 25：不硬写空字段）。主仓库 `hooks/claude-statusline.js` 证明这两样来自 **Claude Code 的 `statusLine.command`** 遥测（`model` / `context_window` / `rate_limits`），那是另一条 hook——它接管终端状态行，必须永远快速打印点东西、绝不抛异常；而 `install.js` 里 statusLine **只注册给 Claude**（`STATUSLINE_MARKER`）。WorkBuddy 的 payload 只有 7 个字段，没有这两项。所以本轮只补了能补的，模型与上下文用量记成"待办：需要单开一个 Claude statusLine 阶段" |
| 2026-10-30 | 功能 | **看板补上"像人话"的两行：会话标题 + 工具名**（用户说「会话管理也没啥具体内容」）。标题两个来源：agent 给的 `session_title`（WorkBuddy `/rename`），没有的话取 `UserPromptSubmit` 的 **prompt 第一行非空文字**。**推导在 hook 侧做，prompt 原文不进这条链路**——只把那一行派生结果 POST 出去。第一行命中密钥正则（`sk-` / `ghp_` / `AKIA` / 32 位以上无空格串，抄主仓库 `workbuddy-hook.js:135`）就**整个标题都不要**，不是洗一半再显示。工具名更省事：`tool_name` hook 一直都在送，但此前**既不存也不显示**——一个活生生的"写对了也不会发生"（硬约束 25），现在它是看板上第二有用的那行。**演示模式连标题一起藏**：那是用户自己说的话，比目录名更容易带出客户名。回归 146 → **157 PASS / 0 FAIL** |
| 2026-10-30 | 功能 | **信箱整套删除**（上午刚做完「报告问题…」入口，下午整套砍掉）。用户一句判断定案：**「如果不能直接发送给 workbuddy，信箱就没有存在的必要了。」** 删了 4 个文件（`mailbox.js` / `letter.html` / `letter-renderer.js` / `letter-preload.js`）、`main.js` 里信纸窗口与 4 个 IPC、`preload.js` 两个动作（13 → 11）、hook 的送信段、`verify` 里 49 条断言。回归 **195 → 146 PASS / 0 FAIL**。更根本的理由（不是"没做好"，是"不该做"）：**它解决的是一个不存在的问题**——想让 agent 知道什么，直接在对话里说是一跳直达，经桌宠转交是三跳，还多一个会丢信的环节 |
| 2026-10-30 | 教训 | **删送信段时误删了 `IGNORED_NOTIFICATION_TYPES` 常量，而使用还在**。`ReferenceError` 被 hook 末尾的 `catch(() => {})` 静默吞掉 → **所有 Notification 都发不出去、零报错**，只有回归里那条「对照组：真的通知照常放行」变红才发现。这是硬约束 1 的反面教材：功能下线要连校验层和文档一起删，而**删的时候要按"使用点"而不是"看起来属于这个功能"来框范围** |
| 2026-10-30 | 功能 | ~~「报告问题…」入口~~ **当天下午随信箱一并删除**。它当时做了三件事：预填现场诊断、本地留副本当回执、给 `letter:open` 加可选 `kind` 让回归能测到跨进程那条链。**其中两条作为通用结论留下了**（已迁进 `PROJECT.md` 硬约束 28）：① 给新内容定隐私口径，先列**全部归宿**、按最严的那处定标准；② **原生菜单在回归里测不到**（弹出来会阻塞主进程），想让菜单背后的链路被真验一次，就得给它留一个可编程入口 |
| 2026-10-30 | 修复 | **「需要我确认的时候，没有提示我啊」（用户写在信里的原话）**：`notification` 被当成"播一次就走"的闪光——内置 3200ms、ragdoll 主题还把它改成 **1500ms**，提示闪一下就撤，人抬头看的时候屏幕上什么都没有。而它在表达的是**持续状态**（agent 卡在那儿等你点允许），主仓库叫 `a real permission hold`。改成内置上限 10 分钟（对齐主仓库 Kimi hold 兜底值），并明确**真正让它消失的是下一个事件把它顶掉**，计时器只是"从此再无事件"的兜底。主题里干脆不再写这个数 |
| 2026-10-30 | 修复 | **长状态暴露出的老 bug**：`tick()` 的 oneshot 霸屏原来只判 `now < oneshot.until`，不问"还有没有人真的处在这个状态"。在 800ms 的 attention 上无感，把 notification 拉到 10 分钟后就变成"权限已通过、agent 在干活，猫还在喊"。加了 `sessionsHave()` 前提——**霸屏的意思是"真的还有人在喊"**。两条断言先红后绿 |
| 2026-10-30 | 修复 | **Notification 的生命周期闲聊在 hook 源头滤掉**：`idle_prompt`（Stop 后约 60 秒的"再发条消息吧"）与 `auth_success`（每轮开头的登录 toast），两个值抄自主仓库 `hooks/workbuddy-hook.js:30` 的实测注释。**必须在 hook 侧滤**——notification 变成长状态后，一条 `idle_prompt` 挂上来就是猫凭空喊好几分钟。白名单式，没见过的 type 照常放行；带对照组断言证明没把整条路关掉 |
| 2026-10-30 | 回滚 | **送信的第二个投递口 `SessionStart` 撤掉了**（前一天刚加）。用户问"我写的信，没了?"——`sent/` 里第二封信被 `take()` 挪走却没进上下文，正是 `mailbox.js` 发誓要防的黑洞。根子是 hook **fire-and-forget**（写完 stdout 就退出，宿主从不回执），"投递成功"根本没有确认手段，于是每多一个口就多一个能把信带走却不一定送到的地方。只守 `UserPromptSubmit`。回归 179 → **183 PASS / 0 FAIL** |
| 2026-10-30 | 台账 | 体积口径改成**含 `src/*.html`**：**23 个 / 7967 行**（src 4654 = 15 js 4056 + 2 html 598、hooks 528、scripts 2785），2026-10-30 10:30 实测。此前记的「21 个 / 7248 行」是漏算了两个 html，不是变胖了 |
| 2026-10-29 | 调研 | **「写完信能不能立刻发出去」的结论：不能，而且不是偷懒**（用户质疑「微信能发，为什么桌宠不行」）。本机确实有一条 IPC（`%USERPROFILE%\.workbuddy\wbipc\endpoint.json`，命名管道 + ticket HMAC 双向挑战握手），**只读探针握手成功**；但它对外只暴露 `wb.request`（唯一方法 `http.fetch`）、`wb.entitlement`、`wb.wecom-a2a`（微信那条路，是内部 A2A）——**没有任何给会话发消息的通道**。结论：**hook 是外部应用唯一能影响上下文的船，它的天花板就是「借下一次上下文」**。探针只握手、只列管道，全程未调用写方法 |
| 2026-10-29 | 功能 | **送信不再必须等用户主动开口**：hook 里 `UserPromptSubmit` 与 `SessionStart` 是官方点名的两个「stdout 进上下文」例外，过去只挂了前者。补上后者之后，因为 WorkBuddy **每一轮都会补发 SessionStart**（同上一条），会话一 resume 信就跟着进了。三处文案从「你下次说话时一起送到」改成「会话一恢复就送到」。新增 3 条断言，其中一条用 `Promise.all` **真并发**逼出双入口竞态，证明 `take()` 的 rename 原子性真的挡住了重复投递。回归 176 → **179 PASS / 0 FAIL**。**2026-10-30 已回滚**：这个口吃掉了一封信（取走了却没送达），见上方 10-30 那条。投递口回到只有 `UserPromptSubmit`，文案改回「你下次开口时送到」，断言翻转成「SessionStart 不会把信取走」。**记住：功能下线要连文档一起改**，否则台账里留着一条描述已经不存在的行为的记录，比没记更糟 |
| 2026-10-29 | 修复 | **「thinking 时显示成 idle」的两个真根因**（用户 10-28 报的现象 1）：① `SessionStart` 被当成"切回 idle"，而 WorkBuddy **每一轮**都会在 `UserPromptSubmit` 之后约 0.1 秒补发一个（source=resume），于是 thinking 立刻被打回 idle 并挂到下一个事件才恢复——改成"只给新会话定初值，不许碰已存在的会话"；② hook 原写 `field(payload.session_id) \|\| "unknown"`，缺会话号的事件被塞进同一条幽灵会话，**多条真实会话的事件互相覆盖**（A 在 thinking，B 结束发 `Stop` → 800ms 后整条回落 idle）→ 缺 session_id 一律丢弃（`trim()` 后判空，`"   "` 也算没带）。两条都在真孔隙、都先红后绿。回归 171 → **179 PASS / 0 FAIL** |
| 2026-10-29 | 台账 | **数字体检**：`PROJECT.md` 原写「25 个源文件 / 7625 行（src 4584）」，实测 **21 个 / 7028 行**——差 597 行是某轮重写后的残留。同批修正 `FILE_MAP` 开头的「19 个 src」（实际 15 个）与 renderer 1475→1476 行。现在体积栏**带实测日期** |
| 2026-10-29 | 视觉 | **身体从「正椭圆」改成「蹲坐的梨形」**：原来 rx54×ry32 的椭圆 + 头宽 104 = 雪人，而且**完美椭圆弧本身就是「圆」的来源**。现在是手绘 path——肩 y112 宽 56（被头完全盖住）、腰 y146 最宽 100、底 y177 收成略平的圆角。连带后爪移到 cx57/143（只在底部露出一牙月牙，原来贴着身体侧面像两块贴片）。试了四版才定：第一版收窄 92 → 头底两侧悬空 13px 的缺口；第二版加平底但肩太陡像斗笠；最后是"肩与头同宽、腰略宽、底收平"。 |
| 2026-10-29 | 视觉 | **删掉肚子上的 `#rig-torso-patch`**（cx112 cy134 rx34 ry18 的米色椭圆，opacity 0.65）。注释写的是"背部柔毛轮廓"，实际读起来是**污渍**：硬边、没描边、比身体暗一档、位置还偏右上。白猫的肚子本来就该是白的，体积感有描边 + 呼吸缩放 + 地面阴影三样就够。 |
| 2026-10-29 | 新增 | **肚子（`#rig-torso`）上补了一行金色 `RAG` 字**：`createRiggedRagdollSVG()` 里躯干 path 之后插 `<text x="100" y="142">`——Georgia 衬线 900 / 14px / `#D4AF37` / `letter-spacing: 2`，外压 0.8px `#524338` 描边压白底。算是对上一条「删掉 `#rig-torso-patch` 后那块空白怎么办」的回答：不做体积暗块，改放标识。当前仅在**工作区改动**（未提交），回归里尚无针对这条装饰件的断言（**补记：这条后来入库了，`git log -S D4AF37` 落在 `48a5ca6 需要提示的时候Ragdoll没有提示`**） |
| 2026-10-28 | 功能 | **S9 鼠标叫醒 + 醒来有过渡**：`mousemove` 命中 `#pet` 且当前 sleeping → `pet:hover` → `store.wake()`（只认 sleeping，working/thinking 不碰；`stateSince` 一起重置）。"慢慢"分两条曲线：躯干/头/耳/尾本来就靠弹簧过冲，眼睛新加 `eyeOpen` 弹簧（0=闭 1=睁，≈0.5s）+ 三层交叉淡入，头顶 zZz 读同一个值淡出。眨眼仍硬切。回归 159 → **171 PASS / 0 FAIL** |
| 2026-10-28 | 视觉 | 删掉胸口大毛领 `#rig-ruff`（只跟呼吸联动的装饰件，躯干本身仍在呼吸）。**删部件要连校验探针一起改**：回归里"每帧都在重算"的探针原本读它的缩放，不改就会读 `missing:rig-ruff` |
| 2026-10-28 | 修复 | 断言 `=== "0"` 判眨眼在连续不透明度下永远不成立（写的是 `0.000`）→ "明明在眨"被判成没眨。改数值比较。**期望值按字符串比**在这个项目里已经踩过两次（上一次是 `style.transform` 的 `3.80px`） |
| 2026-10-28 | 功能 | **S8 跟桌宠说话**：双击 = 写封信，右键 = 小菜单。信落 `mailbox/pending`，由 `UserPromptSubmit` hook 经 `additionalContext` 送进 agent 上下文。**猫不生成任何文字**，只搬运。回归 123 → **159 PASS / 0 FAIL** |
| 2026-10-28 | 决策 | **放弃"立刻送进 WorkBuddy 当前会话"**。CLI 要单独登录（桌面端登录态在 Electron 加密存储里读不到）且 `-p` 只开新会话；桌面端 `127.0.0.1:51650` 是未公开接口，一次更新就崩。选 hook 的 stdout——官方文档写死的契约，代价是"信要到下次提交才送达" |
| 2026-10-28 | 修复 | **信箱顺序 bug**：同毫秒写的几封信排序只能拿 UUID 兜底 → "先写的先寄出"变成随机。修法是 `createdAt` 至少比现有最晚那封晚 1ms；断言验的是**严格递增**这个不变量，不是"第一封排前面"（后者在同毫秒时可能碰巧对） |
| 2026-10-28 | 修复 | **working 中途睡着**（用户报的真问题，是我上一轮加的）：`ragdoll/theme.json` 里写了 `sleepAfterMs: 20000`，而判定用的是"多久没收到事件"（`lastAt`）。一次跑 40 秒的构建期间零事件，但 agent 在干活。改成**只从 idle 累计**（`stateSince`），并删掉那 20 秒 |
| 2026-10-28 | 工具 | `petDebug.events()` 第 15 个出口 + 未知事件终端告警：事件进 `EVENT_STATE` 之前先记一条 `{event, from, to, how}`，`how` 三态 `mapped` / `same` / `ignored`。**"为什么它变 idle"从此有现场可查**，不用靠猜 |
| 2026-10-28 | 修复 | **右手势语义**：右键原来是"直接退出、没有确认"，而桌宠没有标题栏——想找"怎么关掉它"的人唯一会试的就是右键。改成原生菜单（写信 / 看板 / 退出），看板从双击挪进菜单 |
| 2026-10-28 | 功能 | **working 改回敲键盘**（用户否掉钓鱼）：键盘 + 深色编辑器窗口，代码行生长 → 淡出换行，两只前爪**不同频**交替敲（同频会像做操）。彩蛋整体删除，连 `theme.js` 的 `normalizeMotion`/`normalizeGags` 和 `themes/README` 的两节 schema 一起删——消费者没了还留校验器，等于「写对了也什么都不发生」 |
| 2026-10-28 | 修复 | `renderer.js` 里 `rootLayer.innerHTML = createRiggedRagdollSVG()` **一直违反硬约束 19**（src/ 下 innerHTML 必须为 0），活了整轮没人发现——因为这条从没被机械检查。模板改走 `svgNode()`，并加断言扫 `src/*.js|*.html`。**约束不落到断言上等于没有** |
| 2026-10-28 | 工具 | 删掉回归里「motion 声明的部件在 SVG 里都存在」：`def.motion` 永远是 `undefined`，循环一次都不进 → 永远为真。**永远为真的断言比没有更糟**，它在报告里长得像一道防线。同时把 `eyelidTop` 11 → 7（11 是打盹，赶工得让蓝眼睛看得见） |
| 2026-10-28 | 修复 | `petDebug.springs()` 读的是 `ragdollRig.springs`，而 rig 的通道表实际叫 `sp` → **永远返回空对象**，没人发现（外部窗口写了不等于接上了）。改到 `sp` 后暴露真值：**28 个通道**。回归新增「弹簧通道都建起来了（≥20 且有限）」，这一类的第四次发生在同一个项目里 |
| 2026-10-28 | 工具 | 「gaze 收敛到满幅位移」假红的真正原因是 **CSSOM 会把 transform 里的尾零吃掉**：写进去 `3.80px`，`el.style.transform` 读出来 `3.8px`，按字符串精确比必然失败。改成**数值判据**（容差 0.06）。「写着对的期望值却在红」时，先看中间层有没有改写过它 |
| 2026-10-28 | 修复 | 「动画在跑」的探针选错了对象：用 `petDebug.springs()` 证明"在动"，但**弹簧就是要收敛到定值**，稳态（working）下 12 次快照一模一样 → 明明在呼吸却被判成没在动。改成读每帧由正弦直接推导、不经弹簧的那几个 transform（`rig-body-group` / `rig-ruff` / `rig-head-group` / `rig-tail-main`），实测 12/12 |
| 2026-10-28 | 功能 | **钓鱼彩蛋在 rig 里重做回来**：`GAG_DEFS` 两条（fish 7~15s / slipper 15~28s），`#rig-fish` / `#rig-slipper` 各套一层 inner 组避 transform 冲突；采样函数对"还没到点的那一段"用 `continue` 而不是照样写 `from`（写 0 会覆盖正在演的那一段）。排期/播放/收/切状态取消全挂在 rig 的同一个 rAF 上 |
| 2026-10-28 | 功能 | working **从伏案打字变回水边垂钓**：删 `#rig-work-desk`，加水面 + 弯竿（`M136 158 Q158 169 176 176`）+ 鱼线 + 浮标；动作从 10Hz 打字节奏改成疲惫点头，瞳孔钉在水面上（`dynGazeY = 2.2`）。这一版重写对这个状态的理解是「在写代码」，和「钓鱼」不是同一件事 |
| 2026-10-28 | 修复 | 回归里 11 条「断言假设过时」全部按 `rigMode` 分叉：不切图层 / 不重建 DOM / layerB 始终为空 / 眨眼看 opacity / 瞳孔唯一性等各给一把尺子，不再拿帧的尺子量骨架。另补「切走状态会取消正在演的彩蛋」。回归 **92/103 → 105/105** |
| 2026-10-27 | 功能 | **动作重做（S7 之后）**：反馈是"没活猫感、切换卡顿、每个状态都只是 idle 加个东西"。两处根因都是架构的：①逐帧替换是**离散**的，6~8fps 必然频闪；②七个状态共用同一张姿势图。改成 `theme.json` 的 `motion` 声明部件动画，渲染层 rAF 插值到 60fps（呼吸/摆尾/歪头/眨眼/抖动），并**重画七个姿势**（端坐/蹲低歪头/趴低钓鱼/拔高张嘴/炸毛泛红/抬头举信封/侧躺垫爪）。帧数 19 → 7（每状态 1 帧） |
| 2026-10-27 | 修复 | `preview:states` 截图超时：隐藏窗口不会自己产生新帧，而 `Page.captureScreenshot` 要等一帧才返回。以前每个状态都有帧轮播定时器在制造帧，改成 1 帧/状态后页面完全静止就暴露了 → 截图前强制重绘一次 + 重试 3 次 |
| 2026-10-27 | 工具 | 回归加两条"活猫感"断言：**同一状态下 transform 持续变化**（12 次采样 12 个不同快照）与**会眨眼**（眼睛纵向比例压到 <0.5）。另外把"19 帧"改成与 `theme.json` 对账，并新增"motion 声明的部件在 SVG 里都存在"——写错 part 名的后果是那条动画静默不生效 |
| 2026-10-27 | 安全 | `motion.part` 会拼进 `querySelector(".m-" + part)`，所以它是主题提供的**选择器片段**。走 `PART_RE = /^[a-z0-9][a-z0-9-]{0,23}$/` 严格限制，不合格的规则整条丢弃；周期 / 幅度 / 位移全部钳制，避免主题用一条 `period: 1` 的规则把渲染进程拖死 |
| 2026-10-27 | 功能 | 布偶猫三个状态重画：working 改成**钓鱼**（弯竿 + 鱼线 + 脚边水塘 + 浮标涟漪，4 帧 4fps）、sleeping 改成**真趴着睡**（侧头垫爪、尾巴绕身、呼吸起伏，3 帧 2fps）、notification 从铃铛改成**爱心信封**（火漆爱心随心跳缩放，4 帧 5fps）。帧数仍是 19，`pupils` 约束不变 |
| 2026-10-27 | 修复 | 「gaze 收敛到满幅位移」是**竞态**：主进程每 100ms 按真实光标推 gaze，正好覆盖测试注入的坐标，断言读到的其实是光标位置（`translate(-0.98 0.81)`）。给 `petDebug.gaze(g, pin)` 加钉子开关，回归用完 `unpinGaze()` |
| 2026-10-27 | 工具 | 透明检测补**背景噪声基线**：窗口藏起来后同一块桌面再拍一次，先量出"这块地方自己会动多少"，噪声 > 6 的角不参与判定（要求至少 3 个可用角）。第一版写成了"容差 = 噪声 + 2"，噪声 137 时等于永远通过的空壳 |
| 2026-10-27 | 文档 | 发现 `state.js` 的 `IDLE_AFTER_MS = 25s` **从未被使用**（只有 60s 入睡生效），而 `preview.html` 写着「idle · 25s 无事件」。**不擅自改行为**（长工具调用会被误判成发呆），只把预览页说明改成「单次状态播完」，并在常量处注明"要用先想清楚怎么区分长工具调用" |
| 2026-10-27 | 功能 | 完成 S7：`src/theme.js` + `themes/` 三个主题包，**删掉 `src/visuals.js`**。帧数据从"写死在 JS 里"变成"从磁盘读，经 IPC 送进渲染层"。回归 64 → **92 项** |
| 2026-10-27 | 安全 | S7 白名单定案：放行 `clipPath`/`mask`/`filter` + 9 个逐个列举的 fe 图元；拒 `feImage`（外部取图）、`feTurbulence`/`feDisplacementMap`（CPU 炸弹）、`style` 标签、`foreignObject`、`animate`/`set`。**先定白名单再写加载器**，顺序不许反 |
| 2026-10-27 | 安全 | 放行滤镜后补 `stdDeviation ≤ 40`：Chrome 对超大模糊半径是同步计算的，`9999` 就是一次卡死 |
| 2026-10-27 | 修复 | 默认主题退化成"字母序第一个"（`crab` 抢了 `ragdoll` 的位置）→ 加显式 `DEFAULT_THEME_ID` |
| 2026-10-27 | 修复 | 剪贴板断言**先写探针再读**，等于自己覆盖证据；改成先读真值、不等才探测。**并推翻了上一轮"本环境访问不到剪贴板"的结论**——现在实测能拿到完整路径 |
| 2026-10-27 | 修复 | 启动时连推两次同值 idle（tick 已 emit + 300ms 首帧保险），表现为"刚切到 working 又弹回 idle"。加 `pushedAnyState` |
| 2026-10-27 | 工具 | 透明检测改法：从"窗口内外比色"改成"同区域显示/隐藏两次拍照"。原方法只要屏幕上有别的窗口压在同一位置就假失败（差值 `[8,0,3,27]`），新方法四角差 `[0,0,0,0]` |
| 2026-10-27 | 工具 | `petDebug` 补 `theme()` / `builds()` / `stateLog()`：分别回答"现在哪个主题"、"这次切换重建了几次"、"最近谁推了什么状态"。第三个直接定位了上面那个间歇失败 |
| 2026-10-27 | 工具 | `check-filemap.js` 支持 `themes/**` 这种整目录条目：几十个 SVG 帧逐条登记只会让台账变成文件列表 |
| 2026-10-27 | 修复 | **一只眼睛不跟随鼠标**。`visuals.js` 的 `open` 分支里左右眼各套了一个 `<g class="pupils">`，而渲染层是 `querySelector("svg.on .pupils")` —— **只返回第一个匹配**，所以只有左眼转，右眼钉死。合并成单个 pupils 组，并加永久断言「每帧最多一个 `.pupils` 组」+「瞳孔层里两只眼都在」 |
| 2026-10-27 | 功能 | 完成 S6：`dashboard.html` + `dashboard-renderer.js` + `dashboard-preload.js`，双击桌宠开关看板；`state.js` 加 `fullCwd()`；SEC-09 拆成存储层/快照层。回归 55 → **64 项** |
| 2026-10-27 | 安全 | S6 兑现 SEC-09 分层。S2 当时「cwd 只留 basename」其实是砍功能——看板的「复制路径」必须有完整路径。改成：存储层留完整（限长 1024），快照层只出 basename（限长 200），完整路径只在用户显式点击时单条释放 |
| 2026-10-27 | 工具 | 回归**自隔离**：`--user-data-dir` + `CLAWD_PORT_FILE` 指向临时目录。之前「用户开着桌宠」和「跑回归」互斥，现在可以并存。清理改按进程树 `taskkill /T /F`，否则 GPU 子进程逃逸后下次启动报 `Unable to move the cache` |
| 2026-10-27 | 工具 | 新增 `scripts/preview-shot.js`：把 `preview.html` 渲染成 `docs/ragdoll-states.png`，零第三方依赖，可复用 |
| 2026-10-27 | 工具 | 修 `docs/ledger/scripts/check-filemap.js` 的真 bug：存在性判断从 `!actual.includes(f)` 改成 `fs.existsSync()`。原写法让 `docs/` 下的资产（在 `SKIP_DIRS` 里）永远被误报为"已不存在" |
| 2026-10-27 | 工具 | 修 `daily-check.js` 的第二个真 bug：`tryRun` 对整个 `git status --porcelain` 输出做 `trim()`，把**首行开头的空格**剥掉了（` M README.md` → `M README.md`），再 `slice(3)` 就多切一个字母——基线里真的出现过 `EADME.md`。改成 `trimEnd()`，并加 `porcelainPath()` 兜底 |
| 2026-10-27 | 形象 | 用户自改形象为**四肢趴伏姿势**（原为坐姿），配色重写，新增 `faceMask()` 倒V面具 + `puff` / `blush` 参数。接口契约与 `viewBox` 不变 |
| 2026-10-27 | 形象 | 螃蟹 → **布偶猫**。只改 `src/visuals.js`（193 → 334 行，7 状态 19 帧），接口契约与 `viewBox` 不变，`renderer.js` 零改动，回归 55/55 |
| 2026-10-27 | 功能 | 完成 S5：`src/permission.js` 裁决台 + `src/server.js` `/permission` 端点 + 三个气泡文件（html/renderer/preload）+ `hooks/install.js` 增加阻塞式 HTTP hook。回归 37 → **55 项** |
| 2026-10-27 | 安全 | 修正 S5 预判：`PermissionRequest` 是 `type:"http"` 而非 command hook，原五条中四条（nonce、默认拒绝、token 校验）全部作废；改写为真实契约五条并落地 |
| 2026-10-27 | 修复 | 权限气泡两个实现 bug：①首个请求因页面未 ready 被静默丢弃（加 `bubble:ready` 握手）②按钮置灰后不恢复导致只能点一次 |
| 2026-10-27 | 安全 | 补退出收尾：`before-quit` 里 `permissions.dispose()` 把挂起请求以 204 结束，避免关桌宠时 Claude Code 卡满 600s hook 超时 |
| 2026-10-27 | 安全 | SEC-08 已修：`electron 41.10.7 → 45.0.0`，audit 归零。判定依据：`npm audit fix --force` 建议的是最新版，最小修复其实是 42.11.16；42.11.18 与 45.0.0 回归同为 37/37，选 45 是因为 42 已在支持线外 |
| 2026-10-27 | 工具 | 新增 `scripts/verify-electron.js`：主进程 inspector + 渲染进程 CDP 双通道回归，起步 37 项断言，含窗口透明像素级验证（S5 后扩到 55 项） |
| 2026-10-26 | 功能 | 完成 S4：`hooks/clawd-hook.js` + `hooks/install.js`，端到端 17 项断言全过；`before-quit` 清理端点文件 |
| 2026-10-26 | 安全 | 修正 S4 预判漏项：状态 hook 全部加 `async: true`（对照主仓库 `agent-runtime-architecture.md:772`：PermissionRequest 阻塞，其余非阻塞） |
| 2026-10-26 | 安全 | 修复 SEC-01/02/03/04/06/09/10，加固 SEC-05，部分修 SEC-07；新增 `src/port-file.js`；`fake-feed.js` 改带 token。SEC-08 待大版本升级 |
| 2026-10-26 | 决策 | 建立项目台账（`docs/ledger/`），并完成 S1-S3 全量安全审计，产出 10 条问题 |
| 2026-10-26 | 部署 | `first commit`，8 个源文件入库 |
