"use strict";
// ============================================================
// S5-1  权限请求的等待与回写（本项目的"裁决台"）
//
// 生命周期只有一种：
//   POST /permission 进来 → 挂起这个 HTTP 响应 → 弹气泡 → 用户点 → 写回响应 → 结束
//
// 三条红线（来自 SECURITY.md 的 S5 小节，预判已被证伪并改写）：
//   1. 任何"没拿到明确决定"的结局都返回 204，让 Claude Code 回落到它自己的原生提示。
//      不要 deny —— deny 会让工具静默失败，用户还以为自己批准过。
//   2. 请求与响应强绑定：用自增 requestId + 内存 Map，已结束的请求不允许再被响应一次。
//   3. 决定只能是 allow 或 deny 两种，"其他"一律按 204 处理。
//
// 关于 nonce：本地 HTTP hook 是"请求即响应、同一个 socket"，决定天然绑在请求上，
// 所以这里不需要 nonce。真正需要 nonce 的是远程审批（决定来自公网、可重放），
// 主仓库的 nonce 就只在 telegram-native-runner.js 里出现。详见 SECURITY.md。
// ============================================================

// 2 分钟没人点就回落，比 hook 侧的 timeout（600s）早得多。
// 可以用环境变量压低——只为了回归脚本能真的测到"超时回落 204"，
// 正常运行时没人会设它。
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAWD_PERMISSION_TIMEOUT_MS) || 120_000;

// 入参来自网络，全部限长（气泡 UI 只有这么大，超了也显示不下）
const MAX_TOOL_NAME = 64;
const MAX_SESSION_ID = 64;
const MAX_CWD = 1024;
// 命令正文：气泡里最多显示这么多，超出截断但用户仍能靠"…"意识到被截了
const MAX_COMMAND = 600;

const { assessRisk } = require("./risk");

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : undefined;
}

// tool_input 的形状每种工具都不一样（Bash 是 {command}，Edit 是 {file_path, ...}），
// 这里只把它收敛成一个可显示的字符串，不做语义判断。
function summarizeInput(toolName, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.url === "string") return input.url;
  if (typeof input.description === "string") return input.description;
  // 兜底：把第一个字符串字段拿出来，总比什么都不显示强
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function createPermissionCenter({ onRequest, onResolve } = {}) {
  /** @type {Map<number, {id,res,toolName,command,sessionId,cwd,createdAt,timer,settled}>} */
  const pending = new Map();
  let nextId = 1;

  // 唯一出口：所有结局都走这里，保证不会漏掉响应、也不会响应两次
  function settle(id, outcome) {
    const entry = pending.get(id);
    if (!entry) return false; // 已经结束了（超时/重复点击），静默忽略
    if (entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    pending.delete(id);

    const res = entry.res;
    if (outcome === "allow" || outcome === "deny") {
      const decision = outcome === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: "用户在桌宠气泡里拒绝了这个操作" };
      const body = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision,
        },
      });
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      // 204 = 我不做决定，交给 Claude Code 原生流程
      res.writeHead(204);
      res.end();
    }

    if (typeof onResolve === "function") onResolve(entry, outcome);
    return true;
  }

  function create(res, payload) {
    const id = nextId++;
    const toolName = str(payload.tool_name, MAX_TOOL_NAME) || "Unknown";
    const command = summarizeInput(toolName, payload.tool_input).slice(0, MAX_COMMAND);
    const entry = {
      id,
      res,
      toolName,
      command,
      sessionId: str(payload.session_id, MAX_SESSION_ID),
      cwd: str(payload.cwd, MAX_CWD),
      // 风险评级在创建时就算好，和命令一起锁定——渲染层拿到的永远是同一份快照。
      // 它只进 UI，不参与任何决策：settle() 的三条结局完全不受它影响。
      risk: assessRisk({ toolName, command, cwd: payload.cwd }),
      createdAt: Date.now(),
      settled: false,
      timer: null,
    };

    // 超时不做决定，回落原生提示。绝不能"超时即允许"。
    entry.timer = setTimeout(() => settle(id, "timeout"), DEFAULT_TIMEOUT_MS);

    pending.set(id, entry);
    // 连接被对端掐断（Claude Code 退出、超时放弃）时也要把条目清掉，
    // 否则气泡会一直挂着一个没人响应的请求
    res.on("close", () => {
      if (pending.has(id)) settle(id, "aborted");
    });

    if (typeof onRequest === "function") onRequest(entry);
    return entry;
  }

  return {
    create,
    decide: (id, decision) => settle(id, decision === "allow" ? "allow" : decision === "deny" ? "deny" : "no-decision"),
    // 用户直接关掉气泡（右上角的 ×）等同于"不表态"，走 204
    dismiss: (id) => settle(id, "no-decision"),
    get: (id) => pending.get(id),
    size: () => pending.size,
    // 有条目要清干净，否则进程退不出去 / 气泡残留
    dispose: () => {
      for (const id of [...pending.keys()]) settle(id, "aborted");
    },
  };
}

module.exports = { createPermissionCenter, summarizeInput, DEFAULT_TIMEOUT_MS };
