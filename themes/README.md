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
  "version": "1.0.0",
  "description": "一句话描述",
  "states": {
    "idle":     { "fps": 2, "eyeTracking": true,  "frames": ["idle-1.svg"] },
    "thinking": { "fps": 6, "eyeTracking": true,  "frames": ["thinking-1.svg", "thinking-2.svg"] },
    "sleeping": { "fps": 3, "eyeTracking": false, "frames": ["sleeping-1.svg"] }
  }
}
```

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 必须是 `1` |
| `name` / `author` / `version` / `description` | 纯展示，会被截断到合理长度 |
| `states` | **只有 `idle` 必填**。缺的状态会自动用 idle 的画面兜住 |
| `states.<name>.fps` | 帧轮播速度，钳在 1–30。不写就 4 |
| `states.<name>.eyeTracking` | 只有写 `true` 才开。开了就必须保证该状态**每一帧**都有 `<g class="pupils">` |
| `states.<name>.frames` | 非空数组，最多 12 项。文件名相对 `assets/` |

状态名只能是这七个：`idle` `thinking` `working` `attention` `error` `notification` `sleeping`。
名字对不上的一律忽略——它们来自 `src/state.js` 的 `EVENT_STATE`，不是主题能自己发明的。

## 三条硬契约（改形象必看）

1. **每帧自带 `viewBox="0 0 200 200"`**。渲染层把每帧当独立 SVG 解析，尺寸不会帮你补。
2. **眼球层必须是唯一的一个 `<g class="pupils">`**，组内坐标用绝对值。
   渲染层是 `querySelector("svg.on .pupils").setAttribute("transform", ...)`——`querySelector` 只返回**第一个**匹配。
   左右眼各包一个组，结果就是「只有一只眼跟着鼠标转」。这个 bug 真发生过。
3. **只用白名单标签**。见 `docs/ledger/SECURITY.md` 的「S7 白名单定案」。
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
