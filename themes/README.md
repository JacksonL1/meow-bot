# 主题

一个主题 = 一个目录，里面一个 `theme.json` + 一个 `assets/`。

```text
themes/
├── _template/          脚手架，复制走再改。**下划线开头 = 不是主题**，不会出现在列表里
└── ragdoll/            布偶猫（默认）
    ├── theme.json
    └── assets/
        ├── idle-1.svg
        ├── thinking-1.svg
        └── …
```

## ⚠️ 先说清楚：ragdoll 现在**不走帧**

`themes/ragdoll/theme.json` 里写着 `"rigType": "ragdoll-spring-v2"`，渲染层看到这个值就走
**骨骼弹簧渲染器**——那只猫是 `src/renderer.js` 用 JS 拼出来的（模板 + 姿势表 + 弹簧通道），
`assets/` 下那 21 个 SVG **一张都不会被读**。

所以：

- 改布偶猫的形象 = 改 `src/renderer.js` 里的 `createRiggedRagdollSVG()` / `STATE_POSES`，
  **不是**改 `assets/*.svg`。改了帧文件看不到任何变化
- 那 21 个 SVG 的用途只有三个：非骨骼路径的示例、`preview:states` 静态对照图、
  主题资产校验的存在性检查（`theme.json` 写了就必须有文件）
- 想加一套**纯数据驱动**的主题，去掉 `rigType` 就行，走的是传统帧路径

这是架构上的一个代价，别被目录结构骗了。要改回纯主题驱动，见
`docs/ledger/PROGRESS.md` 的「骨骼弹簧重写：把它救回来」。

## theme.json

```json
{
  "schemaVersion": 1,
  "name": "布偶猫",
  "author": "clawd-starter",
  "version": "2.0.0",
  "description": "一句话描述",
  "states": {
    "idle": {
      "fps": 1,
      "eyeTracking": true,
      "frames": ["idle-1.svg"]
    },
    "working": {
      "fps": 1,
      "eyeTracking": false,
      "frames": ["working-1.svg"]
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 必须是 `1` |
| `name` / `author` / `version` / `description` | 纯展示，会被截断到合理长度 |
| `states` | **只有 `idle` 必填**。缺的状态会自动用 idle 的画面兜住 |
| `states.<name>.fps` | 多帧时的轮播速度，钳在 1–30。不写就 4。**只有 1 帧就没意义** |
| `states.<name>.eyeTracking` | 只有写 `true` 才开，**默认关**。开了就必须保证该状态**每一帧**都有 `<g class="pupils">`。写 `false` 时图里可以保留 `pupils`——它只是不会动（working 就是这样：眼睛钉在屏幕上敲键盘，不追鼠标，但眼睛还得有瞳孔） |
| `states.<name>.frames` | 非空数组，最多 12 项。文件名相对 `assets/` |
| `states.<name>.variants` | 可选。**同一个状态的多套表情变体**，每套结构和本表一样（`frames` 必填，`fps` / `eyeTracking` / `id` 可选），最多 4 套 |
| `timings` | 可选。改状态时长，见下一节。**不写就用 `src/state.js` 里的内置默认** |

### variants：一个状态的多套表情

```json
"idle": {
  "fps": 8,
  "eyeTracking": true,
  "frames": ["idle-a.svg", "idle-b.svg"],
  "variants": [
    { "id": "stretch", "frames": ["idle-stretch.svg"] },
    { "id": "stretch", "fps": 6, "eyeTracking": false, "frames": ["idle-slow.svg"] }
  ]
}
```

- **每次进入这个状态轮换一套**：主资产 → 第 1 套 → 第 2 套 → 回到主资产。
  第一次进入播的一定是主资产，所以没写 `variants` 的主题行为完全不变。
- **为什么是轮换不是随机**：随机没法断言。测试要的是"多切几次一定不全一样"，
  随机却可能连着两次选中同一套，那样的断言会时红时绿——**那是测试在赌时序，不是在验功能**。
- **没写的字段继承主资产**：`fps` / `eyeTracking` 自己写了就用自己那个。
  主资产和变体走**同一套校验**（帧数上限、资产名、大小），不会分叉成"主资产钳了、变体没钳"。
- **`id` 只是给你自己看的**（排查时 `petDebug.variant()` 会报出来），不是路由键，重复也不报错。
- `variants` 和主资产**共用同一个 4MB 总量额度**，上限 4 套是为了绑住加载耗时。

### timings：主题能改的只有这四个数

```json
"timings": {
  "oneshot": { "error": 1200, "attention": 800 },
  "sleepAfterMs": 20000
}
```

- `oneshot.<state>`：这三个状态**最多**停留多久就退回 `idle`（否则 attention 会永远挂在屏幕上）。
- `sleepAfterMs`：**闲着（idle）多久才睡着**。计时从进入 idle 开始，working / thinking 期间不累计 ——
  agent 明明在干活时睡着是错的（一次跑 40 秒的构建期间一个事件都没有，但它在干活）。

**`notification` 那一条不要往短里写。** 它不是"播一次就走"的闪光，是**"agent 在等你点允许"**的持续状态
（主仓库管它叫 a real permission hold）。ragdoll 早期在这里写过 `1500`，后果是用户在信里问的那句：

> 「需要我确认的时候，没有提示我啊」

提示闪 1.5 秒就撤了，人抬头看的时候屏幕上什么都没有。所以主题里现在**干脆不写它**，
用 `src/state.js` 的内置上限（10 分钟）。真正让提示消失的不是这个计时器，
而是下一个事件（agent 又开始动了）把它顶掉 —— 这条写在 `state.js` 的 `tick()` 里。
你自己写也可以，但记住那个数是**上限**，写短了等于把提示掐掉。

**主题没写就是没写**：不写 `timings` 时加载器如实返回 `null`，由 `src/state.js` 用它自己的默认。
默认值的真相只放在一处，加载器不会替你编一个——两边各存一份默认，分叉是静默的。

**只能改 `error` / `notification` / `attention` 这三个**。在 `oneshot` 里写别的
（比如 `working`、或者一个状态机根本没有的 `sweeping`）不会生效，而且会**在加载警告里报出来**：
「状态机不认识的状态（永不会生效）」。理由和未知状态名一样——静默丢弃的东西，
作者永远不会发现，只会以为自己写错了别的地方。
这条还有一层意思：**主题改不了状态机的形状**。要是允许给 `working` 配时长，
一个主题就能让「工作中」播 2 秒就消失，那是行为不是外观。

边界与报错：`oneshot` 钳在 200–30000ms，`sleepAfterMs` 钳在 2000–3600000ms，
被钳了会在加载警告里说明。值不是数字 → 忽略并警告；
`timings` 本身不是对象 → **整个主题加载失败**（写错了要让你看见，而不是悄悄按默认跑）。

### 动画：帧只是「兜底」，活的是渲染层

主题里**写不了** CSS 动画（白名单拒 `<style>`）和 SMIL（拒 `animate`/`set`）。
最直接的办法是多画几帧再轮播，但那是**离散**的：6~8fps 的逐帧替换必然频闪，
看起来就是"卡顿式切换"。**帧数多 != 流畅**——ragdoll 从 19 帧降到 7 帧反而更顺，
因为它最后干脆不播帧了，改由骨骼弹簧渲染器每帧重算整只猫。

所以现在的分工是：

| 主题类型 | 靠什么动 | 帧的作用 |
|---|---|---|
| 骨骼弹簧（`rigType`） | 渲染层 28 个弹簧通道 + 呼吸 / 尾巴 / 眨眼 / 敲键，60fps | **完全不用**，只作为主题资产校验的素材 |
| 帧序列（没写 `rigType` 的主题，如内置的兜底画面） | 按 `fps` 轮播 `frames` | 就是画面本身 |

**`motion` / `gags` 两个字段已经不存在了**：motion 引擎随骨骼重写一起没了，
一次性彩蛋（钓上鱼 / 扔拖鞋）随「working 改回敲键盘」一起删了。
校验器和消费者一起删——现在写这两个字段会被当作未知字段忽略，
因为「校验通过、加载成功、什么都不发生」比删掉更害人。

状态名只能是这七个：`idle` `thinking` `working` `attention` `error` `notification` `sleeping`。
名字对不上的一律忽略——它们来自 `src/state.js` 的 `EVENT_STATE`，不是主题能自己发明的。

## 四条硬契约（改形象必看）

1. **每帧自带 `viewBox="0 0 200 200"`**。渲染层把每帧当独立 SVG 解析，尺寸不会帮你补。
2. **眼球层必须是唯一的一个 `<g class="pupils">`**，组内坐标用绝对值。
   渲染层是 `querySelector("svg.on .pupils").setAttribute("transform", ...)`——`querySelector` 只返回**第一个**匹配。
   左右眼各包一个组，结果就是「只有一只眼跟着鼠标转」。这个 bug 真发生过。
3. **一个部件只能有一个 `transform` 源**。眼球追踪每帧都在写 `.pupils` 的 `transform`，
   谁最后写谁生效，而且**不会报错**。要同时位移和缩放，就再套一层 `<g>`（外层位移、内层缩放）。
4. **只用白名单标签**。见 `docs/ledger/SECURITY.md` 的「S7 白名单定案」。
   简版：`svg g defs path rect circle ellipse line polyline polygon text tspan
   linearGradient radialGradient stop use clipPath mask filter` + 九个 `fe*` 图元。
   **没有** `style`、`foreignObject`、`animate`、`feImage`、`feTurbulence`。

## 资产规则

- **只支持 `.svg`**。GIF / APNG / WebP 要另写解码器，S7 没做。
- 文件名只能含字母、数字、`.`、`_`、`-`，必须以 `.svg` 结尾——这条正则同时挡掉了 `../`、绝对路径和盘符。
- 单文件 ≤ 256KB，单主题合计 ≤ 4MB。
- 任何一条不合格 → **整个主题拒绝加载**，不做部分加载（半个主题的表现是"看着怪"，作者根本不会发现）。
  全部主题都失败时用内置的「?」占位图，保证窗口不会变成一片空白。

## 加一个主题

```bash
cp -r themes/_template themes/my-theme      # 目录名只能用小写字母、数字、- 和 _
# 改 theme.json、换 assets/ 里的 SVG
npm run preview:states -- --theme=my-theme  # 出对照图 docs/my-theme-states.png
npm start -- --theme=my-theme               # 直接看
```

选中的主题会写进 `%APPDATA%\clawd-starter\clawd-starter.theme`，下次启动还是它。
命令行 `--theme=` 与环境变量 `CLAWD_THEME` 都能临时覆盖（环境变量优先，回归脚本用它）。

也可以在看板（双击桌宠）底部直接切。
