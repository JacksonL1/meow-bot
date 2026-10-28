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

// 下面是**内置默认**，只有主题没写 timings 时才用。
// 默认值的真相只放在这一处：theme.js 遇到没写 timings 的主题返回 null，
// 而不是自己也存一份默认——两边各写一套，分叉是静默的。
const SLEEP_AFTER_MS = 60_000; // 这么久没动静 → 睡着
const TICK_MS = 250;

// 曾经这里还有一个 IDLE_AFTER_MS = 25_000（25 秒没动静就回 idle 发呆），
// **它从头到尾没有消费者**，连"配置项"都算不上，只是一段被注释掉的设想。
// 它的设想本身有个没解决的问题：一次长工具调用（跑 40 秒的构建）期间
// 没有任何事件，宠物会被误判成发呆。所以搬 timings 的时候没有顺手带上它——
// 带上去就是一个"写对了也不会发生"的字段（硬约束 25）。
// 真要做，先回答"长工具调用怎么和真的闲置区分"，再回来加消费者。

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

function createStore({ onChange, getTimings } = {}) {
  /** @type {Map<string, {id:string,state:string,stateSince:number,lastAt:number,cwd?:string}>} */
  const sessions = new Map();
  let oneshot = null; // { state, until }
  let lastVisual = null;
  let lastUnknown = null; // 未知事件只报一次，避免每轮刷屏

  // 主题时长是**运行时**才拿得到的（主进程里 store 先建、主题后解析），
  // 所以这里存的是一个 getter 而不是一份拷进来的值。
  function timings() {
    const t = typeof getTimings === "function" ? getTimings() : null;
    return t && typeof t === "object" ? t : null;
  }

  // oneshot 播放时长：主题可以改，但**只能改本来就属于 oneshot 的那三个**。
  // 返回 undefined 就表示"这个状态不是 oneshot"——主题写了也不能凭空造一个，
  // 否则 working 播 2 秒就消失，状态机的形状就被主题改掉了。
  function oneshotMs(state) {
    const base = ONESHOT[state];
    if (base === undefined) return undefined;
    const t = timings();
    const v = t && t.oneshot && t.oneshot[state];
    return Number.isFinite(v) ? v : base;
  }

  function sleepAfterMs() {
    const t = timings();
    const v = t && t.sleepAfterMs;
    return Number.isFinite(v) ? v : SLEEP_AFTER_MS;
  }

  function emit() {
    if (typeof onChange === "function") onChange(snapshot());
  }

  // 事件日志（环形，最多 30 条）。排查"它为什么变成 idle"只能靠这个——
  // 视觉层只知道自己现在是什么状态，不知道是被哪个事件推过去的。
  // 环形是为了有界：agent 一次会话能推几千个事件，全留着内存不肯往下掉。
  const recentEvents = [];
  function logEvent(rec) {
    recentEvents.push(rec);
    if (recentEvents.length > 30) recentEvents.shift();
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
      recent: recentEvents.slice(),
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
      // 删会话是最容易被忽略的"变 idle"元凶：没有会话时 dominant() 直接返回 idle。
      logEvent({ t: now, event, sid: id.slice(0, 8), from: "(session)", to: "(removed)", how: "session-end" });
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

    const prevState = s.state;
    const target = EVENT_STATE[event];
    let how = "ignored";
    if (target && target !== s.state) {
      s.state = target;
      s.stateSince = now;
      const ms = oneshotMs(target);
      if (ms) oneshot = { state: target, until: now + ms };
      how = "mapped";
    } else if (target) {
      how = "same"; // 映射了但状态没变
    } else if (lastUnknown !== event) {
      // 只报一次：未知事件通常是每一轮都发的，刷屏会把别的告警淹掉。
      // 出现这条意味着 EVENT_STATE 漏了一种 agent 真的会发的事件——
      // 那时候宠物的表现就是"该有反应的时候没反应"，而且看不出来为什么。
      lastUnknown = event;
      console.warn(`[state] 未知事件 ${JSON.stringify(event)}（没在 EVENT_STATE 里，它不会改变任何状态）`);
    }
    logEvent({ t: now, event, sid: id.slice(0, 8), from: how === "mapped" ? prevState : s.state, to: s.state, how });

    tick();
    return snapshot();
  }

  // 心跳：所有"随时间发生的状态变化"都收敛到这一个函数，不散落在定时器里。
  function tick() {
    const now = Date.now();

    for (const s of sessions.values()) {
      const sinceState = now - s.stateSince;

      // 1) oneshot 播完 → 回 idle（否则 attention 会永远挂在屏幕上）
      const ms = oneshotMs(s.state);
      if (ms && sinceState > ms) {
        s.state = "idle";
        s.stateSince = now;
        continue;
      }
      // 2) 闲得太久 → 睡着。
      //
      // 计时从**进入 idle 多久**算（`stateSince`），不是"多久没收到事件"（`lastAt`）。
      // 这两者差得很远：一次跑 40 秒的构建期间一个事件都没有，
      // 按 lastAt 算就是"闲置"→ agent 明明在干活却被判睡着，
      // 下一个事件一来又醒、一会儿又睡，看起来像在抽搐。
      //
      // 而且只认 idle：working / thinking / error 期间不累计睡意。
      // "没新事件推过来"不等于"没在做事"。
      if (s.state !== "sleeping" && s.state === "idle" && now - s.stateSince > sleepAfterMs()) {
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
