"use strict";
// ============================================================
// S5-3  权限气泡的渲染层
//
// 它只做三件事：把请求显示全、把两个按钮接上、把高度报给主进程。
//
// 一条产品原则写在 CSS 里：允许按钮**不做成醒目的主色**。
// 权限气泡最危险的失败模式不是被绕过，而是用户养成了"弹出来就点允许"的肌肉记忆。
// 所以按钮视觉权重接近，迫使用户先读正文。
// ============================================================

const el = {
  tool: document.getElementById("tool"),
  cmd: document.getElementById("cmd"),
  meta: document.getElementById("meta"),
  allow: document.getElementById("btnAllow"),
  deny: document.getElementById("btnDeny"),
  queue: document.getElementById("queue"),
  card: document.getElementById("card"),
  risk: document.getElementById("risk"),
  why: document.getElementById("why"),
  note: document.getElementById("note"),
};

// 这行提示是卡片的一部分，每次 render 都要还原——否则上一轮的错误信息
// 会一直挂在下一轮的卡片上，看着像这条请求也出错了。
const NOTE = el.note.textContent;

function setNote(text) {
  el.note.textContent = text || NOTE;
}

// 命令是 agent 送过来的不可信字符串。风险理由是我们自己写的固定文案，
// 但两条规矩一起守：一律 textContent、一律 createElement，不要 innerHTML。
// （硬约束 19：src/ 下 innerHTML 出现次数必须是 0，回归里有机械检查。）
function renderRisk(risk) {
  const level = risk && typeof risk.level === "string" ? risk.level : "low";
  const label = risk && typeof risk.label === "string" ? risk.label : "低";
  el.card.setAttribute("data-risk", level);
  el.risk.textContent = level === "low" ? "风险 低" : `风险 ${label}`;

  el.why.textContent = "";
  const reasons = (risk && Array.isArray(risk.reasons) ? risk.reasons : []).slice(0, 3);
  for (const r of reasons) {
    const li = document.createElement("li");
    li.textContent = typeof r.text === "string" ? r.text : "";
    el.why.appendChild(li);
  }
}

let currentId = null;

function render(req) {
  currentId = req.id;
  // 上一条请求点完之后按钮被置灰了，这里必须恢复——
  // 否则第二个及以后的权限请求全都点不动，只能等到超时回落。
  el.allow.disabled = false;
  el.deny.disabled = false;
  setNote("");
  el.tool.textContent = req.toolName || "Unknown";
  // textContent 而不是 innerHTML —— 命令是 agent 给的字符串，绝不能当 HTML 解析
  el.cmd.textContent = req.command || "(没有可显示的参数)";
  renderRisk(req.risk);
  const parts = [];
  if (req.cwd) parts.push(req.cwd);
  if (req.sessionId) parts.push(`会话 ${req.sessionId.slice(0, 8)}`);
  el.meta.textContent = parts.join(" · ");

  if (req.queued > 0) {
    el.queue.hidden = false;
    el.queue.textContent = `后面还有 ${req.queued} 个待批准`;
  } else {
    el.queue.hidden = true;
  }

  // 卡片高度随内容变，量出来告诉主进程改窗口高度（窗口本身没有固定高度）
  // 等一帧再量，避免拿到布局前的高度
  requestAnimationFrame(() => {
    const h = Math.ceil(el.card.getBoundingClientRect().height);
    window.bubble.setHeight(h);
  });
}

// 页面刚加载时 HTML 里那张卡片就是可见的，但还没有任何请求进来。
// 这时按钮必须**点不动**：否则点下去会撞上下面 `currentId === null` 的分支，
// 用户看到的是一张有内容、有按钮、点完却什么也不发生的卡片——
// "我点了允许，没有任何返回"就是这么来的。只有 render() 拿到真请求才放开。
el.allow.disabled = true;
el.deny.disabled = true;

async function decide(decision) {
  if (currentId === null) {
    setNote("这条请求已经结束了，等下一个请求吧");
    window.bubble.close(null);
    return;
  }
  const id = currentId;
  // 立刻置灰，避免主进程回写慢一拍时用户连点两次
  el.allow.disabled = true;
  el.deny.disabled = true;
  try {
    // 用等回执的那条通道（不是 send）：主进程会告诉我们"这条请求还在不在"。
    // 返回 false 意味着它已经过期了——那就要把窗收掉，否则留下的是
    // 一张永远点不动的卡片。
    const ok = await window.bubble.decide(id, decision);
    // 这一行**必须**先比对 id 再清：等回执的这几毫秒里，下一条请求可能已经
    // 到了（render 刚把它的 id 写进 currentId）。无条件清空会把那张刚显示出来
    // 的卡片变成"没有当前请求"——用户点「允许」，一个字节都不发出去，
    // 请求一直挂到超时回落。（2026-11-06 实测复现：第二条卡片显示 Read、
    // 按钮是亮的、点下去页面却回答"这条请求已经结束了"，120 秒后 204。）
    if (currentId !== id) return;
    currentId = null;
    if (!ok) {
      setNote("这条请求已经结束了（可能已经超时），交给 agent 自己决定");
      window.bubble.close(id);
    }
  } catch (err) {
    // 决定没送到主进程：按钮必须能再点一次，否则这扇窗就废了。
    // 同理，已经在显示下一条时不要去动它的按钮和文案。
    if (currentId !== id) return;
    setNote(`没能把决定送回桌宠：${(err && err.message) || err}`);
    el.allow.disabled = false;
    el.deny.disabled = false;
  }
}

el.allow.addEventListener("click", () => decide("allow"));
el.deny.addEventListener("click", () => decide("deny"));

// Esc = 我不表态，交还给 Claude Code 原生提示（不是拒绝）
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && currentId !== null) decide("no-decision");
});

window.bubble.onRequest(render);
// 注册完再握手。顺序反过来的话，主进程可能在这之前就把第一个请求发过来了。
window.bubble.ready();
