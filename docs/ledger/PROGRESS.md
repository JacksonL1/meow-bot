# 进度 — clawd-starter

> 阶段划分见 PROJECT.md。每完成一格，同步更新下面的「安全状态」表——**安全和功能一起算完成，不算两件事**。

## 当前目标

S4 已完成。下一步 S4-前（Electron 升 45.x）或直接进 S5 权限气泡——**S5 之前必须先把 SEC-08 的单独一轮做完**，因为权限回包要动 IPC 与窗口层级，回归面重叠。

## 进行中

（无）

## 待办

### S4-前 依赖升级

- [ ] 升级 Electron 到 45.x（见 SECURITY.md SEC-08）
- [ ] 回归：透明窗口三件套、点击穿透、拖拽轮询、gaze 收敛、`powerMonitor` 锁屏隐藏

### S5 权限气泡

- [ ] `/permission` 阻塞回包
- [ ] 一次性 nonce 机制（绑定 session_id + tool_use_id）
- [ ] 默认拒绝 + 超时拒绝
- [ ] 气泡 UI 显示足够判断的信息
- [ ] 把 `PermissionRequest` 加成**阻塞式** hook（与 S4 的 async hook 相反，见下）

### S6 / S7

- [ ] S6 多会话 dashboard（cwd 需脱敏）
- [ ] S7 主题系统（先做 SVG 白名单再加载外部主题）

## 已完成

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

## 安全状态

| 阶段 | P0 | P1 | P2 | P3 | 结论 |
|---|---|---|---|---|---|
| 全局依赖 | 0 | 1 | 0 | 0 | SEC-08 未修：Electron 41.10.7 仍为 high，升到 45 属 major，S4 前单独走一轮 |
| S1 窗口 | 0 | 0 | 0 | 1 | SEC-07 部分修（锁屏/休眠隐藏窗口），气泡内容脱敏留到 S5 |
| S2 服务 + 状态机 | 0 | 0 | 0 | 0 | SEC-01/02/04/09 已修：Host/Origin/Token/Content-Type 四道锁 + 会话上限 + cwd 脱敏 |
| S3 渲染 | 0 | 0 | 0 | 1 | SEC-03/06 已修；SEC-05 SVG 白名单清洗器就位，S7 接外部主题前必须回归 |
| S4 接 hook | 0 | 0 | 0 | 0 | 预判点全部落地：备份 + 原子写 + marker 只动自己 + 不落盘 + 静默退出。**补了一条预判里没写的：观察型 hook 必须 `async: true`**，否则每次事件阻塞 agent ~200ms |
| S5 权限回包 | 预判 1 | — | — | — | 违反五条要求中任一条即为权限绕过后门；**token 不能替代一次性 nonce** |

下一阶段开工前，先看 [SECURITY.md](./SECURITY.md) 里该阶段的预判小节。

## 变更时间线

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-10-26 | 功能 | 完成 S4：`hooks/clawd-hook.js` + `hooks/install.js`，端到端 17 项断言全过；`before-quit` 清理端点文件 |
| 2026-10-26 | 安全 | 修正 S4 预判漏项：状态 hook 全部加 `async: true`（对照主仓库 `agent-runtime-architecture.md:772`：PermissionRequest 阻塞，其余非阻塞） |
| 2026-10-26 | 安全 | 修复 SEC-01/02/03/04/06/09/10，加固 SEC-05，部分修 SEC-07；新增 `src/port-file.js`；`fake-feed.js` 改带 token。SEC-08 待大版本升级 |
| 2026-10-26 | 决策 | 建立项目台账（`docs/ledger/`），并完成 S1-S3 全量安全审计，产出 10 条问题 |
| 2026-10-26 | 部署 | `first commit`，8 个源文件入库 |
