"use strict";
// ============================================================
// S6 会话看板的渲染层
//
// 2026-11-10 的改版（用户原话：「现在的会话太乱了」）：从**一个平铺列表**改成
// 「平台 → 会话」两级。乱在哪：同一个列表里混着 WorkBuddy 和 DeepSeek Harness
// 的会话，而它们连"能不能往里说话"都不一样——用户没法一眼看出哪条来自哪儿。
//
// 一级是平台（由每行的 `agent` 字段决定），二级是那条平台下的会话。
// 平台那一行还承担一个**平台级的事实**：「只能看」——WorkBuddy / Claude Code
// 在本机没有可写的 CLI，能不能说话不是某条会话的特殊情况，贴在这一行才对。
//
// 一条卡片仍是两路数据拼起来：
//   · dashboard_snapshot → 猫在演什么（状态、闲置、聚焦的是哪条）
//   · agent_sessions     → 会话里发生了什么（最后一轮问答、模型、token、上下文）
// 两者按 session id join。为什么不用一个接口：数据源不同（状态机 250ms 一拍 /
// DSH 探测 1s + 磁盘扫描带缓存），生命周期也不同（Snapshot 还被 HTTP /state 复用）。
//
// 三条原则和气泡一致：
//   1. 所有来自 agent 的字符串一律 textContent 写入。**这条现在更要紧了**：
//      卡片里会显示用户的 prompt 原文和模型回复。
//   2. 数据靠轮询拿（1s）。idleMs / ageMs 本来就随时间变，即使没人发事件也得刷新。
//   3. 演示模式只在渲染层生效——它掩盖的是**显示**，不是数据。
// ============================================================

const el = {
  groups: document.getElementById("groups"),
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

// 平台 → 显示名。**认不出就原样显示 id**（不编一个好听的名字）：
// 平台名是宿主从 hook / 磁盘读来的事实，编名字等于让用户以为我们认出来了。
const AGENT_META = {
  dsh: { name: "DeepSeek Harness" },
  workbuddy: { name: "WorkBuddy" },
  "claude-code": { name: "Claude Code" },
  codebuddy: { name: "CodeBuddy" },
  unknown: { name: "未知来源" },
};

function agentName(a) {
  return (AGENT_META[a] && AGENT_META[a].name) || String(a || "未知来源");
}

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

// ---- 折叠状态 ----
// 存在 localStorage：它只是"我现在想看哪个平台"，不敏感，也不必回主进程。
const COLLAPSE_KEY = "clawd.collapsed";
let collapsed = new Set();
try {
  collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]"));
} catch {}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  } catch {}
}

// ---- 每组先只显示几条 ----
//
// 为什么需要（2026-11-10，真机实测）：DSH 那组一开就是 **46 条**——分组只解决了
// "两家的会话混在一起"，没解决"一屏全是历史"。用户要的是"我刚才在干什么"，
// 不是档案室。所以默认每组给最近 8 条，剩下的折成一行「还有 N 条」。
//
// 展开状态只记在内存里：它是一个临时动作（"我现在要翻一下"），
// 刷新后回到收敛状态反而更符合预期——和平台折叠不同，那个是长期偏好。
const SHOW_LIMIT = 8;
const expandedGroups = new Set();

// ---- 卡片 ----

/** key = `agent/id`：两个平台各有一条同名会话时不能互相顶掉。 */
/** @type {Map<string, ReturnType<typeof makeCard>>} */
const cards = new Map();
/** @type {Map<string, ReturnType<typeof makeGroup>>} */
const groups = new Map();

function makeCard() {
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

  const copy = document.createElement("button");
  copy.textContent = "复制路径";
  foot.append(note, say, copy);

  li.append(head, sub, ask, ans, foot);
  const card = { li, badge, title, idle, dir, model, chip, ask, ans, note, say, copy, id: "", key: "", copyKey: "", canSay: false };

  // 监听器只绑一次，具体发给谁在每次 render 时更新到 `card.*` 上——
  // 卡片是复用的，闭包里钉死一个 id 会在会话换组之后指向别人。
  say.addEventListener("click", () => {
    // 走和桌宠完全相同的入口：能不能续写在窗口打开的那一刻就显示出来，
    // 这里不需要（也不应该）再判一遍。
    if (!card.canSay) return;
    window.clawd.openCompose(card.id).catch((err) => {
      note.textContent = String(err);
      note.classList.add("bad");
    });
  });
  copy.addEventListener("click", async () => {
    const ok = await window.dashboard.copyPath(card.copyKey);
    copy.textContent = ok ? "已复制" : "无路径";
    setTimeout(() => (copy.textContent = "复制路径"), 1200);
  });
  return card;
}

/** 一级：平台。组头点一下折叠，折叠状态记在 localStorage。 */
function makeGroup(agent) {
  const sec = document.createElement("section");
  sec.className = `group a-${agent}`;
  sec.dataset.agent = agent;

  const gh = document.createElement("div");
  gh.className = "gh";
  gh.setAttribute("role", "button");
  gh.tabIndex = 0;
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  const dot = document.createElement("span");
  dot.className = "gdot";
  const name = document.createElement("span");
  name.className = "gname";
  const meta = document.createElement("span");
  meta.className = "gmeta";
  const note = document.createElement("span");
  note.className = "gnote";
  gh.append(caret, dot, name, meta, note);

  const ul = document.createElement("ul");
  // 「还有 N 条」那一行常驻在 ul 末尾，不显示时是 hidden——
  // 这样卡片和它的位置关系不会因为这一行时有时无而抖。
  const more = document.createElement("li");
  more.className = "more";
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  more.append(moreBtn);
  moreBtn.addEventListener("click", () => {
    expandedGroups.add(agent);
    tick();
  });

  sec.append(gh, ul);

  const toggle = () => {
    if (collapsed.has(agent)) collapsed.delete(agent);
    else collapsed.add(agent);
    saveCollapsed();
    applyCollapsed(agent);
  };
  gh.addEventListener("click", toggle);
  gh.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  const g = { sec, ul, more, moreBtn, name, meta, note, agent };
  applyCollapsed(agent, g);
  return g;
}

function applyCollapsed(agent, g = groups.get(agent)) {
  if (!g) return;
  const on = collapsed.has(agent);
  g.sec.classList.toggle("collapsed", on);
  // 折叠之后组头自己得说明白"里面还有几条"，否则看起来像这个平台没会话。
  if (on) g.sec.setAttribute("data-collapsed", "1");
  else g.sec.removeAttribute("data-collapsed");
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
    const r = byId.get(id) || null;
    // 平台以**磁盘那条**为准：它是"这个会话 id 属于哪个产品"的直接证据。
    // hook 那条只在会话还没落盘时兜底（老装法的 hook 会一直报 claude-code）。
    out.push({
      ...s,
      id,
      live: true,
      agent: String((r && r.agent) || s.agent || "unknown"),
      rich: r,
    });
    byId.delete(id);
  }
  for (const r of byId.values()) {
    out.push({
      id: String(r.id),
      state: null,
      live: false,
      agent: String(r.agent || "unknown"),
      cwd: r.cwd,
      title: r.title,
      idleMs: 0,
      ageMs: 0,
      rich: r,
    });
  }
  return out;
}

const ORDER = { error: 0, notification: 1, working: 2, thinking: 3, attention: 4, idle: 5, sleeping: 6 };

function isRunning(r) {
  return ["working", "thinking", "notification"].includes(String(r.state));
}

/** 这条会话"最后一次有动静"的绝对时刻（ms）。历史会话只有 rich 里那个。 */
function stamp(r) {
  if (r.live) return Date.now() - (Number(r.idleMs) || 0);
  return Number((r.rich && r.rich.updated_ms) || 0);
}

/** 组内排序：活着的按状态优先级，历史的按"最近动过"。 */
function cmpRow(a, b) {
  const ra = a.live ? ORDER[a.state] ?? 9 : 9;
  const rb = b.live ? ORDER[b.state] ?? 9 : 9;
  if (ra !== rb) return ra - rb;
  return stamp(b) - stamp(a);
}

function render(snapshot, rich) {
  const rows = join(snapshot, rich);
  const dominantVisual = snapshot?.visual;

  // 顶部聚合：几条在跑 / 一共多少 token。比单纯一个"3"有用。
  const running = rows.filter(isRunning).length;
  const tok = rows.reduce((a, r) => a + ((r.rich && r.rich.tokens_out) || 0), 0);
  el.sum.replaceChildren();
  const n = document.createElement("b");
  n.textContent = String(rows.length);
  el.sum.append(n, document.createTextNode(" 条"));
  if (running) el.sum.append(document.createTextNode(` · ${running} 条在跑`));
  if (tok) el.sum.append(document.createTextNode(` · 累计出 ${fmtTok(tok)} token`));

  el.empty.hidden = rows.length > 0;

  // 按平台分组
  const byAgent = new Map();
  for (const r of rows) {
    const a = String(r.agent || "unknown");
    if (!byAgent.has(a)) byAgent.set(a, []);
    byAgent.get(a).push(r);
  }

  // 组的顺序：**有活在跑的平台排在最前**（那是用户此刻关心的），
  // 其次按最近一条的动静。以前是全局按状态排，结果两个平台的会话交错在一起。
  const ordered = [...byAgent.keys()].sort((x, y) => {
    const ax = byAgent.get(x);
    const ay = byAgent.get(y);
    const dx = ax.filter(isRunning).length;
    const dy = ay.filter(isRunning).length;
    if (dx !== dy) return dy - dx;
    return Math.max(...ay.map(stamp)) - Math.max(...ax.map(stamp));
  });

  const seenGroups = new Set();
  /** 这一轮真正渲染出来的卡片（`agent/id`）。清理靠它，不靠"组里有没有"——
   *  被 SHOW_LIMIT 挡住的卡片必须从 DOM 里撤掉，否则展开/收拢一次就漏一批。 */
  const seenKeys = new Set();
  ordered.forEach((agent) => {
    seenGroups.add(agent);
    let g = groups.get(agent);
    if (!g) {
      g = makeGroup(agent);
      groups.set(agent, g);
    }

    const list = byAgent.get(agent).sort(cmpRow);
    const run = list.filter(isRunning).length;
    const latest = Math.max(...list.map(stamp));
    g.name.textContent = agentName(agent);
    g.meta.textContent =
      `${list.length} 条` +
      (run ? ` · ${run} 条在跑` : "") +
      (latest ? ` · ${fmtIdle(Math.max(0, Date.now() - latest))}` : "");

    // 平台级的"能不能说话"。DSH 有 `headless --session-id`，别的没有可写的 CLI。
    const sayable = list.some((r) => r.rich && r.rich.can_say);
    g.note.textContent = sayable ? "" : "只能看";
    g.note.title = sayable
      ? ""
      : `${agentName(agent)} 的会话没法从桌宠往里写（没有可用的 CLI 入口），这里只做展示`;
    applyCollapsed(agent, g);

    const shown =
      expandedGroups.has(agent) || list.length <= SHOW_LIMIT ? list : list.slice(0, SHOW_LIMIT);

    shown.forEach((s, index) => {
      const key = `${agent}/${s.id}`;
      seenKeys.add(key);
      let card = cards.get(key);
      if (!card) {
        card = makeCard();
        cards.set(key, card);
      }
      card.id = String(s.id);
      card.key = key;
      // DSH 的会话在图状态机里有全路径（按裸 id 查）；磁盘扫出来的那几家只有
      // 宿主侧那份 `agent/id`。这个差别由宿主兜底，这里只把两种都送对。
      card.copyKey = agent === "dsh" ? String(s.id) : key;
      const r = s.rich || {};
      card.canSay = Boolean(r.can_say);

      // 1) 状态。没有活态的历史会话显示「记录」——它不是在做什么，它只是存在过。
      const meta = STATE_META[s.state] || { label: "记录", cls: "b-sleeping" };
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

      // 历史会话没有"闲置"，只有"多久以前"——两者都由 stamp() 算，语义一致。
      card.idle.textContent = s.live ? fmtIdle(s.idleMs) : fmtIdle(Math.max(0, Date.now() - stamp(s)));

      // 6) 底部提示：发送失败的原因留在这儿，比一闪而过的弹窗有用。
      //    `sayErrors` 按**裸 session id** 存：那个事件只可能来自 DSH 的发送，
      //    和卡片 key（`agent/id`）不是一回事。
      const err = sayErrors.get(String(s.id));
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
      card.say.disabled = !card.canSay;
      card.say.title = !card.canSay
        ? r.agent_preset
          ? "这条是桌面端建的，DSH 不许一次性 runner 往里写；点了会在桌宠里新起一条"
          : `${agentName(agent)} 没有可写的 CLI，这条会话只能看`
        : "在桌宠那个小窗里对着这条会话说";

      // 主导标记：这条正是桌宠此刻在演的那个状态
      card.li.classList.toggle("dominant", s.state != null && s.state === dominantVisual);

      // 按排序结果调整 DOM 顺序（insertBefore 对已在正确位置的节点是空操作）
      const at = g.ul.children[index];
      if (at !== card.li) g.ul.insertBefore(card.li, at || null);
    });

    // 「还有 N 条」永远在最后一行：append 对已在末尾的节点是移动，不是复制。
    // 不需要的时候**移出 DOM**，不是 hidden——留着它，"组里有几条会话"这件事
    // 在 DOM 上就多出一个人造节点（闸门数 li 的时候会数错）。
    const rest = list.length - shown.length;
    if (rest > 0) {
      g.moreBtn.textContent = `还有 ${rest} 条（展开）`;
      g.ul.append(g.more);
    } else {
      g.more.remove();
    }

    // 组本身也要排到正确的位置
    const gAt = el.groups.children[ordered.indexOf(agent)];
    if (gAt !== g.sec) el.groups.insertBefore(g.sec, gAt || null);
  });

  for (const [key, card] of cards) {
    if (!seenKeys.has(key)) {
      card.li.remove();
      cards.delete(key);
    }
  }
  for (const [agent, g] of groups) {
    if (!seenGroups.has(agent)) {
      g.sec.remove();
      groups.delete(agent);
    }
  }
}

async function tick() {
  try {
    // 两路并行：状态机那条永远有；agent 那条在没装任何 agent 时会返回空，
    // 失败也不该让整个看板空掉（那会把"没装"显示成"没有会话"）。
    const [snap, rich] = await Promise.all([
      window.dashboard.getSnapshot(),
      window.dashboard.agentSessions().catch(() => []),
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
