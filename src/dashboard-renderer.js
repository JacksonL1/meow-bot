"use strict";
// ============================================================
// S6 会话看板的渲染层（2026-11-05 重做内容）
//
// 上一版的卡片只有「状态 + 标题 + 目录 + 空闲多久」。用户的原话是
// 「现在的看板没有任何有效信息」——因为那四样加起来只说明"有这么一条会话"，
// 而人真正想知道的是：**它在干什么、干到哪了、用的是哪个模型、花了多少**。
//
// 现在一条卡片两路数据拼起来：
//   · dashboard_snapshot → 猫在演什么（状态、闲置、聚焦的是哪条）
//   · dsh_sessions       → 会话里发生了什么（最后一轮问答、模型、token、上下文）
// 两者按 session id join。为什么不用一个接口：数据源不同（状态机 250ms 一拍 /
// DSH 探测线程 1s 一拍），生命周期也不同（Snapshot 还被 HTTP /state 复用）。
//
// 三条原则和气泡一致：
//   1. 所有来自 agent 的字符串一律 textContent 写入。**这条现在更要紧了**：
//      卡片里开始显示用户的 prompt 原文和模型回复。
//   2. 数据靠轮询拿（1s）。idleMs / ageMs 本来就随时间变，即使没人发事件也得刷新。
//   3. 演示模式只在渲染层生效——它掩盖的是**显示**，不是数据。
// ============================================================

const el = {
  list: document.getElementById("list"),
  empty: document.getElementById("empty"),
  sum: document.getElementById("sum"),
  demo: document.getElementById("demo"),
  sayNew: document.getElementById("sayNew"),
};

// 状态 → 中文名 + 徽标配色类。名字必须和 theme.json / state.rs 对得上。
const STATE_META = {
  idle: { label: "发呆", cls: "b-idle" },
  thinking: { label: "思考", cls: "b-thinking" },
  working: { label: "干活", cls: "b-working" },
  attention: { label: "收工", cls: "b-attention" },
  error: { label: "出错", cls: "b-error" },
  notification: { label: "待确认", cls: "b-notification" },
  sleeping: { label: "睡着", cls: "b-sleeping" },
};

const HIDDEN_DIR = "项目已隐藏";
const HIDDEN_TITLE = "内容已隐藏";
const HIDDEN_TEXT = "演示模式下不显示对话";

let demoMode = false;
/** 最近一次 say:done 的失败原因，按 session id（新会话记在 "" 上）。 */
const sayErrors = new Map();

// ---- 格式化 ----

function fmtIdle(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

/** token 数只保留三位有效数字的意义：1.1k / 23k / 1.2M。看板不是账本。 */
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 10_000) return `${(v / 1000).toFixed(1)}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}

function fmtSpan(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (s < 1) return "";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

// ---- 卡片 ----

/** @type {Map<string, ReturnType<typeof makeCard>>} */
const cards = new Map();

function makeCard(id) {
  const li = document.createElement("li");

  const head = document.createElement("div");
  head.className = "head";
  const badge = document.createElement("span");
  badge.className = "badge";
  const title = document.createElement("span");
  title.className = "title";
  const idle = document.createElement("span");
  idle.className = "idle";
  head.append(badge, title, idle);

  const sub = document.createElement("div");
  sub.className = "sub";
  const dir = document.createElement("span");
  dir.className = "dir";
  const dot1 = document.createElement("span");
  dot1.className = "dot";
  dot1.textContent = "·";
  const model = document.createElement("span");
  model.className = "model";
  const chip = document.createElement("span");
  chip.className = "chip";
  sub.append(dir, dot1, model, chip);

  const ask = document.createElement("div");
  ask.className = "ask";
  const ans = document.createElement("div");
  ans.className = "ans";

  const foot = document.createElement("div");
  foot.className = "foot";
  const note = document.createElement("span");
  note.className = "note";
  const say = document.createElement("button");
  say.textContent = "说一句";
  say.title = "在桌宠那个小窗里对着这条会话说";
  say.addEventListener("click", () => {
    // 走和桌宠完全相同的入口：能不能续写在窗口打开的那一刻就显示出来，
    // 这里不需要（也不应该）再判一遍。
    window.clawd.openCompose(id).catch((err) => {
      note.textContent = String(err);
      note.classList.add("bad");
    });
  });
  const copy = document.createElement("button");
  copy.textContent = "复制路径";
  copy.addEventListener("click", async () => {
    const ok = await window.dashboard.copyPath(id);
    copy.textContent = ok ? "已复制" : "无路径";
    setTimeout(() => (copy.textContent = "复制路径"), 1200);
  });
  foot.append(note, say, copy);

  li.append(head, sub, ask, ans, foot);
  return { li, badge, title, idle, dir, model, chip, ask, ans, note, say, copy };
}

/** 两路数据按 id 合成一条。状态机没有的（超出活跃窗口）也要显示—— 
 *  "看板空着但投影里有会话"比"多一行旧会话"更让人困惑。 */
function join(snapshot, rich) {
  const byId = new Map();
  for (const r of Array.isArray(rich) ? rich : []) {
    if (r && r.id) byId.set(String(r.id), r);
  }
  const out = [];
  for (const s of Array.isArray(snapshot?.sessions) ? snapshot.sessions : []) {
    const id = String(s.id || "");
    out.push({ ...s, rich: byId.get(id) || null });
    byId.delete(id);
  }
  for (const r of byId.values()) {
    out.push({
      id: r.id,
      state: null,
      cwd: r.cwd,
      title: r.title,
      idleMs: 0,
      ageMs: 0,
      rich: r,
    });
  }
  return out;
}

function render(snapshot, rich) {
  const rows = join(snapshot, rich);
  const dominantVisual = snapshot?.visual;

  // 顶部聚合：几条在跑 / 一共多少 token。比单纯一个"3"有用。
  const running = rows.filter((r) =>
    ["working", "thinking", "notification"].includes(String(r.state))
  ).length;
  const tok = rows.reduce((a, r) => a + ((r.rich && r.rich.tokens_out) || 0), 0);
  el.sum.replaceChildren();
  const n = document.createElement("b");
  n.textContent = String(rows.length);
  el.sum.append(n, document.createTextNode(" 条"));
  if (running) el.sum.append(document.createTextNode(` · ${running} 条在跑`));
  if (tok) el.sum.append(document.createTextNode(` · 累计出 ${fmtTok(tok)} token`));

  el.empty.hidden = rows.length > 0;

  const order = { error: 0, notification: 1, working: 2, thinking: 3, attention: 4, idle: 5, sleeping: 6 };
  const sorted = [...rows].sort((a, b) => {
    const d = (order[a.state] ?? 9) - (order[b.state] ?? 9);
    if (d !== 0) return d;
    return (a.idleMs || 0) - (b.idleMs || 0);
  });

  const seen = new Set();
  sorted.forEach((s, index) => {
    const id = String(s.id);
    seen.add(id);
    let card = cards.get(id);
    if (!card) {
      card = makeCard(id);
      cards.set(id, card);
    }
    const r = s.rich || {};

    // 1) 状态
    const meta = STATE_META[s.state] || { label: s.state ? String(s.state) : "外部", cls: "" };
    card.badge.textContent = meta.label;
    card.badge.className = `badge ${meta.cls}`;

    // 2) 标题 / 目录。演示模式藏标题和目录，理由和上一版一样（S6 的注释）：
    //    目录名"低敏感但容易社死"，标题是用户自己说的第一句话，敏感度更高。
    card.title.textContent = s.title ? (demoMode ? HIDDEN_TITLE : s.title) : "";
    card.title.classList.toggle("untitled", !s.title);
    card.li.classList.toggle("untitled", !s.title);
    card.dir.textContent = demoMode ? HIDDEN_DIR : s.cwd || "（未知目录）";

    // 3) 模型 + 供应商。用户自己配过供应商，所以这里不能写死任何名字。
    //    `model_default` = 这条会话自己没记模型（headless 会话就是这样），
    //    这个值是从 profile 的 agent-default-model 补来的。必须标出来：
    //    "它就是这么配的"和"这条会话真的用了它"是两句话，混成一句就是在编。
    const modelText = [r.model, r.provider].filter(Boolean).join(" · ");
    card.model.textContent = modelText ? (r.model_default ? `${modelText}（默认）` : modelText) : "";
    card.model.hidden = !modelText;
    card.model.title = r.model_default
      ? "这条会话没记模型，显示的是 headless profile 的默认模型"
      : "";

    // 4) 计数：轮数 / 进→出 / 上下文占用。**只显示有的**——
    //    headless 会话没有 sessionStats，硬填 0 就是在编。
    const bits = [];
    if (r.turns) bits.push(`${r.turns} 轮`);
    if (r.steps && r.steps !== r.turns) bits.push(`${r.steps} 步`);
    if (r.tokens_in || r.tokens_out) {
      bits.push(`${fmtTok(r.tokens_in)} → ${fmtTok(r.tokens_out)}`);
    }
    if (r.ctx_tokens && r.ctx_window) {
      const pct = (r.ctx_tokens / r.ctx_window) * 100;
      bits.push(`上下文 ${pct < 0.1 ? "<0.1" : pct.toFixed(1)}%`);
    }
    if (r.llm_ms) bits.push(`模型 ${fmtSpan(r.llm_ms)}`);
    card.chip.textContent = bits.join(" · ");
    card.chip.hidden = bits.length === 0;

    // 5) 最后一轮：用户原话 + 回复开头。这是整张卡片的信息主体。
    if (demoMode) {
      card.ask.textContent = HIDDEN_TEXT;
      card.ans.textContent = "";
    } else {
      card.ask.textContent = r.last_prompt || "";
      card.ans.textContent = r.last_reply || "";
    }

    card.idle.textContent = fmtIdle(s.idleMs);

    // 6) 底部提示：发送失败的原因留在这儿，比一闪而过的弹窗有用。
    const err = sayErrors.get(id);
    card.note.classList.toggle("bad", Boolean(err));
    if (err) {
      card.note.textContent = err;
    } else if (r.agent_preset) {
      // 桌面端 / 网页端建的会话：一次性 runner 写不进去（原因见 say.rs）。
      // 与其等用户点了「说一句」再被拒，不如现在就说清楚。
      card.note.textContent = "桌面端会话 · 只能看";
    } else {
      card.note.textContent = "";
    }
    // 能不能续：宿主在窗口里也会判一次，这里灰掉只是少一次白跑。
    card.say.disabled = false;
    card.say.title = r.agent_preset
      ? "这条是桌面端建的，DSH 不许一次性 runner 往里写；点了会在桌宠里新起一条"
      : "在桌宠那个小窗里对着这条会话说";

    // 主导标记：这条正是桌宠此刻在演的那个状态
    card.li.classList.toggle("dominant", s.state != null && s.state === dominantVisual);

    // 按排序结果调整 DOM 顺序（insertBefore 对已在正确位置的节点是空操作）
    const at = el.list.children[index];
    if (at !== card.li) el.list.insertBefore(card.li, at || null);
  });

  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.li.remove();
      cards.delete(id);
      sayErrors.delete(id);
    }
  }
}

async function tick() {
  try {
    // 两路并行：状态机那条永远有；DSH 那条在没装 DSH 时会失败，
    // 失败不该让整个看板空掉（那会把"没装"显示成"没有会话"）。
    const [snap, rich] = await Promise.all([
      window.dashboard.getSnapshot(),
      window.dashboard.dshSessions().catch(() => []),
    ]);
    render(snap, rich);
  } catch {
    // 主进程正在退出 / 窗口销毁中，静默即可，别在控制台刷错误
  }
}

// 发送失败的原因是"事件"，不是轮询能拿到的东西：它发生在一瞬间，
// 然后 dsh 就退出了。留在卡片上直到下一次成功发送或者这条会话消失。
window.dashboard.onSayDone((d) => {
  if (!d) return;
  const key = d.id ? String(d.id) : "";
  if (d.ok) {
    sayErrors.delete(key);
  } else {
    sayErrors.set(key, String(d.message || "发送失败"));
  }
  tick();
});

el.sayNew.addEventListener("click", () => {
  window.clawd
    .openCompose(null)
    .catch((err) => console.error("[dashboard] 打不开发消息窗口:", err));
});

// 演示模式存在 localStorage：它只是显示偏好，不敏感，也不必回主进程
el.demo.addEventListener("change", () => {
  demoMode = el.demo.checked;
  try {
    localStorage.setItem("clawd.demo", demoMode ? "1" : "0");
  } catch {}
  tick();
});

try {
  demoMode = localStorage.getItem("clawd.demo") === "1";
} catch {}
el.demo.checked = demoMode;

tick();
setInterval(tick, 1000);

// 调试入口：DevTools 里 dashboardDebug.render(...) 手动灌一份快照
window.dashboardDebug = {
  render,
  state: () => ({ demoMode, cards: cards.size, sum: el.sum.textContent }),
};

// ------------------------------------------------------------
// S7：主题切换
//
// 列表由主进程给，所以下拉框里能点到的每一项都是真的读得出来的。
// 加载失败的主题也会出现在列表里（禁用 + 显示原因）——
// 让它可见比让它消失好：作者改了 theme.json 之后，第一件事就是来看这里why没生效。
// ------------------------------------------------------------

const themeSel = document.getElementById("themeSel");
let currentThemeId = null;

async function loadThemes() {
  let data;
  try {
    data = await window.dashboard.listThemes();
  } catch {
    return;
  }
  if (!data) return;

  currentThemeId = data.current;
  themeSel.replaceChildren();
  for (const t of data.themes) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.ok ? t.name || t.id : `${t.id}（加载失败）`;
    opt.disabled = !t.ok;
    if (t.ok && t.id === data.current) opt.selected = true;
    themeSel.appendChild(opt);
  }
}

themeSel.addEventListener("change", async () => {
  let r;
  try {
    r = await window.dashboard.setTheme(themeSel.value);
  } catch {
    r = null;
  }
  if (!r || !r.ok) {
    // 切失败就把选择退回去，别让下拉框显示一个屏幕上没发生的东西
    themeSel.value = currentThemeId || themeSel.value;
    return;
  }
  currentThemeId = r.id;
});

// 桌宠那边换了主题，这里跟着走（保持两处显示一致）
window.dashboard.onTheme((t) => {
  currentThemeId = t.id;
  themeSel.value = t.id;
});

loadThemes();
