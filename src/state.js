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

const IDLE_AFTER_MS = 25_000; // 这么久没动静 → 回 idle 发呆
const SLEEP_AFTER_MS = 60_000; // 这么久没动静 → 睡着
const TICK_MS = 250;

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
        cwd: s.cwd || null,
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
    const id = String(payload.session_id || "default");
    const event = payload.event || "Unknown";
    const now = Date.now();

    if (event === "SessionEnd") {
      sessions.delete(id);
      tick();
      return snapshot();
    }

    let s = sessions.get(id);
    if (!s) {
      s = { id, state: "idle", stateSince: now, lastAt: now, cwd: payload.cwd };
      sessions.set(id, s);
    }
    s.lastAt = now;
    if (payload.cwd) s.cwd = payload.cwd;

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

  return { apply, snapshot, tick, dispose: () => clearInterval(timer) };
}

module.exports = { createStore, PRIORITY, ONESHOT, EVENT_STATE };
