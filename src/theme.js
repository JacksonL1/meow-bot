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

// 状态时长（毫秒）的边界。和 fps 一样：**钳制而不是拒绝**——写错的时长
// 不该让整个主题挂掉，但 0 会让 oneshot 一闪而过、过大又会假死，所以拉回区间。
const MIN_ONESHOT_MS = 200;
const MAX_ONESHOT_MS = 30_000;
const MIN_SLEEP_AFTER_MS = 2_000;
const MAX_SLEEP_AFTER_MS = 3_600_000;

// timings 只认这三个：它们就是 state.js 里 ONESHOT 的键。
// 主题**可以改这三个的时长，但没法把别的状态变成 oneshot**——
// 那是状态机的形状，不是外观参数，交给主题改会让"working 播 2 秒就消失"成为可能。
const ONESHOT_STATES = ["error", "notification", "attention"];

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
// 这里曾经有一整套 motion / gags 的校验器（部件动画 + 一次性彩蛋）。
//
// 两套都删了，因为**没有消费者**：渲染层的 motion 引擎随骨骼弹簧重写一起没了，
// 彩蛋的鱼 / 拖鞋也随「working 改回敲键盘」一起删了。
// 留着校验器的后果比删掉更糟：主题作者写对了 gags 会**校验通过、加载成功、
// 什么都不发生**——这正是这个项目踩过四次的那一类（CSP / 白名单 /
// VISUAL_STATES / petDebug.springs）。
//
// 现在主题里写 motion 或 gags 会被当作未知字段忽略。要恢复，先恢复消费者。
// ------------------------------------------------------------

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
/**
 * 归一化 timings（状态时长）。
 *
 * 三条约定，都是为了避免"写对了却什么都不发生"：
 *   1. 主题**没写**就返回 null —— 默认值的真相只有一份，在 state.js 里。
 *      这里再写一套默认，两边迟早分叉，而且分叉是静默的。
 *   2. 只认 ONESHOT_STATES 那三个；写了别的（或在 oneshot 里塞 working）
 *      一律**报进 warnings**，理由和 unknownStates 一样：静默丢弃的东西
 *      作者永远不会发现。
 *   3. 超出边界就钳，并且把"被钳了"说出来。
 *
 * @returns {{timings: object|null, warnings: string[], error?: string}}
 */
function normalizeTimings(raw) {
  if (raw === undefined) return { timings: null, warnings: [] };
  if (!isPlainObject(raw)) return { timings: null, warnings: [], error: "timings 必须是对象" };

  const warnings = [];

  let oneshotRaw = {};
  if (raw.oneshot !== undefined) {
    if (!isPlainObject(raw.oneshot)) return { timings: null, warnings, error: "timings.oneshot 必须是对象" };
    oneshotRaw = raw.oneshot;
  }

  const oneshot = {};
  for (const name of ONESHOT_STATES) {
    const v = oneshotRaw[name];
    if (v === undefined) continue;
    if (!Number.isFinite(v)) {
      warnings.push(`timings.oneshot.${name} 不是数字，已忽略`);
      continue;
    }
    const ms = clamp(Math.round(v), MIN_ONESHOT_MS, MAX_ONESHOT_MS);
    if (ms !== v) {
      warnings.push(`timings.oneshot.${name} 被钳到 ${ms}ms（允许 ${MIN_ONESHOT_MS}~${MAX_ONESHOT_MS}）`);
    }
    oneshot[name] = ms;
  }

  // 主题写了状态机不认的 oneshot 键：它永远不会生效，必须说出来。
  const unknownOneshot = Object.keys(oneshotRaw).filter((n) => !ONESHOT_STATES.includes(n));
  if (unknownOneshot.length) {
    warnings.push(`timings.oneshot 里有状态机不认识的状态（永不会生效）：${unknownOneshot.join(", ")}`);
  }

  let sleepAfterMs;
  if (raw.sleepAfterMs !== undefined) {
    if (!Number.isFinite(raw.sleepAfterMs)) {
      warnings.push("timings.sleepAfterMs 不是数字，已忽略");
    } else {
      sleepAfterMs = clamp(Math.round(raw.sleepAfterMs), MIN_SLEEP_AFTER_MS, MAX_SLEEP_AFTER_MS);
      if (sleepAfterMs !== raw.sleepAfterMs) {
        warnings.push(`timings.sleepAfterMs 被钳到 ${sleepAfterMs}ms（允许 ${MIN_SLEEP_AFTER_MS}~${MAX_SLEEP_AFTER_MS}）`);
      }
    }
  }

  const unknownKeys = Object.keys(raw).filter((k) => k !== "oneshot" && k !== "sleepAfterMs");
  if (unknownKeys.length) {
    warnings.push(`timings 里有不认识的字段（已忽略）：${unknownKeys.join(", ")}`);
  }

  return { timings: { oneshot, sleepAfterMs }, warnings };
}

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
      frames,
    };
  }

  // 缺失的状态用 idle 兜住。理由：状态机随时可能切到任何一个状态，
  // 少一个就在那一刻变成"画面不动"，而作者很难联想到是主题缺项。
  for (const name of STATE_NAMES) {
    if (!states[name]) states[name] = { ...states.idle, eyeTracking: false };
  }

  // 主题里写了但状态机不认识的状态名：**报出来，别静默丢**。
  // 这条是被踩出来的——有人给布偶猫写了 walking，加载一切正常、运行也对，
  // 只是那 4 帧永远不可能被播到。静默丢弃的东西，作者永远不会发现。
  const unknownStates = Object.keys(meta.states).filter((n) => !STATE_NAMES.includes(n));
  const warnings = unknownStates.length
    ? [`不认识的状态名（状态机没有，永不会触发）：${unknownStates.join(", ")}`]
    : [];

  // timings 类型写错直接拒绝，不静默回落：作者写了 `"timings": 5000` 期望它生效，
  // 悄悄忽略的话他只会看到"没生效"，不知道是自己写错了。
  const t = normalizeTimings(meta.timings);
  if (t.error) return { ok: false, id, error: t.error };
  warnings.push(...t.warnings);

  return {
    ok: true,
    warnings,
    theme: {
      id,
      name: typeof meta.name === "string" ? meta.name.slice(0, 80) : id,
      author: typeof meta.author === "string" ? meta.author.slice(0, 80) : "",
      version: typeof meta.version === "string" ? meta.version.slice(0, 32) : "",
      description: typeof meta.description === "string" ? meta.description.slice(0, 300) : "",
      // rigType 是主题自报的"我需要哪套渲染器"。透传出去，
      // 渲染层才不用靠 id/name 字符串猜（原来只有 id==="ragdoll" 兜底，
      // 意味着任何叫 ragdoll 的主题都会掉进同一个分支）。
      rigType: typeof meta.rigType === "string" ? meta.rigType.slice(0, 40) : "",
      states,
      // 主题没写 timings 就是 null，state.js 用自己那份默认值。
      // 默认值的真相只有一份，不要在两边各写一套。
      timings: t.timings,
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
