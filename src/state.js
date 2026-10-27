"use strict";
// ============================================================
// S2-1  状态机（本项目的"心脏"，原项目对应 src/state.js）
//
// 只做三件事：
//   1. 把 agent 事件翻译成逻辑状态
//   2. 多会话时按优先级仲裁出一个"该显示谁"
//   3. 让 oneshot 状态播完自动退回，让闲置会话自己睡着
//
// 原项目的 state.js 有 4098 行，90% 在处理各种边界情况。
// 这里抽出来的 100 行是它真正的骨架 —— 先理解这个，再去看它为什么变厚。
// ============================================================

// 数字越大越"响"。error 永远压过 working，这是桌宠的灵魂。
const PRIORITY = {
  error: 8,
  notification: 7,
  attention: 5,
  working: 3,
  thinking: 2,
  idle: 1,
  sleeping: 0,
};

// oneshot = 播一次就结束的状态。不会赖在屏幕上。
// value 是建议播放时长（毫秒）。
const ONESHOT = {
  error: 2600,
  notification: 3200,
  attention: 2400,
};

// agent 事件 → 逻辑状态。这张表的权威版本是原项目 docs/guides/state-mapping.md
const EVENT_STATE = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  PermissionRequest: "notification",
  Notification: "notification",
  PreCompact: "working",
  Stop: "attention",
  SessionEnd: null, // 特殊处理：移除会话
};

// 注意：IDLE_AFTER_MS 目前**没有被任何逻辑使用**。
// 早期设想是"25 秒没动静就回 idle 发呆"，但接上会带来一个副作用：
// 一次长工具调用（比如跑 40 秒的构建）期间没有任何事件，宠物会被误判成发呆。
// 现在的实际行为是：working 会一直挂着，直到下一个事件到来、或 60 秒后直接睡着。
// 要用它之前先想清楚"长工具调用"怎么区分，别直接把它塞进 tick()。
const IDLE_AFTER_MS = 25_000;
const SLEEP_AFTER_MS = 60_000; // 这么久没动静 → 睡着
const TICK_MS = 250;

// SEC-04：请求来自网络侧，任何字段都不能直接进内存结构。
const MAX_SESSION_ID = 64;
const MAX_SESSIONS = 100;
const MAX_EVENT_LEN = 64;

function sanitizeSessionId(raw) {
  if (typeof raw !== "string") return "default";
  // 只留可见 ASCII，砍掉控制字符，限长 64
  const id = raw.replace(/[^\x20-\x7E]/g, "").slice(0, MAX_SESSION_ID);
  return id || "default";
}

function sanitizeEvent(raw) {
  return typeof raw === "string" ? raw.slice(0, MAX_EVENT_LEN) : "Unknown";
}

// SEC-09：分层处理，不要一刀切。
//   存储层：保留完整路径（清洗控制字符、限长 1024）——S6 的「跳转终端」需要它
//   快照层：只输出最后一段目录名——快照会进渲染进程、进看板、上屏幕
// 只留 basename 会顺手砍掉 S6 的功能，那不是修复，是砍功能。
const MAX_CWD_STORE = 1024;
const MAX_CWD_PUBLIC = 200;

function sanitizeCwd(raw) {
  if (typeof raw !== "string" || !raw) return undefined;
  return raw.replace(/[\x00-\x1F\x7F]/g, "").slice(0, MAX_CWD_STORE) || undefined;
}

function publicCwd(full) {
  if (!full) return null;
  const base = full.split(/[\\/]/).filter(Boolean).pop() || "";
  return base.slice(0, MAX_CWD_PUBLIC) || null;
}

// 超出上限时淘汰最久没动静的那条，保证内存有界
function evictOldest(sessions) {
  let oldestId = null;
  let oldestAt = Infinity;
  for (const s of sessions.values()) {
    if (s.lastAt < oldestAt) {
      oldestAt = s.lastAt;
      oldestId = s.id;
    }
  }
  if (oldestId !== null) sessions.delete(oldestId);
}

function createStore({ onChange } = {}) {
  /** @type {Map<string, {id:string,state:string,stateSince:number,lastAt:number,cwd?:string}>} */
  const sessions = new Map();
  let oneshot = null; // { state, until }
  let lastVisual = null;

  function emit() {
    if (typeof onChange === "function") onChange(snapshot());
  }

  function snapshot() {
    return {
      visual: lastVisual,
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        state: s.state,
        cwd: publicCwd(s.cwd),
        idleMs: Date.now() - s.lastAt,
      })),
    };
  }

  // 多会话仲裁：谁优先级高显示谁。只有一条规则，但足以撑起整个 Dashboard。
  function dominant() {
    let best = null;
    for (const s of sessions.values()) {
      if (!best || PRIORITY[s.state] > PRIORITY[best.state]) best = s;
    }
    return best ? best.state : "idle";
  }

  function apply(payload) {
    if (!payload || typeof payload !== "object") return snapshot();

    const id = sanitizeSessionId(payload.session_id);
    const event = sanitizeEvent(payload.event);
    const cwd = sanitizeCwd(payload.cwd);
    const now = Date.now();

    if (event === "SessionEnd") {
      sessions.delete(id);
      tick();
      return snapshot();
    }

    let s = sessions.get(id);
    if (!s) {
      s = { id, state: "idle", stateSince: now, lastAt: now, cwd };
      sessions.set(id, s);
      if (sessions.size > MAX_SESSIONS) evictOldest(sessions);
    }
    s.lastAt = now;
    if (cwd) s.cwd = cwd;

    const target = EVENT_STATE[event];
    if (target && target !== s.state) {
      s.state = target;
      s.stateSince = now;
      if (ONESHOT[target]) oneshot = { state: target, until: now + ONESHOT[target] };
    }

    tick();
    return snapshot();
  }

  // 心跳：所有"随时间发生的状态变化"都收敛到这一个函数，不散落在定时器里。
  function tick() {
    const now = Date.now();

    for (const s of sessions.values()) {
      const sinceState = now - s.stateSince;
      const sinceEvent = now - s.lastAt;

      // 1) oneshot 播完 → 回 idle（否则 attention 会永远挂在屏幕上）
      if (ONESHOT[s.state] && sinceState > ONESHOT[s.state]) {
        s.state = "idle";
        s.stateSince = now;
        continue;
      }
      // 2) 长时间没动静 → 睡着
      if (s.state !== "sleeping" && sinceEvent > SLEEP_AFTER_MS) {
        s.state = "sleeping";
        s.stateSince = now;
      }
    }

    // 3) 视觉层：oneshot 在时长内霸屏，否则看仲裁结果
    let visual;
    if (oneshot && now < oneshot.until) {
      visual = oneshot.state;
    } else {
      oneshot = null;
      visual = dominant();
    }

    if (visual !== lastVisual) {
      lastVisual = visual;
      emit();
    }
  }

  const timer = setInterval(tick, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();

  return {
    apply,
    snapshot,
    tick,
    // SEC-09 的兑现点：完整 cwd 永远不进快照、不进渲染层。
    // 只有"用户对某一条会话显式做了动作"（点复制路径）时，
    // 由主进程按 id 取出这一条，直接塞进剪贴板。
    fullCwd: (id) => {
      const s = sessions.get(id);
      return s ? s.cwd : undefined;
    },
    dispose: () => clearInterval(timer),
  };
}

module.exports = { createStore, PRIORITY, ONESHOT, EVENT_STATE };
