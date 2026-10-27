"use strict";
// ============================================================
// S3  状态 → 帧序列 的映射表（形象：布偶猫）
//
// 每个状态是一个 { fps, eyeTracking, frames[] }：
//   frames      同一状态的若干张图，按 fps 轮播 = 动画
//   eyeTracking 只有"睁眼"的帧才有 .pupils 节点，能跟鼠标转
//
// 到 S7 这份数据会搬进 themes/<name>/theme.json，代码一行都不用改。
//
// ---- 换形象时必须守住的契约（渲染层就是这么读的）----
//   1. 根节点必须是 viewBox="0 0 200 200" 的 <svg>，否则整套坐标系对不齐
//   2. 身体整体放进 <g transform="translate(dx dy)">，overlay 留在外面
//      ——这样 error 的抖动只抖身体，气泡不会跟着抽搐
//   3. eyeTracking 为 true 的帧必须含 <g class="pupils">，且组内用绝对坐标
//      ——渲染层是直接往这个 g 上 setAttribute("transform") 的，
//        自带的 transform 会被覆盖掉
//   4. 只能用 renderer.js 的 ALLOWED_TAGS 白名单内的标签：
//      svg/g/path/rect/circle/ellipse/line/polyline/polygon/text/gradient/stop
//      **没有 clipPath / mask / filter**，所以形状全靠堆叠，
//      蓬松感一律用「粗描边 + 圆角端点」做出来
// ============================================================

// ---- 布偶猫配色 ----
// 品种三要素：奶油白长毛 + 深棕重点色（耳/尾/爪）+ 蓝宝石眼。
// 重点色刻意不做得太深，否则蓝眼睛会被压住看不见——蓝眼是这个形象的票房。
const FUR = "#F7EFE4";        // 身体奶油白
const FUR_HI = "#FFFBF4";     // 胸口领毛高光
const POINT = "#9A7454";      // 重点色（seal 貂棕）
const IRIS = "#5CB3E4";       // 布偶蓝眼
const PUPIL = "#22415C";      // 瞳孔深蓝
const NOSE = "#D98A82";       // 鼻尖粉
const LINE = "#5A4436";       // 轮廓线

// ------------------------------------------------------------
// 眼睛。布偶猫的关键在蓝虹膜 + 竖瞳，缺一个都不像。
// ------------------------------------------------------------
function eyesSvg(kind) {
  if (kind === "open") {
    // 虹膜 rx < ry 是猫眼的感觉；瞳孔做成竖椭圆（rx << ry）才像猫
    // ——圆瞳会立刻变成狗或人。高光点跟着瞳孔一起放进 pupils，眼才活。
    return `
      <ellipse cx="82" cy="96" rx="13.5" ry="15.5" fill="${IRIS}" stroke="${LINE}" stroke-width="2"/>
      <ellipse cx="118" cy="96" rx="13.5" ry="15.5" fill="${IRIS}" stroke="${LINE}" stroke-width="2"/>
      <g class="pupils">
        <ellipse cx="82" cy="96" rx="5" ry="10.5" fill="${PUPIL}"/>
        <ellipse cx="118" cy="96" rx="5" ry="10.5" fill="${PUPIL}"/>
        <circle cx="77.5" cy="90" r="2.8" fill="#FFF" opacity="0.92"/>
        <circle cx="113.5" cy="90" r="2.8" fill="#FFF" opacity="0.92"/>
      </g>`;
  }
  if (kind === "happy") {
    // 笑弯的眼（^ ^），和布偶猫的圆脸最搭
    return `
      <path d="M69 100 q13 -15 26 0" fill="none" stroke="${LINE}" stroke-width="5" stroke-linecap="round"/>
      <path d="M105 100 q13 -15 26 0" fill="none" stroke="${LINE}" stroke-width="5" stroke-linecap="round"/>`;
  }
  if (kind === "shut") {
    // 睡着：向下弯的弧比直线更像"闭着放松"
    return `
      <path d="M69 96 q13 8 26 0" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M105 96 q13 8 26 0" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>`;
  }
  // dead：X 眼（出错时的"当机"）
  return `
    <path d="M73 88 l18 18 M91 88 l-18 18" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M109 88 l18 18 M127 88 l-18 18" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>`;
}

// ---- 尾巴姿势。猫的情绪有一半写在尾巴上，几个状态必须不一样 ----
function tailD(kind) {
  switch (kind) {
    case "up":    // attention：竖起来打招呼
      return "M138 150 C158 156 172 134 168 110 C166 98 156 92 148 96";
    case "curl":  // sleeping：绕回身侧把自己圈起来
      return "M142 154 C172 162 190 146 180 126 C173 112 150 118 146 134";
    case "swish": // working：甩到另一侧
      return "M140 152 C168 152 186 160 190 146";
    case "puff":  // error：炸毛，短而粗地竖起
      return "M136 154 C156 152 168 140 166 124";
    default:      // 常态：自然垂到身侧
      return "M140 152 C166 162 190 146 186 124";
  }
}

// ---- 额头的重点色块 ----
// 真猫的重点色是「脸中央往下 + 四肢末端」，这里简化成一顶"小帽子"，
// 刻意避开眼睛周围——留出白净的眼区，蓝眼睛才跳得出来。
function faceMask() {
  return `
    <path d="M100 52 C78 52 64 62 62 76 C60 86 66 92 74 94 L100 82 L126 94 C134 92 140 86 138 76 C136 62 122 52 100 52 Z"
      fill="${POINT}" opacity="0.95"/>`;
}

// ------------------------------------------------------------
// 身体主绘制
//   dx / dy  整体位移（working 的颠、error 的抖）
//   fur      身体色（error 时偏红）
//   point    重点色（error 偏红棕、sleeping 偏暗）
//   tail     尾巴姿势
//   puff     是否炸毛（沿外轮廓扎出尖角）
//   blush    是否加腮红（表示情绪好）
// ------------------------------------------------------------
function ragdoll({
  eyes = "open",
  overlay = "",
  fur = FUR,
  point = POINT,
  tail = "rest",
  dx = 0,
  dy = 0,
  puff = false,
  blush = false,
} = {}) {
  // 炸毛：尖角必须扎在**外轮廓的外侧**（肩背 + 头顶）。
  // 第一版扎在脖子两侧（x≈62/138, y≈100），渲染出来像长了一对小翅膀，
  // 因为那个位置正好是头和身体的交界，读者会把它解释成"肢体"而不是"毛"。
  const puffSvg = puff
    ? `<g fill="${point}" opacity="0.9">
         <path d="M57 118 l-14 -4 l6 12 z"/>
         <path d="M53 100 l-14 -7 l7 12 z"/>
         <path d="M88 49 l4 -13 l7 12 z"/>
         <path d="M112 49 l-4 -13 l-7 12 z"/>
         <path d="M143 118 l14 -4 l-6 12 z"/>
         <path d="M147 100 l14 -7 l-7 12 z"/>
       </g>`
    : "";

  // 腮红：只在需要"情绪好"的状态出现，是 attention 和 sleeping 拉开差距的关键
  // ——两者都是"眼睛不再睁着"，光靠眼的弧度区分太弱。
  const blushSvg = blush
    ? `<g fill="${NOSE}" opacity="0.5">
         <ellipse cx="66" cy="110" rx="8.5" ry="5"/>
         <ellipse cx="134" cy="110" rx="8.5" ry="5"/>
       </g>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <g transform="translate(${dx} ${dy})">
    <ellipse cx="100" cy="177" rx="50" ry="9" fill="${LINE}" opacity="0.10"/>

    <!-- 尾巴：粗描边而不是填充。既省坐标，圆头端点又自动得到蓬松感。 -->
    <!-- 第二条压在下层做描边阴影，把尾巴从身体上分出来。 -->
    <path d="${tailD(tail)}" fill="none" stroke="${LINE}" stroke-width="25" stroke-linecap="round" opacity="0.14"/>
    <path d="${tailD(tail)}" fill="none" stroke="${point}" stroke-width="21" stroke-linecap="round"/>

    ${puffSvg}

    <!-- 身体：坐姿梨形 -->
    <ellipse cx="100" cy="137" rx="50" ry="37" fill="${fur}" stroke="${LINE}" stroke-width="3.5"/>
    <!-- 胸口白领毛，布偶猫最有辨识度的一撮 -->
    <ellipse cx="100" cy="148" rx="33" ry="24" fill="${FUR_HI}" opacity="0.85"/>
    <!-- 前爪：白手套 -->
    <ellipse cx="77" cy="167" rx="15" ry="9" fill="${FUR_HI}" stroke="${LINE}" stroke-width="3"/>
    <ellipse cx="123" cy="167" rx="15" ry="9" fill="${FUR_HI}" stroke="${LINE}" stroke-width="3"/>

    <!-- 头 -->
    <ellipse cx="100" cy="88" rx="47" ry="41" fill="${fur}" stroke="${LINE}" stroke-width="3.5"/>
    <!-- 耳朵：外耳重点色 + 内耳透出粉色 -->
    <path d="M62 62 L58 34 L86 52 Z" fill="${point}" stroke="${LINE}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M138 62 L142 34 L114 52 Z" fill="${point}" stroke="${LINE}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M66 58 L64 42 L80 52 Z" fill="${NOSE}" opacity="0.45"/>
    <path d="M134 58 L136 42 L120 52 Z" fill="${NOSE}" opacity="0.45"/>

    ${faceMask()}
    ${eyesSvg(eyes)}
    ${blushSvg}

    <!-- 鼻子 + 嘴 + 胡须 -->
    <path d="M100 108 l6 6 l-12 0 z" fill="${NOSE}" stroke="${LINE}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M100 114 q-7 8 -12 2" fill="none" stroke="${LINE}" stroke-width="2.6" stroke-linecap="round"/>
    <path d="M100 114 q7 8 12 2" fill="none" stroke="${LINE}" stroke-width="2.6" stroke-linecap="round"/>
    <g stroke="${LINE}" stroke-width="1.8" stroke-linecap="round" opacity="0.55">
      <path d="M52 100 l-16 -3"/><path d="M52 106 l-16 3"/><path d="M53 112 l-15 7"/>
      <path d="M148 100 l16 -3"/><path d="M148 106 l16 3"/><path d="M147 112 l15 7"/>
    </g>
  </g>
  ${overlay}
</svg>`;
}

// ------------------------------------------------------------
// overlay：叠在身体之外的小挂件。它们用绝对坐标，不跟着身体抖。
// 这一组与形象无关，换任何角色都能直接复用。
// ------------------------------------------------------------

function bubble(x, y, w, h, stroke, fill, inner) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
    <path d="M${x + 12} ${y + h} l-6 12 l16 -11 z" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
    ${inner}`;
}

// 思考气泡：三个点轮流亮
function thinkingBubble(active) {
  const dots = [137, 149, 161]
    .map((cx, i) => `<circle cx="${cx}" cy="68" r="4.5" fill="#378ADD" opacity="${i === active ? 1 : 0.28}"/>`)
    .join("");
  return bubble(120, 48, 58, 40, "#378ADD", "#E6F1FB", dots);
}

// 打字火花：两张图交错
function sparkPhase(phase) {
  const up = phase === 0;
  return `<g stroke="#BA7517" stroke-width="3" stroke-linecap="round" fill="none" opacity="${up ? 1 : 0.4}">
    <path d="M150 ${up ? 92 : 98} l14 -10"/>
    <path d="M154 ${up ? 104 : 98} l16 -4"/>
  </g>`;
}

// 开心闪光：缩放做出"闪"的感觉
function sparklePhase(phase) {
  const big = phase === 0;
  const s1 = big ? 1 : 0.55;
  const s2 = big ? 0.5 : 0.9;
  return `<g fill="#EF9F27">
    <path transform="translate(152 86) scale(${s1}) translate(-152 -86)"
      d="M152 72 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 z"/>
    <path transform="translate(44 92) scale(${s2}) translate(-44 -92)" opacity="0.85"
      d="M44 80 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3 l7 -3 z"/>
  </g>`;
}

// 铃铛：绕顶点左右摆
function bellPhase(phase) {
  const deg = [-10, 0, 10, 0][phase];
  return bubble(
    120,
    46,
    56,
    42,
    "#BA7517",
    "#FAEEDA",
    `<g transform="rotate(${deg} 148 56)">
       <path d="M148 58 c-6 0 -9 5 -9 10 v5 l-3 4 h24 l-3 -4 v-5 c0 -5 -3 -10 -9 -10 z"
         fill="#EF9F27" stroke="#854F0B" stroke-width="2"/>
       <circle cx="148" cy="80" r="2.6" fill="#854F0B"/>
     </g>`
  );
}

// zzz：往上飘 + 变淡
function zzzPhase(phase) {
  const lift = phase * 5;
  const fade = 1 - phase * 0.28;
  return `<g fill="#5F5E5A" font-family="system-ui, sans-serif" font-weight="500" opacity="${fade}">
    <text x="146" y="${78 - lift}" font-size="18">z</text>
    <text x="161" y="${60 - lift}" font-size="14">z</text>
  </g>`;
}

// ------------------------------------------------------------
// 七个状态。名字必须存在，renderer.js 靠白名单挡住任意字符串进 DOM。
// ------------------------------------------------------------

const VISUAL_STATES = {
  // 单帧：静止时的"活气"完全靠眼球追踪（蓝眼睛跟着鼠标转），不需要帧序列
  idle: {
    fps: 2,
    eyeTracking: true,
    frames: [ragdoll({ eyes: "open" })],
  },

  thinking: {
    fps: 6,
    eyeTracking: true,
    frames: [0, 1, 2].map((i) => ragdoll({ eyes: "open", overlay: thinkingBubble(i) })),
  },

  // 四帧：身体上下轻颠 + 尾巴来回甩 + 火花交错 = 忙碌感
  working: {
    fps: 8,
    eyeTracking: true,
    frames: [
      ragdoll({ eyes: "open", dy: 0, tail: "rest", overlay: sparkPhase(0) }),
      ragdoll({ eyes: "open", dy: -2, tail: "swish", overlay: sparkPhase(1) }),
      ragdoll({ eyes: "open", dy: 0, tail: "rest", overlay: sparkPhase(0) }),
      ragdoll({ eyes: "open", dy: -1, tail: "swish", overlay: sparkPhase(1) }),
    ],
  },

  // 尾巴竖起来 + 腮红 = "有好事给你看"。腮红是必须的：
  // 只靠 ^ ^ 的弧度和 sleeping 的闭眼弧太接近，扫一眼分不出来。
  attention: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 1].map((i) =>
      ragdoll({ eyes: "happy", tail: "up", blush: true, overlay: sparklePhase(i) })
    ),
  },

  // 炸毛 + 抖动 + 毛色泛红：整只猫看起来不对劲，一眼能看出来
  error: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 2].map((dx) =>
      ragdoll({
        eyes: "dead",
        fur: "#F0D2C8",
        point: "#A5452C",
        tail: "puff",
        puff: true,
        dx,
        overlay: bubble(
          126,
          46,
          40,
          44,
          "#E24B4A",
          "#FCEBEB",
          `<path d="M146 58 v14" stroke="#A32D2D" stroke-width="4.5" stroke-linecap="round"/>
           <circle cx="146" cy="80" r="2.8" fill="#A32D2D"/>`
        ),
      })
    ),
  },

  notification: {
    fps: 6,
    eyeTracking: true,
    frames: [0, 1, 2, 3].map((i) => ragdoll({ eyes: "open", overlay: bellPhase(i) })),
  },

  // 尾巴绕回身侧 + 毛色压暗 = 睡熟了
  sleeping: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 1, 2].map((i) =>
      ragdoll({ eyes: "shut", fur: "#EFE4D4", point: "#7B5B41", tail: "curl", overlay: zzzPhase(i) })
    ),
  },
};

window.VISUAL_STATES = VISUAL_STATES;
