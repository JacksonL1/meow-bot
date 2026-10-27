# clawd-starter

从零重搭 Clawd 桌宠的 **S1–S6** 骨架：一个能自己出现在桌面上、能被真实 agent 事件驱动、**还能替你回答权限确认**、并且能一眼看到所有会话在干什么的透明窗口。

目标不是"做一个好看的桌宠"，而是**把核心数据链路跑通**——之后每一阶段都是往这条链路上加东西，而不是推倒重来。

```text
事件流：agent 事件 → hook（短命进程，async）→ 本地 HTTP → 状态机 → IPC → 动画
裁决流：agent 要执行工具 → HTTP hook（阻塞）→ 气泡等你点 → 同一个 socket 回 200/204
看板流：双击桌宠 → 独立窗口 → 1s 轮询快照 → 列表（cwd 只有 basename）
```

## 跑起来

```bash
npm install
npm start
```

窗口会出现在屏幕右下角。**拖动它换个位置，双击它打开会话看板**，右键退出。端点（端口 + token）写在 userData 里，不在项目目录：

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

## 安全边界（2026-10-26 加固，2026-10-27 扩到权限端点）

本地 HTTP 端口是「本机任何进程都能连」的，所以接口不是有端口就能用：

| 关卡 | 拦什么 | 失败返回 |
|---|---|---|
| Host 必须是 `127.0.0.1:<本进程端口>` | DNS rebinding | 403 |
| `Origin` 存在且非 `null` | 网页发起的跨源请求 | 403 |
| `x-clawd-token` | 同机其他进程 | 401 |
| `content-type: application/json` | 不触发预检的 CORS 简单请求 | 415 |

**`/permission` 是个例外：它不校 token。** 调用方是 Claude Code 自己，它读不到我们的端点文件，
这条路径上塞 token 只会让权限气泡永远不出现。所以它只过 Host / Origin / Content-Type 三道——
挡的正是**浏览器发起的跨源请求**，那才是真正可利用的路径。这是 HTTP hook 架构的固有属性，不是疏漏。

渲染层另有两道：SVG 字符串走 `DOMParser` + 标签白名单；气泡里的命令用 `textContent` 写入，
agent 给的字符串永远不会被当 HTML 解析。看板同理——目录名、会话 id 全部 `textContent`。

**cwd 是分层处理的（SEC-09）**：存储层留完整路径（「复制路径」要用），快照层只出最后一段目录名。
快照会进渲染进程、进看板、上屏幕，完整路径不会。唯一的例外是用户显式点「复制路径」——
主进程单条释放给剪贴板，`dashboard-preload.js` 里根本没有「取完整 cwd」这种接口。

依赖侧：`electron ~45.0.0`，`npm audit` 为 0 漏洞（原来 41.10.7 有 8 条，含 1 条 high）。
完整清单与验证记录见 `docs/ledger/SECURITY.md`。

## 调试与回归命令

```bash
node scripts/fake-feed.js                     # 完整剧本： thinking → working → error → attention → idle
node scripts/fake-feed.js Stop                # 单个事件
node scripts/fake-feed.js --hold working 10   # 保持某个状态 10 秒

npm run verify:electron                       # 64 项回归：窗口/透明/IPC/DOM/gaze/HTTP/权限/看板/单实例/退出
```

`verify:electron` 同时开两个调试端口：`--inspect=9229` 看主进程（窗口属性、IPC 接线），
`--remote-debugging-port=9222` 看渲染进程（DOM、帧轮播、瞳孔位移、气泡内容、看板列表）。
**升级 Electron 后先跑它再提交。**

它会给自己开一个临时 `--user-data-dir` 和一个临时端点文件，所以**你开着桌宠也能跑回归**，
两者互不干扰。跑完按进程树 `taskkill /T /F` 清理——只杀主进程的话 GPU 子进程会逃逸，
下次启动就报 `Unable to move the cache: 拒绝访问`。

权限那一段（6 项）会把三种结局都走一遍：点拒绝 → 200 `behavior:deny`、点允许 → 200 `behavior:allow`、
没人点 → **204 不做决定**；再加三条攻击面（带 Origin → 403、`text/plain` → 415、数组 body → 400）。
最后两项是退出收尾：挂起中的请求必须拿到 204，而不是悬空到客户端超时。

## 它现在具备什么

- 透明 / 无边框 / 置顶 / 不进任务栏的窗口，可拖动
- 非像素区域**点击穿透**，鼠标不会穿过宠物本体
- `POST /state` 接收器，固定端口 23333 + 端点文件发现（端口与 token 一起写 userData）
- 接口四道锁 + 渲染层 SVG 白名单（见下方「安全边界」）
- 单会话状态机：事件 → 状态 → 优先级仲裁 → oneshot 播完自动退回 → 闲置发呆 / 睡着
- 状态 → 帧序列的映射表（`src/visuals.js`），每个状态可含多帧，按 fps 轮播
- **形象是布偶猫**：奶油白长毛 + 深棕重点色 + 蓝宝石竖瞳；七个状态的尾巴姿势各不相同
  （垂 / 甩 / 竖 / 绕 / 炸），error 会炸毛并让毛色泛红。截图见 `docs/ragdoll-states.png`
- **眼球追踪**：主进程读全局光标 → 归一化成 gaze → 渲染层插值移动瞳孔
- **双图层交叉淡入**：新状态先在隐藏层画好再淡入，切换瞬间不会闪白
- **真 hook 接入**：`hooks/` 下两个文件，把 agent 的 8 个事件送进来；观察型 hook 全部 `async`。
  安装器支持 `--agent claude|codebuddy|workbuddy`，三家的事件名 / matcher 取值 / async 支持各不相同
- **权限气泡（S5）**：桌宠替你在屏幕上问一句「这条命令放不放行」，点一下就把决定回写给 agent；
  不点 / 关掉 / 退出 / 超时一律返回 **204 不做决定**，自动回落到终端原生提示
- **会话看板（S6）**：双击桌宠弹出列表，一条会话一行——状态徽标、目录名、会话 id、闲了多久，
  正在演的那条用左侧色条标出；按「最吵的排前面」排序（error 优先）。
  目录**只显示最后一段**，完整路径只能点「复制路径」单独取（见下方 SEC-09 说明）
- 调试入口：DevTools 里 `petDebug.setState('working')` / `petDebug.gaze({x:1,y:-1})` / `petDebug.state()`

## 故意的简化（去原项目对照时会遇到的差异）

| 这里 | 原项目 | 为什么先简化 |
|---|---|---|
| `visuals.js` 里写死 SVG | `themes/<name>/theme.json` + 资产目录 | 主题系统是 S7，先把"状态→画面"跑通 |
| 事件名以 Claude Code 为基准 | 30+ agent 各自的适配器 | 安装器已能装三家（`--agent`），但事件映射表还没按 agent 分叉 |
| `Map` 内存里存会话 | 加上持久化、恢复租约、历史记录 | 掉电恢复是产品需求，不是学习需求 |
| 看板 1s 轮询 | 事件驱动的推送 + 增量 diff | `idleMs` 天然随时间变，轮询省掉一整套"何时该推"的判断 |
| `/permission` 不校 token | 同样不校——这是 HTTP hook 架构决定的 | 本地 hook 是「请求即响应、同一个 socket」，决定天然绑在请求上，不需要 nonce。**只有远程审批（决定来自公网、可重放）才必须加** |
| 气泡只支持鼠标点 + Esc | 支持键盘决定、远程审批（Telegram 等） | 先把"决定能正确回写"跑通，输入方式属于体验层 |
| 权限请求只存在内存，不落盘 | 有决策历史 | 落盘就多存一份命令原文，等真需要排查再加 |
| 每次 250ms 统一 tick | 事件驱动的定时器 + 相位推断 | 一个心跳函数比十个定时器好懂一百倍 |

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

分界线记住：**观察型 hook 异步，裁决型 hook 阻塞**。S5 的 `PermissionRequest` 走的是 HTTP hook
（HTTP 响应就是决定），那条路径上更不能加 `async`——加了就等于立刻返回空响应，永远问不到用户。

**别用 `spawnSync` 量 hook 耗时**

用 `spawnSync` 在循环里连发测 hook，会稳定得到 ~950ms 这种数字，看着像性能问题。
真实开销是 240–280ms —— 多出来的是父进程阻塞 + 子进程连发造成的测量假象。
要量就用 shell 记时（`date +%s%3N` 前后夹），或者只在业务代码里打点。

**仓库根目录冒出 `NVIDIA Corporation/umdlogs`**

不是你的代码写的。显卡驱动按**进程 CWD** 写着色器日志，而 `electron .` 的 CWD 就是项目根目录。
已在 `.gitignore` 里忽略，不用管它。

**`npm audit fix --force` 建议的版本不是最小修复**

它报「`electron` 受影响 `<=42.11.15`，fix 45.0.0 (major)」，看起来只能跳三个大版本。
但那是 npm 的「跳到最新版」策略。逐条读公告范围会发现最低修复是 `42.11.16`——41.x 没有 backport
（41.10.7 是最后一版且仍受影响），所以必须跨 major，但只需要跨到 42。

判断方法：`npm audit --json`，看 `via[].range`，取所有范围的最大下界；不要直接信 `fixAvailable`。

**`npm install electron@x` 之后启动报错 / 卡在 "Downloading Electron binary..."**

`node_modules/electron` 的二进制是 postinstall 另下的，包本身装好了不代表二进制到位。
国内网络经常在这一步超时，换个镜像重下即可（这一步只下载，不改 `package.json`）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

**写 CDP 脚本时 `require` 在主进程里 undefined**

Node inspector 的 `Runtime.evaluate` 跑在全局作用域，而 `require` 是模块作用域的。
调 `Runtime.evaluate` 时带 `includeCommandLineAPI: true`，它才会注入一个 console 风格的 `require`。
不带的话所有 `require('electron')...` 都会抛 `Uncaught`，看起来像 Electron API 没了。

**连上 inspector 后 `Runtime.evaluate` 永远不回显**

必须先发一次 `Runtime.enable`。不发也能建立连接、也能 `send`，但消息发出去没有任何响应，
`await` 就一直挂着——表现是"脚本卡住"或者"所有断言都超时"，很容易误判成应用挂了。

**第一个权限请求必定丢失（气泡空白，点了没反应，2 分钟后回落）**

气泡窗口是懒创建的。如果页面还没执行完渲染脚本就 `webContents.send`，这条 IPC 会被**静默丢弃**——
不报错、不排队、不重试。修法是握手：渲染层注册完监听后回一个 `bubble:ready`，主进程收到才投递，
在此之前用 `bubblePendingEntry` 暂存。

这类 bug 的隐蔽性在于它表现为「慢」而不是「错」。没有断言就会当成网络偶发，能一直活到生产。

**只有一只眼睛跟着鼠标转**

`querySelector` 只返回**第一个**匹配。渲染层追踪眼球是这么写的：

```js
const pupils = el.querySelector("svg.on .pupils");
pupils.setAttribute("transform", `translate(${dx} ${dy})`);
```

如果画眼睛时图省事，给左右眼各包一个 `<g class="pupils">`，那只有左眼会动，右眼永远钉在原地。
两只眼的瞳孔必须收进**同一个**组里，且组内坐标用绝对值（渲染层会整个覆盖这个组的 `transform`）。

这类 bug 的恶心之处在于它不报错、不警告，画面上看起来"只是有点怪"。回归里有两条永久断言：
「每帧最多一个 `.pupils` 组」和「瞳孔层里两只眼都在（≥2 个瞳孔）」。

**跑回归时提示"渲染进程 15s 内没起来"**

八成不是代码坏了，是**你自己开着桌宠**。单实例锁 + 固定端口 23333 会让测试进程直接退出。

修法不是关掉桌宠，而是让测试自隔离：`requestSingleInstanceLock()` 是按 `--user-data-dir` 分实例的，
所以只要 spawn 时换一个临时 userData 目录（顺带把端点文件也指到临时目录），测试就是另一个应用：

```js
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-verify-"));
process.env.CLAWD_PORT_FILE = path.join(TMP, "clawd-starter.port");
spawn(electron, [".", "--user-data-dir=" + path.join(TMP, "userdata"), ...]);
```

**顺带一条教训**：别用 `taskkill /IM electron.exe` 清场。这个项目自己的进程也叫 electron，
一杀就把用户正在用的桌宠杀了。要按 PID 杀，且先用 `Get-CimInstance Win32_Process` 看命令行确认。

**`Unable to move the cache: 拒绝访问`**

`child.kill()` 只杀主进程，GPU / utility 子进程逃逸后继续占着缓存目录。下次启动就撞这个错。
按进程树杀：`taskkill /PID <pid> /T /F`（`/T` 才是关键）。

**权限气泡只能用一次，之后的请求按钮全是灰的**

点完按钮立刻置灰是正确的防连点，但下一条 `render()` 必须把它恢复。少这一行，第二个及以后的
权限请求全都点不动，只能等超时。所以 `render()` 开头无条件 `disabled = false`，
回归里也专门断言了「第二次请求时按钮已恢复可用」。

## S4 已完成：接真 hook

三个阶段都跑通了：

1. `hooks/clawd-hook.js` —— 读 stdin（2s 硬超时 / 1MB 上限）→ 只挑 4 个字段 → POST（1.5s 超时）
   → 永远 `exit(0)`。没日志、没异常、没重试。
2. `hooks/install.js` —— marker 增量合并 8 个观察型事件 + 1 条权限 HTTP hook，只动带自己标记的条目，
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

## S5 已完成：权限气泡

这一关原本是这个项目最危险的环节，开工前发现**五条预判里有四条建立在错误假设上**：
以为 `PermissionRequest` 走 command hook（有短命进程、有 stdin），实际上它是 `type: "http"` 的
HTTP hook——Claude Code 直接 POST 我们的端点，**HTTP 响应就是决定，没有中间进程**。

因此原方案里的一堆东西直接作废：一次性 nonce 不需要（决定天然绑在请求上）、token 校不了
（Claude Code 读不到端点文件）、默认 deny 是错的（deny 会让工具静默失败，用户还以为批准过）。

落地后的三条态：

| 用户动作 | 响应 | 结果 |
|---|---|---|
| 点「允许」 | 200 `decision:{behavior:"allow"}` | 放行 |
| 点「拒绝」 | 200 `decision:{behavior:"deny", message:"…"}` | 拒绝，并告诉 agent 原因 |
| 不点 / Esc / 关气泡 / 退出 / 超时 | **204 空** | 不做决定，回落 Claude Code 原生提示 |

四个文件：`src/permission.js`（裁决台，所有结局收敛到唯一出口 `settle()`）、
`src/bubble.html` + `bubble-renderer.js` + `bubble-preload.js`（气泡本体）。
`hooks/install.js` 里新加的这条 HTTP hook **故意不写 `async`**——它必须阻塞等决定，
和 S4 那 8 个观察型 hook 语义正好相反。

回归 55/55，其中权限 6 项 + 退出收尾 2 项。**还没验的一段**：本机没有 `claude` CLI，
真实会话依然没跑过。第一次装上要重点看三件事——宿主认不认 `type:"http"`、
`timeout: 600` 的单位是秒还是毫秒、宿主对 204 的处理是否真的回落到原生提示。

**装之前先注意端口**：服务固定用 23333，和主仓库 `clawd-on-desk` 一样，而 hook URL 是安装时
写死进 `settings.json` 的。所以两个项目**不能同时跑**——后启动的会退到随机端口，而 URL 仍指向
23333，权限请求会打到先启动的那个。端口变了必须重跑 `npm run install:hooks`。

## S6 已完成：多会话看板

状态机里从 S2 起就有一张多会话仲裁表，但用户只看到桌宠演「最吵的那一条」。S6 把它摊开成一张表。

**这一关真正的难点不是 UI，是 SEC-09。** S2 当时的做法是「cwd 只留 basename」——听着安全，
其实是**砍功能**：看板要做「复制路径」「跳转终端」就必须有完整路径。S6 把它拆成两层：

| 层 | 存什么 | 谁看得见 |
|---|---|---|
| 存储层（`state.js` 的 `sessions` Map） | 完整 cwd，清洗控制字符、限长 1024 | 只在主进程内存里 |
| 快照层（`snapshot()` → IPC → 渲染进程 → 屏幕） | 只有最后一段目录名，限长 200 | 看板 DOM、投屏、截图 |

完整路径唯一的出口是用户显式点某一行的「复制路径」——主进程**单条**释放给剪贴板。
`dashboard-preload.js` **故意没有**「取完整 cwd」的接口，回归里用伪造 id `'../../etc/passwd'` 验证过拿不到。

另外两个设计取舍：

- **双击开关，不是「只开」**。桌宠没有任务栏入口，看板又是带边框的正常窗口，一旦被关掉就再也找不回来。
  双击判定只认落在 `#pet` 上的——单击必须留给拖拽，否则拖一下就弹窗。
- **1s 轮询，不是推送**。`idleMs` 本来就随时间变，没人发事件也得刷新；推的话还要维护一套「什么时候该推」，
  而轮询一个本地 IPC 的代价近似为零。

**演示模式**只隐藏目录名，状态和时间照旧——它防的是投屏/直播把客户项目名漏出去，不是把看板变成废纸。
它是渲染层偏好，存在 `localStorage`，不回主进程；真要彻底隐藏，应该在宿主侧就不采集，那是另一件事。

回归 64/64，其中看板 7 项。**没验的一段**：剪贴板内容。`copyPath` 返回 true/false 是准的
（伪造 id 拿到 false 就是证据），但本环境 `clipboard.readText()` 恒为空，连「自己写个探针再读回」
都拿不到——手工双击点一次才能确认粘出来的是完整路径。

## 下一步：S7 主题系统

把写死的 `visuals.js` 换成 `themes/<name>/theme.json` + 资产目录。

开工前必须先在 `SECURITY.md` 里定一件事：`renderer.js` 的 `ALLOWED_TAGS` 现在**没有** `clipPath` / `mask` / `filter`。
接外部主题时，放行它们等于让主题文件能做视觉欺骗（把 UI 伪装成系统弹窗）和信息外带（滤镜 URI 引用外部资源）；
不放行，主题的表达能力就受限。**顺序必须是「先定白名单，再做加载器」**——反过来写，加载器写完才发现白名单要放宽，
那时候放宽的动机已经变成「让这个主题能跑起来」，而不是「这样安全」。

## 对照阅读

- `docs/ledger/PROGRESS.md` —— 每个阶段做了什么、实测数据、哪些没验
- `src/state.js` —— 只看 `resolveDominantSessionState` 和 `updateVisualState` 附近，外加 SEC-09 的 `sanitizeCwd` / `publicCwd` / `fullCwd` 三个函数
- `src/permission.js` —— 134 行，重点看 `settle()` 为什么必须是唯一出口
- `src/dashboard-renderer.js` —— 156 行，看「行节点复用 + insertBefore 调序」怎么避免每秒重建
- `hooks/clawd-hook.js` —— 看它如何"读了就 POST，然后立刻退出"
- `hooks/install.js` —— 看观察型（async）和裁决型（阻塞）hook 的区别怎么落进 JSON，以及三家 agent 的差异表
