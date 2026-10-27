# 主题

一个主题 = 一个目录，里面一个 `theme.json` + 一个 `assets/`。

```text
themes/
├── _template/          脚手架，复制走再改。**下划线开头 = 不是主题**，不会出现在列表里
├── crab/               原版螃蟹
└── ragdoll/            布偶猫（默认）
    ├── theme.json
    └── assets/
        ├── idle-1.svg
        ├── thinking-1.svg
        └── …
```

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
      "frames": ["idle-1.svg"],
      "motion": [
        { "part": "body", "type": "scale", "pivot": [100, 168], "from": [1, 1], "to": [1, 1.03], "period": 3400 },
        { "part": "tail", "type": "rotate", "pivot": [148, 152], "from": -7, "to": 7, "period": 2600 },
        { "part": "eyes", "type": "blink", "pivot": [100, 92], "min": 2600, "max": 6800 }
      ]
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
| `states.<name>.eyeTracking` | 只有写 `true` 才开，**默认关**。开了就必须保证该状态**每一帧**都有 `<g class="pupils">`。写 `false` 时图里可以保留 `pupils`——它只是不会动（working 就是这样：疲惫的猫不追光标，但眼睛还得有瞳孔） |
| `states.<name>.frames` | 非空数组，最多 12 项。文件名相对 `assets/` |
| `states.<name>.motion` | 可选。**循环**动画处方，最多 12 条。**写错的单条会被丢掉，不连坐整个主题** |
| `states.<name>.gags` | 可选。**一次性**彩蛋，最多 4 条。见下面的「彩蛋」一节 |

### 动画：为什么是 motion 而不是多帧

主题里**写不了** CSS 动画（白名单拒 `<style>`）和 SMIL（拒 `animate`/`set`），
所以最直接的办法是多画几帧再轮播。但那是**离散**的：6~8fps 的逐帧替换必然是频闪，
看起来就是"卡顿式切换"。所以动画放在渲染层：主题只**声明**哪个部件怎么动，
渲染层用 `requestAnimationFrame` 连续插值到 60fps。

一条规则长这样：

| 字段 | 说明 |
|---|---|
| `part` | 对应 SVG 里的 `<g class="m-<part>">`，正则 `[a-z0-9-]{1,24}` |
| `type` | `rotate`（度）· `scale`（倍数）· `translate`（viewBox 单位）· `blink`（眨眼） |
| `from` / `to` | `rotate` 是数字；`scale` / `translate` 是 `[x, y]`。按 `period` 在两者之间来回 |
| `period` | 一个完整来回的毫秒数，钳在 200–20000 |
| `phase` | 0–1 的相位偏移。让几个部件的呼吸错开，别整齐得像机器 |
| `pivot` | 变换中心 `[x, y]`。旋转尾巴必须把支点放在尾巴根，否则整条尾巴会绕着画面中心甩 |
| `min` / `max` | 仅 `blink`：两次眨眼的随机间隔（毫秒） |

状态名只能是这七个：`idle` `thinking` `working` `attention` `error` `notification` `sleeping`。
名字对不上的一律忽略——它们来自 `src/state.js` 的 `EVENT_STATE`，不是主题能自己发明的。

## 彩蛋（gags）：隔一阵干一件一次性的事

`motion` 是循环的——"一直在呼吸"、"一直在摆尾"。它写不出"隔一阵钓上来一条鱼"：
硬塞进 `period` 只能演成"每 10 秒准时钓上来一条"，那是最不像活物的节奏。
所以一次性的小动作单开一层：

```json
"gags": [
  {
    "name": "fish",
    "parts": ["fish", "fish-in", "pupils"],
    "every": [7000, 14000],
    "duration": 2900,
    "steps": [
      { "part": "pupils", "type": "translate", "from": [0, 0], "to": [2.8, 2.0], "at": 200, "span": 450, "ease": "out" },
      { "part": "fish",   "type": "translate", "from": [-4, 40], "to": [0, 0], "at": 0, "span": 1000, "ease": "out" },
      { "part": "fish",   "type": "translate", "from": [0, 0], "to": [-48, -56], "at": 1900, "span": 800, "ease": "in" },
      { "part": "fish-in","type": "scale", "pivot": [178, 170], "from": [1, 1], "to": [0.02, 0.02], "at": 2000, "span": 750, "ease": "inout" }
    ]
  }
]
```

| 字段 | 说明 |
|---|---|
| `name` | 彩蛋名，同时是选择器片段（`[a-z0-9-]`），也是 `petDebug.gag(name)` 的参数 |
| `parts` | 这条彩蛋要**收放**的部件。开演时移除它们的 `display="none"`，演完恢复**开演前的原值** |
| `every` | `[最小, 最大]` 毫秒，每次随机取一个。写反了整条丢弃 |
| `duration` | 整条彩蛋的时长（300–10000ms） |
| `steps[].at` / `span` | 这一段从第 `at` 毫秒开始，用 `span` 毫秒走完。`span` 会被夹到 `duration - at` 以内 |
| `steps[].ease` | `out`（默认，由快到慢）· `in`（由慢到快）· `inout`（两头软） |
| `steps[].part` / `type` / `from` / `to` / `pivot` | 与 `motion` 同名同义 |

三条容易踩的：

1. **还没到点的步骤不参与**。所以同一部件的多段动作可以放心写，前一段会一直有效到后一段开始。
   但相邻两段的端点要写成同一个值（前一段的 `to` == 后一段的 `from`），否则接缝处会跳一下。
2. **收放只看 `display`**。要藏的部件在 SVG 里写死 `display="none"`；本来露着的（比如 `pupils`）
   就直接放进去，别加 `display`——收尾会按原值恢复，一律隐藏会把猫的眼睛一起抹掉。
3. **一个部件同一时刻只能被一个 `transform` 源控制**。`motion` 每帧都在写，
   所以彩蛋不要动 `motion` 已经占用的部件（比如 `head`）。同一个部件要同时位移和缩放，
   就在 SVG 里再套一层：外层 `<g class="m-fish">` 管位移，内层 `<g class="m-fish-in">` 管缩放。

排期是随机的，肉眼验收要等。调试时直接在 DevTools 里 `petDebug.gag('fish')` 手动放一条。

## 五条硬契约（改形象必看）

1. **每帧自带 `viewBox="0 0 200 200"`**。渲染层把每帧当独立 SVG 解析，尺寸不会帮你补。
2. **眼球层必须是唯一的一个 `<g class="pupils">`**，组内坐标用绝对值。
   渲染层是 `querySelector("svg.on .pupils").setAttribute("transform", ...)`——`querySelector` 只返回**第一个**匹配。
   左右眼各包一个组，结果就是「只有一只眼跟着鼠标转」。这个 bug 真发生过。
3. **被动画的部件外层 `<g class="m-xxx">` 不能自带 `transform`**。
   渲染层每帧都会 `setAttribute("transform", ...)` 覆盖它。静态角度（比如歪头）
   要放在内层 `<g transform="...">` 上——嵌套之后两者互不干扰。
4. **一个部件只能有一个 `transform` 源**。`motion` / `gags` / 眼球追踪都在 `setAttribute("transform", ...)`，
   谁最后写谁生效，而且**不会报错**。要同时位移和缩放，就再套一层 `<g class="m-xxx">`（外层位移、内层缩放）。
5. **只用白名单标签**。见 `docs/ledger/SECURITY.md` 的「S7 白名单定案」。
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
