# 安全问题清单

> 按阶段记录。每完成一个阶段，就对照「阶段检查项」过一遍，把新发现补进对应小节。
> 审计基准：`src/` 下 8 个文件全量通读 + `npm audit`，日期 2026-10-26。
> 严重度：**P0 阻断发布 / P1 上线前必修 / P2 应当修 / P3 记录在案**。
> **当前状态（2026-10-26 修复轮）**：SEC-01/02/03/04/06/09/10 已修复；SEC-05 已加固；SEC-07 部分修复；SEC-08 未修（需 major 升级，待决定）。逐条证据见下方「修复记录」。

---

## S1 + S2 + S3 现状（已实现代码的审计结果）

### SEC-01 本地 HTTP 服务不校验来源，任意网页都能驱动桌宠

- **严重度**：P2（S5 之后升级为 P0）
- **位置**：`src/server.js:60-86`
- **问题**：`POST /state` 只校验「是不是合法 JSON 对象」，不校验 `Host`、`Origin`、`Content-Type`。
- **攻击路径**：任意网页执行 `fetch('http://127.0.0.1:57541/state', { method:'POST', body:'{"event":"error"}', headers:{'content-type':'text/plain'} })`。因为 `text/plain` 属于 CORS 简单请求，**不触发预检**，响应被浏览器拦下也无所谓——副作用已经发生。
- **影响**：当前仅能篡改视觉状态（低影响）。但 S5 的 `/permission` 会复用同一个服务，届时等于任何网页都能替你「批准」工具调用。
- **修复**：
  1. 校验 `req.headers.host === 127.0.0.1:<实际端口>`，否则 403；
  2. 要求 `content-type` 必须以 `application/json` 开头，否则 415；
  3. 若 `origin` 存在且不是 `null`，一律拒绝。

### SEC-02 端口文件即凭证，本机任意进程可直接操控

- **严重度**：P2
- **位置**：`src/server.js:90-91`、`src/main.js:78-80`
- **问题**：`.clawd-port` 里只有端口号，没有密钥。任何本机进程读到这个文件就能调用全部接口。
- **影响**：同机恶意软件（或另一个用户会话下的进程）可任意驱动桌宠；S5 之后可伪造权限回包。
- **修复**：启动时 `crypto.randomBytes(32).toString('hex')` 生成 token，与端口一起写入端口文件（JSON 格式），文件权限设为 `0o600`；所有 POST 必须带 `x-clawd-token` 头，服务端用 `crypto.timingSafeEqual` 比对。

### SEC-03 缺少 Content-Security-Policy

- **严重度**：P2
- **位置**：`src/index.html:3-5`
- **问题**：没有 CSP meta，渲染层等于「任何能注入的脚本都能执行」。
- **影响**：当前只加载本地两个脚本，风险有限；但 S7 主题系统一旦引入外部 SVG/HTML，缺 CSP 会让注入直接变成任意代码执行。
- **修复**：在 `<head>` 里加
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;`
  注意内联 `<style>` 需要 `'unsafe-inline'`，若不想开就把样式挪进独立 css 文件。

### SEC-04 会话 Map 无上限，可被撑爆内存

- **严重度**：P2
- **位置**：`src/state.js:93-97`
- **问题**：`sessions.set(id, s)` 对 `session_id` 没有任何数量与长度限制。
- **攻击路径**：本机进程循环 POST 递增的 `session_id`，每次新增一条会话对象且永不过期（`SessionEnd` 才删）。
- **影响**：内存持续增长，长时间运行后可拖垮进程。
- **修复**：`session_id` 限制 64 字符；Map 上限 100 条，超出按 `lastAt` 最旧淘汰。

### SEC-05 `innerHTML` 解析 SVG，S7 后会变成 XSS 入口

- **严重度**：P3（S7 之后升为 P1）
- **位置**：`src/renderer.js:24-28`
- **问题**：`tpl.innerHTML = markup`，当前 `markup` 来自本地常量 `visuals.js`，安全。
- **风险点**：S7 主题系统会从 `themes/<name>/theme.json` 加载第三方 SVG 字符串。届时这是标准的 DOM XSS：`<svg><script>` 或 `<image href="javascript:...">` 都能执行。
- **修复（S7 前必须做）**：改用 `DOMParser.parseFromString(markup, 'image/svg+xml')`，并遍历节点做白名单：只允许 `svg/g/path/circle/ellipse/rect` 等图形标签，删除所有 `on*` 属性、`href`/`xlink:href` 中的 `javascript:`，移除 `foreignObject` 与 `script`。

### SEC-06 `sandbox` 未显式声明，安全基线靠默认值

- **严重度**：P3
- **位置**：`src/main.js:49-54`
- **现状**：`contextIsolation: true`、`nodeIntegration: false` 都是对的（这两项是本项目最该表扬的地方），`preload.js` 也只暴露了 6 个具体动作、没有泄漏 `ipcRenderer` 本体。
- **问题**：`sandbox` 未写，依赖 Electron 20+ 的默认值 `true`。将来改配置或降级 Electron 时会被无声削弱。
- **修复**：显式写 `sandbox: true`、`webSecurity: true`、`allowRunningInsecureContent: false`。

### SEC-07 窗口置顶层级可能盖住锁屏与全屏应用

- **严重度**：P3
- **位置**：`src/main.js:58`
- **问题**：`setAlwaysOnTop(true, 'screen-saver')` 是最高的常规层级，可能浮在全屏演示、锁屏界面之上。
- **影响**：当前窗口只有 240×240 且只显示宠物，问题不大。但 S5 气泡会显示「正在执行什么命令」——在共享屏幕、直播、录屏时可能把项目路径或命令内容暴露给旁人。
- **修复**：进入全屏/锁屏时降低层级或隐藏；S5 后的气泡内容做脱敏（只显示工具名，不显示完整命令与路径）。

### SEC-08 依赖 Electron 41.10.7，`npm audit` 报 8 个高危公告

- **严重度**：P1
- **实测**：`electron@41.10.7`，`npm audit` → `high`，受影响范围 `<=42.11.15`，共 8 条公告（含 HID/USB 权限归属错误、SameSite cookie 绕过、指针锁定权限归属错误等）。修复版本 `45.0.0`，属 major 升级。
- **说明**：这些公告多与「加载远程内容 + 权限请求」相关，本项目只加载本地文件，**实际可利用性低**。但作为 Electron 应用的卫生标准，应在 S4 之前升级。
- **修复**：`package.json` 中把 `"electron": "^41.10.4"` 改为固定版本（如 `"45.0.0"`），去掉 `^`，避免每次 `npm install` 漂移；升级后回归跑一遍 S1-S3 的可见行为。

### SEC-09 `cwd` 原样存储与推送，未脱敏

- **严重度**：P3
- **位置**：`src/state.js:95,99`、`state.js:67`
- **问题**：`payload.cwd` 不做长度/格式校验就进 snapshot，并随状态推送。
- **影响**：S6 多会话看板一定会显示 cwd，届时完整磁盘路径（含用户名、项目名）会出现在桌面上。
- **修复**：只保留 `path.basename(cwd)`，或做 `~/...` 缩写；长度限制 200。

### SEC-10 端口文件写在项目根目录

- **严重度**：P3
- **位置**：`src/main.js:78-80`
- **现状**：`.gitignore` 已忽略 `.clawd-port`，不会误提交。
- **风险**：若项目目录在 OneDrive/坚果云等同步盘（当前在 `E:\JacksonLee\project`，注意是否存在同步），端口号会随文件同步外泄；多实例并发时还会互相覆盖导致后启动者抢占。
- **修复**：开发期也统一写 `app.getPath('userData')`；或加单实例锁 `app.requestSingleInstanceLock()`。

---

## 2026-10-26 修复记录（S1–S3）

改了什么、怎么验的，全部实测。命令都在 `clawd-starter/` 下执行。

| 编号 | 状态 | 改动 | 验证结果 |
|---|---|---|---|
| SEC-01 | ✅ 已修 | `src/server.js` 四道锁依次执行：Host 必须 `127.0.0.1:<本进程端口>`；`Origin` 存在且非 `null` 一律 403；`x-clawd-token` 必须匹配；POST 的 `content-type` 必须 `application/json` | 无 token→401；伪造 Origin→403；伪造 Host→403；`text/plain`→415；正常请求→200 |
| SEC-02 | ✅ 已修 | 启动时 `crypto.randomBytes(32)` 生成 token；端点文件改为 `{port, token}` JSON（`mode 0600`，Windows 无等价语义）；全部接口校验 token，用 `timingSafeEqual`；`/health` 不再回 pid | 端点文件内容仅为 port+token；`/health` 无 token→401 |
| SEC-03 | ✅ 已修 | `src/index.html` 加 CSP：`default-src 'none'` + 逐项白名单（内联样式保留 `'unsafe-inline'`） | 页面与七个状态素材正常渲染，无 CSP 报错 |
| SEC-04 | ✅ 已修 | `src/state.js`：`session_id` 仅留可见 ASCII、限 64 字符；会话 Map 上限 100，超出按 `lastAt` 淘汰最旧 | 连发 150 个不同 `session_id` 后 `sessions` 长度停在 100；传 200 字符 id 只存 64 |
| SEC-05 | 🟡 已加固 | `src/renderer.js`：`innerHTML` 改为 `DOMParser` + 标签白名单（svg/g/path/rect/text…）+ 属性清洗（剥 `on*`、非 `#` 的 `href`、`javascript:`、`url(`）；解析失败返回 `null`，`setState` 直接跳过 | 恶意 SVG 的 `<script>`/`<foreignObject>`/`<image>`/`onclick`/`onload` 全部被剥；正常帧与 `.pupils` 不受影响；非法 XML 返回 null |
| SEC-06 | ✅ 已修 | `webPreferences` 显式写 `sandbox: true`、`webSecurity: true`、`allowRunningInsecureContent: false` | 启动、IPC、拖拽、穿透全部正常 |
| SEC-07 | 🟡 部分修 | `powerMonitor` 监听 `lock-screen`/`suspend` 隐藏窗口，`unlock-screen`/`resume` 恢复；气泡内容脱敏留到 S5 | 仅逻辑实现，未做真机锁屏/投屏回归 |
| SEC-08 | ❌ 未修 | 仍是 `electron@41.10.7`。`npm audit` 复核：`electron high, range <=42.11.15, fix 45.0.0 (major)` | **待决定**：属 major 升级，需单独一轮做回归，不在本次安全修复里夹带 |
| SEC-09 | ✅ 已修 | `src/state.js`：`cwd` 只保留最后一段目录名，限 200 字符 | 传 `C:\Users\Think\secret-folder\my-proj`，快照里只剩 `my-proj` |
| SEC-10 | ✅ 已修 | 端点文件统一写 `userData`（`src/port-file.js` 统一算路径，`fake-feed.js` 复用同一份逻辑）；`app.requestSingleInstanceLock()` 单实例锁 | 文件落在 `%APPDATA%\clawd-starter\clawd-starter.port`；第二个实例直接退出 |

**顺带产出**：新增 `src/port-file.js`（端点文件读写，唯一真相），`scripts/fake-feed.js` 改为读 JSON 端点并带 token。

**给 S5 的提醒**：SEC-01 的 token 只能证明「调用方拿到了端点文件」，**不能**证明「这一次权限请求是它发起的」。S5 的一次性 nonce 仍然必须做，token 不能替代 nonce。

---

## S4 接真 hook：预判与落地核对

实现前写下的预判，以及 2026-10-26 的落地核对结果。

| 风险 | 说明 | 要求 | 落地 |
|---|---|---|---|
| 改坏用户全局配置 | 往 `~/.claude/settings.json` 追加 hook，覆盖写会让 Claude Code 整个无法启动 | 写前备份；读-改-写用临时文件 + `rename` 原子替换；只追加带 marker 的条目，不碰他人配置 | ✅ 备份 `<file>.clawd-backup-<时间戳>`；`writeAtomic` 同目录 tmp + `rename`；`isOurs()` 只认命令含 `clawd-hook.js`，`stripOurs()` 摘空的组整组丢弃。JSON 解析失败直接抛错退出，绝不覆盖看不懂的文件 |
| 命令注入 | 若把 `tool_name`、`cwd` 拼进 shell 字符串再 `exec` | 一律用 `execFile`/`spawn` 传数组，永远不拼字符串 | ✅ 全程无 `exec`。hook 只 `fetch` 一个固定 URL，payload 走 JSON body；`cwd` 只进数据字段，从不进命令行 |
| 敏感数据落盘 | hook 的 stdin JSON 含用户 prompt、文件路径、工具参数 | 只取需要的 3 个字段即丢；不写日志文件；调试输出必须脱敏 | ✅ 只取 `session_id / hook_event_name / cwd / tool_name`，`prompt`、`tool_input`、`transcript_path` 直接丢弃；全路径无一处 `console.log`；异常也静默 |
| hook 阻塞用户操作 | hook 是同步阻塞的短命进程 | 2 秒硬超时，超时按空对象继续；任何异常 `process.exit(0)` 静默退出 | ✅ stdin 2s 硬超时 + 1MB 上限；POST 1.5s `AbortController`；`main().catch(()=>{}).finally(()=>process.exit(0))` 兜底。**并补上了预判里漏掉的一条，见 SEC-11** |
| 端口文件不存在时的行为 | 桌宠没开，hook 不应报错 | 不重试、不打印、直接退出，退码 0 | ✅ `readPortFile()` 抛错 → `catch { return }`。实测：端点文件不存在 → 0ms 内退 0；文件残留但进程已死 → `ECONNREFUSED` → `.catch(() => null)` → 241ms 退 0 |

### SEC-11 观察型 hook 未声明 `async`，每次工具调用白等 node 冷启动（已修）

- **级别**：P2（不是安全问题，是「安全修复顺手带出来的体验缺陷」，但它决定这个产品能不能日常开着）
- **现象**：`install.js` 初版只写了 `timeout: 5`，没写 `async`。Claude Code 默认等 hook 进程退出才继续，而 Windows 上 `node` 冷启动实测约 200ms。
- **实测拆解**：`node` 启动 ~200ms → 读端点文件 ≈0 → `fetch` POST ≈35ms → 完整 hook 236ms（带 payload ~280ms）。**hook 自己的代码只占 ~35ms，其余全是进程启动。**
- **为什么是漏项**：S4 预判把「阻塞」理解成「hook 内部要够快」（做了 2s/1.5s 超时），但真正的成本在**进程启动**，超时机制管不到它。
- **修法**：`ourGroup()` 写 `{ type: "command", command, async: true, timeout: 5 }`。
- **依据**：主仓库 `docs/project/agent-runtime-architecture.md:772` —— 「PermissionRequest 用 HTTP hook（阻塞式），其他事件用 command hook（非阻塞式）」。原项目 `hooks/install.js:1484` 同样是 `async: true` + `STATE_HOOK_TIMEOUT_SECONDS = 5`。
- **分界线（S5 必读）**：`async: true` 只适用于**不参与决策**的观察型 hook。S5 的 `PermissionRequest` 必须**阻塞**，因为要返回 `permissionDecision`；那条路径上不能抄这里的配置。
- **验证**：`--file` 合并后断言 8 个 entry 全部 `async: true` 且 `timeout: 5`，用户自有 hook 与顶层 `model` 原样保留，二次执行零变化。


---

## S5 预判：权限回包是整个项目最高危的一关

**P0 级设计风险。** S5 会让桌宠替用户回答 `PermissionRequest`。如果实现不当，等于给所有本机进程开了一个「绕过 Claude Code 权限确认」的后门。

必须同时满足以下五条，缺一不可：

1. **一次性 nonce**：每次权限请求生成随机 nonce，与 `session_id`、`tool_use_id` 绑定；回包必须携带，用后即焚。
2. **nonce 只走 stdin**：nonce 只通过 hook 进程的 stdin 传入，不落盘、不进端口文件、不写日志。这样其他进程即使能 POST 也伪造不了回包。
3. **默认拒绝**：超时、解析失败、nonce 不匹配、未知会话 —— 一律 `deny`。**绝不能「超时即允许」**。
4. **回包校验来源**：回包请求除 nonce 外，还要满足 SEC-01/SEC-02 的 Host 与 token 校验。
5. **UI 不盲批**：气泡必须显示足够判断的信息（工具名 + 目标路径 + 关键参数），且「允许」不能做成单键无脑确认；禁止提供「永久允许所有」而跳过二次确认。

---

## S6 / S7 预判

- **S6 多会话看板**：`cwd` 脱敏（见 SEC-09）；提供「演示模式」隐藏项目名，避免投屏/直播泄露。
- **S7 主题系统**：主题包是不可信输入。加载前做 SVG 白名单（见 SEC-05）、禁止主题携带 `<script>`/`<foreignObject>`/外链资源；主题目录建议校验来源（本地手工放置，不做自动下载）。

---

## 每个阶段的固定检查清单

做完任何一个阶段，逐条过：

- [ ] `npm audit` 是否新增 high/critical
- [ ] 新增的 IPC 通道是否都在 `preload.js` 里以「具体动作」暴露，没有泄漏 `ipcRenderer`
- [ ] 新增的网络/文件输入是否做了长度与类型校验
- [ ] 新增的渲染内容是否走了 `innerHTML` 或模板字符串拼接
- [ ] 是否有新的敏感信息（路径、命令、prompt）进入渲染层或日志
- [ ] 若涉及权限决策：是否默认拒绝、是否有一次性 nonce、是否防伪造
- [ ] 以上结论是否已回写到本文件的对应阶段小节

---

## 附：值得保留的好设计

审计不是只挑毛病，以下三点是这个骨架最容易在后续开发中被破坏、必须守住的东西：

1. **`preload.js` 只暴露动作，不暴露 `ipcRenderer`** —— 这是 Electron 安全的核心边界，S7 加主题功能时最容易被「顺手」开个大口子。
2. **服务端强制 256KB 请求体上限，且超限立即 `req.destroy()`** —— 很多本地服务忘掉这条。
3. **渲染层的状态白名单**：`setState` 里 `window.VISUAL_STATES[state]` 不存在就忽略，`svgNode` 之外没有任何地方拼接 HTML。这让「服务端收到的任意字符串」无法直接变成 DOM。
