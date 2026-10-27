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
};

let currentId = null;

function render(req) {
  currentId = req.id;
  // 上一条请求点完之后按钮被置灰了，这里必须恢复——
  // 否则第二个及以后的权限请求全都点不动，只能等到超时回落。
  el.allow.disabled = false;
  el.deny.disabled = false;
  el.tool.textContent = req.toolName || "Unknown";
  // textContent 而不是 innerHTML —— 命令是 agent 给的字符串，绝不能当 HTML 解析
  el.cmd.textContent = req.command || "(没有可显示的参数)";
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

function decide(decision) {
  if (currentId === null) return;
  const id = currentId;
  currentId = null;
  // 立刻置灰，避免网络/主进程回写慢一拍时用户连点两次
  el.allow.disabled = true;
  el.deny.disabled = true;
  window.bubble.decide(id, decision);
}

el.allow.addEventListener("click", () => decide("allow"));
el.deny.addEventListener("click", () => decide("deny"));

// Esc = 我不表态，交还给 Claude Code 原生提示（不是拒绝）
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") decide("no-decision");
});

window.bubble.onRequest(render);
// 注册完再握手。顺序反过来的话，主进程可能在这之前就把第一个请求发过来了。
window.bubble.ready();
