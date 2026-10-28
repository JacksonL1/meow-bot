#!/usr/bin/env node
/**
 * 生成具有全身差异化姿态的 themes/ragdoll/assets/*.svg 资源文件
 * 即使在静态预览页 (preview.html) 或不支持 JS 的 SVG 查看器中，
 * 每个状态的布偶猫也拥有截然不同的全身姿态、耳位、爪位、尾巴与眼神！
 */
const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "..", "themes", "ragdoll", "assets");
fs.mkdirSync(outDir, { recursive: true });

function renderPoseSVG(opts) {
  const {
    bodyY = 0, bodyScaleX = 1, bodyScaleY = 1, bodyRot = 0,
    headX = 0, headY = 0, headRot = 0,
    earLRot = 0, earRRot = 0,
    pawFLX = 0, pawFLY = 0, pawFLRot = 0, pawPadL = false,
    pawFRX = 0, pawFRY = 0, pawFRRot = 0, pawPadR = false,
    pawBLY = 0, pawBRY = 0,
    pupilRx = 5, pupilRy = 9, pupilDX = 0, pupilDY = 0,
    eyelidTop = 0, eyeMode = "open",
    mouthOpenRx = 0, mouthOpenRy = 0,
    tailAngle = 0,
    workDesk = false,
    fx = ""
  } = opts;

  const rad = (tailAngle * Math.PI) / 180;
  const cp1x = (142 + Math.cos(rad - 0.25) * 28).toFixed(1);
  const cp1y = (152 + bodyY * 0.6 - Math.sin(rad + 0.35) * 18).toFixed(1);
  const cp2x = (166 + Math.cos(rad * 1.25) * 26).toFixed(1);
  const cp2y = (138 + bodyY * 0.4 - Math.sin(rad * 1.25) * 24).toFixed(1);
  const endX = (178 + Math.sin(rad * 1.3) * 16).toFixed(1);
  const endY = (118 + bodyY * 0.3 - Math.cos(rad * 1.3) * 14).toFixed(1);
  const tailD = `M142 ${(152 + bodyY * 0.6).toFixed(1)} C${cp1x} ${cp1y} ${cp2x} ${cp2y} ${endX} ${endY}`;

  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="100" cy="172" rx="${(65 * (1 - bodyY * 0.01)).toFixed(1)}" ry="8" fill="#524338" opacity="0.12"/>
  <g id="rig-tail">
    <path d="${tailD}" fill="none" stroke="#524338" stroke-width="28" stroke-linecap="round"/>
    <path d="${tailD}" fill="none" stroke="#967866" stroke-width="24" stroke-linecap="round"/>
    <path d="${tailD}" fill="none" stroke="#FAF6F0" stroke-width="10" stroke-linecap="round" stroke-dasharray="28 120" stroke-dashoffset="-75"/>
  </g>
  <g id="rig-body-group" transform="translate(0 ${bodyY}) rotate(${bodyRot} 100 156) scale(${bodyScaleX} ${bodyScaleY})">
    <ellipse cx="52" cy="${158 + pawBLY}" rx="10" ry="7" fill="#FFFFFF" stroke="#524338" stroke-width="2.5"/>
    <ellipse cx="152" cy="${158 + pawBRY}" rx="10" ry="7" fill="#FFFFFF" stroke="#524338" stroke-width="2.5"/>
    <ellipse cx="100" cy="142" rx="54" ry="32" fill="#FAF6F0" stroke="#524338" stroke-width="3.5"/>
    <path d="M60 115 C45 130 55 155 75 160 C85 163 115 163 125 160 C145 155 155 130 140 115 C125 125 115 128 100 128 C85 128 75 125 60 115 Z"
          fill="#FFFFFF" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>
  </g>
  ${workDesk ? `<g><rect x="54" y="164" width="92" height="12" rx="5" fill="#362B24" stroke="#524338" stroke-width="2"/><rect x="58" y="166" width="84" height="4" rx="2" fill="#68BFFF"/></g>` : ""}
  <g id="rig-head-group" transform="translate(${headX} ${headY}) rotate(${headRot} 100 104)">
    <g transform="rotate(${earLRot} 68 54)" stroke="#524338" stroke-width="3.5" stroke-linejoin="round">
      <path d="M56 60 C42 30 62 18 78 38 C82 42 80 48 76 50 Z" fill="#7A5E4E"/>
      <path d="M60 55 C50 38 65 28 72 38 C75 42 70 48 65 52 Z" fill="#F2A7A7" opacity="0.55" stroke="none"/>
    </g>
    <g transform="rotate(${earRRot} 132 54)" stroke="#524338" stroke-width="3.5" stroke-linejoin="round">
      <path d="M144 60 C158 30 138 18 122 38 C118 42 120 48 124 50 Z" fill="#7A5E4E"/>
      <path d="M140 55 C150 38 135 28 128 38 C125 42 130 48 135 52 Z" fill="#F2A7A7" opacity="0.55" stroke="none"/>
    </g>
    <path d="M100 48 C125 48 142 55 146 72 C150 90 152 105 136 114 C125 120 112 122 100 122 C88 122 75 120 64 114 C48 105 50 90 54 72 C58 55 75 48 100 48 Z"
          fill="#FAF6F0" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M100 48 C125 48 142 55 146 72 C150 90 152 105 136 114 C130 117 124 105 118 95 C112 85 106 72 100 72 C94 72 88 85 82 95 C76 105 70 117 64 114 C48 105 50 90 54 72 C58 55 75 48 100 48 Z"
          fill="#967866"/>
    <path d="M100 48 C125 48 142 55 146 72 C150 90 152 105 136 114 C125 120 112 122 100 122 C88 122 75 120 64 114 C48 105 50 90 54 72 C58 55 75 48 100 48 Z"
          fill="none" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>
    <ellipse cx="62" cy="103" rx="6.5" ry="3.8" fill="#F2A7A7" opacity="0.38"/>
    <ellipse cx="138" cy="103" rx="6.5" ry="3.8" fill="#F2A7A7" opacity="0.38"/>
    ${eyeMode === "sleep" ? `
    <g>
      <path d="M62 93 Q74 102 86 93" fill="none" stroke="#524338" stroke-width="3.4" stroke-linecap="round"/>
      <path d="M114 93 Q126 102 138 93" fill="none" stroke="#524338" stroke-width="3.4" stroke-linecap="round"/>
    </g>` : `
    <g>
      <circle cx="74" cy="92" r="14" fill="#524338"/>
      <circle cx="74" cy="92" r="12.5" fill="#2B73B0"/>
      <circle cx="74" cy="92" r="10.5" fill="#51ABE8"/>
      <circle cx="126" cy="92" r="14" fill="#524338"/>
      <circle cx="126" cy="92" r="12.5" fill="#2B73B0"/>
      <circle cx="126" cy="92" r="10.5" fill="#51ABE8"/>
      <g class="pupils" transform="translate(${pupilDX} ${pupilDY})">
        <ellipse cx="74" cy="92" rx="${pupilRx}" ry="${pupilRy}" fill="#1A2E40"/>
        <circle cx="70.5" cy="87" r="3" fill="#FFFFFF"/>
        <circle cx="77" cy="96" r="1.5" fill="#FFFFFF" opacity="0.85"/>
        <ellipse cx="126" cy="92" rx="${pupilRx}" ry="${pupilRy}" fill="#1A2E40"/>
        <circle cx="122.5" cy="87" r="3" fill="#FFFFFF"/>
        <circle cx="129" cy="96" r="1.5" fill="#FFFFFF" opacity="0.85"/>
      </g>
      ${eyelidTop > 0 ? `<path d="M58 76 L90 76 L90 ${76 + eyelidTop} Q74 ${78 + eyelidTop} 58 ${76 + eyelidTop} Z" fill="#967866"/><path d="M110 76 L142 76 L142 ${76 + eyelidTop} Q126 ${78 + eyelidTop} 110 ${76 + eyelidTop} Z" fill="#967866"/>` : ""}
    </g>`}
    ${mouthOpenRx > 0 ? `<ellipse cx="100" cy="109" rx="${mouthOpenRx}" ry="${mouthOpenRy}" fill="#E87A82" stroke="#524338" stroke-width="1.8"/>` : ""}
    <path d="M100 102 L104 96.5 C106 95 94 95 96 96.5 Z" fill="#F2A7A7" stroke="#524338" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="M100 102 L100 106 M100 106 Q94 113 88 108 M100 106 Q106 113 112 108" fill="none" stroke="#524338" stroke-width="2.5" stroke-linecap="round"/>
    <g stroke="#524338" stroke-width="1.6" stroke-linecap="round" opacity="0.42">
      <path d="M46 95 L22 91"/><path d="M44 101 L20 101"/><path d="M46 107 L24 112"/>
      <path d="M154 95 L178 91"/><path d="M156 101 L180 101"/><path d="M154 107 L176 112"/>
    </g>
  </g>
  <g transform="translate(${pawFLX} ${pawFLY}) rotate(${pawFLRot} 68 158)">
    <ellipse cx="68" cy="164" rx="12" ry="8" fill="#FFFFFF" stroke="#524338" stroke-width="3"/>
    ${pawPadL ? `<ellipse cx="68" cy="165" rx="4" ry="3" fill="#F2A7A7"/>` : ""}
  </g>
  <g transform="translate(${pawFRX} ${pawFRY}) rotate(${pawFRRot} 132 158)">
    <ellipse cx="132" cy="164" rx="12" ry="8" fill="#FFFFFF" stroke="#524338" stroke-width="3"/>
    ${pawPadR ? `<ellipse cx="132" cy="165" rx="4" ry="3" fill="#F2A7A7"/>` : ""}
  </g>
  ${fx}
</svg>`;
}

const framesToGenerate = {
  "idle-1.svg": { bodyY: 0, tailAngle: 0 },
  "idle-2.svg": { bodyY: 1.5, bodyScaleX: 1.02, bodyScaleY: 0.98, headY: 1.5, tailAngle: 10 },
  "idle-3.svg": { bodyY: 0.5, earLRot: -8, tailAngle: -8, eyelidTop: 3 },

  "thinking-1.svg": {
    bodyY: 2, headX: 4, headY: 2, headRot: 13, earLRot: 6, earRRot: -14,
    pawFRX: -14, pawFRY: -38, pawFRRot: -25, pawPadR: true, pupilDX: -2, pupilDY: -2.5, eyelidTop: 2, tailAngle: -6,
    fx: `<circle cx="152" cy="54" r="3" fill="#FFF" stroke="#524338" stroke-width="2"/><rect x="154" y="14" width="38" height="24" rx="12" fill="#FFF" stroke="#524338" stroke-width="2.4"/><circle cx="165" cy="26" r="2.2" fill="#2B73B0"/>`
  },
  "thinking-2.svg": {
    bodyY: 2.5, headX: 5, headY: 3, headRot: 15, earLRot: 8, earRRot: -16,
    pawFRX: -14, pawFRY: -40, pawFRRot: -28, pawPadR: true, pupilDX: 2, pupilDY: -2.5, eyelidTop: 2.5, tailAngle: 4,
    fx: `<circle cx="152" cy="54" r="3" fill="#FFF" stroke="#524338" stroke-width="2"/><circle cx="160" cy="44" r="4.5" fill="#FFF" stroke="#524338" stroke-width="2"/><rect x="154" y="12" width="38" height="24" rx="12" fill="#FFF" stroke="#524338" stroke-width="2.4"/><circle cx="165" cy="24" r="2.2" fill="#2B73B0"/><circle cx="173" cy="24" r="2.2" fill="#2B73B0"/>`
  },
  "thinking-3.svg": {
    bodyY: 2, headX: 4, headY: 2, headRot: 12, earLRot: 5, earRRot: -12,
    pawFRX: -14, pawFRY: -36, pawFRRot: -22, pawPadR: true, pupilDX: 0, pupilDY: -3, eyelidTop: 2, tailAngle: 10,
    fx: `<circle cx="152" cy="54" r="3" fill="#FFF" stroke="#524338" stroke-width="2"/><circle cx="160" cy="44" r="4.5" fill="#FFF" stroke="#524338" stroke-width="2"/><rect x="154" y="14" width="38" height="24" rx="12" fill="#FFF" stroke="#524338" stroke-width="2.4"/><circle cx="165" cy="26" r="2.2" fill="#2B73B0"/><circle cx="173" cy="26" r="2.2" fill="#2B73B0"/><circle cx="181" cy="26" r="2.2" fill="#2B73B0"/>`
  },

  "working-1.svg": {
    bodyY: 5.5, bodyScaleX: 1.06, bodyScaleY: 0.93, headX: -2, headY: 6.5, earLRot: -16, earRRot: 16,
    pawFLX: 6, pawFLY: -7, pawFRX: -6, pawFRY: 1, pupilRx: 4.2, pupilDX: -2.5, pupilDY: 2, workDesk: true, tailAngle: 15
  },
  "working-2.svg": {
    bodyY: 6.2, bodyScaleX: 1.07, bodyScaleY: 0.92, headX: 0, headY: 7.5, earLRot: -18, earRRot: 18,
    pawFLX: 6, pawFLY: 1, pawFRX: -6, pawFRY: -7, pupilRx: 4.2, pupilDX: 0, pupilDY: 2.2, workDesk: true, tailAngle: -12
  },
  "working-3.svg": {
    bodyY: 5.5, bodyScaleX: 1.06, bodyScaleY: 0.93, headX: 2, headY: 6.5, earLRot: -16, earRRot: 16,
    pawFLX: 6, pawFLY: -7, pawFRX: -6, pawFRY: 1, pupilRx: 4.2, pupilDX: 2.5, pupilDY: 2, workDesk: true, tailAngle: 18
  },
  "working-4.svg": {
    bodyY: 6.2, bodyScaleX: 1.07, bodyScaleY: 0.92, headX: 0, headY: 7.5, earLRot: -18, earRRot: 18,
    pawFLX: 6, pawFLY: 1, pawFRX: -6, pawFRY: -7, pupilRx: 4.2, pupilDX: 0, pupilDY: 2.2, workDesk: true, tailAngle: -15
  },

  "attention-1.svg": {
    bodyY: -7.5, bodyScaleX: 0.93, bodyScaleY: 1.09, headY: -9.5, earLRot: 9, earRRot: -9,
    pupilRx: 7.6, pupilRy: 10.2, mouthOpenRx: 2.2, mouthOpenRy: 1.8, tailAngle: 24,
    fx: `<path d="M100 8 L100 22" stroke="#E85D56" stroke-width="5" stroke-linecap="round"/><circle cx="100" cy="30" r="2.8" fill="#E85D56"/>`
  },
  "attention-2.svg": {
    bodyY: -6.5, bodyScaleX: 0.94, bodyScaleY: 1.08, headY: -8.5, earLRot: 11, earRRot: -11,
    pupilRx: 7.8, pupilRy: 10.4, mouthOpenRx: 2.0, mouthOpenRy: 1.6, tailAngle: 20,
    fx: `<path d="M100 6 L100 20" stroke="#E85D56" stroke-width="5" stroke-linecap="round"/><circle cx="100" cy="28" r="2.8" fill="#E85D56"/><path d="M84 14 L76 6 M116 14 L124 6" stroke="#F59E0B" stroke-width="3" stroke-linecap="round"/>`
  },

  "notification-1.svg": {
    bodyY: -2, headX: -3, headY: -4, headRot: -10, pawFLX: -10, pawFLY: -38, pawFLRot: 22, pawPadL: true,
    pupilRx: 6.8, mouthOpenRx: 4.2, mouthOpenRy: 3.4, tailAngle: 12
  },
  "notification-2.svg": {
    bodyY: -3, headX: -4, headY: -5, headRot: -12, pawFLX: -16, pawFLY: -44, pawFLRot: 32, pawPadL: true,
    pupilRx: 6.8, mouthOpenRx: 2.0, mouthOpenRy: 1.5, tailAngle: -10
  },
  "notification-3.svg": {
    bodyY: -2, headX: -3, headY: -4, headRot: -9, pawFLX: -8, pawFLY: -38, pawFLRot: 18, pawPadL: true,
    pupilRx: 6.8, mouthOpenRx: 4.5, mouthOpenRy: 3.6, tailAngle: 16
  },
  "notification-4.svg": {
    bodyY: -3, headX: -4, headY: -5, headRot: -11, pawFLX: -14, pawFLY: -42, pawFLRot: 28, pawPadL: true,
    pupilRx: 6.8, mouthOpenRx: 1.5, mouthOpenRy: 1.2, tailAngle: -8
  },

  "error-1.svg": {
    bodyY: -3, bodyScaleX: 1.08, bodyScaleY: 0.95, headX: -2, headY: -2, headRot: -4, earLRot: -36, earRRot: 36,
    pawFLX: -6, pawFLY: -6, pawFRX: 6, pawFRY: -6, pupilRx: 2.1, mouthOpenRx: 3.5, mouthOpenRy: 2.5, tailAngle: 22,
    fx: `<path d="M94 8 L108 22 M108 8 L94 22" stroke="#E11D48" stroke-width="4.5" stroke-linecap="round"/>`
  },
  "error-2.svg": {
    bodyY: -3, bodyScaleX: 1.09, bodyScaleY: 0.94, headX: 2, headY: -2, headRot: 4, earLRot: -38, earRRot: 38,
    pawFLX: -6, pawFLY: -8, pawFRX: 6, pawFRY: -8, pupilRx: 2.0, mouthOpenRx: 3.8, mouthOpenRy: 2.8, tailAngle: -18,
    fx: `<path d="M94 8 L108 22 M108 8 L94 22" stroke="#E11D48" stroke-width="4.5" stroke-linecap="round"/>`
  },

  "sleeping-1.svg": {
    bodyY: 8.5, bodyScaleX: 1.09, bodyScaleY: 0.87, headX: 2, headY: 13.5, headRot: 6.5, earLRot: -14, earRRot: 14,
    pawFLX: 10, pawFLY: 2, pawFRX: -10, pawFRY: 2, eyeMode: "sleep", tailAngle: -24,
    fx: `<text x="142" y="58" font-family="sans-serif" font-weight="bold" font-size="14" fill="#7A5E4E">z</text>`
  },
  "sleeping-2.svg": {
    bodyY: 9.5, bodyScaleX: 1.12, bodyScaleY: 0.85, headX: 2, headY: 15, headRot: 7.5, earLRot: -16, earRRot: 16,
    pawFLX: 10, pawFLY: 2, pawFRX: -10, pawFRY: 2, eyeMode: "sleep", tailAngle: -26,
    fx: `<text x="142" y="58" font-family="sans-serif" font-weight="bold" font-size="14" fill="#7A5E4E">z</text><text x="156" y="42" font-family="sans-serif" font-weight="bold" font-size="18" fill="#524338">Z</text>`
  },
  "sleeping-3.svg": {
    bodyY: 8.8, bodyScaleX: 1.10, bodyScaleY: 0.86, headX: 2, headY: 14, headRot: 6.8, earLRot: -15, earRRot: 15,
    pawFLX: 10, pawFLY: 2, pawFRX: -10, pawFRY: 2, eyeMode: "sleep", tailAngle: -25,
    fx: `<text x="156" y="42" font-family="sans-serif" font-weight="bold" font-size="18" fill="#7A5E4E">Z</text><text x="170" y="24" font-family="sans-serif" font-weight="bold" font-size="22" fill="#524338">Z</text>`
  },

  // walking 不生成：clawd-starter 的状态机只有 7 个状态（见 src/theme.js 的 STATE_NAMES），
  // 没有 walking。曾经生成过 4 帧、主题里也声明了，结果那 4 帧**永远不可能被播到**，
  // 而加载一切正常、不报任何错。主仓库 clawd-on-desk 才有自由漫游，才需要走路。
};

for (const [filename, opts] of Object.entries(framesToGenerate)) {
  fs.writeFileSync(path.join(outDir, filename), renderPoseSVG(opts), "utf8");
}
console.log(`Generated ${Object.keys(framesToGenerate).length} full-body posed Ragdoll SVG frames in ${outDir}`);
