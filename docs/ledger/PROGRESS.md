# 进度 — clawd-starter

> 阶段划分见 PROJECT.md。每完成一格，同步更新下面的「安全状态」表——**安全和功能一起算完成，不算两件事**。

## 当前目标

S1–S7 全部完成。回归 **102 PASS / 0 FAIL**（声明 103 条，剪贴板那条在本环境读不到时会走 `[warn]` 降级——既不计 PASS 也不计 FAIL，属既有设计，不是失败；换台机器会是 103）。布偶猫主题按用户反馈改了三轮，第三版是一版外部重写（60fps 弹簧物理渲染器）；那 11 条「断言假设过时」的红项已按 `rigMode` 改写。**working 最终定为「桌前敲键盘」**——上一轮做的钓鱼彩蛋被用户否掉，连部件带引擎一起删干净了（见下方「把摸鱼拆掉」）。**内核到此为止**，接下来是产品化方向，不是学习骨架了：

- 真实 agent 会话验证（本机无 `claude` CLI，WorkBuddy / CodeBuddy 也没实测过 hook 是否真触发）——这是**唯一还没补的最大缺口**
- 主题再做就超出"骨架"范围了：需要图片解码器（GIF/APNG）、缩略图、在线目录，那是产品
- ~~若继续做内核，自然的下一步是「状态时长写进 theme.json」~~ → **已完成**（2026-10-28，见下方）。内核剩下的只有「一个主题里放多套表情变体」这一格了

## 进行中

（无）

## 待办

### 已验证但未覆盖真实环境的部分

- [ ] **真实 agent 会话一次都没跑过**——本机无 `claude` CLI，也无 WorkBuddy/CodeBuddy 的 hook 实测。这是贯穿 S4–S7 的最大缺口
- [ ] WorkBuddy 是否真的支持 hooks（官方文档无 hooks 章节，`hooks/install.js --agent workbuddy` 生成的是按 CodeBuddy 契约推的）
- [ ] WorkBuddy 安装待用户在自己终端执行：`npm run install:hooks:workbuddy`（沙箱写不了 `~/.workbuddy/settings.json`）

### 已知的能力让渡（不是 bug，是选择）

- [ ] 主题只支持 SVG。GIF / APNG / WebP 要写解码器，没做
- [ ] 主题不能用 `<style>` 做 CSS 动画（只能用帧序列）。换来的是「主题文件里没有可执行的样式入口」
- [ ] 没有在线主题目录，主题只能手工放进 `themes/`。换来的是供应链攻击面为零
- [x] ~~状态时长（25s 发呆 / 60s 入睡）仍写死在 `state.js`~~ → **已进 `theme.json.timings`**（2026-10-28）。注意原来写的「25s 发呆」是个误会：那个 `IDLE_AFTER_MS` **从头没有消费者**，连配置项都算不上，已删（见 DEVLOG）。搬过去的是 `oneshot` 三个时长 + `sleepAfterMs`

## 已完成

### 状态时长进 theme.json（2026-10-28）

台账里挂了很久的一条：「状态时长（25s 发呆 / 60s 入睡）仍写死在 `state.js`，没进 `theme.json`」。
动手才发现**这条待办本身写错了**：那个 25 秒的 `IDLE_AFTER_MS` **从头到尾没有消费者**，
它旁边那行注释甚至自己写着"目前没有被任何逻辑使用"。它连配置项都算不上，只是一段被注释掉的设想。

所以真正搬的是另外两组：`ONESHOT`（error 2600 / notification 3200 / attention 2400）和 `SLEEP_AFTER_MS`（60 秒）。

- **注入而不是传值**：`main.js` 里 store 在 302 行建、主题在 331 行才解析，构造时拿不到主题。
  所以 `createStore({ getTimings })` 收一个 getter，每次判断时长都重新问一次——换主题后新时长立刻生效，不用重建 store。
- **默认值的真相只有一份**：主题没写 `timings`，`theme.js` 如实返回 `null`，由 `state.js` 用内置默认。
  加载器不存第二份默认——两边各写一套，分叉是静默的（`timings=null` 这条本身也有断言）。
- **主题改不了状态机的形状**：`oneshotMs(state)` 只在 `ONESHOT[state]` 本来就有定义时才允许主题覆盖。
  否则一个主题给 `working` 配个时长，就能让"工作中"播 2 秒消失——那是行为，不是外观。
- **写错了要说出来**：在 `oneshot` 里塞 `working` / `sweeping`，加载警告会报「永不会生效」；
  超界钳制并说明；`timings` 不是对象则**整个主题加载失败**，不悄悄按默认跑。
- **断言带对照组**（9 条新断言）：只证明"写了 60ms 就退回"是**不够的**——它可能本来就短。
  所以每条都配一个"不写会怎样"：没写时 220ms 仍在 attention（默认 2400）、仍是 working（默认 60 秒）。
- `IDLE_AFTER_MS` 删了，但它那个没解决的问题留在了 `state.js` 的注释里：
  **长工具调用（跑 40 秒的构建）期间没有任何事件，会被误判成闲置**。真要做，先回答这个再回来加消费者。

回归 **102 → 112**（新增 9 条；剪贴板那条这次也读到了，所以是 103+9）。

### 骨骼弹簧重写：把它救回来（2026-10-28）

用户拿了一版外部重写的布偶猫（「60fps 骨骼弹簧物理版」）进来说加载失败。
这一版不是改主题数据，是**换掉整个渲染架构**：`src/renderer.js` 里用 JS 直接拼一只猫
（242 行 SVG 模板 + 576 行姿势表 + 二阶弹簧阻尼通道），主题系统对这个主题等于架空。

它确实好看——状态姿势差异大、切换是弹簧过冲而不是硬切。所以**救，不回退**。
但救的时候把被一起拆掉的东西补了回来：

- [x] **加载链条**：`schemaVersion: 2` → `1`（它用到的全是 v1 字段，「2」是自封的）；
      跑 `generate-ragdoll-assets.js` 生成缺失的 18 帧（脚本写了但没执行过）
- [x] **CSP 补回** `index.html`。它是最后一道闸，不该因为「新版看起来不需要」就删
- [x] **白名单补回**：非骨骼路径从 `innerHTML = frames.join("")` 改成逐帧 `svgNode()`
      （`DOMParser` + `ALLOWED_TAGS` + `url()` 出口管控），坏帧单张丢弃不连累状态
- [x] **`petDebug` 补回**（`setState` / `svg` / `gaze`+pin / `springs` / `theme` / `builds` / `stateLog`）。
      它不是便利工具，是**唯一能让回归看到内部状态的窗口**
- [x] **`window.VISUAL_STATES` 补回**，收成单一 `adoptTheme()` 入口
- [x] **`eyeTracking` 真的生效**（rig 分支原来无条件跟眼）；working 改回 `false`
- [x] **疲惫眼**：`eyelidTop` 1.8 → 11
- [x] **`rigType` 透传** + 未知状态名告警（`walking` 就是这么发现是死配置的）

**救回来之后又改的（第三轮：把摸鱼拆掉，改回敲键盘）**：

- [x] **working 从水边垂钓改回桌前敲键盘**：删掉水面 / 弯竿 / 鱼线 / 浮标，换成键盘（两排键 + 呼吸灯）
      + 深色编辑器窗口（红黄绿三点 + 三条代码行，宽度按时间生长、末尾淡出换下一行）
- [x] **彩蛋删干净**，不是停用：`GAG_DEFS` / `GAG_EASES` / `GAG_ORIGIN` / `sampleGagTrack` /
      `sampleGagInner` / `scheduleGag` / `playGag` / `renderGag` / `gagLook` / `#rig-fish` / `#rig-slipper` /
      `petDebug.gagNames|gag|gagState` / `docs/ragdoll-gags.png`，一处不留。
      **停用版等于留一条没人走的死路径**，那正是这个项目踩过四次的东西
- [x] **连校验层和文档一起删**：`theme.js` 里 `normalizeMotion` / `normalizeGags`（约 150 行）、
      `themes/README.md` 里两整节 schema 说明。消费者没了还留着校验器，主题作者写对了也什么都不发生
- [x] **回归里那条「motion 声明的部件在 SVG 里都存在」删掉**：`def.motion` 永远是 `undefined`，
      循环一次都不进 → **永远为真**。永远为真的断言比没有更糟，它在报告里长得像一道防线
- [x] **`innerHTML` 归零 + 落地成机械断言**：`renderer.js` 里 `rootLayer.innerHTML = createRigged…()`
      这条一直违反硬约束 19、却因为没人查而活了整轮。模板改走 `svgNode()`（白名单只挡 `on*` / 外部 `url`，
      放行 `style` 属性，rig 的 `transform-origin` 不受影响），并加了一条扫 `src/*.js|*.html` 的断言
- [x] **疲惫眼的尺度跟着改**：`eyelidTop` 11 → 7。11 是"打盹"（眼球基本被盖掉，读成睡着了还在敲键盘）；
      赶工得让蓝眼睛看得见
- [x] 回归 105 → **103**（删 7 条彩蛋 + 1 条假 motion，加 6 条：桌面部件存在 / 亮出 / 收起 /
      前爪交替敲 / 代码行在长 / `innerHTML` 为零）

**已经不在的东西**：`motion` 引擎与 `gags` 配置能力（两者都随各自的重写/删除失去了消费者）。
要恢复「主题作者也能写动画 / 彩蛋」，得先有渲染层的消费者，再谈 schema——
顺序反了就会得到「校验通过、加载成功、什么都不发生」。

**这个代价值得记下来**：重写拿走了三样东西，全都**不报错、不崩、看着也正常**——
CSP、白名单、`VISUAL_STATES`。功能代码写得越好，这些「没用的闸」越容易被当成冗余删掉。
这一轮修完还发现第四个：`petDebug.springs()` 读的是 `ragdollRig.springs`，而通道表实际叫 `sp`，
于是它**永远返回空对象**——外部窗口写了不等于接上了。

### 活猫感第二轮：疲惫 / 毛边 / 彩蛋（2026-10-27）

第一轮把"卡顿"从架构上解决了（`motion` + rAF 插值），但用户看到的还是"基本都是在 idle 基础上加一个东西"。
这一轮不再是换架构，是**把每个状态画成它自己该有的样子**，并补上第一轮没做的一层：一次性的小动作。

- [x] **sleeping**：身体从 `ellipse` 换成锯齿轮廓（`fuzzy(cx,cy,rx,ry,spikes,amp)`）+ 4 撮毛簇；前爪挪到头部之后画，只露出压在下巴底下的爪尖
- [x] **thinking**：头 `cy` 90 → 97，身体 `cy` 148 `ry` 30，两者重叠 14px，脖子缝消失
- [x] **working**：疲惫半睁眼（眼睑是一块从眼角压下来的实心弧，颜色取**面具色**）+ 眼下动纹；`eyeTracking: false`
- [x] **working 的彩蛋**：鱼与拖鞋各一条 `gags`，`display="none"` 藏在图里，靠渲染层随机排期放出来
- [x] 渲染层两个新引擎分层：`motion`（循环，状态级）与 `gags`（一次性，事件级）；写 `transform` 的那一段（`writeTransform`）**两边共用**，只差 `k` 怎么算
- [x] 回归从 92 → 103 项，新增的 9 项全是这一轮真踩过的坑（见上表）

**为什么彩蛋要单开一层而不是塞进 `motion`**：`motion` 是 `period` + `phase` 的无限循环，
它的语义是"一直这样动"。"隔一阵来一次，来的那一次分三段演"（浮上来 / 停住盯着 / 吃掉）
在循环语义里根本表达不出来——硬塞只能靠 `period` 演成"每 10 秒准时钓上来一条"，那是最不像活物的节奏。
所以：**循环的归 `motion`，一次性的归 `gags`**，两层都在同一个 rAF 上跑。

**为什么彩蛋不用 CSS 动画**：跟第一轮同一个理由（白名单拒 `<style>`/SMIL），但这里多一层好处——
彩蛋的"放出来、演完收回去"必须能被断言。CSS 动画只能靠 `animationend` 猜，而 `gags` 的每一次
`display` 变化都在我们的代码里，回归才能问出"鱼到底被放出来了吗、演完收回去了吗"。

### S7 主题系统（2026-10-27）

S3 之后形象是写死的 19 帧 SVG。S7 把它拆成 `themes/<id>/theme.json` + `assets/*.svg`，**`src/visuals.js` 整个删掉**——不是"改成从文件读"，是"不再有那个文件"。

**动手顺序刻意反过来**：先写白名单定案（`SECURITY.md`「S7 白名单定案」），再写加载器。反过来的话，等第一个主题加载不出来时才去放宽白名单，那时候放宽的动机已经变成"让这个主题能跑起来"。

- [x] `src/theme.js`（325 行）：扫目录、校验 schema、读资产、缺状态补齐、全坏给兜底
- [x] `themes/ragdoll/`：默认主题，19 帧从原 `visuals.js` 用脚本拆出来，不是手抄
- [x] `themes/crab/`：原版螃蟹，从 `git show 85c094a:src/visuals.js` 取。**第二个主题的意义是证明"能换形象"，不是"能换配置"**
- [x] `themes/_template/`：脚手架。下划线开头 → `ID_RE` 不匹配 → 不会出现在主题列表里，零特殊分支
- [x] `themes/README.md`：三条硬契约（viewBox / 唯一 pupils 组 / 白名单标签）+ 资产规则
- [x] 渲染层 `applyTheme()`：换主题 = 换一份帧数据 + 强制重画当前状态，不重开窗口
- [x] 主题是**拉**回来的（`getTheme` invoke），不是推的——S5 的第一个气泡就是"推早了被静默丢弃"
- [x] 看板底部加主题下拉框，切换立即生效；加载失败的主题也会列出来（禁用 + 说明），因为作者改完 `theme.json` 第一件事就是来看这里
- [x] 偏好写 `%APPDATA%\clawd-starter\clawd-starter.theme`，重启还是上次那个；`--theme=` 与 `CLAWD_THEME` 可临时覆盖
- [x] 内置兜底画面（灰色「?」）：主题全坏时窗口不会变成一片空白。桌宠没有任务栏入口，空白等于"一个看得见进程、找不到退出按钮"
- [x] `preview.html` 加主题选择器；`scripts/build-preview-bundle.js` 从 themes/ 打包（file:// 下 fetch 读不到本地文件）
- [x] `scripts/migrate-visuals-to-theme.js`：一次性迁移脚本，保留是为了说明 themes/ 怎么来的

**白名单的定案**（完整理由见 SECURITY.md）：

| 处置 | 内容 |
|---|---|
| 放行 | `clipPath` `mask` `filter` |
| 逐个放行 | `feGaussianBlur` `feOffset` `feDropShadow` `feColorMatrix` `feBlend` `feComposite` `feFlood` `feMerge` `feMergeNode`（**不用 `fe*` 通配**） |
| 拒 | `feImage`（唯一用途是从 href 拉外部图）、`feTurbulence` / `feDisplacementMap`（CPU 炸弹）、`style` 标签、`foreignObject`、`animate` / `set`（运行时改 href） |

加了这三个标签之后，`url()` 目标校验从"锦上添花"变成**唯一的出口管控**——`filter` / `clip-path` / `mask` 的值天生就是 `url()`。另外补了一条 `stdDeviation ≤ 40`，因为 Chrome 对超大模糊半径是同步算的。

### S6 多会话看板（2026-10-27）

S2 起状态机里就有一个 `Map` 在做多会话仲裁，但**用户看不见它**——只能看到桌宠演"最吵的那一条"。S6 把这块内存摊开成一张表：谁在跑、跑到什么状态、闲了多久、目录叫什么。

- [x] `src/dashboard.html` + `dashboard-renderer.js` + `dashboard-preload.js`：独立窗口，222/156/18 行
- [x] **双击桌宠开/关看板**（`renderer.js`）。做成 toggle 不是"只开"：桌宠没有任务栏入口，`frame: true` 的看板一旦被关掉，用户就再也找不回来
- [x] 双击判定**只认落在 `#pet` 上的双击**——单击必须留给拖拽，否则拖一下就弹窗
- [x] 窗口参数与桌宠/气泡**刻意相反**：420×460、有边框、不透明（`#faf9f5`）、`alwaysOnTop: false`。那两个是"突然出现在你屏幕上"，这个是你主动要看
- [x] 定位贴着桌宠放；上方放不下就翻到下方（`y < area.y ? py + WIN_H + 12`），并且 clamp 进工作区
- [x] 1s 轮询快照。**不用推送**：`idleMs` 本来就随时间变，没人发事件也得刷新；轮询一个本地 IPC 比维护一套"何时该推"简单得多
- [x] 排序按「最吵的排前面」：error → notification → working → thinking → attention → idle → sleeping，同级按闲置时间升序
- [x] 行节点复用（`rows` Map）+ `insertBefore` 调序，避免每秒重建导致闪烁和按钮失焦
- [x] 当前正在演的那一条用左侧色条标出（`.dominant`）
- [x] 演示模式：只隐藏目录名，状态与时间照旧。它掩盖的是**显示**不是数据，真要彻底隐藏得在宿主侧不采集
- [x] 锁屏/休眠 `hideAll()` 把看板一起 hide——看板比桌宠泄露得多（整张项目列表）
- [x] CSP 与主窗口同款 `default-src 'none'`；所有外部字符串一律 `textContent`

**SEC-09 在 S6 才真正兑现**。S2 当时的做法是「cwd 只留 basename」——那其实是**砍功能**换安全，因为看板要做「复制路径」「跳转终端」就必须有完整路径。S6 把它拆成两层：

| 层 | 存什么 | 谁看得见 |
|---|---|---|
| 2026-10-28 | 修复 | **主题加载失败**：一版外部重写把 `schemaVersion` 写成 `2`，而加载器只认 `1`——它引用的 **18 个帧文件也一个都没生成**（生成脚本写了但从没跑过）。链条上两处断点，报错只暴露第一处 |
| 2026-10-28 | 安全 | 重写把 **CSP 整块删了**，并把非骨骼路径改成 `nextEl.innerHTML = frames.join("")`——**一行绕过整个 SVG 白名单**。白名单还在文件里、注释还在，但已不在任何一条路径上。两条都补回 |
| 2026-10-28 | 修复 | `window.VISUAL_STATES` 被删 → 回归里十几条断言**集体静默失效**（读 `undefined` 不报错，只是查不到）。补回为「给外面看进来的窗口」，收成单一 `adoptTheme()` 入口 |
| 2026-10-28 | 修复 | `eyeTracking` **第二次**变成死字段：rig 分支无条件 `setGaze()`，主题写 `false` 照样跟眼。上一轮修过一模一样的 bug，重写又带回来——「新写的分支不读老字段」是重写最常见的漏 |
| 2026-10-28 | 功能 | working 补回疲惫感：`eyelidTop` 1.8 → 11（1.8 在 28px 高的眼睛上只压 4.5px，肉眼看不见）。眼睑仍必须取面具色 `#967866`，取身体色会在脸上糊白块 |
| 2026-10-28 | 修复 | 主题写了 `walking` 但状态机只有 7 个状态 → **那 4 帧永远播不到**，加载却一切正常。加载器现在把不认识的状态名收进 `warnings`：静默丢弃的东西，作者永远不会发现 |
| 2026-10-28 | 修复 | `rigType` 不再靠 id/name 嗅探：加载器透传、渲染层优先读。原来 `id === "ragdoll"` 兜底意味着**任何叫 ragdoll 的主题都会掉进「画死在 JS 里的那只猫」** |
| 2026-10-28 | 工具 | 回归 54 → 92（补回 `petDebug` 与 `VISUAL_STATES` 救回 38 条）。剩余 11 项是断言假设过时，见「待办」 |
| 2026-10-27 | 功能 | **布偶猫第二轮反馈**：sleeping 身体从椭圆改成锯齿毛边轮廓 + 4 撮毛簇（原话"太圆滑，加点毛"）；thinking 头下移 7px 与身体重叠，消掉脖子缝（原话"头和身体分离了"）；working 换**疲惫半睁眼**（眼睑必须取面具色 `#967866`，取身体色会在脸上糊白块） |
| 2026-10-27 | 功能 | **彩蛋引擎 `gags`**：`motion` 是循环的，写不出"隔一阵钓上来一条鱼"，所以单开一层 `{name, parts, every, duration, steps[]}`——渲染层随机排期、`display` 收放部件、按 `at/span` 一次性插值。working 配两条：**鱼**（浮上来 → 盯着看 0.9s → 加速收进嘴边并缩小）、**拖鞋**（浮上来 → 翻个个儿 → 甩出画面 → 嫌弃地撇开眼）。`pupils` 也参与，猫是真的在看自己钓上来的东西 |
| 2026-10-27 | 修复 | `eyeTracking` 是**写了不生效的死字段**：`theme.js` 校验它、状态对象里带着它，渲染层却从没读过——主题写 `false` 照样跟眼。改成 `applyGaze()` 先看 `currentDef.eyeTracking`；并给 working 的瞳孔补回单个 `.pupils` 组，让这个 `false` **有对象可管、有断言可测**（否则"不跟眼"只是"图里恰好没有瞳孔层"） |
| 2026-10-27 | 修复 | 彩蛋第一段永远"没动"：**还没到点的后续步骤被钳在 `from` 上照写一遍**，覆盖掉正在演的那段（实测鱼在水下时读到 `translate(0.00 0.00)`）。改成"没到点的步骤直接跳过"，语义变成"当前有效的那段说了算"——也正是时间线的直觉 |
| 2026-10-27 | 修复 | 彩蛋收尾把猫的眼睛一起藏了：鱼/拖鞋是天生 `display="none"`，瞳孔是**本来露着**的，一律隐藏就抹掉双眼。改成开演前记录 `{display, transform}` 原值，收尾按原值恢复 |
| 2026-10-27 | 修复 | 睡觉的两只前爪读成"一副眼镜"：两个一样大的完整白椭圆摆在脸正下方。挪到头部**之后**画（被脑袋盖住上半截）、下移、缩小，才是"压在身下的爪尖" |
| 2026-10-27 | 安全 | `gags` 是 `motion` 那类输入的**第二个入口**，且同一彩蛋里有两处选择器片段（`parts[]` 与 `steps[].part`），都走 `PART_RE`；`ease` 走 `EASES` 白名单（未知缓动 = `NaN` 插值 = 部件消失）；`span` 夹到 `duration - at` 以内。结论写进 SECURITY.md，硬约束加第 16–18 条 |
| 2026-10-27 | 工具 | 回归 92 → **103 项**：彩蛋"声明得到 / 部件都画了 / 放得出来 / 真的在动 / 演完收回去 / 瞳孔没被一起藏掉"，以及 `working` 不跟眼 + `idle` 跟眼（对照组） |
| 2026-10-27 | 工具 | `preview:states` 改按**内容高度**取景：原来只截 640 的视口，七状态对照图第二行永远被切一半。顺带让标注写出"跟眼/不跟眼"和"几条彩蛋"——彩蛋 7~28 秒才来一次，静图上永远看不到，不标容易被当成没做 |
| 存储层（`state.js` 的 `sessions` Map） | 完整 cwd，清洗控制字符、限长 1024 | 只在主进程内存里 |
| 快照层（`snapshot()` → IPC → 渲染进程 → 屏幕） | 只有 `publicCwd()` 出来的最后一段目录名，限长 200 | 看板 DOM、投屏、截图 |

完整路径唯一的出口是 `dashboard:copy-path`：用户显式点某一行的「复制路径」，主进程**单条**释放给剪贴板。preload **故意没有**「取完整 cwd」的接口——回归里专门用伪造 id `'../../etc/passwd'` 验证拿不到。

### 接入层国内化：一个安装器，三种 agent（2026-10-27）

原来 `hooks/install.js` 写死 Claude Code。三家 hook **格式**兼容（都是 `{matcher, hooks:[{type, command|url}]}`），
但契约有三处实质差异，照抄会装出"装好了却不触发"或"重复触发"的结果：

| 差异 | Claude Code | CodeBuddy | WorkBuddy |
|---|---|---|---|
| 事件名 | 有 `PostToolUseFailure` | 无，但有 `PreCompact` | 同 CodeBuddy |
| `matcher` | `"*"` | `""`（主仓库一致） | `""` |
| `async` 字段 | 支持，观察型必加 | 官方安装器从不写 | 官方安装器从不写 |
| PermissionRequest | ✓ 真会 POST | ✓ 真会 POST | **✗ 原生沙箱 + GUI 自己处理，永不调用外部端点** |

最后一条是硬事实，来自主仓库源码注释（`workbuddy-install.js:180`）——它甚至专门写代码去清理
早期版本给 WorkBuddy 装下的死 URL。所以 `AGENTS.workbuddy.permission = "none"`，**给 WorkBuddy 装权限 hook 是纯垃圾配置**。

- [x] `AGENTS` 表驱动：`--agent claude|codebuddy|workbuddy`，默认 claude（保持旧行为不变）
- [x] 观察型 hook 按 agent 决定要不要写 `async`；权限 hook 按 agent 决定装不装
- [x] 卸载时即使 `permission: "none"` 也会清理自己留下的残条
- [x] 新增 npm 脚本 `install:hooks:workbuddy` / `:codebuddy` 及对应卸载
- [x] 验证「不破坏别人配置」：拿主仓库留下的备份当输入跑 dry-run，
      主仓库 8 条 command hook **全部保留**，只追加我们自己的 9 条

**共存的两条代价（必须记住）**：CodeBuddy 上两套 hook 并存时，
① 每个事件会跑两次 node（它不支持 async，无法像 Claude 那样甩掉冷启动）；
② `PermissionRequest` 会有两条 http hook 指向同一个 23333 → **一次请求弹两个气泡**。
所以真要长期用 starter 接 CodeBuddy，应当把主仓库那套卸掉，而不是叠着。

### 形象改造：螃蟹 → 布偶猫（2026-10-27）

只换了 `src/visuals.js` 一个文件，`renderer.js` / `state.js` / `main.js` 一行没动——这正是 S3 把"状态机"和"画什么"分开的回报。

- [x] `ragdoll()` 完全对齐原 `crab()` 的接口：`{ eyes, overlay, fur/point, tail, dx, dy, puff, blush }`，`viewBox` 仍是 `0 0 200 200`
- [x] 品种三要素：**蓝宝石虹膜 + 竖瞳**（圆瞳会立刻变成狗/人）、奶油白长毛、深棕重点色（耳/尾/白手套）
- [x] 状态差异化不只靠眼睛：尾巴有 5 种姿势（垂/甩/竖/绕/炸），error 额外炸毛并让毛色泛红
- [x] attention 加**腮红**——这是被截图逼出来的：`^ ^` 的弯眼和 sleeping 的闭眼弧太像，扫一眼分不出来
- [x] 静态契约校验器（临时脚本）：7 状态 19 帧，全部只使用白名单标签，eyeTracking 帧都含 `.pupils`
- [x] 回归 55/55 不变，`gaze` 在新形象上仍收敛（`translate(3.60 -2.60)`）
- [x] 预览截图留档 `docs/ragdoll-states.png`

**白名单的硬约束**（换主题 / 接 S7 时会再撞一次）：`renderer.js` 的 `ALLOWED_TAGS` **没有 `clipPath` / `mask` / `filter`**。
所以蓬松感不能靠滤镜，只能用「粗描边 + 圆角端点」堆出来；尾巴就是一条 `stroke-width=21` 的曲线。

### S5 权限气泡（2026-10-27）

开工前把预判读了一遍，**发现原五条要求里有四条建立在错误假设上**（以为走 command hook，实际是 `type:"http"` 的 HTTP hook），已改写为真实契约版五条，详见 `SECURITY.md`。

- [x] `src/permission.js`：裁决台。所有结局（allow / deny / 超时 / 用户关闭 / 进程退出 / 对端断开）收敛到唯一出口 `settle()`，保证恰好响应一次
- [x] `src/server.js`：`/permission` 端点。不校 token（Claude Code 带不上），但过 Host / Origin / Content-Type 三道锁
- [x] **不做决定的结局返回 204**（不是 deny）—— deny 会让工具静默失败，用户还以为自己批准过
- [x] `src/bubble.html` + `bubble-renderer.js` + `bubble-preload.js`：气泡窗口，懒创建、贴在桌宠上方 12px、宽度固定 360、高度由渲染层量完回传
- [x] 气泡显示工具名 + 完整命令 + cwd + 会话前缀；**「允许」故意不做成主色**，两按钮视觉权重接近
- [x] `hooks/install.js` 增加 `PermissionRequest` 的 HTTP hook：**故意不写 `async`**（它必须阻塞等决定），`timeout: 600`
- [x] 退出收尾：`before-quit` 里 `permissions.dispose()` 把挂起请求全部以 204 结束
- [x] 轮换不适用：本地 HTTP hook 无需 nonce（请求即响应同 socket），nonce 只留给将来的远程审批
- [x] 回归脚本从 37 项扩到 **55 项**，新增权限 A~F 六段 + 退出收尾两段

实现期被自动化测出来的两个 bug（都会让用户莫名其妙，但都不报错）：

- [x] 启动后**第一个**权限请求必定丢失 → 加 `bubble:ready` 握手 + `bubblePendingEntry` 暂存
- [x] 气泡只能点一次（后续按钮全灰） → `render()` 开头恢复按钮可用

### S4-前 Electron 升级（2026-10-27）

- [x] SEC-08：`41.10.7 → 45.0.0`，`npm audit` 8 条公告 → 0
- [x] 新增回归脚本 `scripts/verify-electron.js`（`npm run verify:electron`），37 项断言，零第三方依赖
- [x] 先在旧版跑出 36/36 基线，再对 42.11.18 与 45.0.0 跑同一套判据，三个版本结果对比留档
- [x] 覆盖到「窗口真透明」——用 `desktopCapturer` 比窗口内外相邻像素，实测差值 0
- [x] `petDebug` 补 `state()`：联调时唯一能确认「现在播的是哪个状态」的入口

### S4 接真 hook（2026-10-26）

- [x] S4-1 `hooks/clawd-hook.js`：读 stdin（2s 硬超时 / 1MB 上限，超时按空对象继续）→ 映射事件名 → 只挑 4 个字段 → POST（1.5s 超时）→ 永远 `exit(0)`
- [x] S4-2 `hooks/install.js`：marker 增量合并 + 备份 + 临时文件 `rename` 原子写，支持 `--uninstall` / `--dry-run` / `--file`
- [x] S4-3 端到端联调：七类事件 + oneshot 回落 + 多会话仲裁，**17 项断言全过**
- [x] 桌宠未启动场景：端点文件不存在 → `readPortFile` 抛错 → 静默 `exit(0)`
- [x] 崩溃残留场景：端点文件在、进程已死 → `ECONNREFUSED` → 静默 `exit(0)`，实测 241ms
- [x] 退出时清理端点文件（`before-quit` 里 `unlinkSync`），避免 hook 拿旧端口连空
- [x] **hook 改 `async: true`**：观察型 hook 不再让 agent 白等 node 冷启动

### S1–S3

- [x] S1 透明置顶窗口：无边框 + `backgroundColor: '#00000000'` + `hasShadow: false` 三件套跑通
- [x] S1 点击穿透：默认全体穿透，renderer 命中 `#pet` 时关掉
- [x] S1 拖拽：放弃 `app-region`，改主进程 16ms 轮询全局光标（窗口跟手后收不到 mousemove）
- [x] S2 `POST /state` 接收器，随机端口 + 端口文件发现，256KB 请求体上限
- [x] S2 单会话状态机：事件映射、优先级仲裁（error 压过 working）、oneshot 播完回落
- [x] S2 闲置机制：25s 发呆、60s 睡着，统一 250ms tick
- [x] S3 状态→帧序列映射，每状态可含多帧按 fps 轮播
- [x] S3 双图层交叉淡入，切换不闪白
- [x] S3 眼球追踪：主进程采样 → 归一化 gaze → 渲染层 0.25 系数插值

## S4 联调实测数据

hook 单次耗时拆解（Windows，本机实测）：

| 阶段 | 累计 | 说明 |
|---|---|---|
| `node` 进程启动 | ~200ms | **环境地板，不是我们代码的成本** |
| + 读端点文件 | ~196ms | 噪声，≈0 |
| + `fetch` POST 到桌宠 | 235ms | fetch 自身 ≈35ms |
| 完整 hook（空 stdin） | 236ms | |
| 完整 hook（带 payload） | ~280ms | |

结论：**hook 自身只加 ~35ms，剩下的都是 node 冷启动**。所以 `async: true` 不是优化，是必需品——不加的话每次工具调用白付 200ms。
（误判记录：用 `spawnSync` 连发测得稳定的 ~950ms，那是父进程阻塞 + 子进程连发的测量假象，不要拿它当真实开销。）

状态流转实测（全部 PASS）：

| 事件 | visual | 回落 |
|---|---|---|
| `SessionStart` | idle | — |
| `UserPromptSubmit` | thinking | — |
| `PreToolUse` | working | — |
| `PostToolUseFailure` | error | 2600ms → idle ✔ |
| `Notification` | notification | 3200ms → idle ✔ |
| `Stop` | attention | 2400ms → idle ✔ |
| `SessionEnd` | 会话从表中移除 | — |

多会话仲裁：A=working 时 B 报 error → 显示 error（8 > 3）；B 的 error 播完后回到 A 的 working ✔

**未覆盖**：本机没有 `claude` CLI，真实的 Claude Code 会话没能跑。已用与官方字段形状一致的 payload 走完真 hook 进程 → 真 HTTP → 真状态机 → 真快照，缺的是「宿主怎么调这个 hook」这一段。装完 hook 后第一次真会话要重点看：`async` 是否被宿主认、`matcher: "*"` 是否把非工具事件也触发、stdin 里 `hook_event_name` 是否总存在。

退出清理实测（不是脚本模拟，是关窗口后的真实退出，exit 0）：

| 检查项 | 结果 |
|---|---|
| 端点文件是否被删除 | 已删除 ✔（`before-quit` 的 `unlinkSync` 生效） |
| electron 残留进程 | 无 ✔ |
| 关闭后跑 hook | exit 0，244ms，无输出 ✔（244ms 全是 node 冷启动，`readPortFile` 抛错是瞬时的） |

## S5 联调实测数据

三种结局的响应实测（回归脚本里跑出来的真值，不是设计意图）：

| 触发方式 | 状态码 | 响应体 | 耗时 |
|---|---|---|---|
| 点「允许」 | 200 | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` | 即时 |
| 点「拒绝」 | 200 | 同上，`decision:{behavior:"deny",message:"用户在桌宠气泡里拒绝了这个操作"}` | 即时 |
| 没人点 | 204 | 空 | 6001ms（回归把默认 120s 压到 6s） |
| 退出时仍挂起 | 204 | 空 | 随 `app.quit()` 一起，<100ms |
| 退出时排队中 | 204 | 空 | 同上 |

拒绝路径的边界（全部为拒绝，且**都不产生气泡**）：

| 变形 | 结果 |
|---|---|
| 带 `Origin: https://evil.example` | 403 空响应 |
| `content-type: text/plain` | 415 |
| body 是数组而非对象 | 400 |

气泡几何实测：`{"x":2192,"y":910,"width":360,"height":190}`；桌宠窗口顶边 1112，气泡底边 1100，**间距 12px 不重叠**。高度不是写死的——渲染层量 `#card` 的 `getBoundingClientRect()` 后回传，长命令会自动变高。

**未覆盖**：本机没有 `claude` CLI，真实 Claude Code 会话依然没跑过。已用官方字段形状的 payload 走完真 HTTP → 真裁决台 → 真气泡 → 真回写，缺的仍是「宿主怎么调这个 HTTP hook」。装上后第一次真会话要重点看三件事：`type:"http"` 的 hook 是否被这个版本的 Claude Code 认、`timeout: 600` 的单位是秒还是毫秒、宿主对 204 的处理是否真的回落到原生提示。

**已知部署隐患（装之前必须先决定）**：我们的服务固定用 **23333**，和主仓库 `clawd-on-desk` 完全一样。而 `install.js` 是把 URL **写死**进 `settings.json` 的。两个后果：

1. 两个项目**同时运行**时，后启动的那个会 `EADDRINUSE` → 退到随机端口（`server.js` 里有明确 warn），但 `settings.json` 里的 hook URL 仍是 23333 → **权限请求会打到先启动的那个项目**，弹出的是别人的气泡。表现为"桌宠不弹了，另一个窗口在弹"。
2. 服务退回随机端口后，必须**重跑一次 `npm run install:hooks`** 才能让 URL 跟上；不重跑就是打到死端口。

目前的取舍是「跟随主仓库的端口，便于对照」，代价是不能和主仓库共存。真要并存，得让 `install.js` 从端点文件取当前真实端口并在启动时校对——这条留给 S6 一起做。

**hooks 尚未装进真实 `~/.claude/settings.json`**（2026-10-27 决定暂缓）。`npm run preview:hooks` 已确认生成的 JSON 形状与主仓库一致（`matcher: ""` + `type: "http"` + `timeout: 600`，另带 `via=clawd-starter` 标记），但本机没有 `claude` CLI，装进去也无法验证；而「端点没开时 HTTP hook 会怎样」正是上面列的未知项，在没验证之前不适合让它影响所有真实会话。要装随时 `npm run install:hooks`（会先备份），撤销用 `npm run uninstall:hooks`。

## S6 联调实测数据

回归里的看板段（7.7）跑出来的真值：

| 断言 | 实测 |
|---|---|
| 双击桌宠能打开会话看板 | 通过（`waitForUrl` 认出 `dashboard.html` 的 target） |
| 看板列出了会话（≥2 行） | 行数 **3** |
| 目录只显示 basename | `proj-alpha\|（未知目录）\|proj-beta` |
| 完整路径没有泄露到看板 DOM | `basename=true 盘符=false` |
| 演示模式隐藏全部目录名 | `项目已隐藏\|项目已隐藏\|项目已隐藏` |
| 复制路径只对真实会话生效 | `真实=true 伪造=false` |
| 再次双击能收起看板 | `可见=false` |

**行数 3 不是 bug，而且顺带验证了一条边界**：脚本只 seed 了 2 个会话（`sess-alpha` / `sess-beta`），第三行来自更早那次 `POST /state`（`session_id: "upgrade-check"`）——**那次没带 `cwd`**。所以「（未知目录）」这一格正是 `cwd` 缺失分支的实证：没有崩、没有空白格、没有把 `undefined` 打成字符串。这个用例是白捡的，写清楚免得以后有人把它当成"泄漏了第三条会话"。

**剪贴板那一条是唯一没验成的**：`copyPath` 返回 `true`/`false` 是准的（伪造 id 拿到 `false` 就是证据），但 `clipboard.readText()` 在本环境**始终返回空串**——连「自己写 `PROBE-OK` 再读回」都拿不到，说明是这台机器/这个会话访问不到 Windows 剪贴板，不是我们的写入逻辑坏了。所以只记 warn 不断言：**假装断言通过比不测更糟**。要确认内容，手工双击桌宠 → 点某行「复制路径」→ 粘一次。

**测试自隔离（这轮最重要的工程改进）**：

之前「用户开着桌宠」和「跑回归」是互斥的——单实例锁 + 固定端口 23333 会让测试进程直接退出，表现为「渲染进程 15s 内没起来」。这轮给回归加了两道隔离：

```js
const TMP_ROOT = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "clawd-verify-"));
const USER_DATA_DIR = path.join(TMP_ROOT, "userdata");
process.env.CLAWD_PORT_FILE = path.join(TMP_ROOT, "clawd-starter.port");
// spawn 加 --user-data-dir=${USER_DATA_DIR}，第二实例测试也用同一个
```

`requestSingleInstanceLock()` 是按 userData 目录分实例的，所以换了 `--user-data-dir` 就等于另一个应用。现在**用户开着桌宠也能跑 64/64**。

配套修的是清理方式：`child.kill()` 只杀主进程，GPU / utility 子进程逃逸后会继续占着缓存目录，下一次启动就报 `Unable to move the cache: 拒绝访问`。`preview-shot.js` 和 `verify-electron.js` 的 `finally` 都改成按进程树杀：

```js
spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
```

**一次险些误杀**：为了跑回归我先 `taskkill /IM electron.exe`，靠 `Get-CimInstance Win32_Process` 查命令行才确认其中一个 PID 是**用户自己开着的桌宠**。教训是——**别按镜像名杀进程，按 PID + 命令行确认后再杀**，尤其这个项目自己就叫 electron。

## S7 联调实测数据

回归从 64 项扩到 **92 项**，重复运行都是 92/92（其中主题与白名单相关 26 项）。

| 断言 | 实测 |
|---|---|
| 主题已加载到渲染层 / 默认是 ragdoll | `id=ragdoll` |
| 帧数完整 | 19 帧（7 状态），换主题后仍是 19 |
| 白名单剥 script / style / foreignObject | 清洗后标签 = `filter,clippath,rect,rect,rect` |
| 白名单剥 feImage / feTurbulence | 同上，两个图元都不见了 |
| 放行 clipPath / filter | 同上，都在 |
| `on*` 属性被剥 | `onclick=false` |
| `url(http…)` 被剥 | `fill=null` |
| `url(#c)` 保留 | `clip-path="url(#c)"` |
| stdDeviation 钳制 | 输入 9999 → `40` |
| 看板列出的主题都能加载 | `ok=crab,ragdoll 坏的=0` |
| 看板切主题后立刻生效 | `id=crab`，帧数仍 19 |
| 加载器拒绝路径 | schemaVersion 错 / `../escape.svg` / 资产不存在 / 非法 JSON / 没有 idle / id 含 `../../` —— 六类全拒 |
| 全坏时兜底 | `id=__fallback__`，7 状态齐全，原因字符串带出来 |

### 这轮测出来并修掉的四个真问题

1. **默认主题变成了"名字最小的主题"**。`resolveTheme` 没有显式默认，就退化成按字母序取第一个可用的 → `crab` 成了默认。加 `DEFAULT_THEME_ID = "ragdoll"` 进候选人末尾。
2. **剪贴板断言把自己的证据覆盖掉了**。上一版是「先写 `PROBE-OK` 探针，再读」——探针能跑通时读到永远是 `PROBE-OK`。改成**先读真值**，不等才做能力探测（并把原值写回去）。这一改也**推翻了上一轮的错误结论**：所谓「本环境访问不到剪贴板」是假的，现在实测能拿到 `E:\work\proj-alpha`。
3. **启动时连推两次 idle**。状态机 tick 的 250ms 周期已经把 `lastVisual` 从 null 推成 idle 并 emit 过，300ms 的「首帧保险」又推一遍同样的东西。加 `pushedAnyState` 只在没推过时才补。
4. **透明检测被别的窗口干扰**。原方法是「窗口矩形内侧 vs 外侧」比色，只要有个窗口压在同一位置（比如用户自己开着的那只桌宠），"外侧"采到的就是别人的像素。改成**同一区域拍两次：显示一次、隐藏一次**，背景变量被消掉。四角差值从 `[8,0,3,27]` 变成 `[0,0,0,0]`。

### 测试稳定性这次是硬指标

第 3 个问题一开始表现为**间歇性失败**：4 次跑有 2 次挂在「换状态时切换图层」。第一反应是渲染层的 bug，实际是**测试和状态机的两条时间线交叉**——测试在启动推送落地前就改了状态，半秒后主进程把 idle 推回来。

定位靠的是新加的 `petDebug.stateLog()`（最近 20 次推送的时间线），一次就读出 `[{t:197,visual:"idle"},{t:309,visual:"idle"}]`——两次 idle，112ms 间隔。没有这个记录，只能靠猜。

修法有两条，都做了：
- **应用侧**：去掉重复推送（问题 3）
- **测试侧**：动手改状态前先等推送静默 400ms，并加断言「换一次状态只重建一次」

后者是永久性防线：重建次数翻倍就意味着有东西在重复触发，而画面上**完全看不出来**。

## 安全状态

| 阶段 | P0 | P1 | P2 | P3 | 结论 |
|---|---|---|---|---|---|
| 全局依赖 | 0 | 0 | 0 | 0 | SEC-08 已修：`electron 41.10.7 → 45.0.0`，`npm audit` 0 漏洞。回归现已扩到 **64/64**（升级当时是 37/37，41.10.7 与 42.11.18 也都跑过作对照） |
| S1 窗口 | 0 | 0 | 0 | 1 | SEC-07 部分修（锁屏/休眠隐藏窗口），气泡内容脱敏留到 S5；窗口透明已由回归脚本像素级验证 |
| S2 服务 + 状态机 | 0 | 0 | 0 | 0 | SEC-01/02/04/09 已修：Host/Origin/Token/Content-Type 四道锁 + 会话上限 + cwd 脱敏 |
| S3 渲染 | 0 | 0 | 0 | 1 | SEC-03/06 已修；SEC-05 SVG 白名单清洗器就位，S7 接外部主题前必须回归 |
| S4 接 hook | 0 | 0 | 0 | 0 | 预判点全部落地：备份 + 原子写 + marker 只动自己 + 不落盘 + 静默退出。**补了一条预判里没写的：观察型 hook 必须 `async: true`**，否则每次事件阻塞 agent ~200ms |
| S5 权限回包 | 0 | 0 | 0 | 1 | 五条要求全部落地并各有断言（见 SECURITY.md「S5 落地核对」）。`/permission` 不校 token 是 HTTP hook 架构的固有属性，风险收敛到 Host/Origin/Content-Type + UI 不盲批。**P3 遗留**：本机进程仍可伪造气泡诱骗点击，但增量风险有限（见威胁模型） |
| S6 会话看板 | 0 | 0 | 0 | 0 | SEC-09 在这里才真正兑现：**存储层留完整 cwd，快照层只出 basename，完整路径只在用户显式点「复制路径」时由主进程单条释放**。preload 没有「取完整 cwd」的接口，伪造 id 拿不到。看板自己也是一个新窗口，`sandbox: true` + CSP `default-src 'none'` + 全部 `textContent` 写入；锁屏/休眠时和桌宠一起 hide |
| S7 主题系统 | 0 | 0 | 0 | 0 | SEC-05 从"就位"变成"真的在挡东西"：白名单收窄到 3 个新标签 + 9 个 filt 图元，拒 feImage / feTurbulence / style / foreignObject / animate。`url()` 目标校验升级为唯一出口管控，`stdDeviation` 钳到 40。**校验分两段**：主进程管文件与格式（路径双保险防穿越），渲染层管内容。**没有下载器**，主题只能手工放进 `themes/`——供应链攻击面为零 |

下一阶段开工前，先看 [SECURITY.md](./SECURITY.md) 里该阶段的预判小节。

## 变更时间线

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-10-28 | 功能 | **working 改回敲键盘**（用户否掉钓鱼）：键盘 + 深色编辑器窗口，代码行生长 → 淡出换行，两只前爪**不同频**交替敲（同频会像做操）。彩蛋整体删除，连 `theme.js` 的 `normalizeMotion`/`normalizeGags` 和 `themes/README` 的两节 schema 一起删——消费者没了还留校验器，等于「写对了也什么都不发生」 |
| 2026-10-28 | 修复 | `renderer.js` 里 `rootLayer.innerHTML = createRiggedRagdollSVG()` **一直违反硬约束 19**（src/ 下 innerHTML 必须为 0），活了整轮没人发现——因为这条从没被机械检查。模板改走 `svgNode()`，并加断言扫 `src/*.js|*.html`。**约束不落到断言上等于没有** |
| 2026-10-28 | 工具 | 删掉回归里「motion 声明的部件在 SVG 里都存在」：`def.motion` 永远是 `undefined`，循环一次都不进 → 永远为真。**永远为真的断言比没有更糟**，它在报告里长得像一道防线。同时把 `eyelidTop` 11 → 7（11 是打盹，赶工得让蓝眼睛看得见） |
| 2026-10-28 | 修复 | `petDebug.springs()` 读的是 `ragdollRig.springs`，而 rig 的通道表实际叫 `sp` → **永远返回空对象**，没人发现（外部窗口写了不等于接上了）。改到 `sp` 后暴露真值：**28 个通道**。回归新增「弹簧通道都建起来了（≥20 且有限）」，这一类的第四次发生在同一个项目里 |
| 2026-10-28 | 工具 | 「gaze 收敛到满幅位移」假红的真正原因是 **CSSOM 会把 transform 里的尾零吃掉**：写进去 `3.80px`，`el.style.transform` 读出来 `3.8px`，按字符串精确比必然失败。改成**数值判据**（容差 0.06）。「写着对的期望值却在红」时，先看中间层有没有改写过它 |
| 2026-10-28 | 修复 | 「动画在跑」的探针选错了对象：用 `petDebug.springs()` 证明"在动"，但**弹簧就是要收敛到定值**，稳态（working）下 12 次快照一模一样 → 明明在呼吸却被判成没在动。改成读每帧由正弦直接推导、不经弹簧的那几个 transform（`rig-body-group` / `rig-ruff` / `rig-head-group` / `rig-tail-main`），实测 12/12 |
| 2026-10-28 | 功能 | **钓鱼彩蛋在 rig 里重做回来**：`GAG_DEFS` 两条（fish 7~15s / slipper 15~28s），`#rig-fish` / `#rig-slipper` 各套一层 inner 组避 transform 冲突；采样函数对"还没到点的那一段"用 `continue` 而不是照样写 `from`（写 0 会覆盖正在演的那一段）。排期/播放/收/切状态取消全挂在 rig 的同一个 rAF 上 |
| 2026-10-28 | 功能 | working **从伏案打字变回水边垂钓**：删 `#rig-work-desk`，加水面 + 弯竿（`M136 158 Q158 169 176 176`）+ 鱼线 + 浮标；动作从 10Hz 打字节奏改成疲惫点头，瞳孔钉在水面上（`dynGazeY = 2.2`）。这一版重写对这个状态的理解是「在写代码」，和「钓鱼」不是同一件事 |
| 2026-10-28 | 修复 | 回归里 11 条「断言假设过时」全部按 `rigMode` 分叉：不切图层 / 不重建 DOM / layerB 始终为空 / 眨眼看 opacity / 瞳孔唯一性等各给一把尺子，不再拿帧的尺子量骨架。另补「切走状态会取消正在演的彩蛋」。回归 **92/103 → 105/105** |
| 2026-10-27 | 功能 | **动作重做（S7 之后）**：反馈是"没活猫感、切换卡顿、每个状态都只是 idle 加个东西"。两处根因都是架构的：①逐帧替换是**离散**的，6~8fps 必然频闪；②七个状态共用同一张姿势图。改成 `theme.json` 的 `motion` 声明部件动画，渲染层 rAF 插值到 60fps（呼吸/摆尾/歪头/眨眼/抖动），并**重画七个姿势**（端坐/蹲低歪头/趴低钓鱼/拔高张嘴/炸毛泛红/抬头举信封/侧躺垫爪）。帧数 19 → 7（每状态 1 帧） |
| 2026-10-27 | 修复 | `preview:states` 截图超时：隐藏窗口不会自己产生新帧，而 `Page.captureScreenshot` 要等一帧才返回。以前每个状态都有帧轮播定时器在制造帧，改成 1 帧/状态后页面完全静止就暴露了 → 截图前强制重绘一次 + 重试 3 次 |
| 2026-10-27 | 工具 | 回归加两条"活猫感"断言：**同一状态下 transform 持续变化**（12 次采样 12 个不同快照）与**会眨眼**（眼睛纵向比例压到 <0.5）。另外把"19 帧"改成与 `theme.json` 对账，并新增"motion 声明的部件在 SVG 里都存在"——写错 part 名的后果是那条动画静默不生效 |
| 2026-10-27 | 安全 | `motion.part` 会拼进 `querySelector(".m-" + part)`，所以它是主题提供的**选择器片段**。走 `PART_RE = /^[a-z0-9][a-z0-9-]{0,23}$/` 严格限制，不合格的规则整条丢弃；周期 / 幅度 / 位移全部钳制，避免主题用一条 `period: 1` 的规则把渲染进程拖死 |
| 2026-10-27 | 功能 | 布偶猫三个状态重画：working 改成**钓鱼**（弯竿 + 鱼线 + 脚边水塘 + 浮标涟漪，4 帧 4fps）、sleeping 改成**真趴着睡**（侧头垫爪、尾巴绕身、呼吸起伏，3 帧 2fps）、notification 从铃铛改成**爱心信封**（火漆爱心随心跳缩放，4 帧 5fps）。帧数仍是 19，`pupils` 约束不变 |
| 2026-10-27 | 修复 | 「gaze 收敛到满幅位移」是**竞态**：主进程每 100ms 按真实光标推 gaze，正好覆盖测试注入的坐标，断言读到的其实是光标位置（`translate(-0.98 0.81)`）。给 `petDebug.gaze(g, pin)` 加钉子开关，回归用完 `unpinGaze()` |
| 2026-10-27 | 工具 | 透明检测补**背景噪声基线**：窗口藏起来后同一块桌面再拍一次，先量出"这块地方自己会动多少"，噪声 > 6 的角不参与判定（要求至少 3 个可用角）。第一版写成了"容差 = 噪声 + 2"，噪声 137 时等于永远通过的空壳 |
| 2026-10-27 | 文档 | 发现 `state.js` 的 `IDLE_AFTER_MS = 25s` **从未被使用**（只有 60s 入睡生效），而 `preview.html` 写着「idle · 25s 无事件」。**不擅自改行为**（长工具调用会被误判成发呆），只把预览页说明改成「单次状态播完」，并在常量处注明"要用先想清楚怎么区分长工具调用" |
| 2026-10-27 | 功能 | 完成 S7：`src/theme.js` + `themes/` 三个主题包，**删掉 `src/visuals.js`**。帧数据从"写死在 JS 里"变成"从磁盘读，经 IPC 送进渲染层"。回归 64 → **92 项** |
| 2026-10-27 | 安全 | S7 白名单定案：放行 `clipPath`/`mask`/`filter` + 9 个逐个列举的 fe 图元；拒 `feImage`（外部取图）、`feTurbulence`/`feDisplacementMap`（CPU 炸弹）、`style` 标签、`foreignObject`、`animate`/`set`。**先定白名单再写加载器**，顺序不许反 |
| 2026-10-27 | 安全 | 放行滤镜后补 `stdDeviation ≤ 40`：Chrome 对超大模糊半径是同步计算的，`9999` 就是一次卡死 |
| 2026-10-27 | 修复 | 默认主题退化成"字母序第一个"（`crab` 抢了 `ragdoll` 的位置）→ 加显式 `DEFAULT_THEME_ID` |
| 2026-10-27 | 修复 | 剪贴板断言**先写探针再读**，等于自己覆盖证据；改成先读真值、不等才探测。**并推翻了上一轮"本环境访问不到剪贴板"的结论**——现在实测能拿到完整路径 |
| 2026-10-27 | 修复 | 启动时连推两次同值 idle（tick 已 emit + 300ms 首帧保险），表现为"刚切到 working 又弹回 idle"。加 `pushedAnyState` |
| 2026-10-27 | 工具 | 透明检测改法：从"窗口内外比色"改成"同区域显示/隐藏两次拍照"。原方法只要屏幕上有别的窗口压在同一位置就假失败（差值 `[8,0,3,27]`），新方法四角差 `[0,0,0,0]` |
| 2026-10-27 | 工具 | `petDebug` 补 `theme()` / `builds()` / `stateLog()`：分别回答"现在哪个主题"、"这次切换重建了几次"、"最近谁推了什么状态"。第三个直接定位了上面那个间歇失败 |
| 2026-10-27 | 工具 | `check-filemap.js` 支持 `themes/**` 这种整目录条目：几十个 SVG 帧逐条登记只会让台账变成文件列表 |
| 2026-10-27 | 修复 | **一只眼睛不跟随鼠标**。`visuals.js` 的 `open` 分支里左右眼各套了一个 `<g class="pupils">`，而渲染层是 `querySelector("svg.on .pupils")` —— **只返回第一个匹配**，所以只有左眼转，右眼钉死。合并成单个 pupils 组，并加永久断言「每帧最多一个 `.pupils` 组」+「瞳孔层里两只眼都在」 |
| 2026-10-27 | 功能 | 完成 S6：`dashboard.html` + `dashboard-renderer.js` + `dashboard-preload.js`，双击桌宠开关看板；`state.js` 加 `fullCwd()`；SEC-09 拆成存储层/快照层。回归 55 → **64 项** |
| 2026-10-27 | 安全 | S6 兑现 SEC-09 分层。S2 当时「cwd 只留 basename」其实是砍功能——看板的「复制路径」必须有完整路径。改成：存储层留完整（限长 1024），快照层只出 basename（限长 200），完整路径只在用户显式点击时单条释放 |
| 2026-10-27 | 工具 | 回归**自隔离**：`--user-data-dir` + `CLAWD_PORT_FILE` 指向临时目录。之前「用户开着桌宠」和「跑回归」互斥，现在可以并存。清理改按进程树 `taskkill /T /F`，否则 GPU 子进程逃逸后下次启动报 `Unable to move the cache` |
| 2026-10-27 | 工具 | 新增 `scripts/preview-shot.js`：把 `preview.html` 渲染成 `docs/ragdoll-states.png`，零第三方依赖，可复用 |
| 2026-10-27 | 工具 | 修 `docs/ledger/scripts/check-filemap.js` 的真 bug：存在性判断从 `!actual.includes(f)` 改成 `fs.existsSync()`。原写法让 `docs/` 下的资产（在 `SKIP_DIRS` 里）永远被误报为"已不存在" |
| 2026-10-27 | 工具 | 修 `daily-check.js` 的第二个真 bug：`tryRun` 对整个 `git status --porcelain` 输出做 `trim()`，把**首行开头的空格**剥掉了（` M README.md` → `M README.md`），再 `slice(3)` 就多切一个字母——基线里真的出现过 `EADME.md`。改成 `trimEnd()`，并加 `porcelainPath()` 兜底 |
| 2026-10-27 | 形象 | 用户自改形象为**四肢趴伏姿势**（原为坐姿），配色重写，新增 `faceMask()` 倒V面具 + `puff` / `blush` 参数。接口契约与 `viewBox` 不变 |
| 2026-10-27 | 形象 | 螃蟹 → **布偶猫**。只改 `src/visuals.js`（193 → 334 行，7 状态 19 帧），接口契约与 `viewBox` 不变，`renderer.js` 零改动，回归 55/55 |
| 2026-10-27 | 功能 | 完成 S5：`src/permission.js` 裁决台 + `src/server.js` `/permission` 端点 + 三个气泡文件（html/renderer/preload）+ `hooks/install.js` 增加阻塞式 HTTP hook。回归 37 → **55 项** |
| 2026-10-27 | 安全 | 修正 S5 预判：`PermissionRequest` 是 `type:"http"` 而非 command hook，原五条中四条（nonce、默认拒绝、token 校验）全部作废；改写为真实契约五条并落地 |
| 2026-10-27 | 修复 | 权限气泡两个实现 bug：①首个请求因页面未 ready 被静默丢弃（加 `bubble:ready` 握手）②按钮置灰后不恢复导致只能点一次 |
| 2026-10-27 | 安全 | 补退出收尾：`before-quit` 里 `permissions.dispose()` 把挂起请求以 204 结束，避免关桌宠时 Claude Code 卡满 600s hook 超时 |
| 2026-10-27 | 安全 | SEC-08 已修：`electron 41.10.7 → 45.0.0`，audit 归零。判定依据：`npm audit fix --force` 建议的是最新版，最小修复其实是 42.11.16；42.11.18 与 45.0.0 回归同为 37/37，选 45 是因为 42 已在支持线外 |
| 2026-10-27 | 工具 | 新增 `scripts/verify-electron.js`：主进程 inspector + 渲染进程 CDP 双通道回归，起步 37 项断言，含窗口透明像素级验证（S5 后扩到 55 项） |
| 2026-10-26 | 功能 | 完成 S4：`hooks/clawd-hook.js` + `hooks/install.js`，端到端 17 项断言全过；`before-quit` 清理端点文件 |
| 2026-10-26 | 安全 | 修正 S4 预判漏项：状态 hook 全部加 `async: true`（对照主仓库 `agent-runtime-architecture.md:772`：PermissionRequest 阻塞，其余非阻塞） |
| 2026-10-26 | 安全 | 修复 SEC-01/02/03/04/06/09/10，加固 SEC-05，部分修 SEC-07；新增 `src/port-file.js`；`fake-feed.js` 改带 token。SEC-08 待大版本升级 |
| 2026-10-26 | 决策 | 建立项目台账（`docs/ledger/`），并完成 S1-S3 全量安全审计，产出 10 条问题 |
| 2026-10-26 | 部署 | `first commit`，8 个源文件入库 |
