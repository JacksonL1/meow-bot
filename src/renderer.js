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

// ------------------------------------------------------------
// 状态切换
// ------------------------------------------------------------

function svgNode(markup) {
  const tpl = document.createElement("template");
  tpl.innerHTML = markup.trim();
  return tpl.content.firstElementChild;
}

function buildFrames(state) {
  const def = window.VISUAL_STATES[state] || window.VISUAL_STATES.idle;
  const nodes = def.frames.map((markup) => {
    const node = svgNode(markup);
    node.classList.add("frame");
    return node;
  });
  nodes[0].classList.add("on");
  return { nodes, def };
}

function setState(state) {
  if (state === currentState || !window.VISUAL_STATES[state]) return;

  const prevLayer = layers[activeLayer];
  const nextIndex = 1 - activeLayer;
  const nextLayer = layers[nextIndex];

  // 1) 先把新状态的所有帧画进"看不见"的那一层
  const { nodes, def } = buildFrames(state);
  nextLayer.replaceChildren(...nodes);
  frames = nodes;
  frameIndex = 0;
  currentState = state;

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

// ------------------------------------------------------------
// 启动 + 调试入口
//
// window.petDebug 是给学习用的：打开 DevTools 直接敲
//   petDebug.setState('working')     马上看效果
//   petDebug.gaze({x:1,y:-1})        手动把眼睛拉到右上
// ------------------------------------------------------------

window.clawd.onState((snapshot) => setState(snapshot.visual || "idle"));

window.petDebug = {
  setState,
  gaze: (g) => {
    gazeTarget = g;
    if (!gazeRaf) gazeRaf = requestAnimationFrame(stepGaze);
  },
  states: () => Object.keys(window.VISUAL_STATES),
};

setState("idle");
