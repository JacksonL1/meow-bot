# 开发心得

> 一条一个 `##` 小节，新的加在最上面。踩过的坑比写完的功能更值得记。

---

## 2026-10-27 · 预判写错了坐标系，五条要求四条作废

- **场景**：S5 开工前按惯例先写"五条安全要求"，写得很细：一次性 nonce 绑 `session_id` + `tool_use_id`、nonce 只走 stdin、默认 deny、回包要过 Host + token。
- **发现**：全错。写预判时脑子里默认 `PermissionRequest` 和 S4 的观察型 hook 一样是 **command hook**（起个短命进程读 stdin）。去主仓库 `hooks/install.js` 一看，它是 `type: "http"`：**Claude Code 直接 POST 我们的端点，HTTP 响应就是决定**。没有中间进程，没有 stdin。
- **连锁后果**：没有"独立的回包步骤"→ nonce 无从谈起（请求即响应、同一个 socket，决定天然绑在请求上）；没有 stdin → 第 2 条整条作废；调用方是 Claude Code 自己 → 它读不到端点文件，token 根本校不了；默认 deny 是错的 → deny 让工具**静默失败**，用户还以为自己批准过，正确做法是 204 不做决定、回落原生提示。
- **教训**：**预判的价值在于"写下来"，不在于"写对"**。但前提是预判必须在读源码之前标成"假设"，读完源码立刻核对、错了就整条重写而不是打补丁。四条错预判如果只是逐条打补丁，会得到一个"每条都做了点事、但都不对"的实现。
- **顺带学到**：真需要 nonce 的是**远程审批**——决定来自公网、可重放。主仓库的 nonce 只出现在 `telegram-native-runner.js`，`/permission` 那条路径上根本没有。这个区分以后再遇到类似设计时可以直接套。

## 2026-10-27 · 表现为"慢"而不是"错"的 bug 最难发现

- **现象**：启动后的**第一个**权限请求永远不弹内容，气泡空白，点了没反应，2 分钟后静默回落到终端。第二个开始正常。
- **原因**：气泡窗口懒创建。`webContents.send` 发出去的时候，渲染层还没执行到 `bubbleRenderer` 的监听注册，这条 IPC 被**静默丢弃**——不报错、不排队、不重试。Electron 的 IPC 就是这样，发早了就是没了。
- **修法**：握手。渲染层注册完监听后回一个 `bubble:ready`，主进程在此之前用 `bubblePendingEntry` 暂存，收到握手才真正投递。
- **为什么难发现**：它不崩、不报错、日志干净。用户看到的是"有点慢"，开发者会归因到网络、到 hook 超时、到系统负载，就是不会想到"消息发早了"。**这类 bug 只有断言能抓**——回归里那句「气泡显示了工具名」就是为它写的。
- **推广**：凡是"主进程推、渲染层收"的链路，只要渲染层是懒创建的，第一次投递就必须有握手。这和 S1 主窗口不一样——主窗口 `ready-to-show` 之后才 show，天然避开了。

## 2026-10-27 · 退出时的收尾不是洁癖，是 10 分钟的卡死

- **场景**：用户关掉桌宠的瞬间，Claude Code 可能正卡在一个 `PermissionRequest` 上等回应。
- **如果不管**：那条 HTTP 连接既不断开也不答复，一直悬着。hook 侧写的是 `timeout: 600`，所以终端最长 **10 分钟没有任何反应**，而气泡已经不在了，用户完全无从判断发生了什么。
- **做法**：`before-quit` 里 `permissions.dispose()`，把仍 pending 的请求全部以 204 结束。204 让 Claude Code 立刻回落原生提示，用户切到终端照样能批。
- **容易写错的地方**：`dispose()` 走 `settle() → onResolve()`，而 `onResolve` 里有"弹下一条"的逻辑。写得不对就会在退出过程中新建一个浏览器窗口，或者把排队项漏成悬空连接。所以回归里**同时挂两条**（一条在显示、一条在排队）来覆盖，只测一条测不出来。
- **教训**：任何"资源在退出时释放"的逻辑，都要问一句「如果还有人在等这个资源呢」。`server.close()` 等的是连接，而连接的对端是一个真实在等的进程。

---

## 2026-10-26 · Electron 的安全默认值是"半个"默认值

- **场景**：给 S1-S3 做安全审计，本以为 `contextIsolation: true` + `nodeIntegration: false` 就基本安全了。
- **发现**：这两个确实是关键项，项目里也都写对了。但 Electron 的安全面远不止这两条——`sandbox` 依赖版本默认、`webSecurity` 没写、`index.html` 没有任何 CSP。三个都没配，等于「门锁好了但窗户开着」。
- **另一个更隐蔽的**：本地 HTTP 服务不校验 `Host` 和 `Content-Type`。因为 `text/plain` 是 CORS 简单请求、不触发预检，**任意网页**都能往 `127.0.0.1` 发 POST 且拿不到响应也无所谓——副作用已经发生了。这类"本地服务信任边界"问题在 Electron/桌面端特别常见。
- **教训**：桌面应用的威胁模型和 Web 不一样。Web 里"跨域被拦"是一种保护；桌面端本地端口是**没有同源策略**的，必须自己补 Host/Origin/Token 三件套。

## 2026-10-26 · 把"未来会变危险"的地方提前标出来

- **做法**：审计时把问题分成「现在的影响」和「S7 之后的影响」两栏，比如 `renderer.js` 里的 `innerHTML`。
- **为什么**：现在 `markup` 来自本地常量，完全安全；但 S7 主题系统会从磁盘读第三方 SVG 字符串，同一个 `innerHTML` 立刻变成标准 DOM XSS 入口。如果只按当前风险评为"无风险"，等 S7 开工时没人会想起来回看。
- **教训**：给问题标「触发条件」，比标「严重度」更能防止遗忘。严重度决定先修谁，触发条件决定什么时候必须修。

---

## 摘自 README 的踩坑（原记录在项目 README，此处存档备查）

### `TypeError: Cannot read properties of undefined (reading 'whenReady')`

- **现象**：`electron .` 启动即崩，`require('electron')` 拿到的是路径字符串而不是 API 对象。
- **原因**：环境里存在 `ELECTRON_RUN_AS_NODE=1`（某些 IDE、CI 或别的工具设置过），Electron 退化成纯 Node 进程。
- **排查**：`env | grep ELECTRON`
- **绕过**：`env -u ELECTRON_RUN_AS_NODE npm start`（PowerShell：`$env:ELECTRON_RUN_AS_NODE=""; npm start`）

### 窗口全黑 / 出现灰色方块

- **原因**：`transparent: true` 必须同时配 `backgroundColor: '#00000000'` 和 `hasShadow: false`。
- **教训**：三个参数缺一个就露底色，这是 Electron 透明窗口的固定组合，不是可选项。

### 点不到、也拖不动

- **原因**：`setIgnoreMouseEvents(true, { forward: true })` 之后窗口默认不接收点击，只转发 `mousemove`。
- **解法**：必须在检测到鼠标压在宠物身上时显式调 `setIgnoreMouseEvents(false)` 切回来。
- **衍生坑**：窗口跟着光标移动后，光标在窗口内的相对位置不变，renderer 就再也收不到 `mousemove`——所以拖拽只能用主进程 `screen.getCursorScreenPoint()` 轮询，不能用 `-webkit-app-region: drag`。
