# clawd-starter

从零重搭 Clawd 桌宠的 **S1 + S2** 骨架：一个能自己出现在桌面上、能被数据驱动的透明窗口。

目标不是"做一个好看的桌宠"，而是**把核心数据链路跑通**——之后每一阶段都是往这条链路上加东西，而不是推倒重来。

## 跑起来

```bash
npm install
npm start
```

窗口会出现在屏幕右下角。端点（端口 + token）写在 userData 里，不在项目目录：

```bash
# 看端点：Windows 下是 %APPDATA%\clawd-starter\clawd-starter.port
node -e "console.log(require('./src/port-file').readPortFile())"
```

手动打一发（**必须带 token，少一个头就是 401，这是故意的**）：

```bash
curl -X POST http://127.0.0.1:<port>/state \
  -H 'content-type: application/json' \
  -H 'x-clawd-token: <token>' \
  -d '{"session_id":"s1","event":"PreToolUse"}'
```

## 安全边界（2026-10-26 加固）

本地 HTTP 端口是「本机任何进程都能连」的，所以接口不是有端口就能用：

| 关卡 | 拦什么 | 失败返回 |
|---|---|---|
| Host 必须是 `127.0.0.1:<本进程端口>` | DNS rebinding | 403 |
| `Origin` 存在且非 `null` | 网页发起的跨源请求 | 403 |
| `x-clawd-token` | 同机其他进程 | 401 |
| `content-type: application/json` | 不触发预检的 CORS 简单请求 | 415 |

渲染层另有一道：SVG 字符串走 `DOMParser` + 标签白名单，`<script>` / `on*` / `javascript:` 全部剥掉。
完整清单与验证记录见 `docs/ledger/SECURITY.md`。

## 三个调试命令

```bash
node scripts/fake-feed.js                     # 完整剧本： thinking → working → error → attention → idle
node scripts/fake-feed.js Stop                # 单个事件
node scripts/fake-feed.js --hold working 10   # 保持某个状态 10 秒
```

## 它现在具备什么

- 透明 / 无边框 / 置顶 / 不进任务栏的窗口，可拖动
- 非像素区域**点击穿透**，鼠标不会穿过宠物本体
- `POST /state` 接收器，随机端口 + 端点文件发现（端口与 token 一起写 userData）
- 接口四道锁 + 渲染层 SVG 白名单（见下方「安全边界」）
- 单会话状态机：事件 → 状态 → 优先级仲裁 → oneshot 播完自动退回 → 闲置发呆 / 睡着
- 状态 → 帧序列的映射表（`src/visuals.js`），每个状态可含多帧，按 fps 轮播
- **眼球追踪**：主进程读全局光标 → 归一化成 gaze → 渲染层插值移动瞳孔
- **双图层交叉淡入**：新状态先在隐藏层画好再淡入，切换瞬间不会闪白
- **真 hook 接入**：`hooks/` 下两个文件，把 Claude Code 的 8 个事件送进来；观察型 hook 全部 `async`
- 调试入口：DevTools 里 `petDebug.setState('working')` / `petDebug.gaze({x:1,y:-1})`

## 故意的简化（去原项目对照时会遇到的差异）

| 这里 | 原项目 | 为什么先简化 |
|---|---|---|
| `visuals.js` 里写死 SVG | `themes/<name>/theme.json` + 资产目录 | 主题系统是 S7，先把"状态→画面"跑通 |
| 只认 Claude 的事件名 | 30+ agent 各自的适配器 | 适配器是纯体力活，等内核稳了再铺 |
| `Map` 内存里存会话 | 加上持久化、恢复租约、历史记录 | 掉电恢复是产品需求，不是学习需求 |
| 只有一个全局 token | 每个权限请求一次性 nonce（S5） | token 只挡"没读过端点文件的人"，挡不住"读过文件但伪造这一次请求的人" |
| 每 250ms 统一 tick | 事件驱动的定时器 + 相位推断 | 一个心跳函数比十个定时器好懂一百倍 |
| 无权限气泡 | `/permission` 阻塞回包 + 键盘决定 | 这是 S5，也是这个项目最有意思的一关 |

## 踩坑记录

**`TypeError: Cannot read properties of undefined (reading 'whenReady')`**

如果环境里存在 `ELECTRON_RUN_AS_NODE=1`（某些 IDE、CI、或者被别的工具设过），
`electron .` 会退化成纯 Node 进程运行，`require('electron')` 返回的是一个**路径字符串**而不是 API 对象。
排查：`env | grep ELECTRON`。绕过：

```bash
env -u ELECTRON_RUN_AS_NODE npm start        # bash
# PowerShell:  $env:ELECTRON_RUN_AS_NODE=""; npm start
```

**窗口全黑 / 有灰色方块**

`transparent: true` 必须配 `backgroundColor: '#00000000'` 和 `hasShadow: false`，三个缺一个就会露底色。

**点不到、也拖不动**

`setIgnoreMouseEvents(true, { forward: true })` 之后窗口默认不接收点击，只转发 mousemove。
必须在检测到鼠标压在宠物上时显式调 `setIgnoreMouseEvents(false)`。

**hook 让每次工具调用都变慢 200ms**

`install.js` 里如果不写 `async: true`，Claude Code 会等 hook 进程退出才继续。
而 Windows 上 `node` 冷启动实测就要 ~200ms —— hook 自己的代码只占 ~35ms，剩下全是进程启动。
`timeout` 管不到这块成本，它管的是「跑太久了砍掉」，不是「要不要等」。

```json
{ "type": "command", "command": "node \"…/clawd-hook.js\" PreToolUse", "async": true, "timeout": 5 }
```

分界线记住：**观察型 hook 异步，裁决型 hook 阻塞**。S5 的 `PermissionRequest` 要返回
`permissionDecision`，那条路径上不能加 `async`。

**别用 `spawnSync` 量 hook 耗时**

用 `spawnSync` 在循环里连发测 hook，会稳定得到 ~950ms 这种数字，看着像性能问题。
真实开销是 240–280ms —— 多出来的是父进程阻塞 + 子进程连发造成的测量假象。
要量就用 shell 记时（`date +%s%3N` 前后夹），或者只在业务代码里打点。

**仓库根目录冒出 `NVIDIA Corporation/umdlogs`**

不是你的代码写的。显卡驱动按**进程 CWD** 写着色器日志，而 `electron .` 的 CWD 就是项目根目录。
已在 `.gitignore` 里忽略，不用管它。

## S4 已完成：接真 hook

三个阶段都跑通了：

1. `hooks/clawd-hook.js` —— 读 stdin（2s 硬超时 / 1MB 上限）→ 只挑 4 个字段 → POST（1.5s 超时）
   → 永远 `exit(0)`。没日志、没异常、没重试。
2. `hooks/install.js` —— marker 增量合并 8 个事件，只动命令里含 `clawd-hook.js` 的条目，
   备份 + 临时文件 `rename` 原子写。`--uninstall` / `--dry-run` / `--file` 都有。
3. 「桌宠没开」两种场景都静默：端点文件不存在 → 立即退 0；文件残留但进程已死 → `ECONNREFUSED` → 241ms 退 0。

```bash
npm run preview:hooks     # 看会写进 settings.json 什么，不落盘
npm run install:hooks     # 真正装进去（会先备份）
npm run uninstall:hooks   # 摘干净，别人的 hook 不动
```

联调实测 17 项断言全过：七类事件映射、oneshot 回落（error 2600ms / notification 3200ms /
attention 2400ms）、多会话仲裁（A 在 working 时 B 报错 → 显示 error，B 播完回到 A 的 working）。
细节和数据在 `docs/ledger/PROGRESS.md`。

**还没验的一段**：本机没有 `claude` CLI，真实的 Claude Code 会话没跑过。装上 hook 后第一次真会话，
重点看三件事 —— 宿主认不认 `async`、`matcher: "*"` 会不会把非工具事件也触发、stdin 里
`hook_event_name` 是不是一直都在（不是的话要靠 argv 兜底，代码里已经兜了）。

## 下一步：S5 权限气泡

S5 是整个项目最危险的一关 —— 桌宠要替用户回答 `PermissionRequest`。做之前先读
`docs/ledger/SECURITY.md` 的 S5 小节，五条要求缺一条就是权限绕过后门。
其中最容易搞错的一条：**token 不能替代一次性 nonce**，因为 token 是长期存在的，而 nonce 用一次就作废。

## 对照阅读

- `docs/guides/state-mapping.md` —— 事件到状态的权威表
- `src/state-priority.js` —— 40 行，整个优先级哲学
- `src/state.js` —— 只看 `resolveDominantSessionState` 和 `updateVisualState` 附近
- `hooks/clawd-hook.js` —— 看它如何"读了就 POST，然后立刻退出"
