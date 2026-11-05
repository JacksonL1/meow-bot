// ============================================================
// S2-1  状态机（本项目的"心脏"）
//
// 只做三件事：
//   1. 把 agent 事件翻译成逻辑状态
//   2. 多会话时按优先级仲裁出一个"该显示谁"
//   3. 让 oneshot 状态播完自动退回，让闲置会话自己睡着
//
// 历史：原与 src/state.js（Electron 版）等价、两处必须一起改，否则同一个
// hook 事件下两边演出不同的画面。2026-11-03 Electron 容器删除后，
// **这里是唯一实现**——上面那条"不一致"的约束随之消失，但行为一个都不能变。
// ============================================================
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Visual {
    Error,
    Notification,
    Attention,
    Working,
    Thinking,
    Idle,
    Sleeping,
}

impl Visual {
    pub fn as_str(self) -> &'static str {
        match self {
            Visual::Error => "error",
            Visual::Notification => "notification",
            Visual::Attention => "attention",
            Visual::Working => "working",
            Visual::Thinking => "thinking",
            Visual::Idle => "idle",
            Visual::Sleeping => "sleeping",
        }
    }

    // 数字越大越"响"。error 永远压过 working，这是桌宠的灵魂。
    fn priority(self) -> u8 {
        match self {
            Visual::Error => 8,
            Visual::Notification => 7,
            Visual::Attention => 5,
            Visual::Working => 3,
            Visual::Thinking => 2,
            Visual::Idle => 1,
            Visual::Sleeping => 0,
        }
    }
}

// oneshot = 播一次就结束的状态。value 是建议播放时长（毫秒）。
//
// 但 notification 那一条的语义**不是播放时长，是上限**，而且它比另外两个
// 长了两个数量级。差别来自"它在表达什么"：
//   error / attention —— 一个瞬间的事实，播完就该消失，留着是噪音。
//   notification     —— 一个**持续的状态**：agent 正卡在那里等你点"允许"。
// 真正的释放不靠这个计时器，靠下一个事件把它顶掉；这个数只是"从此再没有
// 任何事件"时的兜底，否则提示会永远挂在屏幕上。
const NOTIFICATION_MAX_MS: u64 = 10 * 60 * 1000;

fn builtin_oneshot(v: Visual) -> Option<u64> {
    match v {
        Visual::Error => Some(2600),
        Visual::Notification => Some(NOTIFICATION_MAX_MS),
        Visual::Attention => Some(2400),
        _ => None,
    }
}

// 下面是**内置默认**，只有主题没写 timings 时才用。
// 默认值的真相只放在这一处：theme.rs 遇到没写 timings 的主题返回 None，
// 而不是自己也存一份默认——两边各写一套，分叉是静默的。
const SLEEP_AFTER_MS: u64 = 60_000;
pub const TICK_MS: u64 = 250;

/// thinking 最多能挂多久。
///
/// 为什么 thinking 需要一条**上限**，而 working 不需要：
/// working 有工具在跑，超时会被 PreToolUse/PostToolUse/Stop 兜住；
/// thinking 的语义是"在等第一个 token"，那是秒级的。可一旦事件源死了
/// （hook 没发出来、`dsh headless` 被杀、DSH 投影里留了个死的 openStep），
/// 就没有任何东西会再叫醒这条会话——它会一直 thinking 到用户重启进程。
/// 用户 2026-11-04 报的「没有任何任务，为什么一直保持 thinking」就是这个。
///
/// 10 分钟是刻意给宽了的：推理模型想几分钟很正常，而"卡住"的那种是几十小时。
/// 真被误判也只是退回 idle（并在气泡里照常显示这条会话），不会丢信息。
const THINKING_MAX_MS: u64 = 10 * 60 * 1000;

// SEC-04：请求来自网络侧，任何字段都不能直接进内存结构。
const MAX_SESSION_ID: usize = 64;
const MAX_SESSIONS: usize = 100;
const MAX_EVENT_LEN: usize = 64;
const MAX_TITLE: usize = 60;
const MAX_TOOL: usize = 64;
// 关键词是泡泡里的兜底标题（会话没有 title 时才用它），太长就把那一行挤满。
const MAX_KEYWORD: usize = 8;
const MAX_CWD_STORE: usize = 1024;
const MAX_CWD_PUBLIC: usize = 200;

/// 主题给的状态时长。`None` = 主题没写，用内置默认。
/// oneshot 时长查表。做成自由函数是为了能在 `sessions.values_mut()` 里调用——
/// 那时 self 已经被可变借用，再调 `&self` 的方法会同时要可变+不可变借用。
fn oneshot_ms_with(t: &Timings, v: Visual) -> Option<u64> {
    let base = builtin_oneshot(v)?;
    match t.oneshot.get(v.as_str()) {
        Some(&ms) if ms > 0 => Some(ms),
        _ => Some(base),
    }
}

#[derive(Clone, Default, Debug, Serialize)]
pub struct Timings {
    pub oneshot: HashMap<String, u64>,
    pub sleep_after_ms: Option<u64>,
}

// agent 事件 → 逻辑状态。这张表的权威版本是原项目 docs/guides/state-mapping.md
// 注意：SessionStart 的 idle 是**新建会话时的初值**，不是"把已有会话切回 idle"，
// apply() 里有专门的前置判断管它。
fn event_state(event: &str) -> Option<Visual> {
    Some(match event {
        "SessionStart" => Visual::Idle,
        "UserPromptSubmit" => Visual::Thinking,
        "PreToolUse" => Visual::Working,
        "PostToolUse" => Visual::Working,
        "PostToolUseFailure" => Visual::Error,
        "PermissionRequest" => Visual::Notification,
        "Notification" => Visual::Notification,
        "PreCompact" => Visual::Working,
        "Stop" => Visual::Attention,
        _ => return None,
    })
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub state: Visual,
    /// 这条会话第一次被看到是什么时候。
    ///
    /// 和 `state_since` 不是一回事：那个会被每一次状态迁移重置，只能回答
    /// "当前这个姿势多久了"。泡泡里要显示的「这条任务跑了多久」问的是整条任务，
    /// 所以得有出生时刻。用 `Instant` 而不是 `SystemTime`：这里只做差值，
    /// 而且改系统时间不该让桌宠显示「跑了 -3 秒」。
    pub born: Instant,
    pub state_since: Instant,
    pub last_at: Instant,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub tool: Option<String>,
    pub keyword: Option<String>,
}

#[derive(Clone, Serialize, Debug)]
pub struct SessionView {
    pub id: String,
    pub state: Visual,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub tool: Option<String>,
    pub keyword: Option<String>,
    #[serde(rename = "idleMs")]
    pub idle_ms: u64,
    /// 这条会话跑了多久（从第一次出现算起）。泡泡里的「已跑」读它。
    #[serde(rename = "ageMs")]
    pub age_ms: u64,
}

#[derive(Clone, Serialize, Debug)]
pub struct EventLog {
    pub t: u64,
    pub event: String,
    pub sid: String,
    pub from: String,
    pub to: String,
    pub how: String,
}

#[derive(Clone, Serialize, Debug)]
pub struct Snapshot {
    pub visual: Option<Visual>,
    pub sessions: Vec<SessionView>,
    pub recent: Vec<EventLog>,
}

// ---- 清洗 ------------------------------------------------------------
fn strip_control(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).collect()
}

fn sanitize_title(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let t = strip_control(raw).trim().to_string();
    let t: String = t.chars().take(MAX_TITLE).collect();
    if t.is_empty() { None } else { Some(t) }
}

fn sanitize_tool(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let t: String = raw
        .chars()
        .filter(|c| ('\u{20}'..='\u{7e}').contains(c))
        .collect();
    let t: String = t.trim().chars().take(MAX_TOOL).collect();
    if t.is_empty() { None } else { Some(t) }
}

fn sanitize_keyword(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let k: String = strip_control(raw).trim().chars().take(MAX_KEYWORD).collect();
    if k.is_empty() { None } else { Some(k) }
}

fn sanitize_session_id(raw: Option<&str>) -> String {
    let Some(raw) = raw else { return "default".into() };
    let id: String = raw
        .chars()
        .filter(|c| ('\u{20}'..='\u{7e}').contains(c))
        .take(MAX_SESSION_ID)
        .collect();
    if id.is_empty() { "default".into() } else { id }
}

fn sanitize_cwd(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let c: String = strip_control(raw).chars().take(MAX_CWD_STORE).collect();
    if c.is_empty() { None } else { Some(c) }
}

// SEC-09：分层处理，不要一刀切。
//   存储层：保留完整路径——S6 的「复制路径」需要它
//   快照层：只输出最后一段目录名——快照会进渲染进程、进看板、上屏幕
//
// `pub(crate)` 是给 dsh.rs 的看板视图复用的：那条链路同样"内部留全路径、
// 出门只留 basename"，两处若各写一份，迟早会有一处忘了截。
pub(crate) fn public_cwd(full: &Option<String>) -> Option<String> {
    let full = full.as_ref()?;
    let base = full
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .next_back()
        .unwrap_or("");
    let b: String = base.chars().take(MAX_CWD_PUBLIC).collect();
    if b.is_empty() { None } else { Some(b) }
}

/// 给输入窗用的目录显示：**最后两段**，前面用 `…` 省略。
///
/// 为什么不沿用 `public_cwd` 的 basename：那句话要落到哪个目录，是这个窗里
/// 唯一需要用户确认的事（DSH 按目录分桶存会话，起错目录等于起在空工作区），
/// 而 `…\project\a` 和 `…\work\a` 的 basename 一模一样——只看一段等于没看。
/// 为什么也不给全路径：`C:\Users\<名字>\Documents\...\...` 会把这个 400px 的
/// 小窗撑破，而前缀那几段里没有任何决策信息。
pub(crate) fn tail_cwd(full: &Option<String>) -> Option<String> {
    const TAIL_SEGMENTS: usize = 2;
    let full = full.as_ref()?;
    let parts: Vec<&str> = full
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .collect();
    let n = parts.len();
    if n == 0 {
        return None;
    }
    let take = TAIL_SEGMENTS.min(n);
    let mut s = String::new();
    if n > take {
        s.push('…');
        s.push('\\');
    }
    s.push_str(&parts[n - take..].join("\\"));
    // 极端长的单段目录名（中文项目名 + 一堆后缀）仍然要收，不然 `.to` 那行会溢出。
    let chars: Vec<char> = s.chars().collect();
    if chars.len() > MAX_CWD_PUBLIC {
        let cut = chars.len() - MAX_CWD_PUBLIC;
        return Some(format!("…{}", chars[cut..].iter().collect::<String>()));
    }
    Some(s)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Store {
    sessions: HashMap<String, Session>,
    oneshot: Option<(Visual, Instant)>,
    last_visual: Option<Visual>,
    last_unknown: Option<String>,
    recent: VecDeque<EventLog>,
    pub timings: Timings,
}

impl Store {
    pub fn new(timings: Timings) -> Self {
        Self {
            sessions: HashMap::new(),
            oneshot: None,
            last_visual: None,
            last_unknown: None,
            recent: VecDeque::new(),
            timings,
        }
    }

    pub fn set_timings(&mut self, t: Timings) {
        self.timings = t;
    }

    // oneshot 播放时长：主题可以改，但**只能改本来就属于 oneshot 的那三个**。
    fn oneshot_ms(&self, v: Visual) -> Option<u64> {
        oneshot_ms_with(&self.timings, v)
    }

    fn log(&mut self, event: &str, sid: &str, from: &str, to: &str, how: &str) {
        self.recent.push_back(EventLog {
            t: now_ms(),
            event: event.to_string(),
            sid: sid.chars().take(8).collect(),
            from: from.to_string(),
            to: to.to_string(),
            how: how.to_string(),
        });
        // 环形是为了有界：agent 一次会话能推几千个事件，全留着内存不肯往下掉。
        while self.recent.len() > 30 {
            self.recent.pop_front();
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let now = Instant::now();
        let mut sessions: Vec<SessionView> = self
            .sessions
            .values()
            .map(|s| SessionView {
                id: s.id.clone(),
                state: s.state,
                cwd: public_cwd(&s.cwd),
                title: s.title.clone(),
                tool: s.tool.clone(),
                keyword: s.keyword.clone(),
                idle_ms: now.saturating_duration_since(s.last_at).as_millis() as u64,
                age_ms: now.saturating_duration_since(s.born).as_millis() as u64,
            })
            .collect();
        // HashMap 顺序不稳定；按 id 排一下，让快照可比、回归可断言
        sessions.sort_by(|a, b| a.id.cmp(&b.id));
        Snapshot {
            visual: self.last_visual,
            sessions,
            recent: self.recent.iter().cloned().collect(),
        }
    }

    // 多会话仲裁：谁优先级高显示谁。只有一条规则，但足以撑起整个 Dashboard。
    fn dominant(&self) -> Visual {
        let mut best: Option<&Session> = None;
        for s in self.sessions.values() {
            match best {
                None => best = Some(s),
                Some(b) if s.state.priority() > b.state.priority() => best = Some(s),
                _ => {}
            }
        }
        best.map(|s| s.state).unwrap_or(Visual::Idle)
    }

    fn sessions_have(&self, v: Visual) -> bool {
        self.sessions.values().any(|s| s.state == v)
    }

    /// 应用一条 hook 事件。返回 (快照, visual 是否变化)。
    pub fn apply(&mut self, payload: &serde_json::Value) -> (Snapshot, bool) {
        if !payload.is_object() {
            return (self.snapshot(), false);
        }
        let id = sanitize_session_id(payload.get("session_id").and_then(|v| v.as_str()));
        let event = payload
            .get("event")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(MAX_EVENT_LEN).collect::<String>())
            .unwrap_or_else(|| "Unknown".to_string());
        let cwd = sanitize_cwd(payload.get("cwd").and_then(|v| v.as_str()));
        let now = Instant::now();

        if event == "SessionEnd" {
            // 删会话是最容易被忽略的"变 idle"元凶：没有会话时 dominant() 直接返回 idle。
            self.log(&event, &id, "(session)", "(removed)", "session-end");
            self.sessions.remove(&id);
            let changed = self.tick();
            return (self.snapshot(), changed);
        }

        // ---- SessionStart：只给**新会话**定初值，不许碰已经存在的会话 ----
        // WorkBuddy 每一轮都会在 UserPromptSubmit 之后约 0.1 秒补发一个 SessionStart。
        // 按普通映射处理的结果是：thinking → 0.1s → idle → 一直挂 idle，
        // 用户看到的就是"明明在 thinking，桌宠却显示 idle"。
        if event == "SessionStart" {
            if let Some(existing) = self.sessions.get_mut(&id) {
                existing.last_at = now;
                if cwd.is_some() {
                    existing.cwd = cwd;
                }
                let st = existing.state.as_str();
                self.log(&event, &id, st, st, "preserved");
                let changed = self.tick();
                return (self.snapshot(), changed);
            }
        }

        if !self.sessions.contains_key(&id) {
            self.sessions.insert(
                id.clone(),
                Session {
                    id: id.clone(),
                    state: Visual::Idle,
                    born: now,
                    state_since: now,
                    last_at: now,
                    cwd: None,
                    title: None,
                    tool: None,
                    keyword: None,
                },
            );
            if self.sessions.len() > MAX_SESSIONS {
                self.evict_oldest();
            }
        }

        let title = sanitize_title(payload.get("title").and_then(|v| v.as_str()));
        let keyword = sanitize_keyword(payload.get("keyword").and_then(|v| v.as_str()));
        let tool = sanitize_tool(payload.get("tool_name").and_then(|v| v.as_str()));
        let is_prompt = event == "UserPromptSubmit";
        // target 与 oneshot 时长在这里算好：下面 s 会可变借用 sessions，
        // 到那时再调 &self 的方法就是同时可变+不可变借用。
        let target = event_state(&event);
        let target_oneshot = target.and_then(|t| oneshot_ms_with(&self.timings, t));

        let s = self.sessions.get_mut(&id).expect("刚插入过");
        s.last_at = now;
        if cwd.is_some() {
            s.cwd = cwd;
        }
        // 标题是**粘的**：绝大多数事件都不带标题，让它们参与覆盖就等于
        // 每来一条 PreToolUse 把好标题抹掉一次。**只有真的拿到了才写**。
        if title.is_some() {
            s.title = title;
        }
        // 关键词跟着标题一起"粘"。新一轮 UserPromptSubmit 会带新词覆盖旧的——
        // 这正是要的，关键词说的是**这一轮**在干什么。
        if keyword.is_some() {
            s.keyword = keyword;
        }
        // 工具名是"这一轮到目前为止最后用到的那个"。新一轮开始时清掉——
        // 不清的话 thinking 阶段会挂着上一轮的工具名，那是在说一件已经不成立的事。
        if is_prompt {
            s.tool = None;
        }
        if tool.is_some() {
            s.tool = tool;
        }

        let prev = s.state;
        let mut how = "ignored";
        match target {
            Some(t) if t != s.state => {
                s.state = t;
                s.state_since = now;
                if let Some(ms) = target_oneshot {
                    self.oneshot = Some((t, now + std::time::Duration::from_millis(ms)));
                }
                how = "mapped";
            }
            Some(_) => how = "same", // 映射了但状态没变
            None => {
                if event == "Meta" {
                    // 只带元数据（标题/关键词/cwd）、**不动状态**。
                    //
                    // 为什么需要它：DSH 的会话标题是 LLM 生成后回填的，落地时刻在一轮
                    // 进行当中，往往离 UserPromptSubmit 已经过去几秒。那一刻没有任何
                    // 状态变化可以搭载这个标题，而硬塞进 PreToolUse 会把一条 idle 的
                    // 会话说成"正在干活"。上面 title/keyword 的赋值本来就在 match 之前，
                    // 所以这条事件天然只改元数据——这里要做的只是别把它当成未知事件报警。
                    how = "meta";
                } else if self.last_unknown.as_deref() != Some(event.as_str()) {
                    // 只报一次：未知事件通常是每一轮都发的，刷屏会把别的告警淹掉。
                    self.last_unknown = Some(event.clone());
                    eprintln!("[state] 未知事件 {event:?}（没在 EVENT_STATE 里，它不会改变任何状态）");
                }
            }
        }
        let (from, to) = if how == "mapped" {
            (prev.as_str(), s.state.as_str())
        } else {
            (s.state.as_str(), s.state.as_str())
        };
        self.log(&event, &id, from, to, how);

        let changed = self.tick();
        (self.snapshot(), changed)
    }

    /// 用户把鼠标停到它身上 = 把它弄醒（S9）。
    ///
    /// 为什么这一件事必须落在状态机里：`sleeping` 是 tick() 按"idle 持续了多久"
    /// 推出来的结果，渲染层擅自把画面改成 idle，下一个 250ms 的推送就把它顶回去，
    /// 看起来是"闪一下又睡"。
    ///
    /// 只动 sleeping：working / thinking / error 是 agent 的真实进展，
    /// 用户的鼠标不该改写它们。
    pub fn wake(&mut self) -> bool {
        let now = Instant::now();
        let mut woke = 0;
        for s in self.sessions.values_mut() {
            if s.state != Visual::Sleeping {
                continue;
            }
            s.state = Visual::Idle;
            // state_since 必须一起重置。不重置的话它已经"闲了很久"，
            // 下一个 tick 立刻判定又该睡了——表现是碰一下就醒、随即又睡，像抽搐。
            s.state_since = now;
            woke += 1;
        }
        if woke == 0 {
            return false;
        }
        self.log("Hover", "-", "sleeping", "idle", "woke");
        self.tick();
        true
    }

    /// 心跳：所有"随时间发生的状态变化"都收敛到这一个函数。
    /// 返回 visual 是否变了（变了才推给渲染层）。
    pub fn tick(&mut self) -> bool {
        let now = Instant::now();
        // 先拷一份时长表：循环里 sessions 被可变借用，不能再借 self.timings
        let timings = self.timings.clone();
        let sleep_after = timings.sleep_after_ms.unwrap_or(SLEEP_AFTER_MS);

        for s in self.sessions.values_mut() {
            let since = now.saturating_duration_since(s.state_since).as_millis() as u64;

            // 1) oneshot 播完 → 回 idle（否则 attention 会永远挂在屏幕上）
            if let Some(ms) = oneshot_ms_with(&timings, s.state) {
                if since > ms {
                    s.state = Visual::Idle;
                    s.state_since = now;
                    continue;
                }
            }
            // 1.5) thinking 不许无限挂着（理由见 THINKING_MAX_MS）。
            if s.state == Visual::Thinking && since > THINKING_MAX_MS {
                s.state = Visual::Idle;
                s.state_since = now;
                continue;
            }
            // 2) 闲得太久 → 睡着。
            //
            // 计时从**进入 idle 多久**算（state_since），不是"多久没收到事件"（last_at）。
            // 这两者差得很远：一次跑 40 秒的构建期间一个事件都没有，
            // 按 last_at 算就是"闲置"→ agent 明明在干活却被判睡着。
            // 而且只认 idle：working / thinking / error 期间不累计睡意。
            if s.state == Visual::Idle && since > sleep_after {
                s.state = Visual::Sleeping;
                s.state_since = now;
            }
        }

        // 3) 视觉层：oneshot 在时长内霸屏，否则看仲裁结果。
        //
        // 霸屏的前提是**真的还有会话处在这个状态**。原来只判 `now < until`，
        // 于是：权限提示挂上来（上限 10 分钟）→ 用户点了允许 → agent 继续干活
        // （PreToolUse → working）→ 画面上猫还在喊，因为 until 还没到。
        // 同样的 bug，短的算瑕疵（800ms 没人看得出来），长的就是"猫喊了整整十分钟"。
        let visual = match self.oneshot {
            Some((st, until)) if now < until && self.sessions_have(st) => st,
            _ => {
                self.oneshot = None;
                self.dominant()
            }
        };

        let changed = self.last_visual != Some(visual);
        self.last_visual = Some(visual);
        changed
    }

    // SEC-09 的兑现点：完整 cwd 永远不进快照、不进渲染层。
    // 只有"用户对某一条会话显式做了动作"（点复制路径）时，按 id 取出这一条。
    pub fn full_cwd(&self, id: &str) -> Option<&str> {
        self.sessions.get(id).and_then(|s| s.cwd.as_deref())
    }

    /// 最近有动静的那条会话在哪个目录。
    ///
    /// 用途只有一个：用户从桌宠里**新起**一条会话时，它得落在某个目录里，
    /// 而"上一次干活的地方"是最不容易猜错的答案——比回家目录好，比让用户
    /// 先从下拉框里挑一个目录好。cwd 对 DSH 不是小事：会话按目录分桶存，
    /// 选错目录等于起在一个空工作区里。
    pub fn latest_cwd(&self) -> Option<String> {
        self.sessions
            .values()
            .filter(|s| s.cwd.is_some())
            .max_by_key(|s| s.last_at)
            .and_then(|s| s.cwd.clone())
    }

    // 超出上限时淘汰最久没动静的那条，保证内存有界
    fn evict_oldest(&mut self) {
        let oldest = self
            .sessions
            .values()
            .min_by_key(|s| s.last_at)
            .map(|s| s.id.clone());
        if let Some(id) = oldest {
            self.sessions.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(event: &str) -> serde_json::Value {
        json!({ "session_id": "s1", "event": event, "cwd": "E:\\work\\proj" })
    }

    #[test]
    fn events_map_to_visuals() {
        let mut st = Store::new(Timings::default());
        let (snap, _) = st.apply(&ev("UserPromptSubmit"));
        assert_eq!(snap.visual, Some(Visual::Thinking));
        let (snap, _) = st.apply(&ev("PreToolUse"));
        assert_eq!(snap.visual, Some(Visual::Working));
        let (snap, _) = st.apply(&ev("Stop"));
        assert_eq!(snap.visual, Some(Visual::Attention));
    }

    // 这条是 Class-B bug 的护栏：WorkBuddy 每轮补发的 SessionStart 不能把
    // 刚进入的 thinking 打回 idle。
    #[test]
    fn late_session_start_does_not_reset_thinking() {
        let mut st = Store::new(Timings::default());
        st.apply(&ev("UserPromptSubmit"));
        let (snap, _) = st.apply(&ev("SessionStart"));
        assert_eq!(snap.visual, Some(Visual::Thinking));
    }

    #[test]
    fn session_end_removes_the_cat() {
        let mut st = Store::new(Timings::default());
        st.apply(&ev("PreToolUse"));
        let (snap, _) = st.apply(&ev("SessionEnd"));
        assert!(snap.sessions.is_empty());
        assert_eq!(snap.visual, Some(Visual::Idle));
    }

    #[test]
    fn hidden_cwd_is_only_basename_in_snapshot() {
        let mut st = Store::new(Timings::default());
        let (snap, _) = st.apply(&ev("PreToolUse"));
        assert_eq!(snap.sessions[0].cwd.as_deref(), Some("proj"));
        // 但完整路径仍按 id 可取（复制路径要用）
        assert_eq!(st.full_cwd("s1"), Some("E:\\work\\proj"));
    }

    #[test]
    fn title_and_keyword_stick_until_replaced() {
        let mut st = Store::new(Timings::default());
        st.apply(&json!({"session_id":"s1","event":"UserPromptSubmit","title":"改登录页","keyword":"登录"}));
        st.apply(&ev("PreToolUse")); // 不带标题/关键词
        let snap = st.snapshot();
        assert_eq!(snap.sessions[0].title.as_deref(), Some("改登录页"));
        assert_eq!(snap.sessions[0].keyword.as_deref(), Some("登录"));
        // 新一輪会覆盖旧词
        st.apply(&json!({"session_id":"s1","event":"UserPromptSubmit","keyword":"风险评级"}));
        assert_eq!(st.snapshot().sessions[0].keyword.as_deref(), Some("风险评级"));
    }

    // 泡泡里要显示「这条任务跑了多久」。它和 idleMs 是两个问题：
    // idleMs 会在每个事件后被清零（"刚动过"），ageMs 不能——
    // 否则一条跑了半小时的任务，只要刚有动作就显示成"跑了 0 秒"。
    #[test]
    fn age_survives_state_migrations_while_idle_resets() {
        let mut st = Store::new(Timings::default());
        st.apply(&ev("PreToolUse"));
        std::thread::sleep(std::time::Duration::from_millis(20));
        st.apply(&json!({"session_id":"s1","event":"Stop"}));
        let s = &st.snapshot().sessions[0];
        assert!(s.age_ms >= 15, "出生时刻被重置了：age={}", s.age_ms);
        assert!(s.idle_ms < 15, "idle 应该被这一条事件清零：idle={}", s.idle_ms);
    }

    // 用户 2026-11-04 报：没有任何任务，猫一直显示 thinking。
    // 根因在 DSH 侧（mtime 兜底被当成新提问，见 dsh.rs 的 has_prompt_at），
    // 但状态机自己也得有一条兜底：**任何**来源把一条会话推进 thinking 之后没人收，
    // 都不该让它挂到天荒地老。这条测的就是"没人收"的那种。
    #[test]
    fn thinking_does_not_last_forever() {
        let mut st = Store::new(Timings::default());
        st.apply(&json!({"session_id":"s1","event":"UserPromptSubmit"}));
        assert_eq!(st.snapshot().sessions[0].state, Visual::Thinking);

        // 把"进入 thinking 的时刻"往前拨，等价于"这一步已经卡了很久"
        {
            let s = st.sessions.get_mut("s1").unwrap();
            s.state_since = Instant::now() - std::time::Duration::from_millis(THINKING_MAX_MS + 5_000);
        }
        st.tick();
        assert_eq!(st.snapshot().sessions[0].state, Visual::Idle, "thinking 不许永远挂着");
    }

    #[test]
    fn only_sleeping_can_be_woken() {
        let mut st = Store::new(Timings::default());
        st.apply(&ev("PreToolUse"));
        assert!(!st.wake(), "working 不该被鼠标改写");
    }

    // DSH 的标题是生成后回填的，落地时没有对应的状态变化可以搭载。
    // Meta 就是那个"只改元数据"的事件——它必须能改标题，又必须一动状态都不动。
    #[test]
    fn meta_updates_title_without_touching_state() {
        let mut st = Store::new(Timings::default());
        st.apply(&ev("PreToolUse"));
        assert_eq!(st.snapshot().visual, Some(Visual::Working));

        st.apply(&json!({"session_id":"s1","event":"Meta","title":"重构状态机"}));
        let snap = st.snapshot();
        assert_eq!(snap.visual, Some(Visual::Working), "Meta 不许改状态");
        assert_eq!(snap.sessions[0].title.as_deref(), Some("重构状态机"));
    }

    // 输入窗那句「新会话 · …\project\DeepseekWorkSpace」就是它。
    // 钉住的是"能区分两个同名末段目录"，而不是某种具体写法——省略号用几个、
    // 分隔符用哪种反斜杠，都是外观，不是契约。
    #[test]
    fn tail_cwd_keeps_the_last_two_segments() {
        let full = Some("E:\\JacksonLee\\project\\DeepseekWorkSpace".to_string());
        assert_eq!(tail_cwd(&full).as_deref(), Some("…\\project\\DeepseekWorkSpace"));
        let full = Some("E:\\work\\DeepseekWorkSpace".to_string());
        assert_eq!(tail_cwd(&full).as_deref(), Some("…\\work\\DeepseekWorkSpace"));
        assert_ne!(tail_cwd(&full), tail_cwd(&Some(
            "E:\\JacksonLee\\project\\DeepseekWorkSpace".to_string()
        )), "末段同名时，前一段必须能把两个目录区分开");
    }

    #[test]
    fn tail_cwd_handles_short_and_empty_paths() {
        assert_eq!(tail_cwd(&Some("C:\\".to_string())).as_deref(), Some("C:"));
        assert_eq!(tail_cwd(&Some("C:\\Users\\Think".to_string())).as_deref(), Some("…\\Users\\Think"));
        assert_eq!(tail_cwd(&None), None);
        assert_eq!(tail_cwd(&Some("\\\\/\\\\".to_string())), None, "只有分隔符 = 没有目录可说");
    }

    #[test]
    fn tail_cwd_caps_runaway_directory_names() {
        let long = "E:\\x\\".to_string() + &"很长".repeat(60);
        let out = tail_cwd(&Some(long)).unwrap();
        assert!(out.chars().count() <= MAX_CWD_PUBLIC + 1, "超长目录名必须收在 {} 字内：{}", MAX_CWD_PUBLIC, out);
        assert!(out.starts_with('…'), "截断要从左边截，末段才是有信息的那一半");
    }
}
