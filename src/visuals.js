"use strict";
// ============================================================
// S3  状态 → 帧序列 的映射表（形象：四肢着地趴伏姿势的萌系布偶猫）
//
// ---- 换形象时必须守住的契约 ----
//   1. viewBox="0 0 200 200" 的 <svg>
//   2. 身体整体放进 <g transform="translate(dx dy)">，overlay 留在外面
//   3. eyeTracking 为 true 的帧必须含 <g class="pupils"> (绝对坐标)
//   4. 仅使用白名单内的标签
// ============================================================

const FUR = "#FAF6F0";        // 身体软糯奶白
const FUR_HI = "#FFFFFF";     // 胸口毛领纯白高光
const POINT = "#967866";      // 经典双色海豹重点色（暖绒棕）
const POINT_DARK = "#7A5E4E"; // 重点色阴影
const IRIS = "#51ABE8";       // 蓝宝石晶莹虹膜
const IRIS_DARK = "#2B73B0";  // 虹膜深层暗影
const PUPIL = "#1A2E40";      // 深海蓝黑瞳孔
const NOSE = "#F2A7A7";       // 柔嫩水蜜桃粉鼻
const LINE = "#524338";       // 柔和炭棕色轮廓线

// ------------------------------------------------------------
// 眼睛系统：温顺深邃的大眼
// ------------------------------------------------------------
function eyesSvg(kind) {
  if (kind === "open") {
    // 两只眼的虹膜先各画各的，但**瞳孔必须收进同一个 <g class="pupils">**。
    // 渲染层是这样驱动的：
    //   const pupils = el.querySelector("svg.on .pupils");
    //   pupils.setAttribute("transform", `translate(dx dy)`);
    // querySelector 只返回第一个匹配 —— 如果左右眼各包一个 pupils 组，
    // 只有左眼会跟鼠标转，右眼永远定在原地（这个 bug 真发生过）。
    return `
      <!-- 左眼 -->
      <circle cx="74" cy="92" r="14" fill="${LINE}"/>
      <circle cx="74" cy="92" r="12.5" fill="${IRIS_DARK}"/>
      <circle cx="74" cy="92" r="10.5" fill="${IRIS}"/>

      <!-- 右眼 -->
      <circle cx="126" cy="92" r="14" fill="${LINE}"/>
      <circle cx="126" cy="92" r="12.5" fill="${IRIS_DARK}"/>
      <circle cx="126" cy="92" r="10.5" fill="${IRIS}"/>

      <!-- 两眼共用的瞳孔层（全帧只允许存在一个） -->
      <g class="pupils">
        <ellipse cx="74" cy="92" rx="5" ry="9" fill="${PUPIL}"/>
        <circle cx="70.5" cy="87" r="3" fill="#FFFFFF"/>
        <circle cx="77" cy="96" r="1.5" fill="#FFFFFF" opacity="0.85"/>
        <ellipse cx="126" cy="92" rx="5" ry="9" fill="${PUPIL}"/>
        <circle cx="122.5" cy="87" r="3" fill="#FFFFFF"/>
        <circle cx="129" cy="96" r="1.5" fill="#FFFFFF" opacity="0.85"/>
      </g>`;
  }
  if (kind === "happy") {
    return `
      <path d="M60 93 Q74 79 88 93" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M112 93 Q126 79 140 93" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>`;
  }
  if (kind === "shut") {
    return `
      <path d="M61 90 Q74 101 87 90" fill="none" stroke="${LINE}" stroke-width="4" stroke-linecap="round"/>
      <path d="M113 90 Q126 101 139 90" fill="none" stroke="${LINE}" stroke-width="4" stroke-linecap="round"/>`;
  }
  return `
    <path d="M65 84 L83 102 M83 84 L65 102" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M117 84 L135 102 M135 84 L117 102" fill="none" stroke="${LINE}" stroke-width="4.5" stroke-linecap="round"/>`;
}

// ---- 四肢趴伏姿势下的尾巴形态 ----
function tailD(kind) {
  switch (kind) {
    case "up":    return "M145 152 C165 155 185 130 178 105 C174 90 156 86 148 96";
    case "curl":  return "M142 154 C172 162 192 144 182 120 C174 104 148 114 140 132";
    case "swish": return "M145 152 C170 150 190 162 194 142";
    case "puff":  return "M142 152 C165 148 180 132 175 110";
    default:      return "M145 152 C170 160 192 142 184 120";
  }
}

// ---- 【重塑】布偶猫灵魂：完美对称的双色倒V面具 ----
function faceMask(pointColor = POINT) {
  return `
    <path d="M100 48
             C125 48 142 55 146 72
             C150 90 152 105 136 114
             C130 117 124 105 118 95
             C112 85 106 72 100 72
             C94 72 88 85 82 95
             C76 105 70 117 64 114
             C48 105 50 90 54 72
             C58 55 75 48 100 48 Z"
      fill="${pointColor}"/>`;
}

// ------------------------------------------------------------
// 角色主体：更加饱满、华丽的布偶长毛质感
// ------------------------------------------------------------
function ragdoll({
  eyes = "open",
  overlay = "",
  fur = FUR,
  point = POINT,
  pointDark = POINT_DARK,
  tail = "rest",
  dx = 0,
  dy = 0,
  puff = false,
  blush = false,
} = {}) {
  const puffSvg = puff
    ? `<g fill="${point}">
         <path d="M48 114 L30 110 L40 124 Z"/>
         <path d="M44 96 L28 90 L37 104 Z"/>
         <path d="M80 44 L84 26 L93 42 Z"/>
         <path d="M120 44 L116 26 L107 42 Z"/>
         <path d="M152 114 L170 110 L160 124 Z"/>
         <path d="M156 96 L172 90 L163 104 Z"/>
       </g>`
    : "";

  const blushSvg = blush
    ? `<g fill="${NOSE}" opacity="0.6">
         <ellipse cx="56" cy="102" rx="9" ry="5"/>
         <ellipse cx="144" cy="102" rx="9" ry="5"/>
       </g>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <g transform="translate(${dx} ${dy})">
    <!-- 地面阴影 -->
    <ellipse cx="100" cy="172" rx="65" ry="8" fill="${LINE}" opacity="0.12"/>

    <!-- 尾巴 (更粗更蓬松) -->
    <path d="${tailD(tail)}" fill="none" stroke="${LINE}" stroke-width="28" stroke-linecap="round" stroke-linejoin="round" opacity="0.14"/>
    <path d="${tailD(tail)}" fill="none" stroke="${point}" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${tailD(tail)}" fill="none" stroke="${fur}" stroke-width="10" stroke-linecap="round" opacity="0.35"/>

    ${puffSvg}

    <!-- 身体后半部分 -->
    <ellipse cx="100" cy="142" rx="54" ry="32" fill="${fur}" stroke="${LINE}" stroke-width="3.5"/>

    <!-- 奢华的胸口大毛领 (Ruff) - 放在头部后面凸显立体感 -->
    <path d="M60 115 C45 130 55 155 75 160 C85 163 115 163 125 160 C145 155 155 130 140 115 C125 125 115 128 100 128 C85 128 75 125 60 115 Z" fill="${FUR_HI}" stroke="${LINE}" stroke-width="3.5" stroke-linejoin="round"/>

    <!-- 四只胖乎乎的白手套爪子 -->
    <ellipse cx="68" cy="164" rx="12" ry="8" fill="${FUR_HI}" stroke="${LINE}" stroke-width="3"/>
    <ellipse cx="132" cy="164" rx="12" ry="8" fill="${FUR_HI}" stroke="${LINE}" stroke-width="3"/>
    <ellipse cx="152" cy="158" rx="10" ry="7" fill="${FUR_HI}" stroke="${LINE}" stroke-width="2.5"/>

    <!-- 耳朵 (放在头部后面显得更自然) -->
    <g stroke="${LINE}" stroke-width="3.5" stroke-linejoin="round">
      <path d="M56 60 C42 30 62 18 78 38 C82 42 80 48 76 50 Z" fill="${pointDark}"/>
      <path d="M144 60 C158 30 138 18 122 38 C118 42 120 48 124 50 Z" fill="${pointDark}"/>
    </g>
    <!-- 耳内粉色绒毛 -->
    <path d="M60 55 C50 38 65 28 72 38 C75 42 70 48 65 52 Z" fill="${NOSE}" opacity="0.55"/>
    <path d="M140 55 C150 38 135 28 128 38 C125 42 130 48 135 52 Z" fill="${NOSE}" opacity="0.55"/>

    <!-- 头部底色与轮廓 (带毛刺边缘的包子脸颊) -->
    <path d="M100 48 C125 48 142 55 146 72 C150 90 152 105 136 114 C125 120 112 122 100 122 C88 122 75 120 64 114 C48 105 50 90 54 72 C58 55 75 48 100 48 Z" fill="${fur}" stroke="${LINE}" stroke-width="3.5" stroke-linejoin="round"/>

    <!-- 八字倒V面具 -->
    ${faceMask(point)}

    <!-- 眼睛 -->
    ${eyesSvg(eyes)}

    <!-- 腮红 -->
    ${blushSvg}

    <!-- 鼻尖与精致小嘴 -->
    <path d="M100 102 L104 96.5 C106 95 94 95 96 96.5 Z" fill="${NOSE}" stroke="${LINE}" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M100 102 L100 106 M100 106 Q94 113 88 108 M100 106 Q106 113 112 108" fill="none" stroke="${LINE}" stroke-width="2.5" stroke-linecap="round"/>

    <!-- 柔和胡须 -->
    <g stroke="${LINE}" stroke-width="1.6" stroke-linecap="round" opacity="0.4">
      <path d="M46 95 L22 91"/><path d="M44 101 L20 101"/><path d="M46 107 L24 112"/>
      <path d="M154 95 L178 91"/><path d="M156 101 L180 101"/><path d="M154 107 L176 112"/>
    </g>
  </g>
  ${overlay}
</svg>`;
}

// ------------------------------------------------------------
// Overlay UI 挂件 (保持不变)
// ------------------------------------------------------------
function bubble(x, y, w, h, stroke, fill, inner) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
    <path d="M${x + 12} ${y + h} l-6 12 l16 -11 z" fill="${fill}" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round"/>
    ${inner}`;
}

function thinkingBubble(active) {
  const dots = [137, 149, 161]
    .map((cx, i) => `<circle cx="${cx}" cy="68" r="4.5" fill="#378ADD" opacity="${i === active ? 1 : 0.28}"/>`)
    .join("");
  return bubble(120, 48, 58, 40, "#378ADD", "#E6F1FB", dots);
}

function sparkPhase(phase) {
  const up = phase === 0;
  return `<g stroke="#BA7517" stroke-width="3" stroke-linecap="round" fill="none" opacity="${up ? 1 : 0.4}">
    <path d="M150 ${up ? 92 : 98} l14 -10"/>
    <path d="M154 ${up ? 104 : 98} l16 -4"/>
  </g>`;
}

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

function zzzPhase(phase) {
  const lift = phase * 5;
  const fade = 1 - phase * 0.28;
  return `<g fill="#5F5E5A" font-family="system-ui, sans-serif" font-weight="500" opacity="${fade}">
    <text x="146" y="${78 - lift}" font-size="18">z</text>
    <text x="161" y="${60 - lift}" font-size="14">z</text>
  </g>`;
}

// ------------------------------------------------------------
// 七种状态 (保持不变)
// ------------------------------------------------------------
const VISUAL_STATES = {
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
  attention: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 1].map((i) =>
      ragdoll({ eyes: "happy", tail: "up", blush: true, overlay: sparklePhase(i) })
    ),
  },
  error: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 2].map((dx) =>
      ragdoll({
        eyes: "dead",
        fur: "#FCE8E6",
        point: "#C85A4A",
        pointDark: "#9E3C2F",
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
  sleeping: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 1, 2].map((i) =>
      ragdoll({ eyes: "shut", fur: "#F0E8DD", point: "#785C47", tail: "curl", overlay: zzzPhase(i) })
    ),
  },
};

window.VISUAL_STATES = VISUAL_STATES;