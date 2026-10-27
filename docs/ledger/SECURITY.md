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

### SEC-08 依赖版本落后，`npm audit` 报 8 个高危公告（2026-10-27 已修）

- **严重度**：P1
- **实测（修复前）**：`electron@41.10.7`，`npm audit` → `high`，受影响范围 `<=42.11.15`，共 8 条公告。
- **说明**：这些公告多与「加载远程内容 + 权限请求」相关，本项目只加载本地文件，**实际可利用性低**。但作为 Electron 应用的卫生标准必须修。
- **关键纠正**：`npm audit fix --force` 建议 `45.0.0`，但那是 npm 的「跳到最新版」策略，**不是最小修复**。逐条读公告范围后发现最低修复版本是 `42.11.16`：

  | 级别 | 修复于 | 公告 |
  |---|---|---|
  | high | <42.11.16 | eMudhra 中间证书缓解 |
  | moderate | <42.11.9 | Pointer lock 权限归因到错误 frame |
  | moderate | <42.11.3 | HID/USB 权限归因、SameSite cookie、openExternal 归因 |
  | low | <42.11.6 | Frame subscription / 离屏渲染信任 GPU 提供的几何 |
  | low | <42.11.1 | Extension tabs.query 越权返回 URL 与标题 |

  41.x 没有 backport（41.10.7 是最后一版且仍受影响），所以必须跨 major。
- **决策**：`42.11.18` 与 `45.0.0` 都实测过，**同一套回归脚本都是 37/37**。最终选 `45.0.0`：
  1. `42` 已不在 Electron 的支持线内，将来新公告不会再 backport，等于把问题往后推；
  2. 既然升级成本已付（回归脚本可复用），没必要付第二次；
  3. `~45.0.0` 而非 `^45.0.0`：45.0.x 补丁自动进（安全修复），45.1+ 需要人工过一遍 + 跑回归。
- **代价**：`45.0.0` 是 major 的第一个版本，尚无补丁版。这份风险由回归脚本兜住——`npm run verify:electron` 就是升级闸门。
- **验证**：见下方「2026-10-27 修复记录（SEC-08）」。


### SEC-09 `cwd` 原样存储与推送，未脱敏

- **严重度**：P3
- **位置**：`src/state.js:95,99`、`state.js:67`
- **问题**：`payload.cwd` 不做长度/格式校验就进 snapshot，并随状态推送。
- **影响**：S6 多会话看板一定会显示 cwd，届时完整磁盘路径（含用户名、项目名）会出现在桌面上。
- **修复**：~~只保留 `path.basename(cwd)`~~ → **S6 时修正为分层**（见下方「S6 落地核对」）：存储层留完整路径，快照层只出 basename。原方案按字段一刀切，会把看板的「复制路径」功能一起砍掉——那不是修复，是砍功能。

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
| SEC-08 | ✅ 已修（10-27） | 升到 `electron@45.0.0`，`~` 版本范围。见下一节 | `npm audit` → 0 漏洞；回归 37/37 |
| SEC-09 | ✅ 已修（10-27 修正） | `src/state.js`：`cwd` 只保留最后一段目录名，限 200 字符。**S6 时修正为分层**：存储层留完整（限 1024），快照层只出 basename，完整路径只在显式点击时单条释放 | 传 `C:\Users\Think\secret-folder\my-proj`，快照里只剩 `my-proj`；看板 DOM 里查不到盘符 |
| SEC-10 | ✅ 已修 | 端点文件统一写 `userData`（`src/port-file.js` 统一算路径，`fake-feed.js` 复用同一份逻辑）；`app.requestSingleInstanceLock()` 单实例锁 | 文件落在 `%APPDATA%\clawd-starter\clawd-starter.port`；第二个实例直接退出 |

**顺带产出**：新增 `src/port-file.js`（端点文件读写，唯一真相），`scripts/fake-feed.js` 改为读 JSON 端点并带 token。

**给 S5 的提醒**：SEC-01 的 token 只能证明「调用方拿到了端点文件」，**不能**证明「这一次权限请求是它发起的」。S5 的一次性 nonce 仍然必须做，token 不能替代 nonce。

---

## 2026-10-27 修复记录（SEC-08 依赖升级）

**结论**：`electron 41.10.7 → 45.0.0`，`npm audit` 从 8 条公告降到 0。

**怎么验的**：为了不再靠肉眼判断「升级后还能不能用」，先写了回归脚本 `scripts/verify-electron.js`，
在**旧版本上先跑出 36/36 的基线**，再对每个候选版本跑同一套判据。脚本同时开两个调试端口：

- `--inspect=9229` 主进程（Node inspector）→ 读窗口属性、数 IPC 监听器、调 `desktopCapturer`
- `--remote-debugging-port=9222` 渲染进程（CDP）→ 读 DOM、切状态、推 gaze、量像素

| 版本 | Chrome | Node | 回归 | audit | 备注 |
|---|---|---|---|---|---|
| 41.10.7（升级前） | 146.0.7680.216 | 24.18.0 | 36/36 | 8 条，high | 基线，用来证明脚本本身是对的 |
| 42.11.18 | 148.0.7778.280 | 24.19.0 | 36/36 | 0 | 最小修复版本 |
| **45.0.0（采用）** | 156.0.8078.48 | 24.22.0 | 37/37 | 0 | 新增透明检查后 37 项 |

**37 项覆盖**：页面与容器、7 状态注册、contextIsolation / sandbox（渲染层拿不到 `require`/`process`/`ipcRenderer`，preload 只有 6 个具名动作）、
状态切换换层、旧层淡出后清空、帧轮播、gaze 收敛到 `translate(3.60 -2.60)` 与回中、命中判定（中心命中 / 左上角穿透）、
窗口存在/可见/置顶/240×240/不可缩放、四条 IPC 接线、**窗口真透明**、端点文件、`/health` 200 与无 token 401、
`POST /state` 端到端驱动渲染层、单实例锁、退出清理。

**透明检测怎么做的**（自动化里最容易被漏掉的一项）：从主进程 inspector 调 `desktopCapturer` 抓屏，
比较「窗口矩形内侧紧邻边界 10px」与「外侧紧邻边界 10px」的像素。窗口若真透明，两处看到的是同一层桌面，
差值应接近 0。用相邻对而不是窗口内外两大片区域，是为了抵消壁纸渐变与暗角。实测 45.0.0 上最大通道差 `0`。

**写脚本时踩到的两个坑**（都不是 Electron 的问题，但会让人误判成升级失败）：

1. **时序竞态**：`main.js` 在启动 300ms 后推一次初始状态 `idle`。如果测试在这之前调 `setState`，
   会被随后到达的 `idle` 覆盖，表现为「图层没换、帧不轮播」——看起来像升级把渲染搞坏了。
   同理，`POST /state` 的响应返回时主进程已经 `broadcast` 过了，此时再手动改状态等于覆盖它。
2. **测量假象**：用 `spawnSync` 连发测 hook 得 ~950ms，真实是 240-280ms（父进程阻塞造成的）。见 PROGRESS.md。

**遗留**：`45.0.0` 是 major 的首个版本，还没有补丁版。所以 `package.json` 用 `~45.0.0`，
45.0.x 补丁自动进、45.1+ 必须人工跑一次 `npm run verify:electron` 再升。

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

## S5 权限回包：预判（已被证伪的部分）与真实契约

**P0 级设计风险。** S5 会让桌宠替用户回答 `PermissionRequest`。实现不当等于给所有本机进程开一个「绕过 Claude Code 权限确认」的后门。

### 开工前先纠正：原五条预判里，1、2、3、4 全部基于错误的架构假设

写预判时假设 `PermissionRequest` 走 **command hook**（和 S4 一样有个短命进程读 stdin）。
实际不是——主仓库 `hooks/install.js:1223` 的 `HTTP_HOOKS`：

```json
{ "matcher": "", "hook": { "type": "http", "url": "http://127.0.0.1:23333/permission", "timeout": 600 } }
```

**Claude Code 直接 POST 我们的端点，HTTP 响应就是决定。没有中间进程，也没有 stdin。**
这推翻了四条预判：

| 原预判 | 为什么站不住 | 真相 |
|---|---|---|
| 1. 一次性 nonce，绑定 `session_id` + `tool_use_id` | HTTP hook 是**请求即响应、同一个 socket**，决定天然绑在请求上，没有独立的「回包」步骤可伪造 | 主仓库 `src/permission.js`、`server-route-permission.js` 里**根本没有 nonce**。nonce 只出现在 `telegram-native-runner.js`，用于远程审批——因为 Telegram 回调来自公网、可重放，才需要一次性凭据 |
| 2. nonce 只走 stdin | 没有 stdin 这个通道 | 同上 |
| 3. 默认 deny | deny 会让工具调用**失败** | 正确做法是返回 **204 不做决定**，让 Claude Code 回落到它自己的原生确认提示（用户照样会在终端被问到）。deny 只在用户明确点「拒绝」时用 |
| 4. 回包要过 Host + token | **`/permission` 不可能校验 token** —— 调用方是 Claude Code 本身，它不知道我们的 token | `/permission` 比 `/state` 更开放，这是 HTTP hook 架构的固有属性，只能靠 HTTP 边界收敛 |

**唯一站得住的是第 5 条**（UI 不盲批），而它恰恰是最重要的一条。

### 真实契约（读主仓库源码得到）

请求体：`{ tool_name, tool_input, session_id, permission_suggestions }`

响应三态：

| 情形 | 响应 | 含义 |
|---|---|---|
| 用户点 Allow | 200 `{hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:"allow"}}}` | 放行 |
| 用户点 Deny | 200 同上，`decision:{behavior:"deny",message:"…"}` | 拒绝并回话 |
| 超时 / 解析失败 / 气泡不可用 | **204 空响应** | 不做决定 → Claude Code 回落原生提示 |

（`server-route-permission.js:509` 构造 allow 体；`:497` 等处的 `send*PermissionNoDecision` 都是 204）

### 因此 S5 的要求改写为五条

1. **默认不做决定**：超时、解析失败、气泡不可用、未知请求 —— 一律 **204**，回落到 Claude Code 原生提示。**绝不能超时即允许，也不该超时即 deny**（deny 会让工具静默失败，用户以为被批准过）。
2. **deny 只在用户明确点击时产生**，且必须携带 `message` 回给 agent，让对方知道为什么。
3. **HTTP 边界照旧收紧**：`/permission` 不能要 token，但 Host / Origin / Content-Type 三道必须做——这挡的是**浏览器发起的跨源请求**，那才是真正可利用的路径。空 Origin、重复 Host 头、非 `application/json` 一律拒。
4. **请求与响应强绑定**：pending 请求用自增 `requestId` + 内存 Map，回写前校验该请求仍处于 pending；已结束的请求不得被二次响应。
5. **UI 不盲批**（原第 5 条，保留）：气泡必须显示工具名 + 完整命令/路径 + 会话 cwd；「允许」不能是无信息单键；**禁止「永久允许所有」**，也不做自动化放行规则。

### 威胁模型（写下来，免得以后自己吓自己）

能 POST 到 `127.0.0.1:<port>` 的本机进程可以伪造一张假气泡诱骗点击。但这个能力的前提是它已经能在用户机器上执行代码——
而它若真想绕过权限，直接改 `~/.claude/settings.json` 的 `permissions.allow` 更省事。所以这条路径的**增量风险有限**，
防护重心应放在「浏览器跨源」和「用户看得清」上，而不是强行给本机进程加一道它能绕过的锁。

**给未来的提醒**：一旦做远程审批（Telegram / 飞书 / 手机端），决定就来自公网通道，那时**必须**引入一次性 nonce
（参考 `telegram-native-runner.js` 的 `callback_data: clawd-test:<nonce>` 模式）。本地 HTTP hook 不需要。

### S5 落地核对（2026-10-27，实现完成，回归 55/55）

五条要求逐条对到代码与断言，不留"应该做了"这种模糊结论：

| # | 要求 | 落在哪 | 怎么证明 |
|---|---|---|---|
| 1 | 默认不做决定，一律 204 | `src/permission.js` 的 `settle()` else 分支。超时 / `dismiss()` / `dispose()` / 连接被对端掐断，四条路全汇到这一个出口 | 回归「没人点 → 204 不做决定」（实测等 6001ms）、「退出时挂起的第一条 → 204」、「退出时排队的那条 → 204」 |
| 2 | deny 只在明确点击时产生，且带 message | `permission.js` 中 `outcome === "deny"` 分支 | 回归「点拒绝 → 200 + behavior:deny」+「deny 带 message 回给 agent」+「响应带 hookEventName」 |
| 3 | HTTP 边界收紧，但 `/permission` 不校 token | `src/server.js`：`/permission` 过 Host / Origin / Content-Type 三道；token 只保护 `/state` 与 `/health` | 回归「带 Origin → 403 空响应」「text/plain → 415」「数组 body → 400」 |
| 4 | 请求与响应强绑定 | 自增 `requestId` + 内存 `Map`；`settle()` 先查条目存在、再查 `settled`，`pending.delete()` 之后才回写 | `settle()` 是唯一出口，重复调用直接 `return false`，天然防二次响应 |
| 5 | UI 不盲批 | `src/bubble.html`：**「允许」故意不用主色**，两个按钮视觉权重接近，逼用户先读正文；正文含工具名 + 完整命令 + cwd + 会话前缀 | 回归「气泡显示了完整命令（不截断关键信息）」「气泡显示了来源目录」「没有『永久允许』这类按钮」 |

### 实现期被自动化测出来的两个真 bug

这两条不是设计缺陷，是**实现缺陷**，而且都属于"不会崩、只会让人莫名其妙"的类型——正因如此才必须记下来：

| 现象 | 根因 | 修法 |
|---|---|---|
| 启动后**第一个**权限请求必定丢失：气泡空白，点了没反应，最后 2 分钟超时回落 | 气泡窗口是懒创建的。`webContents.send` 发生在渲染层执行 `bubble-renderer.js` 之前，IPC 消息被静默丢弃（不报错、不排队） | 渲染层注册完 `onRequest` 后回一个 `bubble:ready`，主进程用 `bubblePendingEntry` 暂存，收到握手才投递 |
| 气泡只能用一次：第二次及以后的请求按钮全是灰的，点不动 | `decide()` 把两个按钮 `disabled = true` 防连点，但下一条 `render()` 没有恢复，状态一路带下去 | `render()` 开头无条件 `disabled = false` |

第一条的隐蔽性值得单独强调：它的表现是"慢"，不是"错"。没有断言就会当成网络偶发，这类 bug 能活到生产。

### 退出时必须给挂起的请求一个答复

`before-quit` 里调 `permissions.dispose()`，把仍 pending 的请求全部以 204 结束。理由不是洁癖：

- 用户关掉桌宠的瞬间，Claude Code 可能正卡在一个 `PermissionRequest` 上等回应；
- hook 侧写的是 `timeout: 600`，连接悬空意味着**终端最长 10 分钟没反应**，而用户已经看不到气泡了，无从判断发生了什么；
- 204 让 Claude Code 立刻回落原生提示，用户换到终端照样能批。

排队中的那条更容易写错：`dispose()` 走 `settle() → onResolve()`，而 `onResolve` 里有"弹下一条"的逻辑。写得不对就会在退出过程中新建一个浏览器窗口，或者把排队项漏成悬空连接。回归里因此**同时挂两条**（一条显示、一条排队）来覆盖它。

---

## S6 会话看板：落地核对（2026-10-27，回归 64/64）

预判只有两条（cwd 脱敏 + 演示模式），落地时实际涉及面更大——因为看板**新增了一个窗口和两条 IPC**。

### SEC-09 的正确解法是分层，不是砍字段

| 层 | 函数 | 存/出什么 | 能到哪 |
|---|---|---|---|
| 存储层 | `sanitizeCwd()` | 完整路径，剥控制字符，限 1024 | 只在主进程内存 `sessions` Map |
| 快照层 | `publicCwd()` | 最后一段目录名，限 200 | IPC → 渲染进程 → 看板 DOM → 屏幕/投屏/截图 |
| 释放口 | `fullCwd(id)` | 完整路径，按 id 单条取 | 只被 `dashboard:copy-path` 调用，结果进剪贴板 |

**断言**（回归 7.7 段）：

- [x] 快照里 `proj-alpha` 在、`E:` 不在：`basename=true 盘符=false`（直接查 `document.body.textContent`）
- [x] 伪造 id `'../../etc/passwd'` 调 `copyPath` 返回 `false`——`fullCwd` 只查 Map，不做路径拼接，所以路径穿越在此不成立
- [x] `dashboard-preload.js` 里**不存在**「取完整 cwd」的接口，渲染层想拿也没有通道

### 演示模式：只掩盖显示，不掩盖数据

它防的是「投屏/直播时把客户项目名漏出去」，所以只隐藏目录名，状态与时长照旧——把看板变成废纸是过度设计。

**这是一条必须写清楚的边界**：演示模式存在渲染层的 `localStorage` 里，主进程不知道它开着。也就是说**快照里仍然有 basename**，只是不显示。真要彻底隐藏，得在宿主侧不采集，那是另一件事（也更彻底）。当前设计的选择是：项目名属于"低敏感但容易社死"的信息，不值得为它改动数据链路。

### 新窗口的安全基线

看板是第二个带 `preload` 的窗口，所以把主窗口那套基线逐条对照过：

| 项 | 看板 | 与主窗口一致？ |
|---|---|---|
| `contextIsolation: true` | ✓ | 一致 |
| `nodeIntegration: false` | ✓ | 一致 |
| `sandbox: true` | ✓ | 一致 |
| `webSecurity: true` | ✓ | 一致 |
| CSP | `default-src 'none'` | 一致 |
| preload 暴露面 | 2 个动作（`getSnapshot` / `copyPath`），无 `ipcRenderer` | 一致（主窗口 7 个） |
| 外部字符串进 DOM | 全部 `textContent` | 一致 |

**刻意不一致的三个窗口参数**（`frame` / `transparent` / `alwaysOnTop`）是体验选择，不是安全项——看板是"用户主动要看"的窗口，所以有边框、不透明、不置顶。而它**比桌宠泄露得多**（一整张项目列表），所以 `hideAll()` 在锁屏/休眠时必须把它一起 `hide()`。

### 遗留

- **P3**：`dashboardDebug` 挂在 `window` 上（DevTools 可手动灌快照）。和 `petDebug` 同一性质——只在能开 DevTools 的前提下可用，且灌进去的数据不会外发。保留是为了联调。
- **未验**：剪贴板内容。`copyPath` 返回 true/false 已验，但本环境 `clipboard.readText()` 恒为空（连自写探针都读不到），需手工确认。

---

## S7 主题系统：预判

- 主题包是**不可信输入**（可能来自第三方分享）。加载前必须过 SVG 白名单（见 SEC-05），禁止 `<script>` / `<foreignObject>` / 外链资源。
- **`ALLOWED_TAGS` 现在没有 `clipPath` / `mask` / `filter`**。接主题前要先决定：
  - 放行 → 主题能做发光、柔和阴影、裁切，但也能做**视觉欺骗**（把界面伪装成系统弹窗诱导点击）和**信息外带**（`filter: url(...)` 引用外部资源）。
  - 不放行 → 表达力受限，但攻击面小得多。
- **顺序不能反**：先定白名单，再做加载器。反过来写，等加载器写完才发现白名单要放宽，那时候放宽的动机已经变成"让这个主题能跑起来"，而不是"这样安全"。
- 主题目录建议校验来源（本地手工放置，不做自动下载）。

---

## 每个阶段的固定检查清单

做完任何一个阶段，逐条过：

- [ ] `npm audit` 是否新增 high/critical
- [ ] 新增的 IPC 通道是否都在 `preload.js` 里以「具体动作」暴露，没有泄漏 `ipcRenderer`
- [ ] 新增的网络/文件输入是否做了长度与类型校验
- [ ] 新增的渲染内容是否走了 `innerHTML` 或模板字符串拼接
- [ ] 是否有新的敏感信息（路径、命令、prompt）进入渲染层或日志
- [ ] 若涉及权限决策：**没拿到明确决定时是否返回「不做决定」而不是拒绝**、deny 是否只在用户明确点击时产生、是否禁止「永久允许」
- [ ] 若涉及远程审批（决定来自公网、可重放）：是否有一次性 nonce。**本地 HTTP hook 不需要**，别照抄
- [ ] 以上结论是否已回写到本文件的对应阶段小节

---

## 附：值得保留的好设计

审计不是只挑毛病，以下三点是这个骨架最容易在后续开发中被破坏、必须守住的东西：

1. **`preload.js` 只暴露动作，不暴露 `ipcRenderer`** —— 这是 Electron 安全的核心边界，S7 加主题功能时最容易被「顺手」开个大口子。
2. **服务端强制 256KB 请求体上限，且超限立即 `req.destroy()`** —— 很多本地服务忘掉这条。
3. **渲染层的状态白名单**：`setState` 里 `window.VISUAL_STATES[state]` 不存在就忽略，`svgNode` 之外没有任何地方拼接 HTML。这让「服务端收到的任意字符串」无法直接变成 DOM。
