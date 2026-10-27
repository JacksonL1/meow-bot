# 进度 — clawd-starter

> 阶段划分见 PROJECT.md。每完成一格，同步更新下面的「安全状态」表——**安全和功能一起算完成，不算两件事**。

## 当前目标

S5 权限气泡已完成并回归通过（55/55）。**下一步 S6 多会话 dashboard**，开工前先读 `SECURITY.md` 的 S6 / S7 预判小节。

## 进行中

（无）

## 待办

### S6 / S7

- [ ] S6 多会话 dashboard（cwd 需脱敏）
- [ ] S7 主题系统（先做 SVG 白名单再加载外部主题）

## 已完成

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

## 安全状态

| 阶段 | P0 | P1 | P2 | P3 | 结论 |
|---|---|---|---|---|---|
| 全局依赖 | 0 | 0 | 0 | 0 | SEC-08 已修：`electron 41.10.7 → 45.0.0`，`npm audit` 0 漏洞。回归现已扩到 55/55（升级当时是 37/37，41.10.7 与 42.11.18 也都跑过作对照） |
| S1 窗口 | 0 | 0 | 0 | 1 | SEC-07 部分修（锁屏/休眠隐藏窗口），气泡内容脱敏留到 S5；窗口透明已由回归脚本像素级验证 |
| S2 服务 + 状态机 | 0 | 0 | 0 | 0 | SEC-01/02/04/09 已修：Host/Origin/Token/Content-Type 四道锁 + 会话上限 + cwd 脱敏 |
| S3 渲染 | 0 | 0 | 0 | 1 | SEC-03/06 已修；SEC-05 SVG 白名单清洗器就位，S7 接外部主题前必须回归 |
| S4 接 hook | 0 | 0 | 0 | 0 | 预判点全部落地：备份 + 原子写 + marker 只动自己 + 不落盘 + 静默退出。**补了一条预判里没写的：观察型 hook 必须 `async: true`**，否则每次事件阻塞 agent ~200ms |
| S5 权限回包 | 0 | 0 | 0 | 1 | 五条要求全部落地并各有断言（见 SECURITY.md「S5 落地核对」）。`/permission` 不校 token 是 HTTP hook 架构的固有属性，风险收敛到 Host/Origin/Content-Type + UI 不盲批。**P3 遗留**：本机进程仍可伪造气泡诱骗点击，但增量风险有限（见威胁模型） |

下一阶段开工前，先看 [SECURITY.md](./SECURITY.md) 里该阶段的预判小节。

## 变更时间线

| 日期 | 类型 | 内容 |
|---|---|---|
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
