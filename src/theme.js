"use strict";
// ============================================================
// S7  主题加载器（主进程）
//
// ---- 职责边界（先看这一段）----
//   这里只做「文件与格式」的校验：路径、扩展名、大小、字段类型与范围。
//   这里**不做内容清洗**——SVG 的标签白名单在渲染层（renderer.js），
//   因为清洗需要 DOMParser + DOM，主进程里没有 DOM。
//
//   分层的好处：主进程决定「能不能读这个文件」，渲染层决定「读来的东西能不能进 DOM」。
//   两道闸门串联，任何一道单独失效都不会直接变成 XSS。
//
// ---- 主题是不可信输入，所以每条校验都按最坏情况写 ----
//   · id 必须来自 readdir 的真实目录名 → 用户传什么都不会被拼进路径
//   · 资产名必须匹配白名单正则 → 挡 ../、绝对路径、盘符、反斜杠
//   · 解析出的真实路径必须仍在 assets/ 内 → 双保险，防正则被绕过
//   · 单文件 256KB / 单主题 4MB / 单状态 12 帧 → 防内存与渲染炸弹
//   · 任何一条不合格 → **整个主题拒绝**，不做部分加载。
//     部分加载会得到一个"半坏不坏"的形象，作者根本不会发现。
// ============================================================

const fs = require("node:fs");
const path = require("node:path");

const { userDataDir } = require("./port-file");

// 主题从哪来：默认是项目里的 themes/。
// CLAWD_THEMES_DIR 只给回归用——它需要造一批"故意坏掉"的主题来验拒绝路径，
// 又不该往仓库里塞垃圾。和 CLAWD_PORT_FILE 是同一个思路：测试要能自造环境。
const THEMES_DIR = process.env.CLAWD_THEMES_DIR
  ? path.resolve(process.env.CLAWD_THEMES_DIR)
  : path.join(__dirname, "..", "themes");
const PREF_FILE = path.join(userDataDir(), "clawd-starter.theme");

const SCHEMA_VERSION = 1;

// 渲染层只认这七个状态名（与 state.js 的 EVENT_STATE / visuals 的键一致）。
// 少一个都会让状态机切到一个没有帧的状态，渲染层会退回 idle。
const STATE_NAMES = ["idle", "thinking", "working", "attention", "error", "notification", "sleeping"];

const MAX_FILE_BYTES = 256 * 1024;
const MAX_THEME_BYTES = 4 * 1024 * 1024;
const MAX_FRAMES_PER_STATE = 12;
const MIN_FPS = 1;
const MAX_FPS = 30;

// 资产名：字母数字开头，只允许 字母数字 . _ -，必须以 .svg 结尾，最长 64。
// 这个正则同时挡掉了 `../x`、`/etc/x`、`C:\x`、`a\b`、带空格的名字。
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.svg$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// ------------------------------------------------------------
// 部件动画（"活猫感"）
//
// 为什么动画不写在主题的 SVG 里：白名单拒了 <style> 和 SMIL（见 SECURITY.md），
// 所以主题作者没法写 CSS 动画；剩下唯一的路就是多画几帧再逐帧替换，
// 而 6~8fps 的逐帧替换一定是频闪，看着"卡顿"。
// 所以改成：主题只**声明**哪个部件怎么动，渲染层用 rAF 连续插值（60fps）。
// SVG 里的约定见 themes/README.md：被动画的部件是外层 <g class="m-xxx">，
// 静角烧在内层，两者不打架。
//
// 单条规则写错只丢这一条，不连坐整个主题——和 fps 的处理一致：
// 动画坏了应该表现为"不动"，而不是"主题加载失败、画面空白"。
// ------------------------------------------------------------
const MAX_MOTION_RULES = 12;
const MOTION_TYPES = new Set(["rotate", "scale", "translate", "blink"]);
const PART_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

function finiteOr(v, lo, hi) {
  return Number.isFinite(v) ? clamp(v, lo, hi) : null;
}

function pairOr(v, lo, hi) {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = finiteOr(v[0], lo, hi);
  const b = finiteOr(v[1], lo, hi);
  return a === null || b === null ? null : [a, b];
}

function normalizeMotion(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const rule of raw.slice(0, MAX_MOTION_RULES)) {
    if (!isPlainObject(rule)) continue;
    if (typeof rule.part !== "string" || !PART_RE.test(rule.part)) continue;
    if (!MOTION_TYPES.has(rule.type)) continue;

    const base = {
      part: rule.part,
      type: rule.type,
      period: finiteOr(rule.period, 200, 20000) ?? 3000,
      phase: finiteOr(rule.phase, 0, 1) ?? 0,
      pivot: pairOr(rule.pivot, 0, 200) ?? [100, 100],
    };

    if (rule.type === "blink") {
      out.push({
        ...base,
        min: finiteOr(rule.min, 400, 60000) ?? 3000,
        max: finiteOr(rule.max, 600, 90000) ?? 7000,
      });
      continue;
    }
    if (rule.type === "rotate") {
      const from = finiteOr(rule.from, -180, 180);
      const to = finiteOr(rule.to, -180, 180);
      if (from === null || to === null) continue;
      out.push({ ...base, from, to });
      continue;
    }
    // scale 上限 3 是为了防止一个 scale(80) 把整幅图放大到撑爆窗口；
    // translate 用 viewBox 尺度（200）的 40% 作为上限。
    const lim = rule.type === "scale" ? [0.2, 3] : [-80, 80];
    const from = pairOr(rule.from, lim[0], lim[1]);
    const to = pairOr(rule.to, lim[0], lim[1]);
    if (!from || !to) continue;
    out.push({ ...base, from, to });
  }
  return out;
}

// 彩蛋（gags）：隔一阵干一件"一次性"的事（钓上鱼吃掉 / 钓上拖鞋扔掉）。
// motion 是循环的，表达不了"偶尔来一次"，所以单开一层。
//
// 一条彩蛋 = 一组部件 + 一个排期区间 + 一串**步骤**。
// 步骤和 motion 的差别就两处，但两处都很关键：
//   1. 步骤是**一次性**的：在 [at, at+span] 里从 from 走到 to；
//      还没到点的不参与，过了点的停在 to 上，直到被同一部件的下一段接走。
//      motion 是 period/phase 的无限循环，写不出"先浮上来，停一下，再被吃掉"。
//   2. 步骤按数组顺序应用，**同一部件多段时后一条覆盖前一条**。
//      所以相邻两段的端点必须写成一样的值（a 的 to == b 的 from），否则会跳一下。
// 校验思路和 motion 一致：名字走 PART_RE、时间与数量全部钳制、坏一条只丢一条。
const MAX_GAGS = 4;
const MAX_GAG_PARTS = 4;
const MAX_GAG_STEPS = 8;
const EASES = new Set(["out", "in", "inout"]);

function normalizeGagSteps(raw, duration) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const step of raw.slice(0, MAX_GAG_STEPS)) {
    if (!isPlainObject(step)) continue;
    if (typeof step.part !== "string" || !PART_RE.test(step.part)) continue;
    if (!MOTION_TYPES.has(step.type) || step.type === "blink") continue;

    const at = finiteOr(step.at, 0, duration) ?? 0;
    // span 不能超出彩蛋本身：at + span > duration 的那一截演不到，提前夹住，
    // 否则作者会以为"我写了 800ms 的抛出"，实际只播了 300ms。
    const span = Math.min(finiteOr(step.span, 50, duration) ?? duration - at, duration - at) || 50;

    const base = {
      part: step.part,
      type: step.type,
      at,
      span,
      ease: EASES.has(step.ease) ? step.ease : "out",
      pivot: pairOr(step.pivot, 0, 200) ?? [100, 100],
    };

    if (step.type === "rotate") {
      const from = finiteOr(step.from, -180, 180);
      const to = finiteOr(step.to, -180, 180);
      if (from === null || to === null) continue;
      out.push({ ...base, from, to });
      continue;
    }
    const lim = step.type === "scale" ? [0.02, 3] : [-120, 120];
    const from = pairOr(step.from, lim[0], lim[1]);
    const to = pairOr(step.to, lim[0], lim[1]);
    if (!from || !to) continue;
    out.push({ ...base, from, to });
  }
  return out;
}

function normalizeGags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const g of raw.slice(0, MAX_GAGS)) {
    if (!isPlainObject(g)) continue;
    if (typeof g.name !== "string" || !PART_RE.test(g.name)) continue;

    const parts = Array.isArray(g.parts)
      ? g.parts.filter((p) => typeof p === "string" && PART_RE.test(p)).slice(0, MAX_GAG_PARTS)
      : [];
    if (!parts.length) continue;

    // every 是"多久来一次"的区间，取随机值。写反了就丢掉这条，
    // 而不是自动 swap——作者笔误应该报出来，不该被悄悄纠正成另一种节奏。
    const every = pairOr(g.every, 800, 120000) || [8000, 18000];
    if (every[1] < every[0]) continue;

    const duration = finiteOr(g.duration, 300, 10000) ?? 2500;
    const steps = normalizeGagSteps(g.steps, duration);
    if (!steps.length) continue;

    out.push({ name: g.name, parts, every, duration, steps });
  }
  return out;
}

/**
 * 列出磁盘上真实存在的主题 id。**所有**对外接口都以这个结果为准，
 * 外部传进来的 id 先在这里比对，比对不上就直接拒——这一步比任何正则都可靠。
 */
function listThemeIds() {
  let entries;
  try {
    entries = fs.readdirSync(THEMES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

function themeDir(id) {
  return path.join(THEMES_DIR, id);
}

function assetsDir(id) {
  return path.join(themeDir(id), "assets");
}

/**
 * 读一个资产文件。返回 {ok, markup} 或 {ok:false, error}。
 * 三道检查：名字合法 → 真实路径仍在 assets/ 内 → 大小与内容可用。
 */
function readAsset(id, name, budget) {
  if (typeof name !== "string" || !ASSET_RE.test(name)) {
    return { ok: false, error: `资产名不合法：${JSON.stringify(name)}（只允许 字母数字._-，且必须以 .svg 结尾）` };
  }

  const base = assetsDir(id);
  const abs = path.resolve(base, name);

  // 双保险：即使正则被绕过，路径也必须落在 assets/ 这一层里。
  // 用 sep 收尾是为了挡住 `assets-evil/` 这种前缀相同的兄弟目录。
  const inside = abs.startsWith(base + path.sep);
  if (!inside) return { ok: false, error: `资产越界：${name}` };

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { ok: false, error: `资产不存在：${name}` };
  }
  if (!st.isFile()) return { ok: false, error: `资产不是文件：${name}` };
  if (st.size > MAX_FILE_BYTES) {
    return { ok: false, error: `资产过大：${name}（${st.size} 字节，上限 ${MAX_FILE_BYTES}）` };
  }
  budget.bytes += st.size;
  if (budget.bytes > MAX_THEME_BYTES) {
    return { ok: false, error: `主题总大小超限（上限 ${MAX_THEME_BYTES} 字节）` };
  }

  let markup;
  try {
    markup = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { ok: false, error: `读不了资产 ${name}：${e.message}` };
  }

  // 便宜的预筛：内容里必须真的有个 <svg。真正挡恶意内容的是渲染层的白名单，
  // 这里只是把「把 .txt 改名成 .svg」这种低级情况在加载阶段就报出来。
  if (!/<svg[\s>]/i.test(markup)) {
    return { ok: false, error: `资产不是 SVG：${name}` };
  }

  return { ok: true, markup };
}

/**
 * 校验并读取一个主题。
 * 成功：{ok:true, theme:{id, name, author, version, description, states}}
 * 失败：{ok:false, id, error}
 *
 * 失败一律**整体拒绝**，不返回半个主题。
 */
function loadTheme(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return { ok: false, id: String(id), error: "主题 id 不合法" };
  }
  if (!listThemeIds().includes(id)) {
    return { ok: false, id, error: `没有这个主题：${id}` };
  }

  const jsonPath = path.join(themeDir(id), "theme.json");
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch (e) {
    return { ok: false, id, error: `theme.json 读不了或不是合法 JSON：${e.message}` };
  }
  if (!isPlainObject(meta)) return { ok: false, id, error: "theme.json 顶层必须是对象" };
  if (meta.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, id, error: `schemaVersion 必须是 ${SCHEMA_VERSION}（读到 ${JSON.stringify(meta.schemaVersion)}）` };
  }
  if (!isPlainObject(meta.states)) return { ok: false, id, error: "缺少 states 对象" };
  if (!meta.states.idle) return { ok: false, id, error: "必须定义 idle 状态（它是所有缺失状态的兜底）" };

  const budget = { bytes: 0 };
  const states = {};
  for (const name of STATE_NAMES) {
    const def = meta.states[name];
    if (!def) continue; // 允许缺，加载完成后补齐成 idle

    if (!isPlainObject(def)) return { ok: false, id, error: `状态 ${name} 必须是对象` };

    const list = def.frames;
    if (!Array.isArray(list) || list.length === 0) {
      return { ok: false, id, error: `状态 ${name} 的 frames 必须是非空数组` };
    }
    if (list.length > MAX_FRAMES_PER_STATE) {
      return { ok: false, id, error: `状态 ${name} 帧数超限（${list.length} > ${MAX_FRAMES_PER_STATE}）` };
    }

    // fps 钳制而不是拒绝：写错的 fps 不该让整个主题挂掉，
    // 但 0 或 1000 会让帧轮播变成死循环或假死，所以要拉回区间。
    const fps = Number.isFinite(def.fps) ? clamp(Math.round(def.fps), MIN_FPS, MAX_FPS) : 4;

    const frames = [];
    for (const fileName of list) {
      const r = readAsset(id, fileName, budget);
      if (!r.ok) return { ok: false, id, error: `状态 ${name}：${r.error}` };
      frames.push(r.markup);
    }

    states[name] = {
      fps,
      // 只有明确写 true 才开眼球追踪。默认关：
      // 开了但那一帧没有 <g class="pupils">，渲染层会拿到 null，属于"静默失效"。
      eyeTracking: def.eyeTracking === true,
      motion: normalizeMotion(def.motion),
      gags: normalizeGags(def.gags),
      frames,
    };
  }

  // 缺失的状态用 idle 兜住。理由：状态机随时可能切到任何一个状态，
  // 少一个就在那一刻变成"画面不动"，而作者很难联想到是主题缺项。
  for (const name of STATE_NAMES) {
    if (!states[name]) states[name] = { ...states.idle, eyeTracking: false };
  }

  return {
    ok: true,
    theme: {
      id,
      name: typeof meta.name === "string" ? meta.name.slice(0, 80) : id,
      author: typeof meta.author === "string" ? meta.author.slice(0, 80) : "",
      version: typeof meta.version === "string" ? meta.version.slice(0, 32) : "",
      description: typeof meta.description === "string" ? meta.description.slice(0, 300) : "",
      states,
    },
  };
}

/** 给看板/调试用：每个主题一行摘要，加载失败的也列出来并带上原因。 */
function listThemes() {
  return listThemeIds().map((id) => {
    const r = loadTheme(id);
    if (!r.ok) return { id, ok: false, error: r.error };
    const t = r.theme;
    return {
      id,
      ok: true,
      name: t.name,
      version: t.version,
      description: t.description,
      frames: Object.values(t.states).reduce((n, s) => n + s.frames.length, 0),
    };
  });
}

// ------------------------------------------------------------
// 主题偏好：存在 userData 里，重启后仍然是上次那个
// ------------------------------------------------------------

function readPreference() {
  try {
    const id = fs.readFileSync(PREF_FILE, "utf8").trim();
    return ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function writePreference(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) return false;
  try {
    fs.mkdirSync(path.dirname(PREF_FILE), { recursive: true });
    fs.writeFileSync(PREF_FILE, id, "utf8");
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// 兜底主题：所有主题都加载失败时用它，保证窗口永远不会变成一片空白
//
// 为什么必须有：桌宠是"没有任务栏入口"的窗口（skipTaskbar + 透明无边框）。
// 如果主题加载失败导致画面为空，用户看到的是一个**看不见的进程**——
// 既没有界面也没有退出按钮，只能去任务管理器杀。这比主题报错难处理得多。
// ------------------------------------------------------------

const FALLBACK_FRAME = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <ellipse cx="100" cy="170" rx="44" ry="7" fill="#000000" opacity="0.08"/>
  <rect x="62" y="68" width="76" height="76" rx="22" fill="#EDE9E1" stroke="#B9AF9F" stroke-width="5"/>
  <text x="100" y="122" text-anchor="middle" font-family="system-ui, sans-serif" font-size="46" font-weight="600" fill="#8A8175">?</text>
</svg>`;

function fallbackTheme(error) {
  const state = { fps: 1, eyeTracking: false, frames: [FALLBACK_FRAME] };
  const states = {};
  for (const name of STATE_NAMES) states[name] = { ...state };
  return {
    id: "__fallback__",
    name: "主题加载失败",
    author: "",
    version: "",
    description: error || "",
    states,
  };
}

/**
 * 按候选人顺序找一个能用的主题；全都不行就用兜底。
 *
 * 候选人顺序由调用方决定（偏好文件 → 环境变量 → 命令行 → 其余按名字），
 * 这里不做优先级判断，只负责"第一个成功的"。
 */
function resolveTheme(candidates = []) {
  const tried = [];

  for (const id of candidates) {
    if (typeof id !== "string" || !id) continue;
    const r = loadTheme(id);
    if (r.ok) return { theme: r.theme, error: null, tried };
    tried.push(`${id}: ${r.error}`);
  }

  // 候选人都不行 → 把磁盘上能找到的主题都试一遍。
  // 这一步让"用户删掉了默认主题"变成"换个能用的"，而不是直接黑屏。
  for (const id of listThemeIds()) {
    if (candidates.includes(id)) continue;
    const r = loadTheme(id);
    if (r.ok) return { theme: r.theme, error: tried.join("；") || null, tried };
    tried.push(`${id}: ${r.error}`);
  }

  return { theme: fallbackTheme(tried.join("；")), error: tried.join("；"), tried };
}

module.exports = {
  THEMES_DIR,
  STATE_NAMES,
  FALLBACK_FRAME,
  listThemeIds,
  listThemes,
  loadTheme,
  resolveTheme,
  readPreference,
  writePreference,
};
