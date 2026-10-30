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
//
// 但 notification 那一条的语义**不是播放时长，是上限**，而且它比另外两个
// 长了两个数量级。差别来自"它在表达什么"：
//   error / attention —— 一个瞬间的事实（"刚才失败了"、"这一轮说完了"），
//                        播完就该消失，留着是噪音。
//   notification     —— 一个**持续的状态**：agent 正卡在那里等你点"允许"。
//                        主仓库管它叫 a real permission hold
//                        （clawd-on-desk src/state.js:345）。
//
// 起因是用户在信里写的一句话：「需要我确认的时候，没有提示我啊」。
// 内置默认 3200ms（ragdoll 主题还把它改成了 1500ms）让它变成一道闪光：
// 闪一下就撤，用户抬头看的时候屏幕上什么都没有。
//
// 10 分钟不是拍脑袋：对齐主仓库 Kimi 权限 hold 的兜底上限，那里的注释写着
// "真实用户常常在 TUI 前耗上几十秒（接电话、吃饭、犹豫）"。
// 真正的释放**不靠这个计时器**，靠下一个事件把它顶掉（见 tick() 里的说明）；
// 这个数只是"从此再没有任何事件"时的兜底——否则提示会永远挂在屏幕上。
const NOTIFICATION_MAX_MS = 10 * 60 * 1000;

const ONESHOT = {
  error: 2600,
  notification: NOTIFICATION_MAX_MS,
  attention: 2400,
};

// agent 事件 → 逻辑状态。这张表的权威版本是原项目 docs/guides/state-mapping.md
// 注意：`SessionStart` 这里的 "idle" 是**新建会话时的初值**，
// **不是**"把已有会话切回 idle"。apply() 里有一条前置判断专门管它——
// 把这一行当成普通映射读回去，就会复发那个 bug：WorkBuddy 每轮补发的
// SessionStart 把刚进入的 thinking 打回 idle（详见 apply() 里的注释）。
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
const MAX_TITLE = 60;
const MAX_TOOL = 64;
// 关键词写在猫的头巾上，超过这个长度就糊成一团（头巾只有那么大）。
// hook 侧已经限到 6，这里留 8 是给"别的 agent 直接打端点"留的余量——
// 但**必须有限**，因为它是网络入参。
const MAX_KEYWORD = 8;

// 会话标题：看板上唯一"像人话"的一行。来源是 hook 侧从 `session_title` 或
// prompt 第一行推出来的，**prompt 原文从不进这条链路**（见 clawd-hook.js）。
// 只剥控制字符 + 限长，不做语义判断——语义（是不是密钥）在 hook 侧已经判过了，
// 那里才有原文可判。
function sanitizeTitle(raw) {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, MAX_TITLE);
  return t || undefined;
}

// 工具名：这条**本来就已经在送了**（hook 一直 POST `tool_name`），
// 但在加上这一行之前**没有任何消费者**——存都不存，等于一个"写对了也不会
// 发生"的字段（硬约束 25）。现在它是看板上第二有用的那一行。
function sanitizeTool(raw) {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/[^\x20-\x7E]/g, "").trim().slice(0, MAX_TOOL);
  return t || undefined;
}

// 头巾上的那一个词。它**比标题更暴露**：标题只在打开看板时上屏幕，
// 而它一直挂在猫头上，投屏、截图、共享桌面全在画面里。
// 所以清洗照做（控制字符、限长），但语义判断（是不是密钥）在 hook 侧已经判过——
// 那里才有 prompt 原文可判。这里只保证"进内存的东西是有界的"。
function sanitizeKeyword(raw) {
  if (typeof raw !== "string") return undefined;
  const k = raw.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, MAX_KEYWORD);
  return k || undefined;
}

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
  /** @type {Map<string, {id:string,state:string,stateSince:number,lastAt:number,cwd?:string,title?:string,tool?:string}>} */
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
        title: s.title ?? null,
        tool: s.tool ?? null,
        keyword: s.keyword ?? null,
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

  // 还有没有人真的处在这个状态？（oneshot 霸屏的前提，见 tick() 里的说明）
  function sessionsHave(state) {
    for (const s of sessions.values()) {
      if (s.state === state) return true;
    }
    return false;
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

    // ---- SessionStart：只给**新会话**定初值，不许碰已经存在的会话 ----
    //
    // 为什么非得例外：WorkBuddy 每一轮都会在 UserPromptSubmit 之后约 0.1 秒
    // **补发**一个 SessionStart（首轮 source=startup，之后全是 resume）。
    // 这段事实不是猜的，主仓库 hooks/workbuddy-hook.js:264 把它写在注释里，
    // 那里的解法是给 body 加 preserve_state 让服务端保留。
    // 按普通映射处理的结果是一条等宽的 Bug：
    //   UserPromptSubmit → thinking → 0.1s → SessionStart → idle → 一直挂 idle
    //   → 直到 PreToolUse（working）才有反应。
    // 用户看到的就是"明明在 thinking，桌宠却显示 idle"。
    // Claude Code 只在真正开会话时发一次，所以这个误会错得很久也不暴露。
    //
    // starter 这里直接在语义上修对：**一条已经存在的会话收到"开始了"，
    // 本来就不该被清空**。落到下面 = 全新会话，用 EVENT_STATE 的 idle 建。
    if (event === "SessionStart") {
      const existing = sessions.get(id);
      if (existing) {
        existing.lastAt = now;
        if (cwd) existing.cwd = cwd;
        // how 记成 preserved：排查时能在 events() 里一眼看出"它来了，但没动手"。
        logEvent({ t: now, event, sid: id.slice(0, 8), from: existing.state, to: existing.state, how: "preserved" });
        tick();
        return snapshot();
      }
    }

    let s = sessions.get(id);
    if (!s) {
      s = { id, state: "idle", stateSince: now, lastAt: now, cwd };
      sessions.set(id, s);
      if (sessions.size > MAX_SESSIONS) evictOldest(sessions);
    }
    s.lastAt = now;
    if (cwd) s.cwd = cwd;

    // 标题是**粘的**：绝大多数事件都不带标题，让它们参与覆盖，就等于
    // 每来一条 PreToolUse 把好标题抹掉一次。主仓库服务端用的是 `||` 链
    // （workbuddy-hook.js:141 的注释专门解释了为什么不回退到低质量来源），
    // 这里同理：**只有真的拿到了才写**。
    const title = sanitizeTitle(payload.title);
    if (title) s.title = title;

    // 关键词跟着标题一起"粘"：只有 hook 真抽到了才写。
    // 新一轮 UserPromptSubmit 会带新词覆盖旧的——这正是要的，
    // 头巾上写的是**这一轮**在干什么。
    const keyword = sanitizeKeyword(payload.keyword);
    if (keyword) s.keyword = keyword;

    // 工具名是"这一轮到目前为止最后用到的那个"。新一轮（UserPromptSubmit）
    // 开始时清掉——不清的话 thinking 阶段会挂着上一轮的工具名，
    // 那是在说一件已经不成立的事。
    if (event === "UserPromptSubmit") s.tool = undefined;
    const tool = sanitizeTool(payload.tool_name);
    if (tool) s.tool = tool;

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

  // 用户把鼠标停到它身上 = 把它弄醒（S9）。
  //
  // 为什么这一件事必须落在状态机里：`sleeping` 是 tick() 按"idle 持续了多久"
  // 推出来的结果，渲染层擅自把画面改成 idle，下一个 250ms 的推送就把它顶回去，
  // 看起来是"闪一下又睡"。真相只有这一个地方能改。
  //
  // 只动 sleeping：working / thinking / error 是 agent 的真实进展，
  // 用户的鼠标不该改写它们（"碰一下就把干活中的猫弄成 idle"是 bug 不是特性）。
  //
  // 返回"是否真的有东西被弄醒"，让调用方（和回归）能区分
  // "醒了"和"本来就没睡"，而不是都得再读一次快照去猜。
  function wake() {
    const now = Date.now();
    let woke = 0;
    for (const s of sessions.values()) {
      if (s.state !== "sleeping") continue;
      s.state = "idle";
      // stateSince 必须一起重置。不重置的话它已经"闲了很久"，
      // 下一个 tick 立刻判定又该睡了——表现是碰一下就醒、随即又睡，像抽搐。
      s.stateSince = now;
      woke++;
    }
    if (woke === 0) return false;
    logEvent({ t: now, event: "Hover", sid: "-", from: "sleeping", to: "idle", how: "woke" });
    tick();
    return true;
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
    //
    // 霸屏的前提是**真的还有会话处在这个状态**。原来只判 `now < oneshot.until`，
    // 于是会发生这种事：权限提示挂上来（上限 10 分钟）→ 用户点了允许 →
    // agent 继续干活（PreToolUse → working）→ 画面上猫还在喊，因为 until 还没到。
    // 这个前提以前只是偶尔闪错一下（attention 只有 800ms，没人看得出来），
    // 把 notification 拉到 10 分钟之后它才第一次变得要紧——
    // 同样的 bug，短的算瑕疵，长的就是"明明在干活，猫喊了整整十分钟"。
    let visual;
    if (oneshot && now < oneshot.until && sessionsHave(oneshot.state)) {
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
    wake,
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
