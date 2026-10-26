# 技术名词手册

> 从 `clawd-starter` 的真实代码里提炼，每个词都能指到具体行。
> **复习方法**：先读「0. 全局骨架」建立地图 → 按组读详解 → 用「速查卡」自测 → 卡住的回到对应编号精读。

## 怎么用这份手册

三种读法，按你的时间选：

| 场景 | 怎么读 |
|---|---|
| 5 分钟，通勤路上 | 只读「速查卡」，看到想不起来的编号再回查 |
| 30 分钟，系统过一遍 | 读 A→H 八组，每组先看开头的一句话概括 |
| 面试/讲给别人听之前 | 做「自测 20 题」，答不出的就是薄弱点 |

每个名词统一四段：**一句话**是什么 → **本项目**哪里用到 → **为什么**这么设计 → **坑**在哪。

---

## 目录

- [0. 全局骨架：先建立地图](#0-全局骨架先建立地图)
- [A. Electron 三进程模型](#a-electron-三进程模型)
- [B. 透明窗口的七个参数](#b-透明窗口的七个参数)
- [C. 进程间通信 IPC](#c-进程间通信-ipc)
- [D. Node 原生 HTTP 服务](#d-node-原生-http-服务)
- [E. 本地服务的安全四道锁](#e-本地服务的安全四道锁)
- [F. 状态机与调度](#f-状态机与调度)
- [G. 渲染层：SVG、动画与性能](#g-渲染层svg动画与性能)
- [H. 工程化与工具链](#h-工程化与工具链)
- [速查卡](#速查卡)
- [自测 20 题](#自测-20-题)
- [按阶段的复习路径](#按阶段的复习路径)

---

## 0. 全局骨架：先建立地图

一句话：**一个 Electron 应用 = 一个 Node 主进程 + 若干被它管着的浏览器窗口 + 两者之间的受控通道。**

这个项目的完整数据流只有一条主线：

```text
   外部事件（fake-feed.js，将来是 Claude Code 的 hook）
        │  ① HTTP POST 127.0.0.1:<port>  { session_id, event, cwd }
        │     必须带 x-clawd-token，且 Host/Origin/Content-Type 合规
        ▼
 ┌─────────────────────────────────────────────────┐
 │  主进程（Node 环境，有完整系统权限）              │
 │                                                 │
 │  server.js ──► state.js ──► broadcast()         │
 │   四道锁       事件→状态      webContents.send   │
 │                优先级仲裁                        │
 └──────────────────────────┬──────────────────────┘
                            │ ② IPC 通道 "state" / "gaze"
                            │   （只有 preload 里白名单的动作能过）
                            ▼
 ┌─────────────────────────────────────────────────┐
 │  渲染进程（浏览器环境，没有 Node 权限）           │
 │                                                 │
 │  preload.js 暴露 window.clawd 的 6 个动作        │
 │  renderer.js setState → visuals.js 取帧 → SVG   │
 └─────────────────────────────────────────────────┘
```

三条铁律，记住这三条，后面所有细节都是它的展开：

1. **能力只在主进程**。渲染进程想要任何系统能力（拖窗口、退出、读光标），必须经过 preload 显式开的口子。
2. **状态只在主进程算**。渲染层收到 `working` 就播 `working`，不问为什么——业务判断和呈现彻底分离。
3. **输入永远不可信**。HTTP 请求来自网络侧，每个字段进内存前都要清洗、限长、白名单。

---

## A. Electron 三进程模型

### A1. 主进程 / Main Process

**一句话**：Electron 应用的入口，是一个完整的 Node.js 进程，能开窗口、读文件、访问系统 API。

**本项目**：`src/main.js` 整个文件；`package.json` 里 `"main": "src/main.js"` 指定入口。

**为什么**：所有"有权限的操作"都收敛在这里。窗口创建、光标读取、生命周期清理，全在这一个文件里，出问题只查一处。

**坑**：主进程里做重活会卡住整个 UI（包括所有窗口）。`npm audit`、大文件解析这类操作不能同步跑在主进程。

### A2. 渲染进程 / Renderer Process

**一句话**：每个 `BrowserWindow` 内部是一个 Chromium 渲染进程，本质就是个浏览器页面。

**本项目**：`src/index.html` + `src/renderer.js` + `src/visuals.js` 运行在这个环境里。

**为什么**：把"画界面"和"管系统"分开，是 Chromium 多进程架构的原样继承。渲染进程崩了不会带崩主进程。

**坑**：渲染进程里 `require` 用不了（本项目 `nodeIntegration: false`），也不能直接读文件、拿光标位置。

### A3. 预加载脚本 / Preload

**一句话**：在渲染进程加载页面**之前**运行的一段脚本，是唯一同时能碰到 Node 和页面 `window` 的地方。

**本项目**：`src/preload.js`，13 行，暴露 6 个动作。

**为什么**：它是"能力的唯一出口"。渲染层拿不到 `ipcRenderer` 本体，只能调用你明确列出来的函数——这叫**最小权限原则**的实现方式。

**坑**：最危险的写法是 `contextBridge.exposeInMainWorld('ipc', ipcRenderer)`，把整个通信对象扔出去，等于把主进程所有通道都对页面开放。本项目连 `ipcRenderer.send` 都没直接给，而是包成了 `dragStart()` 这种具体动作。

### A4. contextIsolation（上下文隔离）

**一句话**：让 preload 和页面脚本运行在**隔离的 JS 上下文**里，页面改不到 preload 的对象。

**本项目**：`src/main.js:59` 显式写 `contextIsolation: true`。

**为什么**：如果不隔离，页面上的脚本（包括被注入的恶意脚本）可以直接改写 `window.clawd.dragStart`，把用户操作劫持成别的动作。

**坑**：默认值在 Electron 12+ 就是 `true`，但**显式写出来**才安全——将来版本策略变化或有人改了配置，你不会因为"依赖默认值"而无声退化。

### A5. nodeIntegration（Node 集成）

**一句话**：控制渲染进程能不能直接用 Node API（`require`、`process`、`fs`）。

**本项目**：`src/main.js:60` 显式 `false`。

**为什么**：一旦开启，页面里任何 XSS 都能直接 `require('child_process').exec()`——从"改个界面"升级成"执行任意命令"。

**坑**：不要为了"图方便读个配置文件"打开它。正确做法是在主进程读好，通过 preload 传过去。

### A6. sandbox（沙箱）

**一句话**：在操作系统层面限制渲染进程的系统调用能力，比 contextIsolation 更底层一层。

**本项目**：`src/main.js:63` 显式 `sandbox: true`。

**为什么**：Electron 20+ 默认开启，但默认值会随版本变。作者在注释里写得很清楚：「默认值会随版本变，而这三项一旦被无声削弱，隔离就没了」。这是很好的工程习惯——**安全基线不依赖默认值**。

**坑**：开沙箱后 preload 里也不能用大部分 Node 模块，只能用 `electron` 暴露的有限 API 和 polyfill 过的几个。

### A7. contextBridge

**一句话**：`preload` 里用来"往页面 window 上挂东西"的官方通道，会做结构化克隆，不让对象引用穿透。

**本项目**：`src/preload.js:6` `contextBridge.exposeInMainWorld("clawd", {...})`。

**为什么**：它保证挂上去的东西是**数据**不是**引用**，页面拿到的函数无法反过来访问 preload 的闭包变量。

**坑**：只能传可序列化的值。传一个 class 实例或带方法的对象会静默失败或抛错。

---

## B. 透明窗口的七个参数

`src/main.js:42-68` 那一段配置，是本项目最"物理"的部分。七个参数共同决定了一个桌宠窗口能不能正常显示。

### B1. 透明窗口三件套

**一句话**：`transparent: true` + `backgroundColor: '#00000000'` + `hasShadow: false`，**缺一个就露底色**。

**本项目**：`src/main.js:47-53`。

**为什么**：
- `transparent` 只关掉"填充背景"这一步；
- 不给 `backgroundColor` 的透明值，Chromium 会补一个默认白/灰；
- `hasShadow` 是系统画的窗口阴影，它按矩形边界算，透明区域会显示成一个灰方块。

**坑**：README 里记录的"窗口全黑 / 有灰色方块"就是这个，三个参数永远要一起改。

### B2. frame / skipTaskbar

**一句话**：`frame: false` 去掉系统标题栏，`skipTaskbar: true` 让窗口不在任务栏占位。

**本项目**：`src/main.js:49,54`。

**为什么**：桌宠不该像普通应用那样有边框和任务栏图标。

**坑**：去掉 frame 就**没有关闭按钮**了。必须自己实现退出方式——本项目用右键菜单（`renderer.js:195` `contextmenu` → `quit`）。

### B3. alwaysOnTop 与 level 参数

**一句话**：`setAlwaysOnTop(true, 'screen-saver')`，第二个参数才是真正决定层级的东西。

**本项目**：`src/main.js:71`。

**为什么**：Windows 上普通 `alwaysOnTop` 会被全屏应用压掉，`screen-saver` 是最高常规层级，能盖住全屏。

**坑**：层级越高越"霸道"——它也会浮在锁屏界面之上。本项目为此加了 `powerMonitor` 监听（见 B7）。

### B4. setIgnoreMouseEvents 与 forward

**一句话**：让窗口"鼠标穿透"，点击落到下面的窗口上；`{ forward: true }` 表示仍然把 `mousemove` 转发给本页面。

**本项目**：`src/main.js:74` 初始全体穿透；`renderer.js:177-182` 根据鼠标是否压在宠物上动态开关。

**为什么**：透明窗口默认会挡住下面所有点击。桌宠只占中间 176×176，四周的透明区域必须能点穿。

**坑**：设了 `ignore(true)` 之后窗口**不接收点击**，只转发移动。想让宠物能被拖动，必须在检测到命中时显式 `setIgnoreMouseEvents(false)`——这就是那个"点不到也拖不动"的坑。

### B5. 命中检测：elementFromPoint 与 closest

**一句话**：用 `document.elementFromPoint(x, y)` 拿到鼠标位置最上层的元素，再看它在不在 `#pet` 里面。

**本项目**：`renderer.js:177-182`。

**为什么**：比维护一个几何矩形简单，而且天然支持 SVG 内部结构变化。

**坑**：本项目用的是 `#pet` 的**包围盒**（176×176 正方形），不是真实 alpha 遮罩——所以四个角上的透明像素会被误判成"可点击"。更精细要做 canvas 采样 alpha，属于后续优化。

### B6. workArea 与 getCursorScreenPoint

**一句话**：`screen.getPrimaryDisplay().workArea` 是去掉任务栏后的可用区域；`screen.getCursorScreenPoint()` 是全局光标坐标。

**本项目**：`main.js:40`（初始位置放右下角）、`main.js:104,113,136`（拖拽与眼球追踪）。

**为什么**：这两个 API **只有主进程有**。渲染进程的 `mousemove` 坐标是相对窗口的，窗口一跟手移动，相对位置就不变了，根本算不出拖拽位移。

**坑**：这就是必须"主进程 16ms 轮询光标"来拖拽的根本原因，不是偷懒。

### B7. powerMonitor

**一句话**：监听锁屏、休眠等系统电源/会话事件。

**本项目**：`main.js:151-162`，锁屏和挂起时 `win.hide()`，解锁恢复时 `win.showInactive()`。

**为什么**：`screen-saver` 层级会浮在锁屏之上。现在只显示个宠物无所谓，但 S5 的气泡会显示"正在执行什么命令"——那时浮在锁屏上就是**信息泄露**。

**坑**：`showInactive()` 和 `show()` 的区别是前者不抢焦点。桌宠恢复时不抢焦点更重要。

---

## C. 进程间通信 IPC

### C1. 单向 send/on 与双向 invoke/handle

**一句话**：`ipcRenderer.send` + `ipcMain.on` 是"发完不管"；`invoke` + `handle` 是"要等返回值"。

**本项目**：全部用单向（`preload.js` 的 6 个动作都是 `send`；主进程用 `webContents.send` 反向推）。

**为什么**：桌宠的交互没有"需要等结果"的场景——拖拽、穿透、退出都是发出去就结束。状态推送是主进程主动广播，也不需要请求-响应。

**坑**：`invoke` 用多了会把主进程变成"服务接口"，通道数量和复杂度都涨。能用单向就别用双向。

### C2. 通道设计原则：动词开头、一个通道一件事

**一句话**：通道名应该是 `drag:start`、`mouse:ignore` 这种具体动作，而不是 `doSomething` 万能通道。

**本项目**：`preload.js:9-12`，加上 `state` 和 `gaze` 两个推送通道。

**为什么**：每个通道就是一个攻击面。通道越少、语义越窄，被滥用的可能性越小。

**坑**：最差的设计是一个 `ipcRenderer.send('cmd', {type, payload})` 通用通道——等于在进程边界上开了个 shell。

### C3. webContents.send 与 isDestroyed

**一句话**：主进程往窗口推消息前，必须判断窗口还活着。

**本项目**：`main.js:83-85` `if (win && !win.isDestroyed()) win.webContents.send(...)`。

**为什么**：窗口关闭是异步的，定时器可能比窗口活得久，直接 send 会抛 "Object has been destroyed"。

**坑**：所有用到 `win` 的定时器回调都要做这个判断。本项目在拖拽轮询、gaze 定时器、广播函数里都做了一遍。

---

## D. Node 原生 HTTP 服务

### D1. http.createServer 与路由

**一句话**：`http.createServer((req, res) => {...})`，在回调里手写 `req.method` + `url.pathname` 的分支就是路由。

**本项目**：`server.js:76-130`，四个分支：`GET /health`、`GET /state`、`POST /state`、兜底 404。

**为什么**：只要三个接口，引 Express 是杀鸡用牛刀，还多一层依赖和攻击面。

**坑**：手写路由要注意 `new URL(req.url, "http://127.0.0.1")` 解析——`req.url` 是相对路径，直接 `startsWith` 拼接容易被 `//`、`..` 之类绕过。

### D2. listen(0)：让系统分配随机端口

**一句话**：端口传 `0`，操作系统分配一个空闲端口，再用 `server.address().port` 读出来。

**本项目**：`server.js:132-137`。

**为什么**：固定端口会冲突，也会成为被探测的目标。随机端口天然少一个攻击面。

**坑**：随机端口意味着**外部必须有个发现机制**——这就是端口文件存在的理由。

### D3. 流式请求体与大小上限

**一句话**：`req` 是流，数据分块到达，用 `req.on('data')` 累加，`req.on('end')` 后才是完整 body。

**本项目**：`server.js:25-49`，累加时判断 `size > 256KB` 就 `reject` 并 `req.destroy()`。

**为什么**：不限长的 body 是经典 DoS——攻击者发一个 10GB 请求就能把内存吃光。**必须在收的过程中就掐断，不能收完再检查。**

**坑**：`req.destroy()` 之后不能再 `res.end()`，连接已经断了。本项目在 reject 前就 destroy，让上层 catch 处理。

### D4. 127.0.0.1 与 0.0.0.0 的区别

**一句话**：`127.0.0.1` 只接受本机回环连接；`0.0.0.0` 监听所有网卡，局域网可访问。

**本项目**：`server.js:132` `server.listen(0, "127.0.0.1")`。

**为什么**：桌宠只需要给本机的 hook 用，绑 `0.0.0.0` 等于把接口暴露给整个局域网（以及公共 WiFi 下的所有人）。

**坑**：很多人本地开发图省事写 `0.0.0.0`，上了公共网络就是漏洞。这条几乎每本安全指南都在喊，但仍然有人犯。

---

## E. 本地服务的安全四道锁

这部分是本项目最值得学的地方：`server.js:81-103` 的四道检查，按顺序 executed。**它们挡的是三种完全不同的攻击者。**

### E1. Host 头校验 —— 挡 DNS rebinding

**一句话**：检查 `req.headers.host` 必须等于 `127.0.0.1:<本进程端口>`。

**攻击场景**：攻击者控制一个域名，让它的 DNS 先解析到自己的服务器（通过浏览器同源检查），然后 TTL 归零改成解析到 `127.0.0.1`。浏览器认为这是同源，请求就打到你的本地服务了。此时 `Host` 头是**攻击者的域名**，不是 `127.0.0.1`。

**本项目**：`server.js:81-83`，不匹配直接 403。

**坑**：只校验 `Host` 含 "127.0.0.1" 不够，必须**连端口一起比对**——否则别的本地服务也可能被混淆。

### E2. Origin 头校验 —— 挡普通网页

**一句话**：`Origin` 存在且不是 `"null"` 就拒绝。

**为什么**：普通网页发起的跨源请求会带 `Origin: https://evil.com`。而 `file://` 页面和沙箱 iframe 的 `Origin` 是字符串 `"null"`，这种情况放行、由 token 兜底。

**本项目**：`server.js:87-90`。

**坑**：**不要只看 Origin 就以为安全**。攻击者能用 `text/plain` 发"不需要预检"的简单请求，浏览器拦的是**响应**，不是**请求**——副作用已经发生了。这就是第四道锁存在的原因。

### E3. Token 鉴权 —— 挡同机进程

**一句话**：启动时 `crypto.randomBytes(32).toString('hex')` 生成 token，写进端点文件，每个请求必须带 `x-clawd-token`。

**本项目**：`main.js:93` 生成；`server.js:93-95` 校验；`port-file.js:44` 写入文件（权限 0600）。

**为什么**：Host 和 Origin 都挡不住"同一台机器上的另一个恶意程序"——它可以直接读文件、直接发请求，Origin 头随便造。token 是唯一能区分"友军"和"同机攻击者"的东西，因为**它只存在于那个权限 0600 的文件里**。

**坑**：token 必须每次启动重新生成。写死或持久化，泄露一次就永久失效。

### E4. timingSafeEqual —— 防时序攻击

**一句话**：比较字符串时用 `crypto.timingSafeEqual`，不用 `===`。

**本项目**：`server.js:61-65`。

**为什么**：`===` 在发现第一个不同字符时就返回，比较耗时和数据匹配程度成正比。攻击者可以通过统计响应时间，逐字符猜出 token。

**坑**：`timingSafeEqual` 要求两个 Buffer **长度相同**，否则直接抛错。所以本项目先比长度再比内容。长度比较泄露的信息可以忽略（token 长度是固定的）。

### E5. Content-Type 校验 —— 挡 CORS 简单请求

**一句话**：POST 必须 `Content-Type: application/json`，否则 415。

**本项目**：`server.js:98-103`。

**为什么**：这是最容易被忽略的一条。`text/plain`、`application/x-www-form-urlencoded`、`multipart/form-data` 属于 **CORS 简单请求**，浏览器**不发送预检**，请求会真的到达服务端。如果服务端不检查 Content-Type 就解析，攻击者不需要预检就能打进来。

**坑**：只靠 CORS 头保护本地服务是错的——CORS 保护的是"读取响应"，不保护"产生副作用"。

### E6. CORS 预检 / Preflight 到底在防什么

**一句话**：非简单请求会先发 `OPTIONS` 问服务器"我能发吗"，服务器同意了才发真实请求。

**为什么重要**：理解这一点才能理解 E5。简单请求（GET/HEAD/POST + 三种 Content-Type + 无自定义头）**跳过预检直接发**。所以：
- 加了自定义头（如 `x-clawd-token`）→ 变成非简单请求 → 触发预检 → 攻击者的网页拿不到服务器同意 → 被挡
- 这解释了为什么 token 放 header 比放 body 更安全——**它顺手把请求从"简单"变成了"需要预检"**

**坑**：这是很多人不知道的免费收获：自定义头本身就是一道防护。

### E7. 文件权限 0o600

**一句话**：`fs.writeFileSync(file, data, { mode: 0o600 })` 让文件只有属主可读写。

**本项目**：`port-file.js:40-48`，还额外 `chmodSync` 一次兜底。

**为什么**：端点文件里有 token，等同凭证。同机其他用户的进程不能读到它。

**坑**：**Windows 上 mode 参数基本无效**，没有 POSIX 权限位。本项目注释里如实写了这点（"靠 ACL 继承"），没有假装跨平台一致。

### E8. CSP（内容安全策略）

**一句话**：一段 HTTP 头或 meta 标签，规定页面能加载什么、能执行什么。

**本项目**：`index.html:7-10`：
```text
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; object-src 'none'; base-uri 'none';
form-action 'none'; connect-src 'none'
```

**为什么**：`default-src 'none'` 是白名单思路的极致——**默认全禁，再逐项开口**。这样即使有脚本注入，它也加载不了外部资源、发不出网络请求。

**坑**：内联 `<style>` 需要 `'unsafe-inline'`，这是一处妥协。想彻底关掉，就把 CSS 挪进独立文件。`connect-src 'none'` 意味着页面自己发不了 fetch——本项目也不需要，状态全靠 IPC 推。

### E9. XSS 与 DOM XSS

**一句话**：把不可信字符串当 HTML 塞进 DOM，浏览器会执行里面的脚本。

**本项目**：`renderer.js:57-61` 用 `DOMParser` 解析 SVG，再走白名单清洗（`renderer.js:27-55`）。

**为什么**：现在 `markup` 来自本地常量，零风险。但 S7 主题系统会让这里接受**第三方文件**——那时 `<script>`、`onload=`、`href="javascript:"` 全是现成的入口。

**坑**：`DOMParser` 解析 `image/svg+xml` 时**不会执行脚本**（这是关键，比 `innerHTML` 安全），但解析出来的节点一旦 `importNode` 进文档，属性里的 `javascript:` 仍可能在交互时触发。所以"解析安全"≠"节点安全"，必须继续做属性白名单。

### E10. 白名单清洗的三个要点

**一句话**：只允许列举的标签和属性，其余一律删。

**本项目**：`renderer.js:27-55`，`ALLOWED_TAGS` 只有 20 个图形标签；属性层面拦三类：`on*` 事件、非 `#` 开头的 `href`、含 `javascript:` 的值。

**为什么**：**黑名单永远漏**（今天是 `onload`，明天是 `onbegin`），白名单天然收敛。

**坑**：本项目还处理了一个细节——`url(#id)` 是本地渐变引用要放行，但 `url(http://...)` 会发外部请求必须拦。用正则 `url\s*\(\s*['"]?(?!\s*#)` 做到了。这类"同一个属性内还要区分内容"的地方最容易被漏。

---

## F. 状态机与调度

### F1. 有限状态机 FSM

**一句话**：把系统行为约束成有限个状态 + 明确的转移规则，而不是一堆 if-else。

**本项目**：`state.js`，7 个状态（`idle/sleeping/thinking/working/error/attention/notification`）。

**为什么**：桌宠的显示必须"任何时候都有且只有一个状态"。用 if-else 判断"现在该显示什么"，条件会指数膨胀；用状态机，只维护一张转移表。

**坑**：状态机最容易漏的是"进入某个状态后怎么出来"。本项目用 `ONESHOT` 定时回落解决了这个问题（F4）。

### F2. 事件映射表

**一句话**：一张 `事件名 → 状态名` 的常量表，把"翻译"和"决策"分开。

**本项目**：`state.js:34-45` `EVENT_STATE`。

**为什么**：加一个新 agent 类型时，只改这张表，不动逻辑。这是本项目宣称"30+ agent 适配器是纯体力活"的底气。

**坑**：`SessionEnd: null` 是特例（要删会话而不是设状态），所以 `apply()` 里在查表**之前**就单独处理了它。表驱动不是"所有情况都能塞进表"，特例要显式处理。

### F3. 优先级仲裁

**一句话**：多个会话同时有状态时，按优先级选一个显示。

**本项目**：`state.js:15-23` `PRIORITY`，`state.js:121-127` `dominant()`。

**为什么**：用户同时开 5 个会话，桌宠只有一个。规则只有一条——"数字大的赢"——但足以定义整个产品的性格（`error: 8` 永远压过 `working: 3`）。

**坑**：仲裁函数是 O(n) 遍历，会话多了会有性能问题。本项目加了 `MAX_SESSIONS=100` 上限（`state.js:53`），先把 n 锁死。

### F4. oneshot 状态与自动回落

**一句话**：某些状态"播一次就该结束"，不能赖在屏幕上。

**本项目**：`state.js:27-31` `ONESHOT = { error: 2600, notification: 3200, attention: 2400 }`（毫秒）；`state.js:172-176` 超时后回 `idle`。

**为什么**：没有这个机制，用户去泡杯咖啡回来，桌宠还在对着他"红叹号"。

**坑**：oneshot 的判定用的是 `stateSince`（进入该状态的时间），不是 `lastAt`（最后一次事件时间）。搞混会导致状态永远不结束。

### F5. 心跳 tick：把时间驱动的变化收敛到一个函数

**一句话**：所有"随时间发生的变化"（oneshot 超时、闲置发呆、睡着）都在同一个 `tick()` 里算，而不是散在多个 `setTimeout` 里。

**本项目**：`state.js:164-197`，每 250ms 跑一次。

**为什么**：多个定时器意味着多个竞态、多处清理、多种 bug。一个心跳函数好调试一百倍——这也是 README 里"一个心跳函数比十个定时器好懂"的意思。

**坑**：250ms 意味着状态变化最多有 250ms 延迟。对桌宠够用；对需要精确计时的场景不行。

### F6. 惰性求值：只在变化时才 emit

**一句话**：`if (visual !== lastVisual) { lastVisual = visual; emit(); }`。

**本项目**：`state.js:193-196`。

**为什么**：心跳每秒跑 4 次，但状态可能几分钟才变一次。每次都广播会白白消耗 IPC 和渲染性能。

**坑**：这个优化有个前提——`emit` 只在"视觉状态"变化时触发。如果将来要推送更细的信息（比如会话列表变化但视觉没变），这个判断就不够了，得另加条件。

### F7. timer.unref()

**一句话**：让定时器不阻止 Node 进程退出。

**本项目**：`state.js:199-200`。

**为什么**：`setInterval` 默认会让事件循环保持活跃，进程退不掉。`unref()` 之后，如果没别的事可做，进程可以正常结束。

**坑**：这不是"取消定时器"。真正清理还是要 `clearInterval`（`dispose()` 做的就是这个）。

---

## G. 渲染层：SVG、动画与性能

### G1. SVG 作为桌宠的载体

**一句话**：用 SVG 画角色，好处是纯矢量、任意缩放不糊、结构可编程。

**本项目**：`visuals.js`，用字符串模板生成 SVG，每个状态一组帧。

**为什么**：桌宠要跟随 DPI 缩放、要单独控制瞳孔位移——位图做不到"只动眼球"这种粒度的操作。

**坑**：SVG 字符串里写 `class="pupils"`，渲染层靠 `querySelector("svg.on .pupils")` 找到它做 `transform`。**命名约定就是 API**，改名就断。

### G2. 双图层交叉淡入

**一句话**：准备两个 `.layer` 容器，新状态先在**隐藏的那层**画好，再交换 `opacity`。

**本项目**：`renderer.js:77-105`，CSS 在 `index.html:40-50`（`transition: opacity 160ms`）。

**为什么**：单图层换图会有一帧"旧的没了、新的还没画"——闪白。双图层先画后切，切换瞬间两层都有内容，视觉上是平滑过渡。

**坑**：切换后旧图层的内容要延迟清理（`renderer.js:99-101`，220ms 后 `replaceChildren()`），提前清会看到淡出过程中内容消失。

### G3. 帧动画：setInterval 按 fps 切 class

**一句话**：同一状态的多个 SVG 帧都塞进图层，只有带 `.on` 的那个显示。

**本项目**：`renderer.js:107-121`，间隔 `1000 / fps`。

**为什么**：**只切 class，不重建 DOM**。如果每秒重建 8 次 SVG 节点，浏览器要重解析 8 次，CPU 直接起飞。

**坑**：单帧状态要提前返回，不启动定时器（`renderer.js:112`）——桌宠大部分时间在 `idle`，省这点电很实在。

### G4. requestAnimationFrame 与线性插值

**一句话**：用 `requestAnimationFrame` 驱动逐帧计算，每次把当前值往目标值靠 25%。

**本项目**：`renderer.js:146-158`，`gazeCurrent.x + dx * 0.25`。

**为什么**：直接跳到目标位置会"咔"一下，像机器人。按比例逼近（lerp）在视觉上是缓动，像活物。

**坑**：`requestAnimationFrame` 必须先判空再启动（`if (!gazeRaf)`），否则每来一个目标就多一条动画链，越跑越快。收敛到阈值内要主动停下（`Math.abs(dx) < 0.01`），否则永远在跑。

### G5. 归一化坐标

**一句话**：把"屏幕绝对坐标"换算成"相对于宠物中心的 -1 到 1 的值"。

**本项目**：`main.js:138-139`，除以 260 再 clamp 到 [-1, 1]。

**为什么**：渲染层不需要知道屏幕多大、窗口在哪，只关心"往哪个方向看、看多少"。这样窗口移动、多显示器切换都不用改渲染逻辑。

**坑**：归一化发生在主进程（因为有全局坐标），渲染层只消费。这个边界一旦破掉（比如渲染层自己算），多屏就会出错。

### G6. 节流：变化太小就不发

**一句话**：`if (Math.abs(nx - lastGaze.x) < 0.02 && ...) return;`

**本项目**：`main.js:141`。

**为什么**：光标每 100ms 采一次，但人眼移动时大部分帧的变化量小于 2%——发过去渲染层也看不出来，白耗 IPC。

**坑**：阈值太大（比如 0.1）会导致小幅度移动完全没反应，眼睛看着"卡住"。0.02 是视觉可接受和经验成本的折中。

### G7. replaceChildren 与 DOM 复用

**一句话**：`replaceChildren(...nodes)` 一次性换掉全部子节点，比先 `innerHTML = ''` 再逐个 append 快。

**本项目**：`renderer.js:88,100`。

**为什么**：它是原子操作，只触发一次重排。

**坑**：本项目采用的是"换状态才重建，切帧不重建"的混合策略——全量复用太复杂，全量重建太慢，中间这个粒度最划算。

---

## H. 工程化与工具链

### H1. CommonJS 模块

**一句话**：`require()` 引入，`module.exports` 导出。Electron 主进程和 preload 都用这套。

**本项目**：所有 `src/*.js` 都是 CommonJS（`"use strict"` + `module.exports`）；渲染层不用模块，直接 `<script>` 顺序加载。

**为什么**：Electron 主进程默认就是 CJS 环境，不用配打包。渲染层只有两个文件，`<script>` 顺序加载最简单。

**坑**：`index.html` 里 `visuals.js` 必须在 `renderer.js` **之前**加载，因为后者依赖 `window.VISUAL_STATES`。顺序就是依赖关系，写反了会 `undefined`。

### H2. semver 与 ^ 的陷阱

**一句话**：`"electron": "^41.10.4"` 允许装 41.x 的任何更高版本。

**本项目**：`package.json` 写成 `^41.10.4`，实际装了 `41.10.7`。

**为什么这是坑**：`npm install` 每次可能装到不同版本，安全公告的修复版本是 `>=42.11.3`，`^41.x` 永远够不着。应该锁死具体版本（如 `"45.0.0"`），升级是显式动作。

**坑**：`package-lock.json` 存在时能保证一致性，但别人执行 `npm update` 或删了 lock 就漂了。

### H3. npm audit

**一句话**：对照漏洞库检查依赖树，输出 critical/high/moderate/low 统计和修复版本。

**本项目**：实测 `electron@41.10.7` → 1 个 high（8 条公告），修复需 `45.0.0`。

**坑**：`npm audit` 有漏洞时**退出码非 0**。用脚本调用时，异常处理里必须读 `e.stdout`，否则会以为"没输出=没漏洞"——本项目写体检脚本时就踩了这个。

### H4. ELECTRON_RUN_AS_NODE

**一句话**：一个环境变量，设置后 Electron 会退化成纯 Node 进程运行，`require('electron')` 返回路径字符串而不是 API。

**本项目**：README 记录的坑；表现是 `TypeError: Cannot read properties of undefined (reading 'whenReady')`。

**为什么**：某些 IDE、CI 或别的工具会设这个变量。排查用 `env | grep ELECTRON`，绕过用 `env -u ELECTRON_RUN_AS_NODE npm start`。

**坑**：这个错误信息完全不提环境变量，看起来像代码 bug，实际是环境问题。

### H5. userData 目录

**一句话**：每个应用的私有数据目录，`app.getPath('userData')` 拿到。

**本项目**：`port-file.js:24-34` **手动**实现了同样的路径规则（`%APPDATA%\clawd-starter` / `~/Library/Application Support` / `~/.config`）。

**为什么不用 Electron API**：`fake-feed.js` 是纯 Node 进程，拿不到 Electron API。两边必须用同一套规则算出同一个路径，注释里写得很清楚。

**坑**：手写路径规则要覆盖三个平台。漏掉 `XDG_CONFIG_HOME` 或 `APPDATA` 为空的情况，两边就对不上了。

### H6. 单实例锁

**一句话**：`app.requestSingleInstanceLock()` 返回 false 说明已有实例在跑，直接退出。

**本项目**：`main.js:25-28`。

**为什么**：两个实例会抢同一个端点文件，后启动的覆盖前面的，hook 就发到错误的进程去了。

**坑**：`app.quit()` 之后还要 `return`，否则代码继续往下跑，窗口还是会创建。

### H7. 环境变量与凭证管理

**一句话**：token 这类凭证不进代码、不进 git，运行时生成或从环境读。

**本项目**：token 每次启动 `crypto.randomBytes(32)` 随机生成，只写进权限 0600 的端点文件。`.gitignore` 忽略了 `.clawd-port` 和 `.last-check.json`。

**为什么**：硬编码的密钥一旦提交，历史里永远删不干净。

**坑**：`.gitignore` 只能防"未来的提交"，已经提交过的还得用 `git filter-repo` 清理。

---

## 速查卡

盖住右列，看左列能不能想起来。

| 名词 | 一句话答案 |
|---|---|
| 三进程 | 主进程（有权限） / 渲染进程（浏览器） / preload（唯一桥梁） |
| contextIsolation | preload 与页面上下文隔离，页面改不到桥的对象 |
| nodeIntegration | 渲染层能否直接 require，必须 false |
| sandbox | 系统级限制渲染进程，显式写 true 不依赖默认值 |
| 透明三件套 | transparent + backgroundColor '#00000000' + hasShadow false |
| setIgnoreMouseEvents | 鼠标穿透；forward 只转发 mousemove 不接收点击 |
| screen-saver 层级 | Windows 上盖住全屏应用的置顶层级 |
| 为什么要轮询光标 | 窗口跟手移动后，渲染层收不到 mousemove |
| listen(0) | 系统分配随机端口，读 server.address().port |
| 四道锁 | Host / Origin / Token / Content-Type |
| Host 校验防什么 | DNS rebinding |
| Origin 校验防什么 | 普通网页跨源请求，"null" 放行由 token 兜底 |
| Token 防什么 | 同机的恶意进程 |
| timingSafeEqual | 定长比较，防时序侧信道猜 token |
| Content-Type 校验防什么 | CORS 简单请求（text/plain 不触发预检） |
| 自定义头的好处 | 把请求从"简单"变成"需要预检"，顺手多一道防护 |
| 0o600 | 文件仅属主可读写；Windows 上基本无效 |
| CSP default-src 'none' | 默认全禁再逐项开口 |
| oneshot | 播一次就结束的状态，超时自动回 idle |
| 心跳 tick | 所有时间驱动的变化收敛到一个函数 |
| timer.unref() | 定时器不阻止进程退出 |
| 双图层 | 新状态先画在隐藏层，再换 opacity，不闪白 |
| 不重建 DOM 的原因 | 每秒重建 8 次 SVG = 每秒重解析 8 次 |
| lerp 0.25 | 每次向目标靠 25%，视觉上是缓动 |
| 归一化 gaze | 换算成 [-1,1]，渲染层不关心屏幕尺寸 |
| 白名单清洗 | 黑名单永远漏，白名单天然收敛 |
| DOMParser vs innerHTML | 前者解析 SVG 不执行脚本，后者会 |
| ^ semver 的坑 | 永远够不到更高 major 的修复版本 |
| npm audit 退出码 | 有漏洞时非 0，脚本里要读 e.stdout |
| ELECTRON_RUN_AS_NODE | 让 Electron 退化成纯 Node，报错像是代码 bug |

---

## 自测 20 题

先自己答，再看文末答案。答不出的回对应编号精读。

1. 渲染进程里为什么不能直接 `require('fs')`？想在页面上读一个文件该怎么走？
2. `contextIsolation: true` 具体防住了什么攻击？
3. 透明窗口出现灰色方块，是哪个参数没配？
4. `setIgnoreMouseEvents(true, { forward: true })` 之后，为什么窗口"能接收移动但收不到点击"？
5. 为什么拖拽必须用主进程轮询光标，不能用 `-webkit-app-region: drag`？
6. `listen(0)` 之后，外部怎么知道端口是多少？
7. Host 头校验具体防的是哪种攻击，攻击过程是怎样的？
8. 为什么只有 Host 和 Origin 校验还不够，必须加 token？
9. `text/plain` 的 POST 为什么能绕过 CORS 预检？服务端该怎么挡？
10. 为什么把 token 放 HTTP 头比放 body 更安全？（提示：简单请求）
11. `timingSafeEqual` 相比 `===` 解决了什么问题？它为什么要求长度相同？
12. `fs.writeFileSync` 传 `mode: 0o600` 在 Windows 上有效吗？
13. `default-src 'none'` 之后，页面还能做什么、不能做什么？
14. 用 `DOMParser` 解析 SVG 就安全了吗？为什么还要属性白名单？
15. `url(#grad)` 和 `url(http://...)` 在清洗时为什么要区别对待？
16. 为什么 `ONESHOT` 判定要用 `stateSince` 而不是 `lastAt`？
17. 单一心跳 tick 相比多个 setTimeout，具体好在哪？
18. 双图层交叉淡入中，为什么旧图层内容要延迟 220ms 才清空？
19. `requestAnimationFrame` 那条动画链，如果不判空会怎样？
20. `npm audit` 发现漏洞时，为什么脚本里必须读 `e.stdout` 才能拿到结果？

---

## 答案

1. `nodeIntegration: false`。正确走法：主进程读文件 → 通过 `webContents.send` 推给 preload → preload 的 `contextBridge` 动作传进页面。
2. 防页面脚本改写 preload 挂到 window 上的对象（比如把 `quit` 换成别的），即桥被篡改。
3. `hasShadow: false` 没配（三个参数必须同时配，任何一个漏了都会露底色）。
4. `ignore` 只关掉"接收鼠标事件"，`forward: true` 仍把 `mousemove` 转发进来，所以能移动但点不到。
5. 因为窗口跟着光标移动后，光标在窗口内的相对位置不变，渲染层再也收不到 `mousemove`；只有 `screen.getCursorScreenPoint()` 能拿到与窗口无关的绝对坐标。
6. 通过端点文件（本项目写 userData 下的 `clawd-starter.port`，内容是 `{port, token}`）。
7. DNS rebinding：先让域名解析到攻击者服务器通过同源检查，再把 TTL 归零改成 127.0.0.1，浏览器仍认为同源。此时 `Host` 是攻击者域名。
8. 因为同机的恶意进程可以随便伪造 Origin，只有存在于权限 0600 文件里的 token 它拿不到。
9. `text/plain` 属于 CORS 简单请求，浏览器不做预检直接发；浏览器只拦响应，不拦请求的副作用。服务端应校验 `Content-Type` 必须是 `application/json`。
10. 带自定义头会让请求变成"非简单请求"，强制触发预检；而攻击者的网页拿不到预检通过，就被挡在门外。
11. `===` 在首个不同字符处提前返回，耗时与匹配长度相关，可通过响应时间逐字符猜。要求长度相同是因为它逐字节比较，长度不等无法安全比较。
12. 基本无效。Windows 没有 POSIX 权限位，只能靠 ACL 继承。
13. 能：加载同源脚本、内联样式（因为有 `'unsafe-inline'`）。不能：加载任何外部资源、执行内联脚本、发网络请求（`connect-src 'none'`）。
14. 不安全。`DOMParser` 保证解析时不执行脚本，但节点导入文档后，属性里的 `javascript:` 仍可能被交互触发，所以必须继续做标签和属性白名单。
15. `url(#grad)` 是文档内引用，安全；`url(http://...)` 会向外部发请求，属于数据外泄/远程加载，必须拦。
16. `stateSince` 是进入当前状态的时间，`lastAt` 是最后一次收到事件的时间。oneshot 要算"这个状态播了多久"，只能用前者。
17. 只有一个竞态源、一处清理、一处调试入口；不用维护多个定时器的启停顺序。
18. 淡出过渡是 160ms，220ms 后才清可以保证淡出过程内容仍在，不会"淡出一半内容没了"。
19. 每来一个 gaze 目标就多启动一条动画链，多条链叠加导致速度失控（越跑越快）。
20. 因为有漏洞时 npm 退出码非 0，`execFileSync` 会抛异常，JSON 在 `e.stdout` 里。

---

## 按阶段的复习路径

不想一次读完的话，按你接下来要做的阶段挑着读：

| 你正在做 | 优先读 | 目标 |
|---|---|---|
| 回顾 S1 窗口 | A1-A3、B1-B7 | 能解释每个窗口参数为什么必须这么写 |
| 回顾 S2 服务与状态机 | D1-D4、E1-E8、F1-F7 | 能画出四道锁的顺序和状态转移图 |
| 回顾 S3 渲染 | G1-G7、C1-C3 | 能说清为什么切帧不重建 DOM |
| 准备 S4 接 hook | C1-C3、D2-D4、E1-E5、H5-H7 | 理解短命进程如何安全地找到端点 |
| 准备 S5 权限气泡 | E1-E10、A4-A7 | **重点**：权限决策必须默认拒绝 + 一次性 nonce |
| 准备 S7 主题系统 | E9-E10、G1-G2、H1 | 重点：第三方 SVG 的清洗链路 |

---

## 还没覆盖到的（留给后续阶段）

这些词在 S4 之后才会真正出现，等做到那一步再补进本手册：

- **nonce**（一次性随机数，S5 权限回包的核心）
- **原子写**（`write tmp` + `rename`，改 settings.json 时防写坏）
- **FSDP / 分布式**（不属于本项目，属于 vdn-minimax-h3 那边）
- **SSE**（服务器推送，本项目用 IPC 而非 SSE）
- **asar 打包与签名**（发布阶段才需要）
