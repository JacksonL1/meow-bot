"use strict";
// ============================================================
// S6  会话看板的渲染层
//
// 三条原则，和气泡一致：
//   1. 所有来自 agent 的字符串一律 textContent 写入。cwd 的文件名、
//      session_id 都是外部输入，绝不能进 innerHTML。
//   2. 数据靠轮询拿（1s）。为什么不推送？因为 idleMs 本来就要随时间变，
//      即使没人发事件也得刷新；轮询一个本地 IPC 比维护一套"何时该推"简单得多。
//   3. 演示模式只在渲染层生效——它掩盖的是**显示**，不是数据。
//      真要彻底隐藏，应该在宿主侧不采集，那是另一件事。
// ============================================================

const el = {
  list: document.getElementById("list"),
  empty: document.getElementById("empty"),
  count: document.getElementById("count"),
  demo: document.getElementById("demo"),
};

// 状态 → 中文名 + 徽标配色类。名字必须和 visuals.js / state.js 对得上。
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

let demoMode = false;

function fmtIdle(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  return `${Math.floor(m / 60)} 小时前`;
}

// 一行 = li；复用已有节点避免每秒重建导致闪烁与按钮失焦
const rows = new Map();

function makeRow(id) {
  const li = document.createElement("li");

  const badge = document.createElement("span");
  badge.className = "badge";

  const dir = document.createElement("span");
  dir.className = "dir";

  const sid = document.createElement("span");
  sid.className = "sid";
  sid.textContent = id.slice(0, 12);

  const idle = document.createElement("span");
  idle.className = "idle";

  const copy = document.createElement("button");
  copy.className = "copy";
  copy.textContent = "复制路径";
  copy.addEventListener("click", async () => {
    const ok = await window.dashboard.copyPath(id);
    copy.textContent = ok ? "已复制" : "无路径";
    setTimeout(() => (copy.textContent = "复制路径"), 1200);
  });

  li.append(badge, dir, sid, idle, copy);
  return { li, badge, dir, idle };
}

function render(snapshot) {
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const dominantVisual = snapshot?.visual;

  el.count.textContent = String(sessions.length);
  el.empty.hidden = sessions.length > 0;

  // 按"最吵的排前面"给个稳定顺序：error → notification → working → thinking → 其他，
  // 同优先级按闲置时间升序（刚活跃的靠前）。这样一眼看到的是最需要注意的那条。
  const order = { error: 0, notification: 1, working: 2, thinking: 3, attention: 4, idle: 5, sleeping: 6 };
  const sorted = [...sessions].sort((a, b) => {
    const d = (order[a.state] ?? 9) - (order[b.state] ?? 9);
    if (d !== 0) return d;
    return (a.idleMs || 0) - (b.idleMs || 0);
  });

  const seen = new Set();
  sorted.forEach((s, index) => {
    seen.add(s.id);
    let row = rows.get(s.id);
    if (!row) {
      row = makeRow(s.id);
      rows.set(s.id, row);
    }

    const meta = STATE_META[s.state] || { label: s.state || "未知", cls: "" };
    row.badge.textContent = meta.label;
    row.badge.className = `badge ${meta.cls}`;

    // 演示模式：只隐藏目录名，状态与时间照旧——隐藏的目的是防投屏泄露项目名，
    // 不是把看板变成废纸。
    row.dir.textContent = demoMode ? HIDDEN_DIR : s.cwd || "（未知目录）";
    row.idle.textContent = fmtIdle(s.idleMs);

    // 主导标记：这条正是桌宠此刻在演的那个状态
    const isDominant = s.state === dominantVisual;
    row.li.classList.toggle("dominant", isDominant);

    // 按排序结果调整 DOM 顺序（insertBefore 对已在正确位置的节点是空操作）
    const at = el.list.children[index];
    if (at !== row.li) el.list.insertBefore(row.li, at || null);
  });

  // 清掉已经结束的会话
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.li.remove();
      rows.delete(id);
    }
  }
}

async function tick() {
  try {
    render(await window.dashboard.getSnapshot());
  } catch {
    // 主进程正在退出 / 窗口销毁中，静默即可，别在控制台刷错误
  }
}

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
window.dashboardDebug = { render, state: () => ({ demoMode, rows: rows.size }) };
