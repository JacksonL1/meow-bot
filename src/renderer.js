"use strict";
// ============================================================
// S3  渲染层：换状态、播帧、跟着鼠标看
//
// 三条边界，比代码本身更重要：
//   1. 渲染层不做业务判断 —— 收到 working 就播 working，不问为什么
//   2. 换状态时才重建 DOM，帧轮播只切 class（否则每秒 8 次重解析 SVG）
//   3. 眼球位移直接改 SVG 的 transform 属性，不碰 CSS，也不重绘
// ============================================================

const stage = document.getElementById("stage");
const layers = [document.getElementById("layerA"), document.getElementById("layerB")];

let activeLayer = 0; // 当前可见的那一层在 layers 里的下标
let currentState = null;
let frames = []; // 当前层里该状态的所有帧元素
let frameIndex = 0;
let framer = null;
let pendingState = "idle"; // 主题到达前收到的状态，先存着
let themeId = null;
let buildCount = 0; // 重建次数。重复重建是 bug，不是"多一点开销"
const stateLog = []; // 最近收到的状态推送（调试用，见 onState）

// ------------------------------------------------------------
// 状态切换
// ------------------------------------------------------------

// SEC-05 / S7：把 SVG 字符串变成 DOM 之前，先按白名单洗一遍。
//
// 现在 markup 来自 themes/ 下的第三方文件，是**不可信输入**。
// 白名单的定案与逐条理由见 SECURITY.md「S7 主题系统：白名单定案」，这里只记结论：
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

// 放行滤镜之后才需要的一条限制：Chrome 对超大模糊半径是同步算的，
// 一个 stdDeviation="9999" 就是一次卡死。钳到 40（200 viewBox 的 20%）。
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
        // 加了 filter / clip-path / mask 之后，这条从"锦上添花"变成唯一的出口管控——
        // 那三个属性的值天生就是 url()。
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

function buildFrames(state) {
  const def = window.VISUAL_STATES[state] || window.VISUAL_STATES.idle;
  const nodes = def.frames
    .map((markup) => svgNode(markup))
    .filter((node) => {
      if (!node) return false;
      node.classList.add("frame");
      return true;
    });
  if (!nodes.length) return null;
  nodes[0].classList.add("on");
  return { nodes, def };
}

function setState(state, force = false) {
  // 主题还没到：先记下来。主进程 300ms 就推首个状态，而主题是异步拉回来的，
  // 这个窗口期是真会撞上的（S5 第一个权限气泡就是这么丢的）。
  if (!window.VISUAL_STATES) {
    pendingState = state;
    return;
  }
  if (!force && state === currentState) return;

  // 主题一定补齐七个状态，但万一拿到个不认识的名字，退回 idle 而不是空白
  if (!window.VISUAL_STATES[state]) state = "idle";
  if (force && state === currentState) currentState = null;

  const prevLayer = layers[activeLayer];
  const nextIndex = 1 - activeLayer;
  const nextLayer = layers[nextIndex];

  // 1) 先把新状态的所有帧画进"看不见"的那一层
  const built = buildFrames(state);
  if (!built) return; // 洗不出可用节点就当没收到，保持当前画面
  const { nodes, def } = built;
  nextLayer.replaceChildren(...nodes);
  frames = nodes;
  frameIndex = 0;
  currentState = state;
  buildCount += 1;

  // 2) 再交换 opacity —— 交叉淡入就完成了
  nextLayer.classList.add("show");
  prevLayer.classList.remove("show");
  activeLayer = nextIndex;

  // 3) 旧层里的帧别留着占内存，等淡出结束再清
  setTimeout(() => {
    if (layers[1 - activeLayer] === prevLayer) prevLayer.replaceChildren();
  }, 220);

  startFramer(def);
  applyGaze();
}

function startFramer(def) {
  if (framer) clearInterval(framer);
  framer = null;

  // 单帧状态不需要定时器，省一点电
  if (!def || def.frames.length < 2) return;

  framer = setInterval(() => {
    frames[frameIndex].classList.remove("on");
    frameIndex = (frameIndex + 1) % frames.length;
    frames[frameIndex].classList.add("on");
    // 换帧之后瞳孔是新节点，必须重新套一次位移
    applyGaze();
  }, 1000 / (def.fps || 8));
}

// ------------------------------------------------------------
// 眼球追踪
//
// 主进程每 100ms 发一个归一化坐标 gaze ∈ [-1,1]，
// 这里做插值再写进 <g class="pupils"> 的 transform。
// 直接跳变会很"机器人"，插值之后才像活物。
// ------------------------------------------------------------

const MAX_X = 3.6;
const MAX_Y = 2.6;

let gazeTarget = { x: 0, y: 0 };
let gazeCurrent = { x: 0, y: 0 };
let gazeRaf = null;

function applyGaze() {
  const pupils = layers[activeLayer].querySelector("svg.on .pupils");
  if (!pupils) return; // 闭眼 / 死鱼眼没有瞳孔，直接跳过
  const dx = (gazeCurrent.x * MAX_X).toFixed(2);
  const dy = (gazeCurrent.y * MAX_Y).toFixed(2);
  pupils.setAttribute("transform", `translate(${dx} ${dy})`);
}

function stepGaze() {
  gazeRaf = null;
  const dx = gazeTarget.x - gazeCurrent.x;
  const dy = gazeTarget.y - gazeCurrent.y;
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
    gazeCurrent = { ...gazeTarget };
    applyGaze();
    return;
  }
  gazeCurrent = { x: gazeCurrent.x + dx * 0.25, y: gazeCurrent.y + dy * 0.25 };
  applyGaze();
  gazeRaf = requestAnimationFrame(stepGaze);
}

window.clawd.onGaze((gaze) => {
  gazeTarget = gaze;
  if (!gazeRaf) gazeRaf = requestAnimationFrame(stepGaze);
});

// ------------------------------------------------------------
// 输入
// ------------------------------------------------------------

let ignoring = true;

function setIgnore(next) {
  if (next === ignoring) return;
  ignoring = next;
  window.clawd.setIgnoreMouse(next);
}

window.addEventListener("mousemove", (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 命中判定用 #pet 的包围盒（176×176），窗口 240×240，
  // 四周留出的透明边距是真正穿透的。更细的 alpha 遮罩判定是后续优化。
  setIgnore(!(el && el.closest("#pet")));
});

document.addEventListener("mouseleave", () => setIgnore(true));

stage.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  window.clawd.dragStart();
});

window.addEventListener("pointerup", () => window.clawd.dragEnd());
window.addEventListener("blur", () => window.clawd.dragEnd());

window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.clawd.quit();
});

// S6：双击桌宠开关会话看板。
// 用 dblclick 而不是单击，是因为 pointerdown 已经被拖拽占用了——
// 单击必须留给"按住拖走"，否则拖拽和"点开看板"会互相打架。
stage.addEventListener("dblclick", (e) => {
  // 只认落在宠物身上的双击，透明边距上的双击不该触发
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || !el.closest("#pet")) return;
  window.clawd.toggleDashboard();
});

// ------------------------------------------------------------
// S7：主题
//
// 主题是主进程读文件、校验完再送过来的（路径与格式在主进程，标签白名单在这里）。
// 拿到之后只是"换一份帧数据"，再强制重画当前状态——不需要重开窗口。
// ------------------------------------------------------------

function applyTheme(theme) {
  if (!theme || !theme.states || typeof theme.states !== "object") return false;
  const next = currentState || pendingState || "idle";
  themeId = theme.id;
  window.VISUAL_STATES = theme.states;
  currentState = null; // 同一个状态名在新主题下是完全不同的画面，必须重建
  setState(next, true);
  return true;
}

window.clawd.onTheme(applyTheme);

// 主题是**拉**回来的，不是主进程推过来的。
// 推的话要赌渲染层已经注册好监听——S5 的第一个权限气泡就是这么丢的。
// 拉一次，天然没有时序问题。
window.clawd.getTheme().then((theme) => {
  if (theme) applyTheme(theme);
});

// ------------------------------------------------------------
// 启动 + 调试入口
//
// window.petDebug 是给学习用的：打开 DevTools 直接敲
//   petDebug.setState('working')     马上看效果
//   petDebug.gaze({x:1,y:-1})        手动把眼睛拉到右上
// ------------------------------------------------------------

window.clawd.onState((snapshot) => {
  // 留一小段最近的推送记录。这类"状态莫名弹回去"的问题，光看最终画面
  // 永远查不出来——必须知道**谁在什么时候推了什么**。
  stateLog.push({ t: Math.round(performance.now()), visual: snapshot && snapshot.visual });
  if (stateLog.length > 20) stateLog.shift();
  setState((snapshot && snapshot.visual) || "idle");
});

window.petDebug = {
  setState,
  svg: svgNode, // 在 DevTools 里试清洗规则：petDebug.svg('<svg ...><script>..</script></svg>')
  gaze: (g) => {
    gazeTarget = g;
    if (!gazeRaf) gazeRaf = requestAnimationFrame(stepGaze);
  },
  states: () => Object.keys(window.VISUAL_STATES || {}),
  // 现在屏幕上播的是哪个状态。联调时唯一可信的真相——DOM 里看不出状态名。
  state: () => currentState,
  // 当前主题 id + 每个状态的帧数，切主题后用来确认真的换了
  theme: () => ({
    id: themeId,
    frames: Object.fromEntries(
      Object.entries(window.VISUAL_STATES || {}).map(([k, v]) => [k, v.frames.length])
    ),
  }),
  // 重建次数。同一个状态被建了两次，说明有东西在重复触发——
  // 画面上看不出来（反正结果一样），但它是竞态的信号。
  builds: () => buildCount,
  // 最近收到的状态推送："状态莫名弹回去"时，这是唯一能看的时间线
  stateLog: () => stateLog.slice(),
};
