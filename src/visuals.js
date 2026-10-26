"use strict";
// ============================================================
// S3  状态 → 帧序列 的映射表
//
// 相比 S2 的单帧，这里每个状态是一个 { fps, eyeTracking, frames[] }：
//   frames      同一状态的若干张图，按 fps 轮播 = 动画
//   eyeTracking 只有"睁眼"的帧才有 .pupils 节点，能跟鼠标转
//
// 到 S7 这份数据会搬进 themes/<name>/theme.json，代码一行都不用改。
// ============================================================

const FILL = "#D85A30";
const LINE = "#993C1D";

// 瞳孔单独包一层 <g class="pupils">，渲染层靠它找目标做位移
function eyesSvg(kind) {
  if (kind === "open") {
    return `
      <circle cx="82" cy="112" r="12" fill="#fff" stroke="${LINE}" stroke-width="2"/>
      <circle cx="118" cy="112" r="12" fill="#fff" stroke="${LINE}" stroke-width="2"/>
      <g class="pupils">
        <circle cx="85" cy="115" r="5.5" fill="#2C2C2A"/>
        <circle cx="121" cy="115" r="5.5" fill="#2C2C2A"/>
      </g>`;
  }
  if (kind === "happy") {
    return `
      <path d="M70 116 q12 -15 24 0" fill="none" stroke="#2C2C2A" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M106 116 q12 -15 24 0" fill="none" stroke="#2C2C2A" stroke-width="4.5" stroke-linecap="round"/>`;
  }
  if (kind === "shut") {
    return `
      <path d="M70 114 h24" fill="none" stroke="#2C2C2A" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M106 114 h24" fill="none" stroke="#2C2C2A" stroke-width="4.5" stroke-linecap="round"/>`;
  }
  return `
    <path d="M72 103 l18 18 M90 103 l-18 18" fill="none" stroke="#4A1B0C" stroke-width="4" stroke-linecap="round"/>
    <path d="M110 103 l18 18 M128 103 l-18 18" fill="none" stroke="#4A1B0C" stroke-width="4" stroke-linecap="round"/>`;
}

// dx / dy 只作用于身体，气泡不跟着抖 —— 否则整张图会像在抽搐
function crab({ eyes = "open", overlay = "", fill = FILL, dx = 0, dy = 0 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <g transform="translate(${dx} ${dy})">
    <ellipse cx="100" cy="180" rx="46" ry="8" fill="#2C2C2A" opacity="0.10"/>
    <g fill="none" stroke="${LINE}" stroke-width="4" stroke-linecap="round">
      <path d="M64 152 L52 172"/><path d="M78 158 L72 178"/><path d="M92 162 L90 180"/>
      <path d="M136 152 L148 172"/><path d="M122 158 L128 178"/><path d="M108 162 L110 180"/>
    </g>
    <ellipse cx="40" cy="128" rx="18" ry="13" fill="${fill}" stroke="${LINE}" stroke-width="3.5" transform="rotate(-18 40 128)"/>
    <ellipse cx="160" cy="128" rx="18" ry="13" fill="${fill}" stroke="${LINE}" stroke-width="3.5" transform="rotate(18 160 128)"/>
    <ellipse cx="100" cy="126" rx="54" ry="42" fill="${fill}" stroke="${LINE}" stroke-width="3.5"/>
    <ellipse cx="100" cy="144" rx="32" ry="19" fill="#F0997B" opacity="0.6"/>
    <path d="M92 141 q8 8 16 0" fill="none" stroke="#4A1B0C" stroke-width="3.5" stroke-linecap="round" opacity="0.8"/>
    ${eyesSvg(eyes)}
  </g>
  ${overlay}
</svg>`;
}

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

const VISUAL_STATES = {
  // 单帧：静止时的"活气"完全靠眼球追踪，不需要帧序列
  idle: {
    fps: 2,
    eyeTracking: true,
    frames: [crab({ eyes: "open" })],
  },

  thinking: {
    fps: 6,
    eyeTracking: true,
    frames: [0, 1, 2].map((i) => crab({ eyes: "open", overlay: thinkingBubble(i) })),
  },

  // 四帧：身体上下轻颠 + 火花交错 = 打字感
  working: {
    fps: 8,
    eyeTracking: true,
    frames: [
      crab({ eyes: "open", dy: 0, overlay: sparkPhase(0) }),
      crab({ eyes: "open", dy: -2, overlay: sparkPhase(1) }),
      crab({ eyes: "open", dy: 0, overlay: sparkPhase(0) }),
      crab({ eyes: "open", dy: -1, overlay: sparkPhase(1) }),
    ],
  },

  attention: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 1].map((i) => crab({ eyes: "happy", overlay: sparklePhase(i) })),
  },

  error: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 2].map((dx) =>
      crab({
        eyes: "dead",
        fill: "#BF4D2C",
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
    frames: [0, 1, 2, 3].map((i) => crab({ eyes: "open", overlay: bellPhase(i) })),
  },

  sleeping: {
    fps: 3,
    eyeTracking: false,
    frames: [0, 1, 2].map((i) => crab({ eyes: "shut", fill: "#C65432", overlay: zzzPhase(i) })),
  },
};

window.VISUAL_STATES = VISUAL_STATES;
