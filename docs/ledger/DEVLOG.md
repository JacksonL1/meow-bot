# 开发心得

> 一条一个 `##` 小节，新的加在最上面。踩过的坑比写完的功能更值得记。

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
