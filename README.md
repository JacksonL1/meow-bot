# clawd-starter

桌面上的一只布偶猫。它不替你干活，只负责让你**看见** Claude Code / CodeBuddy / WorkBuddy 在干什么——
谁在跑、跑到哪一步、有没有卡在某条命令上等你点「允许」。

容器是 Rust（Tauri 2 + 系统 WebView2），渲染层是原生 JS + SVG。**没有框架、没有构建步骤、没有运行时依赖**：
`package.json` 的 `dependencies` 与 `devDependencies` 都是空的，node 只用来跑脚本（装 hook、回归、签名）。

| | |
|---|---|
| 容器 | Tauri 2.12.5 · Rust 宿主 ≈ 4000 行 · 系统 WebView2 |
| 渲染 | 原生 JS / SVG，28 通道二阶弹簧逐帧算，无框架无打包 |
| 运行时依赖 | **0** 个 npm 包 |
| 安装包 | `clawd-starter_0.1.0_x64-setup.exe` · **1.59 MiB** · NSIS · currentUser（不弹 UAC） |
| 平台 | Windows 10 / 11 实测；macOS / Linux 代码留了分支但**没跑过** |
| 代码签名 | `scripts/sign-release.js` ← `bundle.windows.signCommand`，接 PFX 或证书库指纹 |
| 规模 | `src` 3476 行 + `src-tauri/src` 3972 行 + `hooks` 644 行 + `scripts` 2160 行 |

## 目录

- [这是什么](#这是什么)
- [三分钟跑起来](#三分钟跑起来)
- [代码签名](#代码签名)
- [接上你的 agent](#接上你的-agent)
- [怎么用](#怎么用)
- [本地端点（HTTP 协议）](#本地端点http-协议)
- [主题](#主题)
- [开发与回归](#开发与回归)
- [项目结构](#项目结构)
- [内存这件事](#内存这件事)
- [已知限制](#已知限制)
- [踩坑记录](#踩坑记录)

## 这是什么

四条数据流，各管一件事：

```text
事件流   agent 事件 → hook（短命进程，async）→ 本地 HTTP → 状态机 → IPC → 弹簧动画
裁决流   agent 要执行工具 → HTTP hook（阻塞）→ 气泡等你点 → 同一个 socket 回 200 / 204
看板流   双击桌宠 → 独立窗口 → 1s 轮询快照 → 一条会话一行
主题流   启动 → 读 themes/<id>/ → 校验 → IPC → 渲染层换帧数据（白名单在这层之前就生效）
```

它要解决的四个具体问题：

1. **"它到底在跑，还是在等我？"**
   桌宠的姿态就是答案：敲键盘是在干活，歪头张嘴是在等你，炸毛是报错。不用切窗口。
2. **同时开五个会话，分不清谁是谁。**
   一个会话一只猫，横排（最多 4 只，重叠），有任务就从你的 prompt 里抽一个词写在头巾上。
3. **权限确认埋在终端滚动的历史里。**
   桌宠把它拎到屏幕最上层：命令原文 + 数据流向 + 命令风险评级，点一下就把决定回写给 agent。
4. **桌宠常驻很占资源。**
   宿主是原生 Rust 进程，不是又一个 Chromium——但这句话有个必须讲清楚的前提，见[内存这件事](#内存这件事)。

形象不是贴图：七种状态是七种**姿势**，靠骨骼弹簧过渡，不是同一张图换帧。
截图见 [`docs/ragdoll-states.png`](docs/ragdoll-states.png)（`npm run preview:states` 重新生成）。

## 三分钟跑起来

**前置**

- Rust stable（`rustup`）+ MSVC build tools
- WebView2 Runtime（Win11 自带；Win10 一般也有，没有的话安装器会联网拉）
- 只有**打包签名**需要 Windows SDK（自带 `signtool.exe`）
- Node ≥ 18，仅用于脚本

**构建与运行**

```bash
npm run build     # cargo build --release
npm run start     # cargo run --release —— 窗口出现在右下角
npm run bundle    # cargo tauri build → NSIS 安装包 + 调用签名脚本
```

产物：`src-tauri/target/release/bundle/nsis/clawd-starter_0.1.0_x64-setup.exe`

装到 `%LOCALAPPDATA%\clawd-starter`，卸载走「应用和功能」。
`scripts/verify-bundle.js --install` 会真装一遍、真跑一遍、真卸一遍，并断言注册表
Uninstall 子键集合回到安装前。

**全部脚本**

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run build` | 跑 / 编 release |
| `npm run bundle` | Tauri 打包 + 补签裸 exe（原因见[代码签名](#代码签名)） |
| `npm run feed` | 喂一轮假事件：thinking → working → error → attention → idle |
| `npm run feed -- Stop` / `--hold working 10` | 单事件 / 保持某状态 10 秒 |
| `npm run verify:tauri` | UI 闸门：起真窗口、连 CDP，逐条断言（**唯一一道 UI 闸门**） |
| `npm run verify:diag` | 状态回放：临时实例 + 10 步真实事件序列，逐步对期望 |
| `npm run verify:bundle` / `:install` | 打包产物：配置与产物 / 再加真装真卸 |
| `npm run verify:all` | 上面三道串起来 |
| `npm run diag:events` | 读**正在跑的那份**，告诉你"它为什么是 idle" |
| `npm run preview:states` | 七状态对照图 → `docs/ragdoll-states.png` |
| `npm run build:preview` | 改完 `themes/` 后更新 `preview.html` 的数据包 |
| `npm run icons` | 重画图标（猫脸 + 托盘图标） |
| `npm run install:hooks` / `uninstall:hooks` / `preview:hooks` | 装 / 卸 / 预览 hook（默认 Claude Code） |
| `npm run install:hooks:codebuddy` / `:workbuddy` | 同上，换目标 agent |

## 代码签名

Windows 上「用户双击安装包」这一步，签名决定了三件事：
**发布者可验证**（属性里能看到你的名字）、**不被 SmartScreen 判为未知发布者**、
**证书过期后旧安装包仍然有效**（靠时间戳）。

### 签名到底签了什么

Authenticode 是三层结构，缺一层就有一类问题：

| 层 | 内容 | 缺了会怎样 |
|---|---|---|
| 签名摘要 | 用私钥对 PE 的 Authenticode 哈希做 RSA 签名（**只覆盖文件内容 + 证书表**，不覆盖签名字段本身） | 没有签名，Windows 报「未知发布者」 |
| 证书链 | 叶子证书 → 中间 CA → 根 CA | 链不完整时，别的机器验不过 |
| 时间戳 | CA 的 RFC3161 服务证明"这个签名在某一时刻已存在" | 证书一到期，**旧安装包立刻变成无效签名** |

所以 `scripts/sign-release.js` 里 `/tr http://timestamp.digicert.com /td sha256` 不是可选项。
`verify` 输出里如果有 `Timestamp` 列，说明这一层在。

### 三条路，按你的用途选

| 方案 | 价格 | 谁都能用吗 | 立刻不弹 SmartScreen 吗 |
|---|---|---|---|
| **自签名** | 免费 | 是 | 否。别人机器上仍会拦，只适合自己用 / 内网 / 测试 |
| **OV 证书**（DigiCert / Sectigo / GlobalSign 等） | 约 $150–300 / 年 | 需要企业资质（国内 CA 同理） | 否。要靠下载量累积信誉 |
| **Azure 制品签名**（原 Trusted Signing） | 约 $9.99 / 月（5,000 次） | 组织：美/加/欧盟/英；个人：仅美/加 | 否。但发布者身份一致的话，后续版本会继承信誉 |
| **EV 证书** | $400+ / 年 | 需要企业资质 | **2024 年起不再"自带信誉"**，与 OV 同待遇 |

三条容易踩的预期：

- **"买了 EV 就没人拦了"** 已经不成立。微软文档明确写了 2024 年后 EV 与 OV 的 SmartScreen 行为一致。
- **签名 ≠ 信誉**。签名让「发布者」可验证；信誉是按签名身份累积的下载/安装量，两者是两套系统。
- **2023 年起 CA/B 论坛要求私钥不能以文件形式躺磁盘上**，商业 OV/EV 基本都改成 USB 硬件令牌或云 HSM 了。
  也就是说你买到的往往不是 `.pfx`，而是"签名盒子"或"云签名 API"——
  这时本项目的 `/f <pfx>` 这条路走不通，要用 `/sha1 <指纹>`（令牌已插、证书在库里），
  或者接云签名的 DLIB 参数（本项目脚本还没接，见下）。

### 用哪张证书，由环境变量决定

私钥**永远不进仓库**（`.gitignore` 里 `*.pfx` / `*.p12` 已挡）。

| 变量 | 什么时候用 |
|---|---|
| `CLAWD_SIGN_PFX` | 有 PFX 文件（自签名、或从令牌导出的一次性副本） |
| `CLAWD_SIGN_PFX_PASSWORD` | 上面那个 PFX 的密码 |
| `CLAWD_SIGN_THUMBPRINT` | 证书已经装进当前用户/本机证书库（硬件令牌走这条） |

一个都不配时，签名脚本**响亮地跳过**：打印一行大写警告，退出码 0，产物不签名。
这样没有证书的人照样能打包；但**配了证书却签失败就退出非 0，让打包直接红**——
绝不允许"以为签了其实没签"这种中间态。

### 现在这台机器上已经有的（自签名，仅本机可用）

```text
证书         CN=clawd-starter (local dev)   有效期 3 年
指纹         20ECA7320CC89439C5C1928AA6B1B3444966C265   （CurrentUser\My）
PFX          C:\Users\<你>\.clawd-signing\clawd-starter-selfsign.pfx
密码         C:\Users\<你>\.clawd-signing\pfx-password.txt
元数据       C:\Users\<你>\.clawd-signing\signing.local.json
```

重新生成一张（PowerShell，全程不碰 `SecureString`——那个 API 会被安全护栏拦下）：

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=clawd-starter (local dev)" `
  -KeyUsage DigitalSignature `
  -FriendlyName "clawd-starter self-signed" `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(3)
$cert.Thumbprint

New-Item -ItemType Directory -Force "$env:USERPROFILE\.clawd-signing" | Out-Null
# 用 certutil 导出 PFX，密码单独存文件：ConvertTo-SecureString 会触发安全护栏
certutil -user -exportPFX -p "<自己编一个密码>" $cert.Thumbprint `
  "$env:USERPROFILE\.clawd-signing\clawd-starter-selfsign.pfx"
```

构建时带上：

```bash
# bash
export CLAWD_SIGN_PFX="$USERPROFILE/.clawd-signing/clawd-starter-selfsign.pfx"
export CLAWD_SIGN_PFX_PASSWORD="$(cat "$USERPROFILE/.clawd-signing/pfx-password.txt")"
npm run bundle
```

```powershell
# PowerShell
$env:CLAWD_SIGN_PFX = "$env:USERPROFILE\.clawd-signing\clawd-starter-selfsign.pfx"
$env:CLAWD_SIGN_PFX_PASSWORD = Get-Content "$env:USERPROFILE\.clawd-signing\pfx-password.txt" -Raw
npm run bundle
```

### 验证签名

```bash
node scripts/sign-release.js --verify src-tauri/target/release/bundle/nsis/clawd-starter_0.1.0_x64-setup.exe
```

```powershell
Get-AuthenticodeSignature .\clawd-starter_0.1.0_x64-setup.exe |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

自签名会得到：

```text
Status               : UnknownError
StatusMessage        : 已处理证书链，但是在不受信任提供程序信任的根证书中终止。
SignerCertificate    : CN=clawd-starter (local dev)
TimeStamperCertificate: CN=DigiCert SHA256 RSA4096 Timestamp Responder 2025 ...
```

**这不是失败**：签名在、链完整、时间戳生效，只是根证书不在受信列表里。
要让自己这台机器不再报警（**只对这台机器生效，别人那里照旧报——信任本来就不能分发**）：

```powershell
Export-Certificate -Cert Cert:\CurrentUser\My\20ECA7320CC89439C5C1928AA6B1B3444966C265 `
  -FilePath .\clawd-starter-selfsign.cer                       # 只导公钥
Import-Certificate -FilePath .\clawd-starter-selfsign.cer `
  -CertStoreLocation Cert:\CurrentUser\Root                    # 装进"受信任的根证书颁发机构"
```

装完再 `Get-AuthenticodeSignature`，`Status` 就是 `Valid`。

### 打包时的两个硬性事实

这两条都是实测出来的，不是推测：

1. **`signCommand` 的工作目录是 `src-tauri/`，不是仓库根。**
   所以要写 `"args": ["../scripts/sign-release.js", "%1"]`。
   写 `"scripts/sign-release.js"` 会得到
   `Error: Cannot find module '...\src-tauri\scripts\sign-release.js'`。
2. **`cargo tauri build` 结束后，裸 exe 是不带签名的。**
   日志里明明有 `[sign] signed: clawd-starter.exe`，但打包结束那一刻
   `target\release\clawd-starter.exe` 的 mtime 落在构建末尾、大小回到了未签名时的 4682752 字节
   （签名后是 4690224，多出的是证书表）。打包器在签名之后又覆写了一次这个文件。
   **安装包不受影响**（`makensis` 生成后才签，签完没人再碰它）。
   因为这条，`npm run bundle` 里串了一次补签：

   ```json
   "bundle": "cargo tauri build && node scripts/sign-release.js src-tauri/target/release/clawd-starter.exe"
   ```

   如果你只分发安装包，可以不管；要单独发裸 exe，必须补这一刀。

另外两个小坑：

- `signtool` 报 `The file is being used by another process`：上一轮回归留下的 `clawd-starter.exe` 还开着。
  `taskkill /F /IM clawd-starter.exe` 之后重签。
- 签名脚本的日志一律 ASCII：它的 stdout 会被 `makensis` 的管道接走，多字节代码页下中文会变成乱码
  `[sign] 宸茬鍚嶏細nst45DE.tmp`。签名本身没问题，只是没法读。

### 想用云签名（Azure 制品签名）要改哪里

`sign-release.js` 现在只接 `/f`（PFX）和 `/sha1`（证书库指纹）两种。接云签名需要：
下载服务的 DLIB 包（让它认识云端证书），把 sign 调用改成
`/dlib <metadata.json> /dmdf <metadata.json>`，再把账号/证书配置文件名传进来——大约十行。
**这一步没做，也没验过**，写在这里是为了不让人以为"填个环境变量就能用"。

## 接上你的 agent

有**两条互不相干**的路能把 agent 的状态送进桌宠，选一条就行：

| | hook（HTTP） | DeepSeek Harness（只读文件） |
|---|---|---|
| 支持 | Claude Code / CodeBuddy | DSH `web` / 桌面版 |
| 原理 | agent 跑 hook → `POST /state` | 主进程 1s 轮询 DSH 的投影缓存 |
| 要改 agent 配置 | **要**（下面那套备份/原子写） | **不要**，只读 |
| 能看到 | 工具名、权限请求、压缩 | 状态、标题、目录、权限档位（**没有工具名**） |

### 一、DeepSeek Harness：不用配置，装上即可

桌宠会自动去找 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`）下的
`storages/session_projcache/sessions/<id>.json`，**一会话一文件**，只读。

- 什么都不用装、不用改。DSH 没装就当没这回事，零开销。
- `dsh web` / 桌面版的会话状态完整：`thinking`（在等首字）/ `working`（在出字或跑工具）/
  `attention`（这一轮做完了）/ `idle` / `sleeping`。
- `dsh headless "…"` 这类一次性会话在投影里**只有标题**，没有统计行，
  所以只能显示成 idle（它本来就是跑完就退的东西）。
- 看板上**工具名那一格是空的**：投影里的 `pendingCalls` 只有 `callId → 派发时刻`，
  不含工具名。这是刻意留的诚实缺口，不是没接完。

排查用 `window.clawd.dshState()`（见下面「调试入口」）。

### 二、hook：把 agent 事件送进来

hook 由 `hooks/install.js` 写进 agent 的全局配置。
它是**整个项目里唯一会改用户配置的地方**：

1. 先备份 `settings.json.clawd-backup-<时间戳>`
2. 原子写（同目录临时文件 + rename，不留半截 JSON）
3. 只动带 `clawd-hook.js` 标记的条目，别人的一个字节都不碰
4. 幂等：重复执行不产生重复 entry

```bash
npm run preview:hooks                   # --dry-run，只看会写什么
npm run install:hooks                   # 装进 ~/.claude/settings.json
npm run install:hooks:codebuddy         # CodeBuddy
npm run install:hooks:workbuddy         # WorkBuddy
npm run uninstall:hooks                 # 摘干净（别人的 hook 不动）
node hooks/install.js --agent claude --file <path>   # 指向别的 settings 文件
```

**三家 agent 的契约不一样，照抄会装出"看起来装好了、其实永远不触发"的配置：**

| | Claude Code | CodeBuddy | WorkBuddy |
|---|---|---|---|
| 观察型事件 | 8 个（含 `PostToolUseFailure`） | 8 个（含 `PreCompact`，无 `PostToolUseFailure`） | 同 CodeBuddy |
| `matcher` 取值 | `"*"` | `""` | `""` |
| 权限请求 | `type: "http"` → `POST /permission` | 会真的 POST | **永不调用外部端点**（原生沙箱自己处理），所以不给它装 |

两条分界线要记住：**观察型 hook 一律 `async: true`，裁决型 hook 必须阻塞**。
Windows 上 `node` 冷启动实测 ~200ms，观察型不加 `async` 就是每次工具调用都慢 200ms；
而权限那条加了 `async` 等于立刻返回空响应，永远问不到用户。

**端口这件事**：服务优先用 23333（与主仓库一致），端口和 token 一起写进
`%APPDATA%\clawd-starter\clawd-starter.port`；hook URL 是**安装时**写死进配置的。
所以端口变了必须重跑 `npm run install:hooks`，否则请求还打向旧端口。

## 怎么用

**窗口本身**

- 透明、无边框、置顶、不进任务栏、**不可缩放**，默认停在右下角（工作区右下角各留 40px）
- 拖猫本体移动窗口；**非像素区域点击穿透**——由宿主每 60ms 按"光标在不在猫身上"判定，
  不靠页面收鼠标事件（为什么不能靠，见[踩坑记录](#踩坑记录)第一条）
- 双击猫开/关**会话看板**；右键猫出菜单（会话看板 / 退出）
- 托盘图标：左键无效（`show_menu_on_left_click(false)`），右键菜单 = 会话看板 / **开机自启**（勾选项）/ 退出
- 单实例：再启动一个只会把已有那只唤到前台（命名互斥量 + 事件，见 `single.rs`）

**状态与动画**

| 状态 | 它在干什么 |
|---|---|
| `idle` | 端坐，眼睛跟着光标 |
| `thinking` | 蹲低歪头——你刚发了一条 prompt，模型在想 |
| `working` | 桌前敲键盘，代码一行行长出来。**这时关掉眼球追踪**：眼睛该在屏幕上 |
| `attention` | 拔高张嘴——一轮任务跑完了，等你回来看 |
| `notification` | 歪头挥爪「喵~」——**卡在权限确认上等你点**，这个状态最长能挂 10 分钟 |
| `error` | 炸毛泛红 |
| `sleeping` | 侧躺垫爪。闲置 60s 睡着，鼠标经过**慢慢**睁眼（弹簧 ≈0.5s，不是"啪"一下） |

**多会话分身**（`MAX_CATS = 4`）

- 一个会话一只猫，横排叠在一起，按「最吵的排前面」排序（error > attention > …）
- 点某只把它顶到最前（`z-index` + `.focus`），**判定带位移阈值**——拖窗口时不会顺手改焦点
- 会话闲置超过 5 分钟（`FADE_AFTER_MS`）就淡出退场："接不到任务了，慢慢消食"
- 头巾（`#rig-bandana`）默认藏起来，只有这条会话真的抽出了关键词才戴上，字数多时自动缩字号

**权限气泡**

| 你做什么 | agent 收到 | 结果 |
|---|---|---|
| 点「允许」 | `200 {"decision":{"behavior":"allow"}}` | 放行 |
| 点「拒绝」 | `200 {"decision":{"behavior":"deny","message":…}}` | 拒绝，并告诉它原因 |
| 不点 / Esc / 关气泡 / 退出 / 超时 | **`204` 空** | **不做决定**，回落终端原生提示 |

气泡上除了命令原文，还有**风险评级**（低 / 中 / 高 / 极高）和最多 4 条理由。
它认的是"命令词 + 参数"，不是拿正则糊整串——所以 `cat ~/.ssh/id_rsa` 会被判成
`CREDENTIAL_TOUCH`（读私钥），而不是"发起了 ssh 连接"。判定类别（代码里的标识）：

```text
删根 / 删系统目录   RM_ROOT · RM_ROOT_FILE · RM_RECURSIVE · RM_FILE
凭据与密钥          CREDENTIAL_TOUCH · CREDENTIAL_WRITE · SECRET_IN_COMMAND
git 破坏性操作      FORCE_PUSH_MAIN · FORCE_PUSH · GIT_HARD_RESET · GIT_CLEAN · GIT_WRITE
执行远端内容        PIPE_REMOTE_EXEC · OUTBOUND_NETWORK
系统级破坏          DISK_WIPE · FORK_BOMB · CHMOD_WORLD_ROOT · SERVICE_KILL · SUDO
数据库 / 覆盖写     DESTRUCTIVE_SQL · OVERWRITE_REDIRECT
出圈与体量          ESCAPES_CWD · BIG_PAYLOAD（>1200 字符，多半是 here-doc 或拼接脚本）
```

**评级只是提示，不是安全边界**：`critical` 也不会自动 deny（deny 会让工具静默失败，
你还以为批准过）。真要拦，闸门在 agent 自己的权限系统里。

**会话看板**

- 一条会话一行：这一轮在问什么（标题）、状态徽标、目录名、会话 id、最后用到的工具、闲了多久
- 正在演的那条用左侧色条标出；按"最吵的排前面"排序
- 底部可以切主题；「复制路径」单独取**完整**路径（见下方 SEC-09）
- **演示模式**只隐藏目录名和标题（防投屏漏客户名），状态与时间照旧
- 1s 轮询，不是推送——`idleMs` 本来就随时间变，轮询一个本地 IPC 的代价近似为零

## 本地端点（HTTP 协议）

| 方法 / 路径 | 谁调 | 返回 |
|---|---|---|
| `POST /state` | 观察型 hook | `200 {"ok":true,"visual":"working"}`——回包顺带告诉 hook 当前该显示什么 |
| `GET /state` | 看板、`diag:events` | 快照 JSON（含 `recent` 事件账本） |
| `GET /health` | 探活 | `200 {"ok":true,"lock":"event"}` |
| `POST /permission` | Claude Code 的 HTTP hook | `200 {decision}` 或 `204` |

**端口不是权限**。本机任何进程都能连 127.0.0.1，所以每一关都要有理由：

| 关卡 | 拦什么 | 失败 |
|---|---|---|
| `Host` 必须是 `127.0.0.1:<本进程端口>` | DNS rebinding | 403 |
| `Origin` 存在且非 `null` 即拒 | 网页发起的跨源请求 | 403 |
| `x-clawd-token` | 同机其他进程 | 401 |
| `content-type: application/json` | 不触发预检的 CORS 简单请求 | 415 |

**`/permission` 是例外：它不校 token**——调用方是 agent，它读不到我们的端点文件，
这条路上塞 token 只会让气泡永远不出现。它只过 Host / Origin / Content-Type 三关，
挡的正是"浏览器发起的跨源请求"，那才是真正可利用的路径。这是 HTTP hook 架构的固有属性，不是疏漏。

手动打一发（**少一个头就是 401，这是故意的**）：

```bash
PORT=23333
TOKEN=$(node -e "console.log(require('./src/port-file').readPortFile().token)")
curl -i -X POST http://127.0.0.1:$PORT/state \
  -H 'content-type: application/json' \
  -H "x-clawd-token: $TOKEN" \
  -d '{"session_id":"s1","event":"PreToolUse"}'
```

**cwd 是分层处理的（SEC-09）**

| 层 | 存什么 | 谁看得见 |
|---|---|---|
| 存储层（`state.rs` 的会话表） | 完整 cwd，清洗控制字符、限长 1024 | 只在宿主进程内存里 |
| 快照层（`snapshot()` → IPC → 屏幕） | 只有最后一段目录名，限长 200 | 看板 DOM、投屏、截图 |

完整路径唯一的出口是用户显式点「复制路径」——宿主单条释放给剪贴板。
渲染层**根本没有**"取完整 cwd"的接口。

## 主题

```text
themes/ragdoll/
├── theme.json          状态 → 帧文件、fps、要不要跟眼球
└── assets/*.svg        一帧一个文件
```

- 内置只有 `ragdoll`（骨骼弹簧版）。早期的 `crab` 已删——暂时不需要第二个
- 想自己做：复制 `themes/_template`（下划线开头，不会出现在主题列表里），
  契约见 `themes/README.md`
- 加载链是**拉**的（渲染层请求 `getTheme`），不是推的——推早了会被静默丢弃，
  这是 S5 第一个权限气泡踩出来的坑
- 主题文件是**不可信输入**：SVG 走 `DOMParser` + 标签白名单，`<style>` / `foreignObject` /
  `animate` / `feImage` / `feTurbulence` 全拒，`url()` 只准指向 `#本地id`
- 主题坏掉时给**内置兜底画面**（灰色「?」）：桌宠是置顶无边框窗口，空白等于让用户
  "看得见进程、找不到窗口、不知道怎么退出"
- 主题优先级：`CLAWD_THEME` 环境变量 → `--theme=<id>` → 上次在看板里选的 → `ragdoll`

改完 `themes/` 记得 `npm run build:preview`——`preview.html` 是静态页，`file://` 下读不到本地文件，
吃的是 `themes/` 打出来的数据包。桌面那只**不走这个包**（它直接读文件），
所以"预览没变但桌宠变了"是可能发生的。

## 开发与回归

三道闸门 + 一道回放，判据不同源：

| 闸门 | 命令 | 现在的数 | 它回答什么 |
|---|---|---|---|
| UI | `npm run verify:tauri` | **92 PASS / 0 FAIL** | 二进制跑起来之后，行为对不对 |
| 单测 | `cd src-tauri && cargo test` | **38 passed** | 状态机 / 风险评级 / 主题校验 / DSH 翻译的纯逻辑 |
| 打包 | `npm run verify:bundle` | **10 PASS**（`--install` 再 +15） | 用户拿到手的那一包，装得上、卸得干净 |
| 回放 | `npm run verify:diag` | **10 步全中** | 真实事件序列走一遍，状态有没有掉 |
| 审计 | `cargo audit` | **0 漏洞 / 2 条警告** | 1402 条公告 × 425 个依赖 |

关于这些数字，有两句话必须写在这里：

- **`verify:tauri` 会给自己开一个临时端点文件（`CLAWD_PORT_FILE` 指到 tmp），所以开着桌宠也能跑。**
  但它有一条"陈旧二进制"守卫：release exe 比源码旧就直接拒跑并提示 `cargo build --release`——
  拿旧二进制跑测试得到的绿是假的。
- **`verify:tauri` 里的 DSH 断言用临时 `DSH_HOME` 夹具，不碰你真实的 `~/.dsh`。**
  夹具是现造现撤的：造出来 → 断言 `/state` 里出现它、猫变 working → 改成 idle 断言结束发 `Stop`
  → 撤掉再等一拍。**拿真实缓存做断言是错的**——那里面有几个会话、是不是还在活跃窗口内
  由你的历史决定，闸门会变成看运气（第一版就是这么红的，而那其实是正确行为）。
- **`verify:diag` 的位置最特殊**：它起一份临时实例，把现场观察到的一轮事件照原样喂回去
  （SessionStart → UserPromptSubmit → 补发 SessionStart → 工具 → PreCompact → 压缩后 SessionStart
  → UserPromptSubmit → Stop → SessionEnd），每一步都对**服务端快照**和**渲染层画面**两个读数。
  它钉死的是一个用户报过的问题：thinking 不许掉、压缩后不许回 idle。

### 状态掉了怎么查

**没有任何报错**——hook POST 成功、服务回 200、页面安静。只看画面永远看不出来，要读账本：

```bash
npm run diag:events
```

`GET /state` 的 `recent` 里每条都有 `how`，它就是答案：

| `how` | 含义 |
|---|---|
| `mapped` | 事件认得，状态真的改了 |
| `same` | 认得，但目标状态与当前一致（不算 bug） |
| `ignored` | **事件名不认得**，什么都没改 ← 掉 idle 的头号嫌疑 |
| `preserved` | `SessionStart` 撞上已有会话，原状态被保住 |
| `session-end` | 会话被删（没有会话时仲裁结果就是 idle，这是对的） |
| `woke` | 鼠标把它弄醒了 |

### 调试入口

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm start
```

连上 CDP 后页面里有 `petDebug`：

| 方法 | 看什么 |
|---|---|
| `setState('working')` | 立刻把画面切到某个状态 |
| `gaze({x:1,y:-1}, true)` / `unpinGaze()` | 把眼睛钉在某个方向 / 放开 |
| `state()` / `states()` / `timings()` | 当前状态、主题声明了哪些状态、每个状态播多久 |
| `springs()` / `eyeOpen()` | 28 个弹簧通道的当前值 / 睁眼程度 0–1（证明"有过渡"只能靠它） |
| `cast()` / `solo()` | 台上有几只猫、各自演什么、头巾上写的什么词、聚焦谁 |
| `desk()` / `variant()` / `builds()` | working 桌面的进度 / 当前播第几套资产 / 重建过几次 |
| `window.clawd.dshState()` | DSH 适配层看到了什么（见下） |

`window.clawd.dshState()` 是排查「接了 DSH 但猫不动」的第一站，四个数一次说清死在哪一步：

| 现象 | 含义 |
|---|---|
| `installed: false` | `$DSH_HOME` / `dir` 路径不对（没装 DSH，或 `DSH_HOME` 指错了） |
| `polls` 在涨、`reads` 不涨 | 线程活着，但那个目录里的文件真的没变过 |
| `reads` 在涨、`feeds == 0` | 读到了却没产出事件：会话全是 `blank`，或全在 30 分钟活跃窗口外 |
| `sessions[].has_stats == false` | 这条会话的投影里没有统计行（`dsh headless` 就是这样），状态只能是 idle |

`scripts/cdp.js` 是三个回归脚本共用的那一段——**同一套判据必须用同一段代码丢进页面**，
否则两边的绿没有可比性。

## 项目结构

```text
clawd-starter/
├── src/                       渲染层（原生 JS + SVG，无框架、无构建步骤）
│   ├── index.html             桌宠主窗口（分身 / 气泡锚点 / 拖拽层）
│   ├── renderer.js            弹簧骨架 + 七种姿势 + 分身 + 头巾 + SVG 白名单
│   ├── bubble.html / .js      权限气泡（命令原文 + 风险评级 + 允许/拒绝）
│   ├── dashboard.html / .js   会话看板（行节点复用，避免每秒重建）
│   ├── theme.js               主题解析与加载（预览构建也用它）
│   ├── tauri-bridge.js        把 window.clawd 装回渲染层（Electron → Tauri 的桥）
│   └── port-file.js           端点文件读写 + DEFAULT_PORT
├── src-tauri/
│   ├── tauri.conf.json        窗口/打包/签名配置（signCommand 在这里）
│   └── src/
│       ├── main.rs            窗口、菜单、托盘、IPC 命令、定时器
│       ├── state.rs           状态机 + 多会话仲裁 + 事件账本
│       ├── dsh.rs             DeepSeek Harness 适配层（读投影缓存 → 翻译成事件）
│       ├── server.rs          本地 HTTP（四道锁）
│       ├── permission.rs      权限裁决台（settle() 是唯一出口）
│       ├── risk.rs            命令风险评级（纯函数，无副作用）
│       ├── theme.rs           主题发现与校验
│       ├── sys.rs             光标 / 剪贴板 / 锁屏 / 开机自启（Win32 直调）
│       └── single.rs          单实例锁 + 唤醒已有实例
├── hooks/
│   ├── clawd-hook.js          读 stdin → POST → 立刻退出（永不非 0）
│   └── install.js             装进三家 agent 的 settings.json
├── themes/                    ragdoll + _template
├── scripts/                   回归 / 诊断 / 预览 / 图标 / 签名
├── docs/
│   ├── ragdoll-states.png     七状态对照图
│   └── ledger/                台账：DEVLOG / SECURITY / PROGRESS / FILE_MAP / GLOSSARY
└── package.json               0 依赖，只有脚本
```

## 内存这件事

用户最初的目标是"常驻内存降到 15MB 以内"。**这个目标没有达到，也不该假装达到。**
同一个 release 构建测了两次，两次互有高低，所以两组都列出来：

| 测量 | 进程数 | RSS | 私有内存 |
|---|---|---|---|
| 第一次 · Tauri 合计 | 7 | 379.6 MB | 211.8 MB |
| └ Rust 宿主 | 1 | **33.9 MB** | **10.4 MB** |
| └ WebView2 子进程 | 6 | 345.7 MB | 201.4 MB |
| 第一次 · Electron 45 合计（对照，已删） | 4 | 350.8 MB | 203.1 MB |

能说的只有一句：**整机基本持平，谁也省不出量级**。两次测量之间差 ±30MB，比"两种容器的差距"还大。

真实收益不在"合计数"，在**宿主进程**：Rust 侧 10.4MB 私有内存，而 Electron 侧光主进程就 100MB+。
WebView2 那 6 个子进程是系统共享的渲染引擎——**换容器换不掉它**，只能换掉"多养一份 Chromium"。
所以这个项目现在的说法是：**宿主是 10MB 级的原生进程**，不是"整只猫 15MB"。

## 已知限制

- **只打了 Windows 的 NSIS 安装包**。`sys.rs` 里 macOS/Linux 有分支，但一次都没跑过
- **离线装不上**：Tauri 默认 `downloadBootstrapper`，机器上没有 WebView2 时安装器要联网。
  要离线包得切 `webviewInstallMode` 并把 `MicrosoftEdgeWebView2RuntimeInstaller` 一起塞进安装包（没做）
- **未签名/自签名安装包会被 SmartScreen 拦**：显示「Windows 已保护你的电脑」，
  要点「更多信息 → 仍要运行」。这是签名问题不是 bug，见[代码签名](#代码签名)
- **看板的「模型 / 上下文用量」没有做**：hook 的 payload 里没有这两个字段，
  硬编一个数字出来比不显示更糟
- **DSH 侧看不到工具名**：投影缓存里 `pendingCalls` 是 `callId → 派发时刻`，不含工具名。
  hook 那条路能看到（`tool_name`），DSH 这条路看不到
- **DSH 的 `headless` 一次性会话只能显示成 idle**：它的投影里只有标题，没有统计行
- **DSH 只做「看」，没做「说」**：桌宠不会把消息送回 agent。这条路技术上可行
  （`dsh --profile headless --session-id <id> "…"` 有完整回执），但还没验并发双写，所以没接
- **主题只支持 SVG**，不支持 GIF/APNG/WebP；也不能用 CSS 动画（白名单拒了 `<style>` 和 SMIL）
- **一个实例、优先固定端口 23333**，与主仓库 `clawd-on-desk` 不能同时跑
- **权限请求只在内存里**，不落盘：重启就没了，也没有决策历史
- **气泡只支持鼠标 + Esc**，没有键盘决定、没有远程审批
- **云签名没接**：只支持 PFX 与证书库指纹

## 踩坑记录

**接了 DSH 之后「一切正常」但一只猫都不显示**

2026-11-04 接 DeepSeek Harness 时踩的。代码写完、单测全绿、真实进程里 `dshState()` 报
`installed: true`、`reads` 在涨、4 条会话都解析出了标题——**状态机里却一条会话都没有**。

原因是读错了文件。`~/.dsh/storages/` 下并排躺着两个东西：

```text
session_projcache.json     ← 8 月 31 日，0.1.x 留下的单文件全量快照
session_projcache/         ← 11 月 4 日，0.2.x 用的目录，一会话一文件
```

读的是前者。它格式合法、字段齐全、**解析不报错**，只是里面的会话全是三个月前的，
全部落在「30 分钟内才活跃」的窗口外，被过滤得干干净净。**最坏的一种失败：不报错，只是什么都不发生。**

新版还有三个只有拆开文件才知道的事实：形状多了 `record` 一层（`{version, record:{identity, rows}}`）、
**会话 id 只在文件名里**（record 内没有）、`dsh headless` 跑出来的会话**只有 `title`**，
连 `lastPromptAt` 都没有（所以要用文件 mtime 兜底）。

教训写在台账硬约束 43 里：**读别人的数据目录，先 `ls -la` 看 mtime**——
并排两个同名物，几乎总有一个是废弃的。

**拖不动、点不了、双击和右键全没反应（整窗永久穿透）**

2026-11-04 用户实测报的第一条。原因是"四角不该挡住桌面"这个好愿望，套了一个在 Tauri 上不成立的做法：
启动时 `set_ignore_cursor_events(true)`，等页面收到 `mousemove` 命中猫再关掉。

Electron 上成立——它在 Windows 上装了低级鼠标钩子，能把 `mousemove` 转发给窗口（`forward: true`）。
**Tauri 没有这个能力**，`tao` 的实现只有一行：

```rust
style_ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED;
```

`WS_EX_TRANSPARENT` 的意思是"我不参与命中测试"，鼠标消息直接交给下层窗口。于是页面**一条 mousemove
都收不到**，"收到就关掉穿透"永远等不到触发条件——自己把自己锁死。

现在的做法是各干各的：渲染层每 200ms 上报"猫在哪"（矩形，分身时每只一个），宿主每 60ms 读真实光标，
落在矩形里就关掉穿透、离开就开回来；拖动中强制不穿透（否则窗口追光标慢半拍的那一拍会吃掉 `pointerup`，
`dragging` 永久卡住）。诊断用 `window.clawd.hitState()`，一次能看清 `ignore` / `inside` / 光标换算后的
`local` 坐标。

这条 bug 值得单独记一笔的地方是：**四道闸门全绿的时候它还在**。CDP 的 `Input.dispatchMouseEvent` 直接
注入渲染进程、绕过操作系统命中测试，所以合成事件照常工作、`elementFromPoint` 照常算得出猫。
合成事件能证明"处理逻辑对"，证明不了"鼠标真的进得来"。

**hook 让每次工具调用都变慢 200ms**

`install.js` 里如果不写 `async: true`，agent 会等 hook 进程退出才继续。
Windows 上 `node` 冷启动实测 ~200ms，hook 自己的代码只占 ~35ms。`timeout` 管不到这块成本——
它管的是"跑太久了砍掉"，不是"要不要等"。分界线：**观察型异步，裁决型阻塞**。

**别用 `spawnSync` 量 hook 耗时**

在循环里连发会稳定得到 ~950ms 这种数字，看着像性能问题。真实开销 240–280ms，
多出来的是父进程阻塞 + 子进程连发的测量假象。要量就用 shell 记时前后夹。

**第一个权限请求必定丢失（气泡空白，点了没反应）**

气泡窗口是懒创建的。页面还没执行完渲染脚本就 `send`，这条 IPC 会被**静默丢弃**——
不报错、不排队、不重试。修法是握手：渲染层注册完监听回一个 `bubble:ready`，宿主收到才投递。
这类 bug 的隐蔽性在于它表现为「慢」而不是「错」，没有断言就会当成网络偶发。

**权限气泡只能用一次，之后按钮全是灰的**

点完立刻置灰是正确的防连点，但下一条 `render()` 必须恢复。少这一行，第二个及以后的请求全都点不动。

**只有一只眼睛跟着鼠标转**

`querySelector` 只返回**第一个**匹配。两只眼的瞳孔必须收进**同一个** `.pupils` 组，且组内坐标用绝对值。
这类 bug 不报错、不警告，看起来"只是有点怪"。回归里有两条永久断言：每帧最多一个 `.pupils` 组、
瞳孔层里两只眼都在。

**没指定主题时，默认主题变成了"名字最小的那个"**

`resolveTheme` 只负责返回"第一个能加载的候选人"。候选人列表里没内置默认时，
它会退化成按 `readdir` 排序取第一个——加一个 `aaa` 主题就把默认形象换掉了。
所以 `pickThemeCandidates()` 末尾必须显式 push `DEFAULT_THEME_ID`。
特征是：**单个组件都对，组合起来不对**，单测 `resolveTheme` 永远发现不了。

**断言不要去改被测对象**

剪贴板那条原来是"先写 `PROBE-OK` 探一下，再读回断言"。探针直接覆盖了上一步刚写进去的路径，
断言读到的永远是 `PROBE-OK`。正确顺序是：先读真值 → 不相等才做能力探测（并且把原值写回去）。
**测试代码和业务代码一样会骗人。**

**连上 CDP 后 `Runtime.evaluate` 永远不回显**

必须先发一次 `Runtime.enable`。不发也能连、也能 send，但消息发出去没有任何响应，`await` 就一直挂着——
表现是"脚本卡住"或"所有断言都超时"。另外 `Runtime.evaluate` 跑在全局作用域，
要 `includeCommandLineAPI: true` 才有 `require`。

**回归偶发失败：gaze 那一条**

gaze 线程有变化检测（位移 < 0.02 不 emit），光标静止时 0 条是**正确行为**，
而断言写的是"这一轮至少推过一次"——成败取决于测试期间有没有人碰鼠标。
修法：先用 PowerShell 把光标挪 3px 再挪回，等 400ms 重读。

**改了 `themes/` 但预览页没变**

见[主题](#主题)：预览页吃的是 `npm run build:preview` 打出来的数据包，桌面那只直接读文件。

**跑回归时提示"渲染进程 15s 内没起来"**

八成不是代码坏了，是**你自己开着桌宠**：单实例锁 + 固定端口会让测试进程直接退出。
现在的脚本会给自己开临时端点文件和临时窗口，理论上不该再撞；真撞了先看 `verify-tauri.js`
打印的进程输出，别急着改代码。

> Electron 时代的坑（`ELECTRON_RUN_AS_NODE`、GPU 缓存目录被占用、临时 `--user-data-dir`）
> 已经随容器一起删了。要考古见 `docs/ledger/DEVLOG.md`。

## 对照阅读

- `docs/ledger/PROGRESS.md` —— 每个阶段做了什么、实测数据、**哪些没验**
- `docs/ledger/SECURITY.md` —— 四道锁、SVG 白名单、SEC-09 分层、依赖审计的原始记录
- `docs/ledger/DEVLOG.md` —— 决策现场：为什么删 Electron、为什么删"写信"、问题 1 的根因
- `src-tauri/src/state.rs` —— 只看 `resolve_dominant_session_state` 与 `update_visual_state` 附近
- `src-tauri/src/permission.rs` —— 重点看 `settle()` 为什么必须是唯一出口
- `src-tauri/src/risk.rs` —— 文件头的两条硬规则，改之前先读
- `src/renderer.js` —— 白名单那段（`ALLOWED_TAGS` + `clampStdDeviation`）是渲染层的安全核心
- `hooks/install.js` —— 观察型（async）与裁决型（阻塞）的差别怎么落进 JSON，以及三家的差异表
- `themes/README.md` —— 想自己做主题时看这个（三条硬契约 + 资产规则）
