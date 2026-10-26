# clawd-starter

从零重搭 Clawd 桌宠的 **S1 + S2** 骨架：一个能自己出现在桌面上、能被数据驱动的透明窗口。

目标不是"做一个好看的桌宠"，而是**把核心数据链路跑通**——之后每一阶段都是往这条链路上加东西，而不是推倒重来。

## 跑起来

```bash
npm install
npm start
```

窗口会出现在屏幕右下角。如果看不见，看控制台输出的端口，先用 curl 打一发：

```bash
curl -X POST http://127.0.0.1:<port>/state \
  -H 'content-type: application/json' \
  -d '{"session_id":"s1","event":"PreToolUse"}'
```

## 三个调试命令

```bash
node scripts/fake-feed.js                     # 完整剧本： thinking → working → error → attention → idle
node scripts/fake-feed.js Stop                # 单个事件
node scripts/fake-feed.js --hold working 10   # 保持某个状态 10 秒
```

## 它现在具备什么

- 透明 / 无边框 / 置顶 / 不进任务栏的窗口，可拖动
- 非像素区域**点击穿透**，鼠标不会穿过宠物本体
- `POST /state` 接收器，随机端口 + 端口文件发现
- 单会话状态机：事件 → 状态 → 优先级仲裁 → oneshot 播完自动退回 → 闲置发呆 / 睡着
- 状态 → 帧序列的映射表（`src/visuals.js`），每个状态可含多帧，按 fps 轮播
- **眼球追踪**：主进程读全局光标 → 归一化成 gaze → 渲染层插值移动瞳孔
- **双图层交叉淡入**：新状态先在隐藏层画好再淡入，切换瞬间不会闪白
- 调试入口：DevTools 里 `petDebug.setState('working')` / `petDebug.gaze({x:1,y:-1})`

## 故意的简化（去原项目对照时会遇到的差异）

| 这里 | 原项目 | 为什么先简化 |
|---|---|---|
| `visuals.js` 里写死 SVG | `themes/<name>/theme.json` + 资产目录 | 主题系统是 S7，先把"状态→画面"跑通 |
| 只认 Claude 的事件名 | 30+ agent 各自的适配器 | 适配器是纯体力活，等内核稳了再铺 |
| `Map` 内存里存会话 | 加上持久化、恢复租约、历史记录 | 掉电恢复是产品需求，不是学习需求 |
| 端口文件写项目根目录 | userData + 多实例锁 | 开发期好找就够 |
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

## 建议的下一步（S4：接真 hook）

按这个顺序，不要跳：

1. **先解析 stdin，再想安装**。Claude Code 调用 hook 时会把 JSON 从 stdin 灌进来，
   里面有 `session_id` / `hook_event_name` / `tool_name`。写一个 `hooks/clawd-hook.js`：
   读 stdin（带 2s 超时，超时就当空对象继续）→ 映射事件名 → POST → 立刻退出。
2. **再写最小安装脚本**：往 `~/.claude/settings.json` 的 `hooks` 段追加 entry。
   注意是"追加并保留别人的配置"，不是覆盖 —— 原项目为此专门做了 marker 增量合并。
3. **最后处理"桌宠没开"**：端口文件不存在就 `process.exit(0)`，安静得像没装过。

到这一步你会撞上本项目最真实的工程问题：hook 是短命进程，它不能等，也不能报错。

## 对照阅读

- `docs/guides/state-mapping.md` —— 事件到状态的权威表
- `src/state-priority.js` —— 40 行，整个优先级哲学
- `src/state.js` —— 只看 `resolveDominantSessionState` 和 `updateVisualState` 附近
- `hooks/clawd-hook.js` —— 看它如何"读了就 POST，然后立刻退出"
