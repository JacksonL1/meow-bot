# 进度 — clawd-starter

> 阶段划分见 PROJECT.md。每完成一格，同步更新下面的「安全状态」表——**安全和功能一起算完成，不算两件事**。

## 当前目标

S1–S6 全部完成，回归 **64/64**。**下一步 S7 主题系统**，开工前先读 `SECURITY.md` 的 S7 预判小节——那一节的核心结论是「白名单先于加载器」，顺序反了就是 XSS 直通车。

## 进行中

（无）

## 待办

### S7

- [ ] S7 主题系统：`themes/<name>/theme.json` + 资产目录，替换写死的 `visuals.js`
- [ ] S7 前置：`renderer.js` 的 `ALLOWED_TAGS` 目前**没有** `clipPath` / `mask` / `filter`，接外部主题前先决定要不要放行（放行 = 滤镜可被用来做视觉欺骗与信息外带，不放行 = 主题表达能力受限）

### 未验证清单（跨阶段累积，别当成已完成）

- [ ] **真实 agent 会话一次都没跑过**——本机无 `claude` CLI，也无 WorkBuddy/CodeBuddy 的 hook 实测。这是贯穿 S4/S5/S6 的最大缺口
- [ ] 剪贴板内容（`dashboard:copy-path` 返回值在回归里只能验 true/false，`clipboard.readText()` 在本环境始终为空，需手工点一次确认）
- [ ] WorkBuddy 是否真的支持 hooks（官方文档无 hooks 章节，`hooks/install.js --agent workbuddy` 生成的是按 CodeBuddy 契约推的）
- [ ] WorkBuddy 安装待用户在自己终端执行：`npm run install:hooks:workbuddy`（沙箱写不了 `~/.workbuddy/settings.json`）

## 已完成

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

下一阶段开工前，先看 [SECURITY.md](./SECURITY.md) 里该阶段的预判小节。

## 变更时间线

| 日期 | 类型 | 内容 |
|---|---|---|
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
