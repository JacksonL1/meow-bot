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
let currentDef = null; // 当前状态的完整定义（fps / eyeTracking / motion / gags）
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
  currentDef = def;
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
  startMotion(def);
  startGags(def);
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
    // 部件也是新节点，动画目标要重新收集（否则动画停在旧帧的节点上）
    if (motionRules.length) collectMotionParts();
  }, 1000 / (def.fps || 8));
}

// ------------------------------------------------------------
// 部件动画（活猫感）
//
// 为什么不用 CSS 动画：白名单拒了 <style> 和 SMIL，主题里写不了动画。
// 为什么不用多帧：逐帧替换是离散的，6~8fps 一定是频闪——用户原话"卡顿式切换"。
// 所以这里做连续插值：主题只声明"哪个部件怎么动、多快"，rAF 每帧算一次，
// 60fps。呼吸、摆尾、歪头、眨眼全部走这一条路。
//
// 约定（themes/README.md 里也写了）：被动画的部件是外层 `<g class="m-xxx">`，
// 它自身**不能有 transform**——否则会被这里的 setAttribute 覆盖掉。
// 图里烧死的静角放在内层 g 上。
// ------------------------------------------------------------

let motionRules = [];
let motionParts = new Map();
let motionRaf = null;
let motionT0 = 0;
const blinkSched = new Map(); // part -> { next, start }

function collectMotionParts() {
  motionParts = new Map();
  const svg = layers[activeLayer].querySelector("svg.on");
  if (!svg) return;
  for (const rule of motionRules) {
    if (motionParts.has(rule.part)) continue;
    // part 已经被 theme.js 用 PART_RE 限成 [a-z0-9-]，拼进选择器是安全的
    const el = svg.querySelector(".m-" + rule.part);
    if (el) motionParts.set(rule.part, el);
  }
}

function pivotTransform(pivot, inner) {
  const [px, py] = pivot;
  return `translate(${px} ${py}) ${inner} translate(${-px} ${-py})`;
}

function startMotion(def) {
  if (motionRaf) cancelAnimationFrame(motionRaf);
  motionRaf = null;
  blinkSched.clear();
  motionRules = (def && Array.isArray(def.motion) ? def.motion : []).slice();
  motionT0 = 0;
  if (!motionRules.length) return;
  collectMotionParts();
  motionRaf = requestAnimationFrame(tickMotion);
}

function tickMotion(now) {
  if (!motionT0) motionT0 = now;
  const t = now - motionT0;

  for (const rule of motionRules) {
    const el = motionParts.get(rule.part);
    if (!el) continue;

    if (rule.type === "blink") {
      el.setAttribute("transform", pivotTransform(rule.pivot, `scale(1 ${blinkScale(rule, now)})`));
      continue;
    }

    // 正弦缓动：0 → 1 → 0，首尾都停得住，不会在循环点上"顿一下"
    const p = (t / rule.period + rule.phase) % 1;
    const k = 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
    writeTransform(el, rule, k);
  }
  motionRaf = requestAnimationFrame(tickMotion);
}

// 把一条规则在"进度 k（0→1）"上的样子写进元素。
// motion（循环）和 gags（一次性）共用这一段——两边只差 k 怎么算出来，
// 写 transform 的活是同一件，分开写早晚会写出两种不一致的插值。
function writeTransform(el, rule, k) {
  if (rule.type === "rotate") {
    const a = (rule.from + (rule.to - rule.from) * k).toFixed(2);
    el.setAttribute("transform", pivotTransform(rule.pivot, `rotate(${a})`));
  } else if (rule.type === "scale") {
    const sx = (rule.from[0] + (rule.to[0] - rule.from[0]) * k).toFixed(3);
    const sy = (rule.from[1] + (rule.to[1] - rule.from[1]) * k).toFixed(3);
    el.setAttribute("transform", pivotTransform(rule.pivot, `scale(${sx} ${sy})`));
  } else {
    const x = (rule.from[0] + (rule.to[0] - rule.from[0]) * k).toFixed(2);
    const y = (rule.from[1] + (rule.to[1] - rule.from[1]) * k).toFixed(2);
    el.setAttribute("transform", `translate(${x} ${y})`);
  }
}

// 眨眼：随机间隔，闭合 140ms 一个来回。用纵向压缩代替画眼皮——
// 眼睛是圆的，压到 0.12 就是一条缝，读起来就是眨眼，不必多画两帧。
function blinkScale(rule, now) {
  let s = blinkSched.get(rule.part);
  if (!s) {
    s = { next: now + rule.min + Math.random() * (rule.max - rule.min), start: 0 };
    blinkSched.set(rule.part, s);
  }
  if (!s.start) {
    if (now < s.next) return 1;
    s.start = now;
  }
  const p = (now - s.start) / 140;
  if (p >= 1) {
    s.start = 0;
    s.next = now + rule.min + Math.random() * (rule.max - rule.min);
    return 1;
  }
  const f = p < 0.5 ? p * 2 : (1 - p) * 2;
  return 1 - 0.88 * f;
}

// ------------------------------------------------------------
// 彩蛋（gags）
//
// "一直在呼吸"和"隔一阵钓上来一条鱼"是两件事。
// motion 是循环的，写不出"偶尔来一次"；所以单开一层：主题声明
// {name, parts, every:[min,max], duration, steps[]}，这里负责三件事：
//   1. 按 every 随机排期（固定节拍一上来就显得机械）
//   2. 开演时把部件放出来（移除 display），按 steps 一次性插值
//   3. 演完**按开演前的原值**还原，再排下一次（不是一律隐藏，理由见 restoreGagParts）
//
// 两条纪律：
//   · 换状态一律清空。彩蛋属于某个状态，状态走了它就该跟着死，
//     否则会有一条鱼挂在"睡眠"的猫面前。
//   · 部件靠 display 收放，不靠 opacity。透明元素仍然参与命中判定与无障碍树，
//     而且 opacity 不在白名单允许的动画属性里（这里只能改 transform）。
// ------------------------------------------------------------

let gagDefs = [];
let gagTimer = null;
let gagRaf = null;
let gagNodes = new Map(); // part -> 元素（只包含本次彩蛋用到的）
let gagOrig = new Map(); // part -> {display, transform} 开演前的原值
let gagRun = null; // { def, t0 }

function startGags(def) {
  stopGags();
  gagDefs = def && Array.isArray(def.gags) ? def.gags.slice() : [];
  if (!gagDefs.length) return;
  scheduleGag();
}

function stopGags() {
  if (gagTimer) clearTimeout(gagTimer);
  if (gagRaf) cancelAnimationFrame(gagRaf);
  gagTimer = null;
  gagRaf = null;
  gagDefs = [];
  gagRun = null;
  restoreGagParts();
}

// 收尾必须回到**开演前的原值**，不能一律 display:none。
// 因为彩蛋的部件分两种：一种天生藏着（鱼、拖鞋，写死 display="none"），
// 另一种本来就露着（瞳孔——它被拉进彩蛋只是为了"跟着看一眼鱼"）。
// 一律隐藏的写法实测会把猫的瞳孔一起抹掉，而且看起来像"主题坏了"。
function restoreGagParts() {
  for (const [part, el] of gagNodes) {
    const orig = gagOrig.get(part) || { display: null, transform: null };
    if (orig.display === null) el.removeAttribute("display");
    else el.setAttribute("display", orig.display);
    if (orig.transform === null) el.removeAttribute("transform");
    else el.setAttribute("transform", orig.transform);
  }
  gagNodes = new Map();
  gagOrig = new Map();
}

function scheduleGag() {
  gagTimer = null;
  if (!gagDefs.length) return;
  const def = gagDefs[Math.floor(Math.random() * gagDefs.length)];
  const wait = def.every[0] + Math.random() * (def.every[1] - def.every[0]);
  gagTimer = setTimeout(() => runGag(def), wait);
}

function runGag(def) {
  if (gagRaf) cancelAnimationFrame(gagRaf);
  gagRaf = null;
  restoreGagParts();

  const svg = layers[activeLayer].querySelector("svg.on");
  if (svg) {
    for (const part of def.parts) {
      const el = svg.querySelector(".m-" + part);
      if (!el) continue;
      gagNodes.set(part, el);
      gagOrig.set(part, { display: el.getAttribute("display"), transform: el.getAttribute("transform") });
    }
  }
  // 部件一个都没找到不是错误：主题里少画一个彩蛋，表现为"这条不出现"，
  // 不该连累整个状态。排下一条就行了。
  if (!gagNodes.size) {
    scheduleGag();
    return;
  }

  for (const el of gagNodes.values()) el.removeAttribute("display");
  gagRun = { def, t0: 0 };
  renderGag(0); // 先把第 0 帧写上，否则第一帧会闪一下上一次的 transform
  gagRaf = requestAnimationFrame(tickGags);
}

// 步骤的缓动。'out' 是默认：出水、浮上来这类"由快到慢"的动作天然合手；
// 'in' 给甩出去（越甩越快）；'inout' 留给"翻个个儿"这种两头都要软的动作。
function easeCurve(p, ease) {
  if (ease === "in") return p * p * p;
  if (ease === "inout") return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  return 1 - Math.pow(1 - p, 3);
}

function renderGag(t) {
  for (const step of gagRun.def.steps) {
    const el = gagNodes.get(step.part);
    if (!el) continue;
    // **还没到点的步骤直接跳过**，不能"钳在 from 上照写一遍"。
    // 后者会把同一部件上正在演的那一段覆盖掉：实测 fish 的第一段（浮出水面 1s）
    // 被第二段（at=1900）的 from=[0,0] 压在 0 上，鱼根本没浮起来。
    // 跳过之后语义就变成"当前有效的那一段说了算"，也正是时间线的直觉。
    if (t < step.at) continue;
    // 窗口内按进度插值，过了窗口夹在 to 上（继续有效，直到被同一部件的下一段接走）
    const p = Math.min(1, (t - step.at) / step.span);
    writeTransform(el, step, easeCurve(p, step.ease));
  }
}

function tickGags(now) {
  if (!gagRun) return;
  if (!gagRun.t0) gagRun.t0 = now;
  const t = now - gagRun.t0;

  if (t >= gagRun.def.duration) {
    restoreGagParts();
    gagRun = null;
    gagRaf = null;
    scheduleGag(); // 演完接着排下一条
    return;
  }

  // 帧切换 / 换主题会把节点换掉。对着已经离开 DOM 的节点写 transform 不会报错，
  // 但屏幕上什么都不会发生——那种"彩蛋偶尔不出现"最难查，所以直接认输重排。
  for (const el of gagNodes.values()) {
    if (!el.isConnected) {
      restoreGagParts();
      gagRun = null;
      gagRaf = null;
      scheduleGag();
      return;
    }
  }

  renderGag(t);
  gagRaf = requestAnimationFrame(tickGags);
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
  // eyeTracking 是主题里的开关，**默认关**。以前这里不看它——主题写了 false
  // 也照样跟眼，那个字段等于死的（写了不生效比没写更坑，作者会以为自己关掉了）。
  // 现在的语义：只有明确 true 才跟，而且这个 false 在画面上有对象可管
  // （working 的瞳孔是一个 .pupils 组，关掉就是它不动）。
  if (!currentDef || currentDef.eyeTracking !== true) return;

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

// 调试用"钉住"：回归要断言"瞳孔会走到指定坐标"，但主进程每 100ms 会按真实光标
// 推一次 gaze，正好把测试注入的坐标覆盖掉——实测出现过断言读到的是光标位置
// （translate(-0.98 0.81)）而不是 (3.60 -2.60)。钉住之后真实推送一律忽略，
// 被测对象（渲染层的插值与写入）才被隔离出来。只在 petDebug 里用得到。
let gazePinned = false;

window.clawd.onGaze((gaze) => {
  if (gazePinned) return;
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
  gaze: (g, pin = false) => {
    // pin=true：忽略主进程的真实 gaze 推送，让注入值稳定成立（回归专用）
    gazePinned = !!pin;
    gazeTarget = g;
    if (!gazeRaf) gazeRaf = requestAnimationFrame(stepGaze);
  },
  unpinGaze: () => {
    gazePinned = false;
  },
  // 当前各部件被插值成什么样。回归用它判断"动画到底在不在动"——
  // 只看一眼像素是没用的，静止画面和动画都可能长一样。
  motion: () => {
    const out = {};
    for (const [part, el] of motionParts) out[part] = el.getAttribute("transform");
    return out;
  },
  // 当前状态声明了哪些彩蛋（working 是 fish / slipper）
  gagNames: () => gagDefs.map((g) => g.name),
  // 手动放一条彩蛋。回归等不了 7~14 秒的随机排期，但"排期"和"播放"是两件事：
  // 这里只跳过排期，播放走的还是 runGag 那条路径，测的仍然是真代码。
  gag: (name) => {
    const def = gagDefs.find((g) => g.name === name);
    if (!def) return false;
    if (gagTimer) clearTimeout(gagTimer);
    gagTimer = null;
    runGag(def);
    return true;
  },
  // 彩蛋部件此刻的 display / transform。用来证明"真的被放出来并且真的在动"。
  gagState: () => {
    const out = {};
    for (const [part, el] of gagNodes) {
      out[part] = { display: el.getAttribute("display"), transform: el.getAttribute("transform") };
    }
    return out;
  },
  // 当前状态跟不跟鼠标（主题里的声明，不是"图里有没有瞳孔"）
  eyeTracking: () => !!(currentDef && currentDef.eyeTracking === true),
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
