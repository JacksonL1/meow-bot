/**
 * Meow-Bot Upgraded Renderer (v2.0)
 * ---------------------------------------------------------------------------
 * 解决原版痛点：
 * 1. 彻底告别 `setInterval` (2~8fps) 硬切跳帧与 `#layerA/#layerB` 160ms 透明度重影叠化。
 * 2. 引入 60fps 二阶胡克定律弹簧阻尼骨骼引擎 (RagdollSpringRig)：
 *    - 身体、头部、左右耳、左右前爪、后爪、瞳孔缩放、上下眼睑各自拥有独立的弹簧刚度(k)与阻尼(c)。
 *    - 状态切换时产生自然的预备微缩、重心转移、惯性过冲 (Overshoot) 与次级动作滞后跟随 (Follow-through)。
 * 3. 8 大状态全部具备截然不同的全身姿态 (Full-Body Pose)：
 *    - idle: 柔和呼吸起伏 + 尾巴双频 S 型摆动 + 随机自然眨眼(含双连眨) + 偶发单耳抖动 + 视线带动头部/胡须立体视差
 *    - thinking: 歪头 14° + 身体微倾 + 右爪抬起托腮思考 + 眼珠斜上看左右扫视 + 浮动思考气泡
 *    - working: 伏案重心压低 + 半飞机耳 + 左右前爪 10Hz 交替高速敲击发光小键盘 + 头部随打字扫视
 *    - attention: 警觉立姿挺胸 (重心拔高) + 双耳高竖 + 蓝宝石瞳孔瞬间放大发亮 + 尾巴竖直微颤
 *    - notification: 轻快歪头 + 左爪高抬挥手招猫 (露出粉色肉垫) + 张嘴“喵~”叫 + 弯月笑眼/亮眼切换
 *    - error: 受惊后缩拱背 + 彻底压平飞机耳 + 瞳孔急剧收缩成细竖线 + 高频受惊颤抖 + 尾巴炸毛甩动
 *    - sleeping: 团身压扁成圆猫球 + 头部深埋枕在前爪上 + 温柔弯月闭眼 + 深慢睡眠呼吸与呼噜微震 + 动态飘升 zZz
 *    - walking: 四肢猫步相位交替迈步 + 躯干双倍频上下轻弹与重心摇摆 + 尾巴高翘平衡
 * 4. 保留对其他非骨骼主题（没写 `rigType` 的第三方主题与内置兜底画面）的完整向后兼容。
 */

const stage = document.getElementById("stage");
const pet = document.getElementById("pet");
const layers = [
  document.getElementById("layerA"),
  document.getElementById("layerB")
];

let activeLayer = 0;
let currentTheme = null;
let currentState = "idle";
let frameTimer = null;
let frameIndex = 0;
let lastGaze = { x: 0, y: 0 };
// 表情变体：每个状态自己在「主资产 + 变体」这个列表里走到第几个。
// 按状态存，所以 idle 走到第 2 套不会影响 thinking 的进度。
const variantCursor = Object.create(null);
// 当前实际在播的那套（主资产时为 null）。applyGaze 也看它——
// 变体可以自己声明 eyeTracking，不能一律照抄主资产。
let activeVariant = null;

// ============================================================================
// SVG 白名单清洗（主题资产的唯一出口）
// ----------------------------------------------------------------------------
// 骨骼引擎自己拼的 SVG 是**我们代码里的字符串**，可以直接进 DOM；
// 但非骨骼主题（没写 rigType 的第三方主题）的帧来自 themes/ 下的磁盘文件，是**不可信输入**，
// 必须过这一关。曾经的写法是 `nextEl.innerHTML = frames.join("")`——
// 一行代码就把白名单整个绕开了。这里把它补回来。
//
// 白名单定案与逐条理由见 SECURITY.md「S7 主题系统：白名单定案」，只记结论：
//   · 放行 clipPath / mask / filter，因为主题没有它们就只能画硬边
//   · 滤镜图元**逐个列举**，不用 fe* 通配
//   · feImage 拒（唯一用途就是从 href 拉外部图片）
//   · feTurbulence / feDisplacementMap 拒（CPU 炸弹）
//   · style 标签拒（能写 @import，能做整页 CSS 覆盖）
//   · foreignObject / animate / set 拒（HTML 注入与运行时改 href）
const ALLOWED_TAGS = new Set([
  "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse",
  "line", "polyline", "polygon", "text", "tspan",
  "lineargradient", "radialgradient", "stop", "use",
  "clippath", "mask", "filter",
  "fegaussianblur", "feoffset", "fedropshadow", "fecolormatrix",
  "feblend", "fecomposite", "feflood", "femerge", "femergenode",
]);

// Chrome 对超大模糊半径是同步算的，一个 stdDeviation="9999" 就是一次卡死。
const BLUR_TAGS = new Set(["fegaussianblur", "fedropshadow"]);
const MAX_STD_DEVIATION = 40;

function clampStdDeviation(el) {
  if (!BLUR_TAGS.has(el.nodeName.toLowerCase())) return;
  const raw = el.getAttribute("stdDeviation");
  if (!raw) return;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (!parts.length || !parts.every(Number.isFinite)) {
    el.removeAttribute("stdDeviation");
    return;
  }
  el.setAttribute("stdDeviation", parts.map((n) => Math.min(MAX_STD_DEVIATION, Math.max(0, n))).join(" "));
}

function sanitizeSvg(doc) {
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;

  for (const el of [...root.querySelectorAll("*")]) {
    if (!ALLOWED_TAGS.has(el.nodeName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      const bad =
        name.startsWith("on") ||
        ((name === "href" || name === "xlink:href") && !value.trim().startsWith("#")) ||
        /javascript:/i.test(value) ||
        // url(#id) 是本地引用，放行；url(http…)/url(data…) 会发外部请求，拦掉。
        /url\s*\(\s*['"]?(?!\s*#)/i.test(value);
      if (bad) el.removeAttribute(attr.name);
    }
    clampStdDeviation(el);
  }
  return document.importNode(root, true);
}

function svgNode(markup) {
  const doc = new DOMParser().parseFromString(String(markup).trim(), "image/svg+xml");
  if (doc.querySelector("parsererror")) return null; // 格式都不对，别硬塞进 DOM
  return sanitizeSvg(doc);
}


// ============================================================================
// 二阶弹簧阻尼物理通道 (Second-Order Spring-Damper Channel)
// ============================================================================
class SpringChannel {
  constructor(initial = 0, stiffness = 140, damping = 16) {
    this.pos = initial;
    this.vel = 0;
    this.target = initial;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  setTarget(val, stiffnessOverride, dampingOverride) {
    this.target = val;
    if (stiffnessOverride !== undefined) this.stiffness = stiffnessOverride;
    if (dampingOverride !== undefined) this.damping = dampingOverride;
  }

  impulse(dv) {
    this.vel += dv;
  }

  step(dt) {
    // 为防止后台切回时 dt 过大导致物理爆炸，做分步约束
    const safeDt = Math.min(dt, 0.05);
    const force = -this.stiffness * (this.pos - this.target) - this.damping * this.vel;
    this.vel += force * safeDt;
    this.pos += this.vel * safeDt;
    return this.pos;
  }
}

// ============================================================================
// 布偶猫骨骼化 SVG 模板 (Hierarchical Rigged SVG)
// 保持原版 200x200 viewBox、原版奶油白/重点色/蓝宝石瞳配色，拆分为可独立受控的骨骼层
// ============================================================================
function createRiggedRagdollSVG() {
  return `<svg class="frame on ragdoll-rig-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="eyeIrisGrad" cx="45%" cy="40%" r="55%">
      <stop offset="0%" stop-color="#68BFFF"/>
      <stop offset="65%" stop-color="#2B73B0"/>
      <stop offset="100%" stop-color="#1B4F82"/>
    </radialGradient>
    <linearGradient id="kbGlow" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#68BFFF" stop-opacity="0.85"/>
      <stop offset="50%" stop-color="#F2A7A7" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#68BFFF" stop-opacity="0.85"/>
    </linearGradient>
  </defs>

  <!-- 1. 地面投影 (#rig-shadow) -->
  <ellipse id="rig-shadow" cx="100" cy="172" rx="65" ry="8" fill="#524338" opacity="0.13"/>

  <!-- 2. 多段柔性贝塞尔尾巴 (#rig-tail) -->
  <g id="rig-tail">
    <path id="rig-tail-border" d="M142 152 C170 160 192 142 184 118" fill="none" stroke="#524338" stroke-width="28" stroke-linecap="round"/>
    <path id="rig-tail-main" d="M142 152 C170 160 192 142 184 118" fill="none" stroke="#967866" stroke-width="24" stroke-linecap="round"/>
    <path id="rig-tail-tip" d="M168 143 C182 136 189 128 184 118" fill="none" stroke="#FAF6F0" stroke-width="11" stroke-linecap="round"/>
  </g>

  <!-- 3. 躯干与后爪组 (#rig-body-group) -->
  <g id="rig-body-group" style="transform-origin: 100px 156px;">
    <!-- 左后爪与右后爪 -->
    <ellipse id="rig-paw-bl" cx="57" cy="168" rx="11" ry="7.5" fill="#FFFFFF" stroke="#524338" stroke-width="2.5"/>
    <ellipse id="rig-paw-br" cx="143" cy="168" rx="11" ry="7.5" fill="#FFFFFF" stroke="#524338" stroke-width="2.5"/>

    <!-- 蹲坐的躯体（手绘 path，不是椭圆）。
         原来是 rx54×ry32 的正椭圆，观感是一颗球：头宽 104、身体宽 108，上下一样粗就成了雪人。
         而**完美椭圆弧本身就是「圆」的来源**——动物身上没有一条纯椭圆轮廓。
         现在是：肩在 y112 处宽 56（整个被头盖住）、腰在 y146 处最宽 100、底部 y177 收成略平的圆角。
         头宽 104 ≈ 身体最宽 100，头压住肩，读起来才是「坐着的一只猫」。
         动这条要连着看三处：后爪（cx 57/143，只在底部露出一牙月牙）、
         前爪（cx 68/132，必须落在身体内）、working 的键盘（y162 起，压在身体下沿）。 -->
    <path id="rig-torso"
          d="M72 112 C59 114 50 130 50 146 C50 162 54 172 66 174 C80 177 120 177 134 174 C146 172 150 162 150 146 C150 130 141 114 128 112 Z"
          fill="#FAF6F0" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>
      <!-- 高级感金色 "RAG" 衬线字体，带有轻微描边以契合整体画风 -->
      <text x="100" y="142" font-family="Georgia, serif" font-weight="900" font-size="14" fill="#D4AF37" text-anchor="middle" letter-spacing="2" stroke="#524338" stroke-width="0.8">RAG</text>
    <!-- 原来这里还有一块 #rig-torso-patch（cx112 cy134 rx34 ry18 的米色椭圆，opacity 0.65），
         注释写的是"背部柔毛轮廓"，实际读起来是肚子上一块**污渍**：硬边、没有描边、
         颜色比身体暗一档、位置还偏右上（不在身体中心）。
         删掉。体积感有描边、呼吸缩放和地面阴影三样就够，白猫的肚子本来就该是白的。 -->
  </g>

  <!-- 4. 工作状态专属：桌前敲键盘 (#rig-work-desk)
       左边立着深色编辑器窗口（代码一行一行长出来），身前横一只键盘，两只前爪交替敲。
       位置取舍：窗口避开脸（y>122），键盘压在身前——
       前爪画在更后面，所以爪子会盖在键上，读起来就是「按着键」。 -->
  <g id="rig-work-desk" opacity="0">
    <!-- 4a. 编辑器窗口 -->
    <g id="rig-monitor">
      <rect x="8" y="124" width="48" height="36" rx="4.5" fill="#2B2F3A" stroke="#12141A" stroke-width="2"/>
      <path d="M8 130 C8 126.6 10.6 124 14 124 L42 124 C45.4 124 48 126.6 48 130 L48 133 L8 133 Z" fill="#3A3F4B"/>
      <circle cx="14" cy="128.5" r="1.8" fill="#FF5F57"/>
      <circle cx="20" cy="128.5" r="1.8" fill="#FEBC2E"/>
      <circle cx="26" cy="128.5" r="1.8" fill="#28C840"/>
      <!-- 代码行：宽度与透明度由渲染层按时间推进（生长 → 淡出换下一行）。
           窗口下沿停在 160，键盘从 162 起——差 2px，不然窗口底边会被键盘切掉。 -->
      <rect id="rig-code-1" x="13" y="137" width="10" height="3.2" rx="1.6" fill="#68BFFF"/>
      <rect id="rig-code-2" x="13" y="143" width="10" height="3.2" rx="1.6" fill="#F2A7A7"/>
      <rect id="rig-code-3" x="13" y="149" width="10" height="3.2" rx="1.6" fill="#9AE6B4"/>
      <rect id="rig-code-caret" x="24" y="149" width="3.4" height="3.2" fill="#FFFFFF"/>
    </g>

    <!-- 4b. 键盘（#rig-keyboard 是整块底座，#rig-kb-glow 是敲击时的呼吸灯） -->
    <g id="rig-keyboard">
      <rect x="44" y="162" width="112" height="20" rx="5" fill="#E8DFD5" stroke="#524338" stroke-width="2.5"/>
      <rect id="rig-kb-glow" x="48" y="164.6" width="104" height="2.6" rx="1.3" fill="url(#kbGlow)" opacity="0.5"/>
      <g fill="#FAF6F0" stroke="#524338" stroke-width="1">
        <rect x="50" y="167" width="14" height="5.5" rx="1.5"/>
        <rect x="67" y="167" width="14" height="5.5" rx="1.5"/>
        <rect x="84" y="167" width="14" height="5.5" rx="1.5"/>
        <rect x="101" y="167" width="14" height="5.5" rx="1.5"/>
        <rect x="118" y="167" width="14" height="5.5" rx="1.5"/>
        <rect x="135" y="167" width="14" height="5.5" rx="1.5"/>
        <rect x="50" y="173.5" width="14" height="5" rx="1.5"/>
        <rect x="67" y="173.5" width="14" height="5" rx="1.5"/>
        <rect x="84" y="173.5" width="14" height="5" rx="1.5"/>
        <rect x="101" y="173.5" width="14" height="5" rx="1.5"/>
        <rect x="118" y="173.5" width="14" height="5" rx="1.5"/>
        <rect x="135" y="173.5" width="14" height="5" rx="1.5"/>
      </g>
    </g>
  </g>

  <!-- 5. 头部总成 (#rig-head-group)：压在躯干上沿、前爪根据动作可在前后切换 -->
  <g id="rig-head-group" style="transform-origin: 100px 104px;">
    <!-- 左耳 (#rig-ear-l) -->
    <g id="rig-ear-l" style="transform-origin: 68px 54px;">
      <path d="M56 60 C42 30 62 18 78 38 C82 42 80 48 76 50 Z" fill="#7A5E4E" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M60 55 C50 38 65 28 72 38 C75 42 70 48 65 52 Z" fill="#F2A7A7" opacity="0.6"/>
      <path d="M62 52 L56 45 M66 49 L62 41" stroke="#FAF6F0" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/>
    </g>

    <!-- 右耳 (#rig-ear-r) -->
    <g id="rig-ear-r" style="transform-origin: 132px 54px;">
      <path d="M144 60 C158 30 138 18 122 38 C118 42 120 48 124 50 Z" fill="#7A5E4E" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M140 55 C150 38 135 28 128 38 C125 42 130 48 135 52 Z" fill="#F2A7A7" opacity="0.6"/>
      <path d="M138 52 L144 45 M134 49 L138 41" stroke="#FAF6F0" stroke-width="1.6" stroke-linecap="round" opacity="0.75"/>
    </g>

    <!-- 头部底色与包子脸轮廓 -->
    <path id="rig-head-base"
          d="M100 48 C125 48 142 55 146 72 C150 90 152 105 136 114 C125 120 112 122 100 122 C88 122 75 120 64 114 C48 105 50 90 54 72 C58 55 75 48 100 48 Z"
          fill="#FAF6F0" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>

    <!-- 八字倒 V 重点色面具 -->
    <path id="rig-face-mask"
          d="M100 48 C125 48 142 55 146 72 C150 90 152 105 136 114 C130 117 124 105 118 95 C112 85 106 72 100 72 C94 72 88 85 82 95 C76 105 70 117 64 114 C48 105 50 90 54 72 C58 55 75 48 100 48 Z"
          fill="#967866"/>
    <!-- 重绘头部外轮廓线使其压住面具边缘 -->
    <path d="M100 48 C125 48 142 55 146 72 C150 90 152 105 136 114 C125 120 112 122 100 122 C88 122 75 120 64 114 C48 105 50 90 54 72 C58 55 75 48 100 48 Z"
          fill="none" stroke="#524338" stroke-width="3.5" stroke-linejoin="round"/>

    <!-- 脸颊粉嫩腮红 -->
    <ellipse id="rig-blush-l" cx="62" cy="103" rx="6.5" ry="3.8" fill="#F2A7A7" opacity="0.38"/>
    <ellipse id="rig-blush-r" cx="138" cy="103" rx="6.5" ry="3.8" fill="#F2A7A7" opacity="0.38"/>

    <!-- 眼部总成 (#rig-eyes) -->
    <g id="rig-eyes">
      <!-- 睁眼组 (#rig-eyes-open) -->
      <g id="rig-eyes-open" style="transform-origin: 100px 92px;">
        <!-- 左眼眶与渐变蓝虹膜 -->
        <circle cx="74" cy="92" r="14" fill="#524338"/>
        <circle cx="74" cy="92" r="12.5" fill="#2B73B0"/>
        <circle cx="74" cy="92" r="10.8" fill="url(#eyeIrisGrad)"/>
        <!-- 右眼眶与渐变蓝虹膜 -->
        <circle cx="126" cy="92" r="14" fill="#524338"/>
        <circle cx="126" cy="92" r="12.5" fill="#2B73B0"/>
        <circle cx="126" cy="92" r="10.8" fill="url(#eyeIrisGrad)"/>

        <!-- 瞳孔与高光组 (.pupils) -->
        <g class="pupils" id="rig-pupils">
          <ellipse id="rig-pupil-l" cx="74" cy="92" rx="5" ry="9" fill="#1A2E40"/>
          <circle id="rig-shine-l1" cx="70.5" cy="87" r="3.1" fill="#FFFFFF"/>
          <circle id="rig-shine-l2" cx="77" cy="96" r="1.6" fill="#FFFFFF" opacity="0.88"/>

          <ellipse id="rig-pupil-r" cx="126" cy="92" rx="5" ry="9" fill="#1A2E40"/>
          <circle id="rig-shine-r1" cx="122.5" cy="87" r="3.1" fill="#FFFFFF"/>
          <circle id="rig-shine-r2" cx="129" cy="96" r="1.6" fill="#FFFFFF" opacity="0.88"/>
        </g>

        <!-- 动态上下眼睑遮罩 (用于平滑眨眼、半眯眼、专注眼神) -->
        <path id="rig-eyelid-top-l" d="M58 76 Q74 76 90 76 L90 74 L58 74 Z" fill="#967866"/>
        <path id="rig-eyelid-top-r" d="M110 76 Q126 76 142 76 L142 74 L110 74 Z" fill="#967866"/>
      </g>

      <!-- 闭眼/睡眠/开心笑眼弧线组 (#rig-eyes-closed) -->
      <g id="rig-eyes-closed" opacity="0">
        <!-- 睡眠温柔下弯弧线 -->
        <path id="rig-eye-sleep-l" d="M62 93 Q74 102 86 93" fill="none" stroke="#524338" stroke-width="3.4" stroke-linecap="round"/>
        <path id="rig-eye-sleep-r" d="M114 93 Q126 102 138 93" fill="none" stroke="#524338" stroke-width="3.4" stroke-linecap="round"/>
        <!-- 睫毛小细节 -->
        <path id="rig-eye-lash-l" d="M63 95 L59 98 M74 99 L74 103" stroke="#524338" stroke-width="2.2" stroke-linecap="round"/>
        <path id="rig-eye-lash-r" d="M137 95 L141 98 M126 99 L126 103" stroke="#524338" stroke-width="2.2" stroke-linecap="round"/>
      </g>

      <!-- 开心弯月笑眼组 (#rig-eyes-happy) -->
      <g id="rig-eyes-happy" opacity="0">
        <path d="M62 94 Q74 82 86 94" fill="none" stroke="#524338" stroke-width="3.6" stroke-linecap="round"/>
        <path d="M114 94 Q126 82 138 94" fill="none" stroke="#524338" stroke-width="3.6" stroke-linecap="round"/>
      </g>
    </g>

    <!-- 鼻子与嘴巴组 (#rig-muzzle) -->
    <g id="rig-muzzle" style="transform-origin: 100px 104px;">
      <!-- 粉色张嘴内腔 (喵叫/吃惊时显现) -->
      <ellipse id="rig-mouth-open" cx="100" cy="109" rx="0" ry="0" fill="#E87A82" stroke="#524338" stroke-width="1.8" opacity="0"/>
      <!-- 鼻子 -->
      <path id="rig-nose" d="M100 102 L104 96.5 C106 95 94 95 96 96.5 Z" fill="#F2A7A7" stroke="#524338" stroke-width="1.8" stroke-linejoin="round"/>
      <!-- 经典 W 小猫嘴 -->
      <path id="rig-mouth-line" d="M100 102 L100 106 M100 106 Q94 113 88 108 M100 106 Q106 113 112 108" fill="none" stroke="#524338" stroke-width="2.5" stroke-linecap="round"/>
    </g>

    <!-- 左侧胡须组 (#rig-whiskers-l) -->
    <g id="rig-whiskers-l" style="transform-origin: 50px 101px;" stroke="#524338" stroke-width="1.6" stroke-linecap="round" opacity="0.45">
      <path d="M46 95 Q34 92 22 91" fill="none"/>
      <path d="M44 101 Q32 101 20 101" fill="none"/>
      <path d="M46 107 Q35 110 24 112" fill="none"/>
    </g>

    <!-- 右侧胡须组 (#rig-whiskers-r) -->
    <g id="rig-whiskers-r" style="transform-origin: 150px 101px;" stroke="#524338" stroke-width="1.6" stroke-linecap="round" opacity="0.45">
      <path d="M154 95 Q166 92 178 91" fill="none"/>
      <path d="M156 101 Q168 101 180 101" fill="none"/>
      <path d="M154 107 Q165 110 176 112" fill="none"/>
    </g>
  </g>

  <!-- 6. 左右独立前爪 (#rig-paws-front)：放在头部下方/前方以支持抬爪招手、托腮、踩奶敲键盘 -->
  <g id="rig-paws-front">
    <!-- 左前爪 (#rig-paw-fl) -->
    <g id="rig-paw-fl" style="transform-origin: 68px 158px;">
      <ellipse cx="68" cy="164" rx="12.5" ry="8.5" fill="#FFFFFF" stroke="#524338" stroke-width="3"/>
      <path d="M64 167 L64 171 M72 167 L72 171" stroke="#524338" stroke-width="1.8" stroke-linecap="round"/>
      <!-- 抬爪招手时露出的粉色小肉垫 -->
      <g id="rig-paw-pad-l" opacity="0">
        <ellipse cx="68" cy="165" rx="4.2" ry="3.2" fill="#F2A7A7"/>
        <circle cx="63" cy="160" r="1.8" fill="#F2A7A7"/>
        <circle cx="68" cy="158.5" r="1.8" fill="#F2A7A7"/>
        <circle cx="73" cy="160" r="1.8" fill="#F2A7A7"/>
      </g>
    </g>

    <!-- 右前爪 (#rig-paw-fr) -->
    <g id="rig-paw-fr" style="transform-origin: 132px 158px;">
      <ellipse cx="132" cy="164" rx="12.5" ry="8.5" fill="#FFFFFF" stroke="#524338" stroke-width="3"/>
      <path d="M128 167 L128 171 M136 167 L136 171" stroke="#524338" stroke-width="1.8" stroke-linecap="round"/>
      <g id="rig-paw-pad-r" opacity="0">
        <ellipse cx="132" cy="165" rx="4.2" ry="3.2" fill="#F2A7A7"/>
        <circle cx="127" cy="160" r="1.8" fill="#F2A7A7"/>
        <circle cx="132" cy="158.5" r="1.8" fill="#F2A7A7"/>
        <circle cx="137" cy="160" r="1.8" fill="#F2A7A7"/>
      </g>
    </g>
  </g>

  <!-- 7. 动态情境氛围与物理粒子层 (#rig-fx) -->
  <g id="rig-fx" pointer-events="none">
    <!-- 思考状态浮动气泡组 (#fx-thinking) -->
    <g id="fx-thinking" opacity="0">
      <circle id="fx-think-d1" cx="152" cy="54" r="3.2" fill="#FFFFFF" stroke="#524338" stroke-width="2"/>
      <circle id="fx-think-d2" cx="160" cy="44" r="4.8" fill="#FFFFFF" stroke="#524338" stroke-width="2"/>
      <g id="fx-think-cloud" style="transform-origin: 174px 26px;">
        <rect x="154" y="14" width="38" height="24" rx="12" fill="#FFFFFF" stroke="#524338" stroke-width="2.4"/>
        <circle cx="165" cy="26" r="2.3" fill="#2B73B0"/>
        <circle cx="173" cy="26" r="2.3" fill="#2B73B0"/>
        <circle cx="181" cy="26" r="2.3" fill="#2B73B0"/>
      </g>
    </g>

    <!-- 警觉状态动态波纹与感叹号 (#fx-attention) -->
    <g id="fx-attention" opacity="0" style="transform-origin: 100px 20px;">
      <path d="M100 8 L100 22" stroke="#E85D56" stroke-width="5" stroke-linecap="round"/>
      <circle cx="100" cy="30" r="2.8" fill="#E85D56"/>
      <path d="M84 14 L76 6 M116 14 L124 6" stroke="#F59E0B" stroke-width="3" stroke-linecap="round"/>
    </g>

    <!-- 消息通知音符与柔光气泡 (#fx-notification) -->
    <g id="fx-notification" opacity="0" style="transform-origin: 162px 42px;">
      <path d="M148 30 C148 21 158 16 168 16 C178 16 188 21 188 30 C188 37 181 42 172 43 L164 50 L165 43 C155 42 148 37 148 30 Z"
            fill="#FFFFFF" stroke="#524338" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M168 35 C168 35 161 30 161 26.5 C161 24.2 163 23 165 23 C166.5 23 168 24.2 168 25.5 C168 24.2 169.5 23 171 23 C173 23 175 24.2 175 26.5 C175 30 168 35 168 35 Z"
            fill="#F26B7A"/>
    </g>

    <!-- 错误受惊闪电与汗珠 (#fx-error) -->
    <g id="fx-error" opacity="0" style="transform-origin: 100px 26px;">
      <path d="M94 8 L108 22 M108 8 L94 22" stroke="#E11D48" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M156 58 C156 58 162 66 162 70 C162 73.5 159.3 76 156 76 C152.7 76 150 73.5 150 70 C150 66 156 58 156 58 Z"
            fill="#68BFFF" stroke="#2B73B0" stroke-width="1.8"/>
    </g>

    <!-- 睡眠飘浮 zZz (#fx-sleeping) -->
    <g id="fx-sleeping" opacity="0">
      <text id="fx-z1" x="138" y="64" font-family=" Rounded Mplus 1c, Nunito, sans-serif" font-weight="800" font-size="13" fill="#7A5E4E">z</text>
      <text id="fx-z2" x="152" y="46" font-family=" Rounded Mplus 1c, Nunito, sans-serif" font-weight="800" font-size="17" fill="#7A5E4E">Z</text>
      <text id="fx-z3" x="168" y="26" font-family=" Rounded Mplus 1c, Nunito, sans-serif" font-weight="800" font-size="22" fill="#524338">Z</text>
    </g>

    <!-- 撸猫互动爱心 (#fx-pet-love) -->
    <g id="fx-pet-love" opacity="0" style="transform-origin: 100px 30px;">
      <path d="M100 34 C100 34 89 26 89 20 C89 16 92.5 13.5 95.8 13.5 C98 13.5 100 15.2 100 17.2 C100 15.2 102 13.5 104.2 13.5 C107.5 13.5 111 16 111 20 C111 26 100 34 100 34 Z"
            fill="#F43F5E" stroke="#FFFFFF" stroke-width="1.5"/>
    </g>
  </g>
</svg>`;
}

// ============================================================================
// 8 大状态基础姿态目标配置表 (State Pose Targets)
// 每个状态具有鲜明的全身重心、头部倾角、耳位、爪位与眼神特征
// ============================================================================
const STATE_POSES = {
  idle: {
    bodyY: 0, bodyScaleX: 1.0, bodyScaleY: 1.0, bodyRot: 0,
    headX: 0, headY: 0, headRot: 0,
    earLRot: 0, earRRot: 0,
    pawFLX: 0, pawFLY: 0, pawFLRot: 0, pawPadL: 0,
    pawFRX: 0, pawFRY: 0, pawFRRot: 0, pawPadR: 0,
    pupilRx: 5.0, pupilRy: 9.0, eyelidTop: 0,
    eyeMode: "open", // "open" | "sleep" | "happy"
    mouthOpenRx: 0, mouthOpenRy: 0,
    whiskerLRot: 0, whiskerRRot: 0,
    tailBaseAngle: 0, tailAmp: 12, tailFreq: 1.8,
    breathFreq: 0.45, breathAmp: 0.024
  },
  thinking: {
    bodyY: 2, bodyScaleX: 1.02, bodyScaleY: 0.98, bodyRot: 2.5,
    headX: 4, headY: 2, headRot: 13.5, // 明显歪头思考
    earLRot: 6, earRRot: -14,          // 一耳竖起、一耳微撇
    pawFLX: 0, pawFLY: 0, pawFLRot: 0, pawPadL: 0,
    pawFRX: -14, pawFRY: -38, pawFRRot: -26, pawPadR: 0.85, // 右爪抬到下巴边托腮
    pupilRx: 4.8, pupilRy: 8.8, eyelidTop: 2.2, // 微眯思考眼
    eyeMode: "open",
    mouthOpenRx: 0, mouthOpenRy: 0,
    whiskerLRot: -4, whiskerRRot: 8,
    tailBaseAngle: -8, tailAmp: 6, tailFreq: 1.1,
    breathFreq: 0.38, breathAmp: 0.02
  },
  working: {
    bodyY: 5.5, bodyScaleX: 1.06, bodyScaleY: 0.93, bodyRot: 0, // 伏案重心压低
    headX: 0, headY: 6.5, headRot: 0,
    earLRot: -16, earRRot: 16, // 专注半飞机耳
    pawFLX: 6, pawFLY: -3, pawFLRot: -8, pawPadL: 0,
    pawFRX: -6, pawFRY: -3, pawFRRot: 8, pawPadR: 0,
    // 眼睑压 7px（约 25%）。钓鱼那版是 11——那是打盹，眼球基本被盖掉；
    // 现在是赶工，得让蓝眼睛还看得见，不然读成「睡着了还在敲键盘」
    pupilRx: 4.2, pupilRy: 8.6, eyelidTop: 7,
    eyeMode: "open",
    mouthOpenRx: 0, mouthOpenRy: 0,
    whiskerLRot: 5, whiskerRRot: -5,
    tailBaseAngle: 12, tailAmp: 18, tailFreq: 4.8, // 干活时尾巴高频欢快摆动
    breathFreq: 0.85, breathAmp: 0.028
  },
  attention: {
    bodyY: -7.5, bodyScaleX: 0.93, bodyScaleY: 1.09, bodyRot: 0, // 警觉挺胸立起
    headX: 0, headY: -9.5, headRot: 0,
    earLRot: 9, earRRot: -9, // 双耳高高竖直前倾
    pawFLX: 3, pawFLY: 1, pawFLRot: 0, pawPadL: 0,
    pawFRX: -3, pawFRY: 1, pawFRRot: 0, pawPadR: 0,
    pupilRx: 7.6, pupilRy: 10.2, eyelidTop: 0, // 蓝宝石大圆瞳孔瞬间放大！
    eyeMode: "open",
    mouthOpenRx: 2.2, mouthOpenRy: 1.8,
    whiskerLRot: 8, whiskerRRot: -8,
    tailBaseAngle: 22, tailAmp: 5, tailFreq: 6.5, // 尾巴高竖微颤
    breathFreq: 0.7, breathAmp: 0.03
  },
  notification: {
    bodyY: -2.5, bodyScaleX: 0.98, bodyScaleY: 1.03, bodyRot: -3,
    headX: -3, headY: -4, headRot: -10.5, // 欢快歪头
    earLRot: 8, earRRot: -5,
    pawFLX: -12, pawFLY: -42, pawFLRot: 28, pawPadL: 1.0, // 左爪高抬招手露出粉肉垫
    pawFRX: 0, pawFRY: 0, pawFRRot: 0, pawPadR: 0,
    pupilRx: 6.8, pupilRy: 9.8, eyelidTop: 0,
    eyeMode: "open",
    mouthOpenRx: 4.2, mouthOpenRy: 3.4, // 张嘴“喵~”
    whiskerLRot: 6, whiskerRRot: -6,
    tailBaseAngle: 8, tailAmp: 22, tailFreq: 3.6,
    breathFreq: 0.6, breathAmp: 0.026
  },
  error: {
    bodyY: -3, bodyScaleX: 1.08, bodyScaleY: 0.95, bodyRot: -2, // 受惊拱背炸毛
    headX: 0, headY: -2, headRot: -4,
    earLRot: -36, earRRot: 36, // 大飞机耳彻底压平
    pawFLX: -6, pawFLY: -6, pawFLRot: 14, pawPadL: 0,
    pawFRX: 6, pawFRY: -6, pawFRRot: -14, pawPadR: 0,
    pupilRx: 2.1, pupilRy: 9.2, eyelidTop: 0, // 受惊极细竖瞳
    eyeMode: "open",
    mouthOpenRx: 3.5, mouthOpenRy: 2.5,
    whiskerLRot: -14, whiskerRRot: 14,
    tailBaseAngle: 18, tailAmp: 24, tailFreq: 8.0, // 炸毛快速甩尾
    breathFreq: 1.2, breathAmp: 0.035
  },
  sleeping: {
    bodyY: 8.5, bodyScaleX: 1.09, bodyScaleY: 0.87, bodyRot: 0, // 团成软乎乎的圆猫球
    headX: 2, headY: 13.5, headRot: 6.5, // 头深深埋在爪子上
    earLRot: -14, earRRot: 14, // 耳朵放松垂下
    pawFLX: 10, pawFLY: 2, pawFLRot: -12, pawPadL: 0,
    pawFRX: -10, pawFRY: 2, pawFRRot: 12, pawPadR: 0,
    pupilRx: 5.0, pupilRy: 9.0, eyelidTop: 14,
    eyeMode: "sleep",
    mouthOpenRx: 0, mouthOpenRy: 0,
    whiskerLRot: -8, whiskerRRot: 8,
    tailBaseAngle: -24, tailAmp: 3.5, tailFreq: 0.6, // 尾巴环抱身侧轻轻呼吸
    breathFreq: 0.28, breathAmp: 0.042 // 深长睡眠呼吸
  },
  walking: {
    bodyY: -2, bodyScaleX: 0.99, bodyScaleY: 1.01, bodyRot: 0,
    headX: 0, headY: -3, headRot: 0,
    earLRot: 3, earRRot: -3,
    pawFLX: 0, pawFLY: 0, pawFLRot: 0, pawPadL: 0,
    pawFRX: 0, pawFRY: 0, pawFRRot: 0, pawPadR: 0,
    pupilRx: 5.4, pupilRy: 9.2, eyelidTop: 0,
    eyeMode: "open",
    mouthOpenRx: 0, mouthOpenRy: 0,
    whiskerLRot: 2, whiskerRRot: -2,
    tailBaseAngle: 16, tailAmp: 14, tailFreq: 3.2,
    breathFreq: 0.75, breathAmp: 0.025
  }
};

// ============================================================================
// 布偶猫 60fps 骨骼物理控制器 (RagdollRigController)
// ============================================================================
// 曾经这里还有一层「彩蛋（gags）」：随机排期 + 分段插值，隔一阵钓上来一条鱼。
// 钓鱼这个语义被拿掉了（working 改成敲键盘），彩蛋连部件带引擎一起删干净——
// 留着「暂时不排期」的版本等于留一条没人走的死路径，那正是这个项目踩过四次的东西。
class RagdollRigController {
  constructor(rootLayer) {
    this.rootLayer = rootLayer;
    // 骨骼模板也是「一串字符串变成 DOM」，和主题帧是同一个动作，
    // 所以走同一个出口 svgNode()——白名单只挡 on* / 外部 url，不挡 style 属性，
    // 而 rig 全靠 style="transform-origin" 定旋转中心，正好放行。
    // （曾经这里是 `innerHTML = createRiggedRagdollSVG()`，硬约束 19 说 src/ 下
    //   必须为 0 却没人发现——因为没有机械检查。现在回归里有了。）
    const rigNode = svgNode(createRiggedRagdollSVG());
    if (!rigNode) throw new Error("骨骼模板解析失败");
    this.rootLayer.replaceChildren(rigNode);
    this.svg = rigNode;
    this.els = {
      shadow: this.svg.querySelector("#rig-shadow"),
      tailBorder: this.svg.querySelector("#rig-tail-border"),
      tailMain: this.svg.querySelector("#rig-tail-main"),
      tailTip: this.svg.querySelector("#rig-tail-tip"),
      bodyGroup: this.svg.querySelector("#rig-body-group"),
      pawBL: this.svg.querySelector("#rig-paw-bl"),
      pawBR: this.svg.querySelector("#rig-paw-br"),
      desk: this.svg.querySelector("#rig-work-desk"),
      code1: this.svg.querySelector("#rig-code-1"),
      code2: this.svg.querySelector("#rig-code-2"),
      code3: this.svg.querySelector("#rig-code-3"),
      caret: this.svg.querySelector("#rig-code-caret"),
      kbGlow: this.svg.querySelector("#rig-kb-glow"),
      headGroup: this.svg.querySelector("#rig-head-group"),
      earL: this.svg.querySelector("#rig-ear-l"),
      earR: this.svg.querySelector("#rig-ear-r"),
      eyesOpen: this.svg.querySelector("#rig-eyes-open"),
      eyesClosed: this.svg.querySelector("#rig-eyes-closed"),
      eyesHappy: this.svg.querySelector("#rig-eyes-happy"),
      pupils: this.svg.querySelector("#rig-pupils"),
      pupilL: this.svg.querySelector("#rig-pupil-l"),
      pupilR: this.svg.querySelector("#rig-pupil-r"),
      eyelidTopL: this.svg.querySelector("#rig-eyelid-top-l"),
      eyelidTopR: this.svg.querySelector("#rig-eyelid-top-r"),
      muzzle: this.svg.querySelector("#rig-muzzle"),
      mouthOpen: this.svg.querySelector("#rig-mouth-open"),
      whiskersL: this.svg.querySelector("#rig-whiskers-l"),
      whiskersR: this.svg.querySelector("#rig-whiskers-r"),
      pawFL: this.svg.querySelector("#rig-paw-fl"),
      pawFR: this.svg.querySelector("#rig-paw-fr"),
      pawPadL: this.svg.querySelector("#rig-paw-pad-l"),
      pawPadR: this.svg.querySelector("#rig-paw-pad-r"),
      fxThinking: this.svg.querySelector("#fx-thinking"),
      fxThinkCloud: this.svg.querySelector("#fx-think-cloud"),
      fxAttention: this.svg.querySelector("#fx-attention"),
      fxNotification: this.svg.querySelector("#fx-notification"),
      fxError: this.svg.querySelector("#fx-error"),
      fxSleeping: this.svg.querySelector("#fx-sleeping"),
      fxZ1: this.svg.querySelector("#fx-z1"),
      fxZ2: this.svg.querySelector("#fx-z2"),
      fxZ3: this.svg.querySelector("#fx-z3"),
      fxPetLove: this.svg.querySelector("#fx-pet-love")
    };

    // 初始化各部位二阶弹簧阻尼通道（不同部位不同刚度/阻尼以产生自然的次级跟随）
    this.sp = {
      bodyY: new SpringChannel(0, 130, 14),
      bodyScaleX: new SpringChannel(1, 140, 15),
      bodyScaleY: new SpringChannel(1, 140, 15),
      bodyRot: new SpringChannel(0, 120, 14),

      headX: new SpringChannel(0, 150, 16),
      headY: new SpringChannel(0, 150, 16),
      headRot: new SpringChannel(0, 135, 14), // 头部带轻微过冲回弹

      earLRot: new SpringChannel(0, 180, 12), // 耳朵更灵敏 Q 弹
      earRRot: new SpringChannel(0, 180, 12),

      pawFLX: new SpringChannel(0, 170, 16),
      pawFLY: new SpringChannel(0, 170, 16),
      pawFLRot: new SpringChannel(0, 170, 16),
      pawPadL: new SpringChannel(0, 180, 20),

      pawFRX: new SpringChannel(0, 170, 16),
      pawFRY: new SpringChannel(0, 170, 16),
      pawFRRot: new SpringChannel(0, 170, 16),
      pawPadR: new SpringChannel(0, 180, 20),

      pupilRx: new SpringChannel(5.0, 210, 18),
      pupilRy: new SpringChannel(9.0, 210, 18),
      gazeX: new SpringChannel(0, 160, 18),
      gazeY: new SpringChannel(0, 160, 18),

      whiskerLRot: new SpringChannel(0, 95, 10), // 胡须滞后柔顺跟随
      whiskerRRot: new SpringChannel(0, 95, 10),

      tailBaseAngle: new SpringChannel(0, 90, 11),
      tailAmp: new SpringChannel(12, 80, 12),
      tailFreq: new SpringChannel(1.8, 80, 12),

      mouthOpenRx: new SpringChannel(0, 190, 18),
      mouthOpenRy: new SpringChannel(0, 190, 18),

      // 「睁眼程度」0 = 睡着闭眼，1 = 完全睁开（S9）。
      //
      // 为什么眼睛要单独走弹簧：`eyeMode` 是个字符串（open / sleep / happy），
      // 按它直接切 opacity 就是硬跳——那不是猫醒过来，那是显示器通电。
      // 临界阻尼（ζ = c/2√k = 21/21 ≈ 1），不会过冲到"睁得比平时还大"，
      // 大约 0.5 秒走完，正好配上躯干从团成一球慢慢撑起来的那个节奏。
      eyeOpen: new SpringChannel(1, 110, 21)
    };

    this.state = "idle";
    this.time = 0;
    this.tailPhase = 0;
    this.breathPhase = 0;

    // 自然眨眼计时器 (Random Natural Blink & Double-Blink)
    this.nextBlinkAt = 1.8 + Math.random() * 3.2;
    this.blinkTimer = 0;
    this.isBlinking = false;
    this.pendingDoubleBlink = false;

    // 随机耳廓微抖计时器 (Random Ear Twitch)
    this.nextEarTwitchAt = 2.5 + Math.random() * 4.5;

    // 撸猫抚摸检测 (Petting Rub Detector)
    this.pettingEnergy = 0;
    this.lastPetMouseX = null;

    this.rafId = null;
    this.lastTs = performance.now();
    this.setState("idle");
    this.startLoop();
  }

  setState(newState) {
    const prev = this.state;
    this.state = STATE_POSES[newState] ? newState : "idle";
    const pose = STATE_POSES[this.state];

    // 状态切换时注入真实的预备冲量 (Anticipation / Squash-and-Stretch Impulse)
    if (prev !== this.state) {
      if (this.state === "attention") {
        this.sp.bodyY.impulse(-45);
        this.sp.headY.impulse(-55);
        this.sp.earLRot.impulse(65);
        this.sp.earRRot.impulse(-65);
      } else if (this.state === "error") {
        this.sp.bodyScaleX.impulse(0.45);
        this.sp.headY.impulse(-35);
      } else if (this.state === "working") {
        this.sp.bodyY.impulse(30);
        this.sp.headY.impulse(35);
      } else if (this.state === "thinking") {
        this.sp.headRot.impulse(40);
      } else if (this.state === "notification") {
        this.sp.headY.impulse(-30);
        this.sp.pawFLY.impulse(-60);
      }
    }

    for (const key of Object.keys(this.sp)) {
      if (pose[key] !== undefined) {
        this.sp[key].setTarget(pose[key]);
      }
    }

    // 眼睛的睁开程度不写进 STATE_POSES：那张表是"姿势数值"，而这一项是
    // 从 eyeMode 推导出来的（eyeMode 本身不是数值，塞不进弹簧通道表）。
    // 所以每次换状态时手动给它一个目标，剩下的交给弹簧慢慢走。
    this.sp.eyeOpen.setTarget(pose.eyeMode === "sleep" ? 0 : 1);
  }

  setGaze(nx, ny) {
    const pose = STATE_POSES[this.state] || STATE_POSES.idle;
    if (this.state === "sleeping") {
      this.sp.gazeX.setTarget(0);
      this.sp.gazeY.setTarget(0);
      return;
    }
    this.sp.gazeX.setTarget(Math.max(-1, Math.min(1, nx)));
    this.sp.gazeY.setTarget(Math.max(-1, Math.min(1, ny)));
    void pose;
  }

  onMouseStroke(clientX) {
    if (this.lastPetMouseX !== null) {
      const dx = Math.abs(clientX - this.lastPetMouseX);
      if (dx > 2 && dx < 45) {
        this.pettingEnergy = Math.min(1.5, this.pettingEnergy + dx * 0.012);
      }
    }
    this.lastPetMouseX = clientX;
  }

  onPoke() {
    // 点击猫咪产生 Q 弹物理回弹
    this.sp.bodyScaleX.impulse(0.55);
    this.sp.bodyScaleY.impulse(-0.55);
    this.sp.headY.impulse(38);
    this.sp.earLRot.impulse(-50);
    this.sp.earRRot.impulse(50);
  }

  startLoop() {
    const loop = (now) => {
      const dt = (now - this.lastTs) / 1000;
      this.lastTs = now;
      this.update(dt);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }

  update(dt) {
    const safeDt = Math.min(dt, 0.05);
    this.time += safeDt;
    const pose = STATE_POSES[this.state] || STATE_POSES.idle;

    // 1. 抚摸撸猫能量衰减
    this.pettingEnergy = Math.max(0, this.pettingEnergy - safeDt * 0.45);
    const isEnjoyingPet = this.pettingEnergy > 0.45 && this.state !== "error";

    // 2. 随机自然眨眼 (Natural Blink) 与随机耳廓抖动 (Ear Twitch)
    if (this.time >= this.nextBlinkAt && !this.isBlinking) {
      this.isBlinking = true;
      this.blinkTimer = 0;
      this.pendingDoubleBlink = Math.random() < 0.22;
    }
    let blinkCloseRatio = 0;
    if (this.isBlinking) {
      this.blinkTimer += safeDt;
      const blinkDuration = 0.15;
      if (this.blinkTimer < blinkDuration) {
        blinkCloseRatio = Math.sin((this.blinkTimer / blinkDuration) * Math.PI);
      } else {
        this.isBlinking = false;
        if (this.pendingDoubleBlink) {
          this.pendingDoubleBlink = false;
          this.nextBlinkAt = this.time + 0.12;
        } else {
          this.nextBlinkAt = this.time + 2.4 + Math.random() * 3.8;
        }
      }
    }

    if (this.time >= this.nextEarTwitchAt) {
      if (this.state === "idle" || this.state === "thinking" || this.state === "working") {
        if (Math.random() < 0.5) {
          this.sp.earLRot.impulse(-65);
        } else {
          this.sp.earRRot.impulse(65);
        }
      }
      this.nextEarTwitchAt = this.time + 2.8 + Math.random() * 4.5;
    }

    // 3. 推进所有二阶弹簧通道
    for (const channel of Object.values(this.sp)) {
      channel.step(safeDt);
    }

    // 睁眼程度（0 = 睡着闭眼，1 = 完全睁开）。眼睛组和头顶的 zZz 都读这一个值——
    // 两处各算一遍的话，醒来时很容易出现"眼睛已经睁开了、Z 还挂在头上"。
    const eyeOpen = Math.min(1, Math.max(0, this.sp.eyeOpen.pos));

    // 4. 连续次级周期运动计算 (呼吸、尾巴波、状态专属微动作)
    this.breathPhase += safeDt * pose.breathFreq * Math.PI * 2;
    this.tailPhase += safeDt * this.sp.tailFreq.pos * Math.PI * 2;

    const breathSin = Math.sin(this.breathPhase);
    const breathCos = Math.cos(this.breathPhase);

    // 视线驱动头部、双耳、胡须产生立体视差跟随 (Parallax Coupling)
    const gx = this.sp.gazeX.pos;
    const gy = this.sp.gazeY.pos;

    // 状态专属周期动态叠加
    let dynBodyY = 0, dynBodyRot = 0;
    let dynHeadX = 0, dynHeadY = 0, dynHeadRot = 0;
    let dynPawFLX = 0, dynPawFLY = 0, dynPawFLRot = 0;
    let dynPawFRX = 0, dynPawFRY = 0, dynPawFRRot = 0;
    let dynPawBLY = 0, dynPawBRY = 0;
    let dynGazeX = gx * 3.8, dynGazeY = gy * 2.8;
    let dynMouthOpen = 0;

    if (this.state === "thinking") {
      // 思考时眼珠斜向上方缓慢左右扫视，右爪轻轻点下巴
      dynGazeX = Math.sin(this.time * 2.2) * 2.6 + gx * 1.5;
      dynGazeY = -2.8 + Math.cos(this.time * 1.4) * 0.8;
      dynHeadRot = Math.sin(this.time * 1.8) * 2.2;
      dynPawFRY = Math.sin(this.time * 4.2) * 2.4;
    } else if (this.state === "working") {
      // 赶工：两只前爪**不同频**地敲（同频会像在做操，这是上一轮踩过的），
      // 头随敲击轻微上下扫视，眼睛盯着左下角的屏幕，不跟鼠标。
      const hitL = Math.abs(Math.sin(this.time * 9.2));
      const hitR = Math.abs(Math.sin(this.time * 7.3 + 1.1));
      dynPawFLY = hitL * 3.4;
      dynPawFRY = hitR * 3.4;
      dynPawFLRot = hitL * 3.2;
      dynPawFRRot = -hitR * 3.2;
      dynHeadY = Math.sin(this.time * 9.2) * 0.9;
      dynHeadRot = Math.sin(this.time * 7.3) * 1.2;
      dynGazeX = -2.2; // 屏幕在左下方：眼睛钉在那儿，不跟鼠标
      dynGazeY = 1.6;
    } else if (this.state === "notification") {
      // 欢快招手 + 喵叫口型开合
      const wave = Math.sin(this.time * 9.5);
      dynPawFLX = wave * 5.5;
      dynPawFLY = Math.abs(wave) * -4.0;
      dynPawFLRot = wave * 16;
      dynHeadRot = Math.sin(this.time * 4.8) * 3.5;
      dynMouthOpen = Math.max(0, Math.sin(this.time * 6.5));
    } else if (this.state === "attention") {
      // 警觉竖耳微颤
      dynHeadY = Math.sin(this.time * 8) * 0.8;
    } else if (this.state === "error") {
      // 受惊高频颤抖
      const shake = Math.sin(this.time * 42);
      dynHeadX = shake * 2.2;
      dynBodyRot = shake * 1.2;
    } else if (this.state === "sleeping") {
      // 睡眠呼噜微震 (Purr micro-vibration)
      dynHeadY = breathSin * 2.2 + Math.sin(this.time * 28) * 0.25;
    } else if (this.state === "walking") {
      // 轻盈猫步：四肢相位交替 + 身体双倍频微弹
      const walkPhase = this.time * 8.5;
      dynPawFLX = Math.cos(walkPhase) * 6.5;
      dynPawFLY = Math.min(0, Math.sin(walkPhase) * 7.5);
      dynPawFRX = Math.cos(walkPhase + Math.PI) * 6.5;
      dynPawFRY = Math.min(0, Math.sin(walkPhase + Math.PI) * 7.5);
      dynPawBLY = Math.min(0, Math.sin(walkPhase + Math.PI * 0.5) * 5.5);
      dynPawBRY = Math.min(0, Math.sin(walkPhase + Math.PI * 1.5) * 5.5);
      dynBodyY = Math.abs(Math.sin(walkPhase)) * -3.5;
      dynBodyRot = Math.sin(walkPhase) * 2.2;
      dynHeadY = Math.abs(Math.sin(walkPhase - 0.4)) * -2.8;
    }

    if (isEnjoyingPet) {
      // 撸猫时舒服地歪头 + 呼噜轻颤
      dynHeadRot += Math.sin(this.time * 6) * 4.5;
      dynHeadY += 2.5 + Math.sin(this.time * 32) * 0.45;
    }

    // 5. 应用躯干、阴影与胸口毛领变换
    const finalBodyY = this.sp.bodyY.pos + dynBodyY + breathSin * 1.6;
    const finalBodyScaleX = this.sp.bodyScaleX.pos * (1 + breathSin * pose.breathAmp);
    const finalBodyScaleY = this.sp.bodyScaleY.pos * (1 - breathSin * pose.breathAmp * 0.65);
    const finalBodyRot = this.sp.bodyRot.pos + dynBodyRot + gx * 1.4;

    this.els.bodyGroup.style.transform =
      `translate(0px, ${finalBodyY.toFixed(2)}px) rotate(${finalBodyRot.toFixed(2)}deg) scale(${finalBodyScaleX.toFixed(3)}, ${finalBodyScaleY.toFixed(3)})`;

    // （原本这里还有一块「胸口大毛领」的滞后蓬松缩放，2026-10-28 连同 SVG 一起删了：
    //   它是只跟呼吸联动的装饰件，删掉后躯干本身仍在呼吸，视觉上没有落差，
    //   反而少了每帧一次 style.transform 写入。）

    // 后爪步伐
    this.els.pawBL.style.transform = `translate(0px, ${dynPawBLY.toFixed(2)}px)`;
    this.els.pawBR.style.transform = `translate(0px, ${dynPawBRY.toFixed(2)}px)`;

    // 地面阴影随身体高低动态缩放
    const shadowScale = 1 - finalBodyY * 0.012 + breathSin * 0.02;
    this.els.shadow.setAttribute("rx", (65 * shadowScale).toFixed(1));

    // 6. 应用多段柔性贝塞尔尾巴 (Multi-Segment Sinusoidal Bezier Tail)
    const baseA = (this.sp.tailBaseAngle.pos + Math.sin(this.tailPhase) * this.sp.tailAmp.pos) * (Math.PI / 180);
    const tipA = baseA + (Math.sin(this.tailPhase - 1.15) * this.sp.tailAmp.pos * 1.35) * (Math.PI / 180);

    const cp1x = 142 + Math.cos(baseA - 0.25) * 28;
    const cp1y = 152 + finalBodyY * 0.6 - Math.sin(baseA + 0.35) * 18;
    const cp2x = 166 + Math.cos(tipA) * 26;
    const cp2y = 138 + finalBodyY * 0.4 - Math.sin(tipA) * 24;
    const endX = 178 + Math.sin(tipA) * 16;
    const endY = 118 + finalBodyY * 0.3 - Math.cos(tipA) * 14;

    const tailPath = `M142 ${(152 + finalBodyY * 0.6).toFixed(1)} C${cp1x.toFixed(1)} ${cp1y.toFixed(1)} ${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`;
    const tipMidX = (cp1x * 0.25 + cp2x * 0.5 + endX * 0.25);
    const tipMidY = (cp1y * 0.25 + cp2y * 0.5 + endY * 0.25);
    const tailTipPath = `M${tipMidX.toFixed(1)} ${tipMidY.toFixed(1)} Q${cp2x.toFixed(1)} ${cp2y.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`;

    this.els.tailBorder.setAttribute("d", tailPath);
    this.els.tailMain.setAttribute("d", tailPath);
    this.els.tailTip.setAttribute("d", tailTipPath);

    // 7. 应用头部、双耳、胡须与视线视差变换
    const headX = this.sp.headX.pos + dynHeadX + gx * 3.4;
    const headY = this.sp.headY.pos + dynHeadY + gy * 2.4 + breathSin * 1.8;
    const headRot = this.sp.headRot.pos + dynHeadRot + gx * 4.2;

    this.els.headGroup.style.transform =
      `translate(${headX.toFixed(2)}px, ${headY.toFixed(2)}px) rotate(${headRot.toFixed(2)}deg)`;

    const earLRot = this.sp.earLRot.pos - gx * 3.5 + breathCos * 1.2 - (isEnjoyingPet ? 12 : 0);
    const earRRot = this.sp.earRRot.pos - gx * 3.5 - breathCos * 1.2 + (isEnjoyingPet ? 12 : 0);
    this.els.earL.style.transform = `rotate(${earLRot.toFixed(2)}deg)`;
    this.els.earR.style.transform = `rotate(${earRRot.toFixed(2)}deg)`;

    const wLRot = this.sp.whiskerLRot.pos - headRot * 0.35 + breathSin * 1.8;
    const wRRot = this.sp.whiskerRRot.pos - headRot * 0.35 - breathSin * 1.8;
    this.els.whiskersL.style.transform = `rotate(${wLRot.toFixed(2)}deg)`;
    this.els.whiskersR.style.transform = `rotate(${wRRot.toFixed(2)}deg)`;

    // 8. 眼睛、瞳孔缩放与眨眼/表情切换
    // 彩蛋期间猫会转头看自己钓上来的东西——叠在 gaze 上，
    // 而不是替换它：那样东西一消失眼睛会"弹回去"，很假。
    this.els.pupils.style.transform = `translate(${dynGazeX.toFixed(2)}px, ${dynGazeY.toFixed(2)}px)`;
    this.els.pupilL.setAttribute("rx", this.sp.pupilRx.pos.toFixed(2));
    this.els.pupilL.setAttribute("ry", this.sp.pupilRy.pos.toFixed(2));
    this.els.pupilR.setAttribute("rx", this.sp.pupilRx.pos.toFixed(2));
    this.els.pupilR.setAttribute("ry", this.sp.pupilRy.pos.toFixed(2));

    // 睁开程度由 eyeOpen 弹簧决定，所以「睡着 ↔ 醒着」是一段交叉淡入淡出，
    // 不是布尔切换。三个眼睛图层（睁眼 / 弯月闭眼 / 笑眼）各自算一个权重，
    // 谁都不是"啪"地一下顶替别人：
    let wOpen = eyeOpen;
    let wSleepArc = 1 - eyeOpen;
    let wHappy = 0;
    if (isEnjoyingPet) {
      // 撸猫时的笑眼跟着 eyeOpen 一起淡入：半醒着被撸，先睁一半再眯起来最自然。
      wHappy = eyeOpen;
      wOpen = 0;
    } else if (pose.eyeMode !== "sleep" && blinkCloseRatio > 0.72) {
      // 眨眼是 150ms 的事，这里必须硬切——慢慢眨眼的猫看起来像卡住了。
      wOpen = 0;
      wSleepArc = 1;
    }
    this.els.eyesOpen.setAttribute("opacity", wOpen.toFixed(3));
    this.els.eyesClosed.setAttribute("opacity", wSleepArc.toFixed(3));
    this.els.eyesHappy.setAttribute("opacity", wHappy.toFixed(3));

    // 眼睑只长在睁眼组里（闭眼组本身是弧线，没有眼睑可压）。
    // 用 wOpen 判断而不是 pose.eyeMode：过渡途中眼睛已经露出一点点，
    // 这时不画眼睑的话，瞳孔会从一片空白里"浮"出来。
    if (wOpen > 0.01) {
      const lidDrop = Math.max(pose.eyelidTop, blinkCloseRatio * 15);
      const lidPathL = `M58 76 L90 76 L90 ${(76 + lidDrop).toFixed(1)} Q74 ${(76 + lidDrop + 2.5).toFixed(1)} 58 ${(76 + lidDrop).toFixed(1)} Z`;
      const lidPathR = `M110 76 L142 76 L142 ${(76 + lidDrop).toFixed(1)} Q126 ${(76 + lidDrop + 2.5).toFixed(1)} 110 ${(76 + lidDrop).toFixed(1)} Z`;
      this.els.eyelidTopL.setAttribute("d", lidPathL);
      this.els.eyelidTopR.setAttribute("d", lidPathR);
    }

    // 嘴巴张合度
    const mRx = this.sp.mouthOpenRx.pos * (this.state === "notification" ? (0.4 + 0.6 * dynMouthOpen) : 1);
    const mRy = this.sp.mouthOpenRy.pos * (this.state === "notification" ? (0.4 + 0.6 * dynMouthOpen) : 1);
    this.els.mouthOpen.setAttribute("rx", mRx.toFixed(2));
    this.els.mouthOpen.setAttribute("ry", mRy.toFixed(2));
    this.els.mouthOpen.setAttribute("opacity", mRx > 0.4 ? "1" : "0");

    // 9. 左右前爪独立变换
    const pflX = this.sp.pawFLX.pos + dynPawFLX;
    const pflY = this.sp.pawFLY.pos + dynPawFLY + finalBodyY * 0.4;
    const pflR = this.sp.pawFLRot.pos + dynPawFLRot;
    this.els.pawFL.style.transform = `translate(${pflX.toFixed(2)}px, ${pflY.toFixed(2)}px) rotate(${pflR.toFixed(2)}deg)`;
    this.els.pawPadL.setAttribute("opacity", this.sp.pawPadL.pos.toFixed(2));

    const pfrX = this.sp.pawFRX.pos + dynPawFRX;
    const pfrY = this.sp.pawFRY.pos + dynPawFRY + finalBodyY * 0.4;
    const pfrR = this.sp.pawFRRot.pos + dynPawFRRot;
    this.els.pawFR.style.transform = `translate(${pfrX.toFixed(2)}px, ${pfrY.toFixed(2)}px) rotate(${pfrR.toFixed(2)}deg)`;
    this.els.pawPadR.setAttribute("opacity", this.sp.pawPadR.pos.toFixed(2));

    // 10. 情境动态特效更新
    this.els.desk.setAttribute("opacity", this.state === "working" ? "1" : "0");
    if (this.state === "working") {
      // 代码一行一行长出来：第 i 行在自己的相位里生长，末尾淡出换下一行。
      // 光标跟着最后一行走，键盘灯随敲击呼吸——这三样一起才读得出「在干活」，
      // 光有爪子上下动会被看成"在抖"。
      const rows = [this.els.code1, this.els.code2, this.els.code3];
      let caretX = 13;
      rows.forEach((el, i) => {
        const p = (this.time * 0.55 + i * 0.34) % 1;
        const w = 6 + 26 * Math.min(1, p * 2.4);
        const op = p > 0.86 ? Math.max(0, (1 - p) / 0.14) : 1;
        el.setAttribute("width", w.toFixed(1));
        el.setAttribute("opacity", op.toFixed(2));
        if (i === rows.length - 1) caretX = 13 + w;
      });
      this.els.caret.setAttribute("x", caretX.toFixed(1));
      this.els.caret.setAttribute("opacity", Math.sin(this.time * 9.2) > 0 ? "1" : "0.15");
      this.els.kbGlow.setAttribute(
        "opacity",
        (0.28 + Math.abs(Math.sin(this.time * 9.2)) * 0.72).toFixed(2)
      );
    }
    this.els.fxThinking.setAttribute("opacity", this.state === "thinking" ? "1" : "0");
    if (this.state === "thinking") {
      this.els.fxThinkCloud.style.transform = `translate(0px, ${(Math.sin(this.time * 3.2) * 3).toFixed(2)}px)`;
    }

    this.els.fxAttention.setAttribute("opacity", this.state === "attention" ? "1" : "0");
    if (this.state === "attention") {
      const s = 1 + Math.sin(this.time * 12) * 0.12;
      this.els.fxAttention.style.transform = `scale(${s.toFixed(3)})`;
    }

    this.els.fxNotification.setAttribute("opacity", this.state === "notification" ? "1" : "0");
    if (this.state === "notification") {
      this.els.fxNotification.style.transform =
        `translate(0px, ${(Math.sin(this.time * 5) * 3.5).toFixed(2)}px) rotate(${(Math.sin(this.time * 4) * 6).toFixed(2)}deg)`;
    }

    this.els.fxError.setAttribute("opacity", this.state === "error" ? "1" : "0");
    if (this.state === "error") {
      this.els.fxError.style.transform = `translate(${(Math.sin(this.time * 35) * 2).toFixed(2)}px, 0px)`;
    }

    // zZz 跟着"睡意"一起散：睡意就是 1 - eyeOpen，和眼睛是同一条曲线的两端。
    // 醒来的那 0.5 秒里三个 Z 会边飘边淡出——如果按 state 硬切，
    // 会出现"眼睛已经睁开、Z 还挂在头上然后瞬间消失"的穿帮。
    const sleepFade = 1 - eyeOpen;
    this.els.fxSleeping.setAttribute("opacity", sleepFade.toFixed(3));
    if (sleepFade > 0.01) {
      const zFloat = (offset) => {
        const p = (this.time * 0.55 + offset) % 1;
        const dy = -p * 18;
        const dx = Math.sin(p * Math.PI * 2) * 4;
        const op = Math.sin(p * Math.PI);
        return { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`, opacity: op.toFixed(2) };
      };
      const z1 = zFloat(0), z2 = zFloat(0.33), z3 = zFloat(0.66);
      this.els.fxZ1.style.transform = z1.transform; this.els.fxZ1.setAttribute("opacity", z1.opacity);
      this.els.fxZ2.style.transform = z2.transform; this.els.fxZ2.setAttribute("opacity", z2.opacity);
      this.els.fxZ3.style.transform = z3.transform; this.els.fxZ3.setAttribute("opacity", z3.opacity);
    }

    this.els.fxPetLove.setAttribute("opacity", isEnjoyingPet ? "1" : "0");
    if (isEnjoyingPet) {
      this.els.fxPetLove.style.transform = `translate(0px, ${(Math.sin(this.time * 6) * 3 - 4).toFixed(2)}px) scale(${(1 + Math.sin(this.time * 8) * 0.12).toFixed(2)})`;
    }
  }
}

let ragdollRig = null;

function isRagdollTheme(theme) {
  if (!theme) return true;
  // 主题自报优先。id / name 匹配只是兼容老主题的兜底——
  // 靠名字嗅探意味着"任何叫 ragdoll 的主题"都会掉进同一个分支，
  // 而那套分支里画的是**写死在 JS 里**的一只猫。名字撞上就换错形象。
  if (theme.rigType) return theme.rigType === "ragdoll-spring-v2";
  const id = (theme.id || "").toLowerCase();
  const name = (theme.name || "").toLowerCase();
  return id === "ragdoll" || name.includes("布偶") || name.includes("ragdoll");
}

// ============================================================================
// 主题与状态切换入口（自动选择 60fps 布偶猫骨骼引擎 或 传统 SVG 多帧引擎）
// ============================================================================
function renderState(stateName) {
  currentState = stateName || "idle";

  if (isRagdollTheme(currentTheme)) {
    if (frameTimer) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
    // 骨骼路径不读 frames，也就没有"变体"这回事。留着上一次的 activeVariant
    // 会让 applyGaze 拿帧序列主题的 def 去问 eyeTracking，属于张冠李戴。
    activeVariant = null;
    layers[0].classList.add("show");
    layers[1].classList.remove("show");
    if (!ragdollRig) {
      ragdollRig = new RagdollRigController(layers[0]);
      buildCount += 1;
    }
    ragdollRig.setState(currentState);
    ragdollRig.setGaze(lastGaze.x, lastGaze.y);
    return;
  }

  // 非骨骼主题（没写 rigType 的）保留双图层交叉淡入淡出逻辑
  if (ragdollRig) {
    ragdollRig.destroy();
    ragdollRig = null;
  }

  const states = (currentTheme && currentTheme.states) || {};
  const def = states[currentState] || states.idle;
  if (!def || !Array.isArray(def.frames) || def.frames.length === 0) return;

  // 表情变体：一个状态可以有多套资产，每次**进来**轮播到下一套。
  // 用轮播而不是随机，是因为随机没法断言——测试要的是"多切几次一定不全一样"，
  // 随机会偶发地连着两次选中同一套，那样的断言时红时不红。
  // 只有主资产（variants 为空）时 pick 恒为 0，行为与以前完全一致。
  // cursor 存的是**当前选中**的槽位（不是"下一个"）——存下一个的话，
  // petDebug.variant() 读它会比实际画面超前一格，看起来像"说变体实际还是主资产"。
  const variants = Array.isArray(def.variants) ? def.variants : [];
  const slotCount = variants.length + 1;
  const seen = variantCursor[currentState];
  const pick = seen === undefined ? 0 : (seen + 1) % slotCount;
  variantCursor[currentState] = pick;
  activeVariant = pick === 0 ? null : variants[pick - 1];
  const source = pick === 0 ? def : activeVariant;

  const nextLayerIdx = 1 - activeLayer;
  const nextEl = layers[nextLayerIdx];
  const prevEl = layers[activeLayer];

  // 主题帧来自 themes/ 下的磁盘文件，是**不可信输入**。
  // 这里必须逐帧过 svgNode（DOMParser + 白名单），不能 innerHTML——
  // 一行 innerHTML 就把白名单整个绕开了，而且不报错、看不出来。
  const svgs = [];
  for (const markup of source.frames) {
    const node = svgNode(markup);
    if (!node) continue; // 坏帧单张丢弃，不连累整个状态
    node.classList.add("frame");
    svgs.push(node);
  }
  if (!svgs.length) return; // 一张都没成活：保持现状（比切到空白好）
  nextEl.replaceChildren(...svgs);
  buildCount += 1;
  svgs[0].classList.add("on");

  nextEl.classList.add("show");
  prevEl.classList.remove("show");
  activeLayer = nextLayerIdx;
  frameIndex = 0;

  // 旧图层淡出之后清掉。不清的话旧 DOM 会一直挂着（内存与 querySelector 都会踩到它）。
  setTimeout(() => {
    if (prevEl !== layers[activeLayer]) prevEl.replaceChildren();
  }, 240);

  if (frameTimer) clearInterval(frameTimer);
  if (svgs.length > 1) {
    const interval = Math.max(60, Math.round(1000 / (source.fps || 4)));
    frameTimer = setInterval(() => {
      svgs[frameIndex].classList.remove("on");
      frameIndex = (frameIndex + 1) % svgs.length;
      svgs[frameIndex].classList.add("on");
      applyGaze();
    }, interval);
  }
  applyGaze();
}

function applyGaze() {
  const states = (currentTheme && currentTheme.states) || {};
  const def = states[currentState] || states.idle;
  // 主题写 eyeTracking:false 就**真的**不跟。骨骼引擎的 gait 和瞳孔都吃这个开关——
  // 上一轮刚修过同一个 bug（字段被校验、被传输、就是没人读），
  // 这一版重写又把它带回来了：rig 分支原来无条件 setGaze。
  // 变体可以覆写 eyeTracking，所以先看当前在播的那套，没有再看主资产。
  const active = activeVariant || def;
  const track = !!(active && active.eyeTracking === true);
  if (ragdollRig) {
    ragdollRig.setGaze(track ? lastGaze.x : 0, track ? lastGaze.y : 0);
    return;
  }
  if (!track) return;

  const pupils = layers[activeLayer].querySelector("svg.on .pupils");
  if (!pupils) return;
  const dx = (lastGaze.x * 3.6).toFixed(2);
  const dy = (lastGaze.y * 2.6).toFixed(2);
  pupils.style.transform = `translate(${dx}px, ${dy}px)`;
}

// ============================================================================
// 绑定 Electron window.clawd IPC 与本地鼠标交互
// ============================================================================
// 诊断用：最近收到的状态推送时间线 + 图层重建次数。
// 这类"状态莫名弹回去"的问题，光看最终画面永远查不出来——
// 必须知道**谁在什么时候推了什么**。
const stateLog = [];
// 主进程推来的最近 agent 事件（见 state.js 的 recentEvents）
let lastEvents = [];
let buildCount = 0;
// 「鼠标把它弄醒」这条上行链路一共发了几次（S9）。
// 只记数不打日志：hover 期间它最多 500ms 一条，日志会把 stateLog 挤满，
// 而 stateLog 挤满之后就查不出"状态到底为什么变"——那才是它存在的理由。
let wakeSends = 0;
let lastWakeAt = 0;
// pin 住 gaze：主进程每 100ms 推一次真实光标，本地 mousemove 又写一遍，
// 会盖掉注入值。回归要断言"瞳孔朝哪"，就得先让注入值稳定成立。
let gazePinned = false;

if (window.clawd) {
  // 主题落地的唯一入口：换主题必须走这里，否则 window.VISUAL_STATES 会跟着漂。
  // 那个全局是**给外面看进来的窗口**（回归脚本、DevTools、预览页都在读它），
  // 新版一度把它删了，结果十几条断言同时"查不到东西"而集体失效——
  // 而失效的方式是 undefined 而不是报错，最容易被当成"功能没做"。
  const adoptTheme = (theme) => {
    currentTheme = theme;
    // 换了主题，上一主题的变体游标就作废了——不清的话新主题会从一个
    // 与它无关的偏移接着走（而且那个偏移可能超出它的变体数量）。
    for (const k of Object.keys(variantCursor)) delete variantCursor[k];
    activeVariant = null;
    window.VISUAL_STATES = (theme && theme.states) || null;
    renderState(currentState);
  };

  window.clawd.getTheme().then(adoptTheme).catch(() => {
    renderState(currentState);
  });

  window.clawd.onTheme(adoptTheme);

  window.clawd.onState((snapshot) => {
    stateLog.push({ t: Math.round(performance.now()), visual: snapshot && snapshot.visual });
    if (stateLog.length > 20) stateLog.shift();
    // 主进程把最近收到的 agent 事件也放在快照里一并带来。
    // 没有它，排查"它为什么变成 idle"就只能靠猜——视觉层只看到结果，看不到是被哪个事件推的。
    if (snapshot && Array.isArray(snapshot.recent)) lastEvents = snapshot.recent;
    if (snapshot && snapshot.visual) {
      renderState(snapshot.visual);
    }
  });

  window.clawd.onGaze((gaze) => {
    if (gazePinned) return;
    if (gaze && typeof gaze.x === "number" && typeof gaze.y === "number") {
      lastGaze = gaze;
      applyGaze();
    }
  });
} else {
  // 浏览器独立预览模式
  renderState("idle");
}

let lastIgnore = null;
window.addEventListener("mousemove", (e) => {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  const onPet = Boolean(hit && hit.closest && hit.closest("#pet"));

  if (window.clawd && typeof window.clawd.setIgnoreMouse === "function") {
    const ignore = !onPet;
    if (ignore !== lastIgnore) {
      lastIgnore = ignore;
      window.clawd.setIgnoreMouse(ignore);
    }
  }

  // 本地鼠标视线兜底 + 摸头撸猫检测
  const rect = pet.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  if (!gazePinned) {
    lastGaze = {
      x: Math.max(-1, Math.min(1, (e.clientX - cx) / 120)),
      y: Math.max(-1, Math.min(1, (e.clientY - cy) / 120))
    };
    applyGaze();
  }

  if (onPet && ragdollRig) {
    ragdollRig.onMouseStroke(e.clientX);
  }

  // 鼠标停在睡着的猫身上 → 请求主进程把它弄醒。
  //
  // 为什么只在 `currentState === "sleeping"` 时发：醒着的猫不该为每一次
  // mousemove 付一条 IPC。正常情况下发一条、主进程醒来、下一帧推回 idle，
  // 这里的条件就不再成立，自己就停了；500ms 上限只是给"没那么快推回来"兜底。
  //
  // 为什么不能在这里直接 renderState("idle")：状态机在主进程，
  // 这里改完会被下一个 250ms 的状态推送顶回去，表现是"闪一下又睡"。
  if (onPet && currentState === "sleeping") {
    const now = performance.now();
    if (now - lastWakeAt > 500) {
      lastWakeAt = now;
      if (window.clawd && typeof window.clawd.wake === "function") {
        wakeSends++;
        window.clawd.wake();
      }
    }
  }
});

if (stage) {
  stage.addEventListener("pointerdown", (e) => {
    if (e.button === 0) {
      if (ragdollRig) ragdollRig.onPoke();
      if (window.clawd && typeof window.clawd.dragStart === "function") {
        window.clawd.dragStart();
      }
    }
  });

  stage.addEventListener("dblclick", (e) => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit && hit.closest && hit.closest("#pet")) {
      // 双击 = 开关看板。
      // 这里原来是"双击 = 写信"（S8）。信箱整套已经砍掉了（2026-10-30）——
      // 它解决的是一个不存在的问题：用户想让 agent 知道什么，直接在对话里说
      // 是一跳直达，而经桌宠转交是三跳，还多出一个会丢信的环节。
      // 空出来的这个手势给了看板：桌宠身上本来就该有一个"点一下看全局"的动作。
      if (window.clawd && typeof window.clawd.toggleDashboard === "function") {
        window.clawd.toggleDashboard();
      }
    }
  });
}

window.addEventListener("pointerup", () => {
  if (window.clawd && typeof window.clawd.dragEnd === "function") {
    window.clawd.dragEnd();
  }
});

window.addEventListener("blur", () => {
  if (window.clawd && typeof window.clawd.dragEnd === "function") {
    window.clawd.dragEnd();
  }
});

window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // 右键不再直接退出：给菜单。退出之前那一版是"右键即退、没有确认"，
  // 对手滑的人（以及想找"怎么关掉这个东西"的人）都太危险了。
  if (window.clawd && typeof window.clawd.petMenu === "function") {
    window.clawd.petMenu();
  }
});


// ============================================================================
// 调试入口
//
// 打开 DevTools 直接敲：
//   petDebug.setState('working')   马上看效果
//   petDebug.gaze({x:1,y:-1}, true) 把眼睛钉在右上
//   petDebug.springs()             看弹簧通道当前收敛到哪
//
// 这些不是"方便"，是**唯一能让回归测到内部状态的窗口**。
// 只看像素是没用的：静止画面和动画可能长得一样。
// ============================================================================
window.petDebug = {
  setState: (state) => {
    renderState(state);
    return currentState;
  },
  // 在 DevTools 里试清洗规则：petDebug.svg('<svg ...><script>..</script></svg>')
  svg: svgNode,
  gaze: (g, pin = false) => {
    gazePinned = !!pin;
    lastGaze = { x: g.x, y: g.y };
    applyGaze();
  },
  unpinGaze: () => {
    gazePinned = false;
  },
  // 骨骼引擎各弹簧通道的当前值。回归用它证明"画面上那些微动真的在算"，
  // 而不是碰巧画了一张静态图。
  springs: () => {
    // 注意这里的名字：rig 的通道表叫 `sp`（rig 构造函数里 this.sp = {...}），
    // 不是 springs。写错名字的话它**不报错，只返回 {}** —— 外部读不到就是读不到，
    // 于是"按规则应该有 26 个通道"这件事永远没人知道是错的。
    const table = ragdollRig && ragdollRig.sp;
    if (!table) return {};
    const out = {};
    for (const [k, ch] of Object.entries(table)) out[k] = Number(ch.pos.toFixed(3));
    return out;
  },
  // 当前状态跟不跟鼠标（主题里的声明，不是"图里有没有瞳孔"）
  eyeTracking: () => {
    const def = ((currentTheme && currentTheme.states) || {})[currentState];
    return !!(def && def.eyeTracking === true);
  },
  states: () => Object.keys((currentTheme && currentTheme.states) || {}),
  state: () => currentState,
  // 当前状态实际在播的是第几套资产（0 = 主资产，1..n = variants[0..]）。
  // 「多套变体」不能只靠肉眼验证：静止一到同样的图上，看不出是第几套。
  variant: () => {
    const s = (currentTheme && currentTheme.states) || {};
    const def = s[currentState] || s.idle;
    return {
      pick: variantCursor[currentState] || 0,
      id: activeVariant ? activeVariant.id : "",
      slots: def && Array.isArray(def.variants) ? def.variants.length + 1 : 1,
    };
  },
  // 当前主题声明的状态时长。**主题没写就是 null**（内置默认在 state.js 里，
  // 两份默认迟早会分叉，所以这里如实返回 null，不替它编一个）。
  timings: () => (currentTheme && currentTheme.timings) || null,
  theme: () => ({
    id: currentTheme && currentTheme.id,
    frames: Object.fromEntries(
      Object.entries((currentTheme && currentTheme.states) || {}).map(([k, v]) => [
        k,
        Array.isArray(v.frames) ? v.frames.length : 0,
      ])
    ),
    rig: ragdollRig ? "spring" : "frames",
  }),
  // working 的桌面场景现在到哪了（键盘灯 / 代码行宽度）——
  // 「在敲键盘」不能只靠前爪上下动来证明，那样和「在抖」没法区分。
  desk: () =>
    ragdollRig
      ? {
          deskOpacity: ragdollRig.els.desk.getAttribute("opacity"),
          kbGlow: ragdollRig.els.kbGlow.getAttribute("opacity"),
          codeWidths: [1, 2, 3].map((i) => ragdollRig.els["code" + i].getAttribute("width")),
        }
      : {},
  builds: () => buildCount,
  // 醒猫请求发出去多少次。回归靠它证明 S9 那条上行链路是通的——
  // 光看画面证明不了"是渲染层真的发了请求"还是"主进程自己转回了 idle"。
  wakeSends: () => wakeSends,
  // 睁眼程度（0 = 睡着闭眼，1 = 完全睁开）。断言"有过渡"只能靠它：
  // 一张静态截图里，慢慢睁开和瞬间睁开长得一模一样。
  eyeOpen: () => (ragdollRig ? Math.min(1, Math.max(0, ragdollRig.sp.eyeOpen.pos)) : null),
  stateLog: () => stateLog.slice(),
  // 最近 30 条 agent 事件（主进程记录的）：每个事件叫什么、把会话从什么改成了什么，
  // 还是压根没认出来（how:"ignored"）。查"那里明明在干活为什么显示 idle"先看这个。
  events: () => (Array.isArray(lastEvents) ? lastEvents.slice() : []),
};

