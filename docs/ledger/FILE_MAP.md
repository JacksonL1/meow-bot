# 文件地图 — clawd-starter

> 11 个源文件全部通读过，职责为实际行为，不是从文件名推测。
> 配了巡检脚本 `node docs/ledger/scripts/check-filemap.js`，可发现「代码里有、台账没记」的文件；它只报告，不改本文件。

## 目录结构

```text
clawd-starter/
├── src/                 Electron 主进程 + 预加载 + 渲染层（全部核心代码）
├── hooks/               Claude Code hook 适配器 + 安装脚本（S4）
├── scripts/             调试工具
├── docs/ledger/         开发台账（本项目文档）
├── preview.html         静态预览页，浏览器直接打开
├── README.md            项目说明与踩坑
├── package.json         依赖（只有 electron）
└── （无运行时文件落盘）
```

> 端点文件已从项目根目录迁到 userData：`%APPDATA%\clawd-starter\clawd-starter.port`（JSON：`{port, token}`）。见 SECURITY.md SEC-02 / SEC-10。

## 源文件职责

| 文件 | 阶段 | 职责 | 备注 |
|---|---|---|---|
| `src/main.js` | S1 | Electron 主进程：单实例锁、建透明置顶窗口、绑定拖拽与点击穿透 IPC、100ms 采样全局光标算 gaze、锁屏/休眠隐藏窗口、退出时清理 | 175 行。三个窗口参数 + `powerMonitor` 是关键 |
| `src/server.js` | S2 | 本地 HTTP 服务：四道锁（Host / Origin / Token / Content-Type）→ `GET /health`、`GET /state`、`POST /state`，请求体 256KB 上限，随机端口 + token 写端点文件 | 144 行。只绑 127.0.0.1 |
| `src/port-file.js` | S2 | 端点文件唯一真相：按平台算 userData 路径、写 `{port, token}`（0600）、读回并校验格式 | 59 行。`fake-feed.js` 与主进程共用，避免两边路径漂移 |
| `src/state.js` | S2 | 状态机心脏：`EVENT_STATE` 事件映射、`PRIORITY` 优先级仲裁、oneshot 定时回落、25s 发呆 / 60s 入睡、250ms 统一 tick；入参清洗（session_id 64 字符、会话上限 100、cwd 只留 basename） | 196 行。原项目 4098 行里抽出的骨架 |
| `src/renderer.js` | S3 | 渲染层：SVG 白名单清洗（`DOMParser`，剥 `on*`/外部 href/`javascript:`）、状态切换重建 DOM、双图层交叉淡入、按 fps 切帧、瞳孔位移插值、命中判定切穿透 | 219 行。`window.petDebug` 调试入口（含 `svg()` 试清洗） |
| `src/visuals.js` | S3 | 视觉数据：7 个状态的 SVG 帧序列（共 17 帧）、fps、眼球可动标记 | 193 行。纯数据，S7 会搬进 theme.json |
| `src/preload.js` | S1 | 上下文桥：向渲染层暴露 7 个动作（onState/onGaze/dragStart/dragEnd/setIgnoreMouse/quit …） | 13 行。安全边界，不要加 `ipcRenderer` |
| `src/index.html` | S1 | 窗口页面：CSP meta、透明背景样式、双图层容器、加载 visuals.js 与 renderer.js | 88 行。CSP 为 `default-src 'none'` + 白名单 |
| `scripts/fake-feed.js` | S2 | 假数据源：从端点文件读 port+token 后 POST 事件，支持完整剧本 / 单事件 / `--hold` 保持状态 | S4 之后只用于离线调试，真事件由 hook 送 |
| `hooks/clawd-hook.js` | S4 | Claude Code hook 适配器：读端点文件 → 读 stdin（2s 硬超时 / 1MB 上限）→ 只取 `session_id/event/cwd/tool_name` → POST（1.5s 超时）→ 永远 `exit(0)` | 111 行。三条铁律：不阻塞、不打日志、不抛异常。桌宠没开就走 `readPortFile` 的 catch 直接返回 |
| `hooks/install.js` | S4 | 往 `~/.claude/settings.json` 的 `hooks` 段增量合并 8 个事件：只动命令含 `clawd-hook.js` 的条目，备份 + 临时文件 rename 原子写，支持 `--uninstall` / `--dry-run` / `--file` | 170 行。每组写 `async: true, timeout: 5`——观察型 hook 不能拖住 agent |

## 其他文件

| 文件 | 职责 | 备注 |
|---|---|---|
| `preview.html` | 静态预览页，浏览器打开可一次看完所有状态的 SVG 与帧序列 | 不参与运行，纯设计对照用 |
| `README.md` | 项目说明、已验证能力清单、故意的简化对照表、3 条踩坑记录 | 踩坑部分是同类项目最有价值的参考 |
| `package.json` | 只有 `electron ^41.10.4` 一个依赖，`npm start` → `electron .` | `^` 导致版本漂移，且当前版本有 high 公告，见 SEC-08 |
| `package-lock.json` | 依赖锁定，实际安装 41.10.7 | 与 package.json 的 `^` 有冲突 |
| 端点文件 | 运行时产物，**不在项目内**：`%APPDATA%\clawd-starter\clawd-starter.port` | 内容 `{port, token}`，权限 0600；删除后重启即重新生成 |
| `.gitignore` | 忽略 node_modules / .clawd-port / dist / .idea / `NVIDIA Corporation/` | 最后一项是显卡驱动按 CWD 写的着色器日志，启动 Electron 时会出现 |
| `docs/ledger/*` | 开发台账：PROJECT / PROGRESS / SECURITY / FILE_MAP / DEVLOG | 本目录 |

## 数据流

```text
Claude Code 事件
        │  spawn: node hooks/clawd-hook.js <Event>   （async，不等它退出）
        ▼
  clawd-hook.js：读端点文件 → 读 stdin → 只挑 4 个字段
        │  POST http://127.0.0.1:<port>/state  {session_id, event, cwd, tool_name}
        ▼
   server.js ──► state.js（事件→状态→优先级仲裁→oneshot 回落）
                        │ onChange（visual 变了才发）
                        ▼
                  main.js broadcast
                        │ IPC "state"
                        ▼
                  renderer.js setState ──► visuals.js 取帧序列 ──► SVG 上屏

  主进程 100ms 采样光标 ──IPC "gaze"──► renderer.js 插值 ──► 瞳孔 transform
```

> 桌宠没开时：`readPortFile()` 抛错 → hook 在 catch 里直接返回 → `exit(0)`，无输出、无重试。
> 端点文件残留但进程已死（崩溃场景）：POST 得到 `ECONNREFUSED` → `.catch(() => null)` → `exit(0)`。实测 241ms。
