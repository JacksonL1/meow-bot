// ============================================================
// S11  DSH 适配层 —— 把 DeepSeek Harness 的投影缓存翻译成 hook 事件
//
// 为什么是"翻译"而不是"另起一套状态机"：
//   状态机的全部语义（优先级、oneshot 时长、睡意计时、多会话仲裁）已经长在
//   state.rs 里，DSH 对它们而言只是**另一个事件来源**。再写一套状态机的后果，
//   正是 2026-11-03 删掉 Electron 副本时才刚消灭掉的那个 bug——同一个 agent
//   在两个来源下演出两幅画面。所以这里只做一件事：把 DSH 的观测翻译成
//   `SessionStart / UserPromptSubmit / PreToolUse / Stop / SessionEnd / Meta`
//   这几个既有词汇，灌进 Store::apply()，剩下的全交给它。
//
// 读什么：`$DSH_HOME/storages/session_projcache/sessions/<id>.json`，**一会话一文件**。
//
//   这条路径是实测出来的，不是文档写的，记下来免得下一个人再踩：
//     · `~/.dsh/storages/session_projcache.json`（单文件、全量）是 **0.1.x 的遗留**，
//       本机那份停在 2026-08-31，读它等于读一份三个月前的快照——而且它不会报错，
//       只会安静地一只猫都不显示。
//     · 0.2.x 改成目录 + 每会话一个文件，文件形如 `{ version: 7, record: { identity, rows } }`。
//       会话 id 只存在于**文件名**里，record 里没有。
//     · 每会话一个文件反而是好事：可以按 (mtime, size) 只重读变过的那个。
//
//   刻意**不**读 `session.v4.jsonl.zstd`：那是 append-only 的多帧 zstd（每追加一次
//   一个 frame，单次 zstdDecompress 只解第一帧），要解压就得引 zstd/ruzstd，
//   而本项目的取舍一贯是"每多一块依赖就多一块常驻内存"。投影缓存已经把该给的都给了：
//     openStep        在不在跑一个 step
//     firstTokenTime  这一步出第一个 token 了没有（→ 区分 thinking / working）
//     pendingCalls    还有几个工具没落地（工具期 openStep 可能是 null，靠它补）
//     plan.active     plan 模式在跑
//     title           这一轮在干什么（气泡/看板要的那句话）
//     identity.cwd    在哪个目录
//     permissions     权限档位（诊断用）
//   唯一拿不到的是**工具名**：pendingCalls 是 `callId → 派发时刻`，不含名字。
//   所以看板上那一格在 DSH 下是空的——这是诚实的缺口，不是忘了接。
//
// 覆盖面（同样是实测，不是推测）：
//   `dsh web` / 桌面版：投影行齐全，状态完整。
//   `dsh headless "…"`：投影里**只有 title，没有 sessionStats / sessionListMetadata**，
//     连 lastPromptAt 都没有。所以这类会话靠**文件 mtime** 兜底判断"最近动过"，
//     状态只能是 idle——它本来就是一次性跑完就退出的东西，没有"进行中"可看。
//
// 状态怎么推：
//   lastPromptAt 变了        → 新一轮 → UserPromptSubmit（thinking）
//   phase 变成 Working       → PreToolUse（working）
//   phase 连续 IDLE_POLLS_TO_STOP 拍都是 Idle → 这一轮结束 → Stop（attention）
//   标题变了但这一拍没别的事件 → Meta（只改元数据，不动状态）
//
//   最后那条为什么要去抖：openStep 的官方注释写得很清楚——"null outside a step
//   **or after its message assembled**"。也就是说一轮里只要有工具调用，步骤之间
//   openStep 会短暂变 null。不去抖就会在轮内反复喊"做完了"（attention 一闪一闪）。
// ============================================================
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 轮询间隔。比状态机心跳（250ms）慢一个量级：
/// 上游投影缓存本身就是"每次事件写一次"的低频文件，盯得更紧只是空转。
const POLL_MS: u64 = 1000;

/// 一个会话"还算活着"的窗口。超过这么久既没新 prompt、又不忙，就不再喂给
/// 状态机——否则 DSH 里躺了半年的几十个会话会一起挤进看板。
const ACTIVE_WINDOW_MS: i64 = 30 * 60 * 1000;

/// 一次最多喂多少条。状态机自己也有上限（MAX_SESSIONS=100），这里先收一道。
const MAX_FEED: usize = 20;

/// 一次最多扫多少个会话文件。防的是"目录被塞了几万个文件"这种病态情况：
/// 那种时候该保的是主进程活着，而不是把看板填满。
const MAX_FILES: usize = 500;

/// 单个会话投影文件的大小上限。正常是 1~2KB，8MB 是"认错文件了"的界线。
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// 连续几拍都 Idle 才算这一轮真的结束了（见文件头"为什么去抖"）。
const IDLE_POLLS_TO_STOP: u32 = 2;

/// 一个 step / 一次工具调用"还活着"的最长时限。
///
/// 为什么需要这条：投影缓存是事件的折叠结果，**它不知道写它的进程已经死了**。
/// 实测（2026-11-04）：一个跑到一半被 `timeout` 杀掉的进程，会留下一个悬空的
/// `openStep`；DSH 会在**下一次打开这个会话时**补一条 `turn/end(interrupted)` 把它
/// 收尾（见 `dsh-session/lib/types/repair.d.ts`），但在那之前，投影里那条会话
/// 一直是"正在干活"。
///
/// 桌宠要是照单全收，就会永远显示 working——正是用户报过的
/// 「没有任务，但桌宠一直在工作」。所以这里按**数据自带的时间戳**判活，
/// 不是按文件 mtime：`openStep.startTime` / `pendingCalls` 的值都是派发时刻，
/// 一个 step 开了半小时还没收尾，只可能是进程没了（正常一次 step 也就几十秒）。
const STEP_STALE_MS: i64 = 30 * 60 * 1000;

/// 泡泡一行放不下太多，state.rs 那边也会再截一次；这里先截是为了
/// 让"关键词从哪来"这件事在本文件里一目了然。
const KEYWORD_CHARS: usize = 8;

/// 看板要显示"最后说了什么"，但投影里的 `turnOutline` 存的是**全文**——
/// 一轮动辄几 KB，几十条会话一起读进来就是几十 MB 常驻内存，而且每秒都在克隆。
/// 所以解析当场就截断：一段话的**开头**足够回答"这条会话在聊什么"。
///
/// 提问给 160：用户自己的话通常很短，截太狠反而看不出区别。
/// 回复给 400：它是"结果长什么样"，多留一点才有信息量。
const MAX_PROMPT_CHARS: usize = 160;
const MAX_REPLY_CHARS: usize = 400;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ------------------------------------------------------------
// 定位
// ------------------------------------------------------------

/// `$DSH_HOME`，否则 `%USERPROFILE%\.dsh`。
/// 两者都没有就返回 None——**DSH 没装时不报错，只是不喂事件**。
pub fn home() -> Option<PathBuf> {
    match std::env::var("DSH_HOME") {
        Ok(v) if !v.trim().is_empty() => Some(PathBuf::from(v.trim())),
        _ => {
            let up = std::env::var("USERPROFILE").ok()?;
            if up.trim().is_empty() {
                return None;
            }
            Some(PathBuf::from(up).join(".dsh"))
        }
    }
}

/// 一会话一文件的那个目录（0.2.x）。注意**不是**同级的 `session_projcache.json`——
/// 那是 0.1.x 的单文件遗留，理由见文件头。
pub fn sessions_dir() -> Option<PathBuf> {
    Some(
        home()?
            .join("storages")
            .join("session_projcache")
            .join("sessions"),
    )
}

// ------------------------------------------------------------
// 观测
// ------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// 模型在处理，但还没出第一个 token（等 TTFT）。桌宠的 thinking。
    Thinking,
    /// 正在出字，或者有工具在跑。桌宠的 working。
    Working,
    /// 手上没有在飞的 step / 工具。桌宠的 idle。
    Idle,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Obs {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    /// 有没有一个 step 正在跑（模型侧）。
    /// 注意它在"消息装配完成"后也会变 false，所以**单独不能**当"这一轮结束了"用。
    pub open_step: bool,
    /// openStep 里 firstTokenTime 的时间戳；None = 还没出第一个 token。
    pub first_token_at: Option<i64>,
    /// openStep 里 startTime：这一步是什么时候开始的。用来判"这一步是不是早就死了"。
    pub step_started_at: Option<i64>,
    /// 还没落地的工具调用，记的是**派发时刻**（原样来自 `pendingCalls` 的值）。
    pub pending_at: Vec<i64>,
    /// plan 模式在跑（它自己就是一个"在干活"的理由）。
    pub plan_active: bool,
    /// 最后一次用户提问题的时刻（ms）。这是"新一轮"唯一可靠的信号。
    /// 投影里没有这个字段时（headless 会话）用文件 mtime 兜底，见 parse_session。
    pub last_prompt_at: i64,
    /// `last_prompt_at` 是**真的** `lastPromptAt`，还是拿文件 mtime 兜底的。
    ///
    /// 为什么必须区分（2026-11-04 用户报「没有任何任务却一直 thinking」的根因）：
    /// `dsh headless` 的投影里**没有** `sessionListMetadata`，于是 last_prompt_at
    /// 只能退到文件 mtime；而 mtime 每写一次就变，进程收尾时还会再变一次。
    /// reconcile 把"这个值变了"当成"用户又提了一轮"，发一条 UserPromptSubmit
    /// 把会话推进 thinking——可它的 phase 永远是 Idle（headless 不写 sessionStats），
    /// 而 Idle 分支有 `saw_active` 这道闸（它从没进过 working/thinking）→ **永远不发 Stop**。
    /// 结果：一条早就死掉的 headless 会话，让猫一直显示 thinking。
    ///
    /// 所以：只有真的读到 `lastPromptAt` 才算"新一轮"；mtime 只用来判断在不在活跃窗口内。
    pub has_prompt_at: bool,
    /// 投影里到底有没有 sessionStats 行。没有 = 这个会话的状态我们其实看不见，
    /// 只能靠 mtime 说"它最近动过"。诊断时这一位比状态本身更能解释问题。
    pub has_stats: bool,
    /// 累计 turn 数。只用于诊断展示。
    pub turns: u64,
    /// 权限预设（read-only / ask …）。只用于诊断展示。
    pub preset: Option<String>,

    // ---- 2026-11-05：看板要能回答"这条会话到底在干什么" ----
    //
    // 此前看板只有 title / cwd / 状态 / 闲置时间。用户的原话是
    // 「现在的看板没有任何有效信息」——因为那四样加起来只说明"有这么一条会话"。
    // 下面这些字段全部是投影里**已经存着**的东西，只是以前没解析：
    // 多读一份同样的 JSON 不会增加任何 I/O，只是把已有字节翻译成人话。
    /// 最后一轮用户说的话（截断到 MAX_PROMPT_CHARS）。
    pub last_prompt: Option<String>,
    /// 最后一轮的回复开头（截断到 MAX_REPLY_CHARS）。空 = 还没答完。
    pub last_reply: Option<String>,
    /// 最后一轮是第几轮（`turnOutline.turns[].turn`）。0 = 还没跑过。
    pub last_turn: u64,
    /// 这一轮用的是哪个供应商 / 模型。用户自己配过供应商，所以这不能写死。
    pub provider: Option<String>,
    pub model: Option<String>,
    /// 累计 token：进（未命中缓存的输入）/ 出。
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// 上下文压力：已用 / 窗口。占比高到一定程度就该提醒用户开新会话了。
    pub ctx_tokens: u64,
    pub ctx_window: u64,
    /// `sessionStats` 里的步数与耗时（LLM / 工具分开记）。
    pub steps: u64,
    pub llm_ms: u64,
    pub tool_ms: u64,
    /// 这条会话是在**哪套 agent preset 下**建起来的。
    ///
    /// 它决定了一件很实际的事：能不能从桌宠里接着它说。
    /// `dsh headless`（一次性 runner）把这条写成了硬闸——记录过 preset 的会话
    /// 一律不接受（它组不出那套 preset 的工具/提示词），报错文案是
    /// `runs under agent preset "…", which the one-shot runner does not compose`。
    /// 桌面端 / 网页端建的会话都有；headless 自己建的没有（= None = 可续）。
    ///
    /// 我们**不去绕**这道闸：绕过它等于拿一套不同的工具集写用户那条会话。
    /// 只是把它提前告诉界面，别让用户打了一屏字才被拒。
    pub agent_preset: Option<String>,
}

impl Obs {
    /// 这一拍该算成什么状态。`now` 显式传进来，是为了让"悬空步骤"这件事可测——
    /// 掺一个 `now_ms()` 在函数里，测试就只能靠 sleep 去撞时间。
    pub fn phase_at(&self, now: i64) -> Phase {
        let dead = |t: i64| {
            // 时间戳缺失（0/负数）时判不了，按"还活着"处理：
            // 宁可短暂多显示一会儿 working，也不要凭空说一条会话干完了。
            t > 0 && now.saturating_sub(t) > STEP_STALE_MS
        };

        // 工具在跑 / plan 在跑，都是"确实在干活"，压过模型侧的判断。
        // 但只有**还活着**的工具调用才算数（见 STEP_STALE_MS）。
        if self.plan_active || self.pending_at.iter().any(|t| !dead(*t)) {
            return Phase::Working;
        }
        if !self.open_step {
            return Phase::Idle;
        }
        // step 开着，但它的开始时间已经老到不可能是活的了：写它的进程没了，
        // 而 DSH 的 repair 要等下次打开会话才补收尾。这中间不能让猫一直喊在干活。
        if self.step_started_at.map(dead).unwrap_or(false) {
            return Phase::Idle;
        }
        // 有 step 但还没有第一个 token = 在等首字。这是 thinking 的**真实含义**，
        // 不是猜的：firstTokenTime 就是"首 token 落地时刻"这个事实本身。
        if self.first_token_at.is_some() {
            Phase::Working
        } else {
            Phase::Thinking
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase_at(now_ms())
    }

    /// 泡泡里的兜底词。v1 直接取标题前几个字——DSH 的 title 是"这一轮在干什么"
    /// 的现成答案（它自己就是 LLM 生成的），不用另造一套关键词。
    fn keyword(&self) -> Option<String> {
        let t = self.title.as_ref()?;
        let k: String = t.trim().chars().take(KEYWORD_CHARS).collect();
        if k.is_empty() {
            None
        } else {
            Some(k)
        }
    }
}

fn row<'a>(rows: &'a Value, key: &str) -> Option<&'a Value> {
    rows.get(key)?.get("val")
}

/// 看板能拿到的那一份会话数据。
///
/// 为什么不直接把 `Obs` 序列化出去：Obs 里带着**完整 cwd**（SEC-09 的红线——
/// 快照会进渲染进程、进看板、上屏幕）。这里的 `cwd` 和 `SessionView` 一样
/// 只留 basename，两者走同一个 `state::public_cwd`，不会有一处忘了截。
///
/// 另一个理由是**稳定性**：Obs 是"探测内部长什么样"，会随探测逻辑变；
/// 这个结构是"看板承诺给你什么"，改它要同时改前端。
#[derive(Clone, Debug, Serialize)]
pub struct RichSession {
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    /// 最后一轮的原话 / 回复开头。
    pub last_prompt: Option<String>,
    pub last_reply: Option<String>,
    pub last_turn: u64,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub ctx_tokens: u64,
    pub ctx_window: u64,
    pub turns: u64,
    pub steps: u64,
    pub llm_ms: u64,
    pub tool_ms: u64,
    pub preset: Option<String>,
    /// 最后一次提问的时刻（ms，epoch）。前端拿它和 Date.now() 比，
    /// 不拿它做排序——排序用 Store 那边的 idleMs，因为那个才是"猫看到的时间"。
    pub last_prompt_at: i64,
    /// 这个会话的状态我们到底看不看得见（false = headless，只有 mtime）。
    pub has_stats: bool,
    /// None = 这条会话是 headless 建的，能被桌宠接着写；Some = 桌面端/网页端的，
    /// 一次性 runner 写不进去（原因见 `Obs::agent_preset`）。
    pub agent_preset: Option<String>,
    /// 这条回复不是从投影读来的，而是**桌宠自己那一次发送**从 stdout 捡到的。
    /// 界面上要区别对待：投影里的回复会随会话更新，这一条只是"那一刻的答案"。
    pub reply_from_say: bool,
    /// `provider` / `model` 不是这条会话自己记的，而是从 profile 的
    /// `agent-default-model` 补来的（headless 会话不在投影里写 `modelSelection`）。
    /// 界面要标一句"默认"，否则用户会以为这条会话真的被钉在了这个模型上。
    pub model_default: bool,
}

impl Obs {
    pub fn rich(&self) -> RichSession {
        RichSession {
            id: self.id.clone(),
            title: self.title.clone(),
            cwd: crate::state::public_cwd(&self.cwd),
            last_prompt: self.last_prompt.clone(),
            last_reply: self.last_reply.clone(),
            last_turn: self.last_turn,
            provider: self.provider.clone(),
            model: self.model.clone(),
            tokens_in: self.tokens_in,
            tokens_out: self.tokens_out,
            ctx_tokens: self.ctx_tokens,
            ctx_window: self.ctx_window,
            turns: self.turns,
            steps: self.steps,
            llm_ms: self.llm_ms,
            tool_ms: self.tool_ms,
            preset: self.preset.clone(),
            last_prompt_at: self.last_prompt_at,
            has_stats: self.has_stats,
            agent_preset: self.agent_preset.clone(),
            reply_from_say: false,
            model_default: false,
        }
    }
}

/// 取一个非负整数。缺失 / 类型不对 / 负数一律当 0——这些都是展示用的计数，
/// 少一个数字比因为一个脏字段整条会话看不见要好得多。
fn num(v: Option<&Value>) -> u64 {
    v.and_then(|x| x.as_i64()).unwrap_or(0).max(0) as u64
}

/// 从投影里取一段**人能读**的文本：压掉换行和控制字符，截断加省略号。
///
/// 为什么必须压换行：投影里的 prompt / response 是 Markdown 原文，一整段带十几个
/// 换行；看板每行只给一行高度，不压平就会把卡片撑成一堵墙。
fn snippet(v: Option<&Value>, max: usize) -> Option<String> {
    let raw = v?.as_str()?;
    let flat: String = raw
        .chars()
        // 控制字符去掉，**但换行/制表留下**——下一步的 split_whitespace 会把它们
        // 折成空格。先无条件 filter 掉的话，"第一行\n第二行" 会粘成一个词。
        .filter(|c| !c.is_control() || c.is_whitespace())
        .map(|c| if c == '\u{00a0}' { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return None;
    }
    let mut out: String = flat.chars().take(max).collect();
    if flat.chars().count() > max {
        out.push('…');
    }
    Some(out)
}

/// 解析**单个会话**的投影文件。纯函数，不碰文件系统，方便直接拿真实样本做测试。
///
/// `mtime_ms` 是文件自己的修改时刻，只在投影里没有 `lastPromptAt` 时用来兜底。
pub fn parse_session(id: &str, raw: &str, mtime_ms: i64) -> Option<Obs> {
    let v = serde_json::from_str::<Value>(raw).ok()?;
    // 0.2.x 的形状。没有 record 的直接放弃——不去猜别的版本。
    let rec = v.get("record")?;
    let rows = rec.get("rows")?;

    let meta = row(rows, "sessionListMetadata");
    // blank = 建了会话但一个字没说。它不该让桌宠冒出来。
    if meta
        .and_then(|m| m.get("blank"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
    {
        return None;
    }

    let stats = row(rows, "sessionStats");
    let open_step = stats
        .and_then(|x| x.get("openStep"))
        .filter(|x| !x.is_null());

    let pending_at: Vec<i64> = stats
        .and_then(|x| x.get("pendingCalls"))
        .and_then(|x| x.as_object())
        .map(|m| m.values().filter_map(|v| v.as_i64()).collect())
        .unwrap_or_default();

    // headless 一次性会话在投影里只有 title，没有 sessionListMetadata，
    // 于是没有 lastPromptAt。那种情况下用文件 mtime 兜底：
    // 至少能说"这个会话最近被动过"，而不是让它永远落在活跃窗口外、彻底看不见。
    let real_prompt_at = meta
        .and_then(|m| m.get("lastPromptAt"))
        .and_then(|x| x.as_i64())
        .filter(|t| *t > 0);
    // 有真值就用真值，没有才退到 mtime；但**记下这是退的**（见 has_prompt_at）。
    let has_prompt_at = real_prompt_at.is_some();
    let last_prompt_at = real_prompt_at.unwrap_or(mtime_ms);

    // ---- 看板要的内容（全部来自同一份投影，不额外读盘） ----
    //
    // `turnOutline.turns` 是 DSH 自己维护的"这一轮问了什么、答了什么"。
    // 它比 title 准得多：title 是 LLM 拟的一句话，而这里是**原话**。
    // 取最后一项而不是拼接全文——看板一行放不下，而且旧轮次没人看。
    let last_turn_row = row(rows, "turnOutline")
        .and_then(|o| o.get("turns"))
        .and_then(|t| t.as_array())
        .and_then(|a| a.last());
    // 供应商/模型：用户自己配过，所以不能写死 deepseek。
    let used = row(rows, "modelSelection").and_then(|m| m.get("lastUsed"));
    let totals = row(rows, "tokenUsage").and_then(|t| t.get("totals"));
    let ctx = row(rows, "contextPressure");

    Some(Obs {
        id: id.to_string(),
        title: row(rows, "title")
            .and_then(|x| x.as_str())
            .map(|x| x.to_string()),
        cwd: rec
            .get("identity")
            .and_then(|i| i.get("cwd"))
            .and_then(|x| x.as_str())
            .map(|x| x.to_string()),
        open_step: open_step.is_some(),
        first_token_at: open_step
            .and_then(|x| x.get("firstTokenTime"))
            .and_then(|x| x.as_i64()),
        step_started_at: open_step
            .and_then(|x| x.get("startTime"))
            .and_then(|x| x.as_i64()),
        pending_at,
        plan_active: row(rows, "plan")
            .and_then(|p| p.get("active"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        last_prompt_at,
        has_prompt_at,
        has_stats: stats.is_some(),
        turns: {
            // 轮数优先取 sessionStats；没有就退到 turnBoundary.lastTurn——
            // `dsh headless` 建的会话不写 sessionStats，但 turnBoundary 是有的
            // （实测：只写了 title + turnBoundary + tokenUsage + contextPressure）。
            // 少了这条兜底，桌宠自己发起的那条会话在看板上会永远显示"0 轮"。
            let n = stats
                .and_then(|x| x.get("turns"))
                .and_then(|x| x.as_i64())
                .unwrap_or(0)
                .max(0) as u64;
            if n > 0 {
                n
            } else {
                num(row(rows, "turnBoundary").and_then(|b| b.get("lastTurn")))
            }
        },
        preset: row(rows, "permissions")
            .and_then(|p| p.get("preset"))
            .and_then(|x| x.as_str())
            .map(|x| x.to_string()),

        last_prompt: snippet(last_turn_row.and_then(|t| t.get("prompt")), MAX_PROMPT_CHARS),
        last_reply: snippet(last_turn_row.and_then(|t| t.get("response")), MAX_REPLY_CHARS),
        last_turn: num(last_turn_row.and_then(|t| t.get("turn"))),
        provider: used
            .and_then(|u| u.get("provider"))
            .and_then(|x| x.as_str())
            .map(|x| x.to_string()),
        model: used
            .and_then(|u| u.get("model"))
            .and_then(|x| x.as_str())
            .map(|x| x.to_string()),
        tokens_in: num(totals.and_then(|t| t.get("uncachedInputTokens"))),
        tokens_out: num(totals.and_then(|t| t.get("outputTokens"))),
        ctx_tokens: num(ctx.and_then(|c| c.get("pressureTokens"))),
        ctx_window: num(ctx.and_then(|c| c.get("contextWindow"))),
        steps: num(stats.and_then(|x| x.get("steps"))),
        llm_ms: num(stats.and_then(|x| x.get("llmMs"))),
        tool_ms: num(stats.and_then(|x| x.get("toolMs"))),
        agent_preset: row(rows, "agentPreset")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|x| x.to_string()),
    })
}

// ------------------------------------------------------------
// 探测
// ------------------------------------------------------------

/// 每条会话上一次被观测到的样子。只为了判"变了没有"。
struct Track {
    last_prompt_at: i64,
    phase: Phase,
    /// 连续几拍是 Idle。
    idle_streak: u32,
    /// 这一轮的 Stop 已经喊过了没有。
    stopped: bool,
    /// 这一轮**曾经**忙过没有。没有忙过就不喊 Stop——
    /// 否则一只一直闲着的会话每 2 拍就会喊一次"我做完了"，那是幻觉。
    saw_active: bool,
    /// 上一次报给状态机的标题。标题是回填的，变了要单独发 Meta（见 reconcile）。
    title: Option<String>,
}

/// 一个会话文件的缓存条目：stamp 相同就不重读。
struct Cached {
    stamp: (u64, u64),
    obs: Obs,
}

pub struct Probe {
    dir: Option<PathBuf>,
    obs: Vec<Obs>,
    /// 按文件名缓存的"上次读到的东西"。目录里几十上百个文件时，
    /// 每拍只重读真正变过的那个。
    cached: HashMap<String, Cached>,
    prev: HashMap<String, Track>,
    // ---- 诊断计数：用户报"桌宠不动"时，这几个数能区分死在哪一步 ----
    polls: u64,
    reads: u64,
    feeds: u64,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct ProbeView {
    pub home: Option<String>,
    pub dir: Option<String>,
    pub installed: bool,
    pub polls: u64,
    pub reads: u64,
    pub feeds: u64,
    pub error: Option<String>,
    pub sessions: Vec<Obs>,
}

impl Default for ProbeView {
    fn default() -> Self {
        Self {
            home: None,
            dir: None,
            installed: false,
            polls: 0,
            reads: 0,
            feeds: 0,
            error: None,
            sessions: Vec::new(),
        }
    }
}

fn stamp_of(p: &PathBuf) -> Option<(u64, u64)> {
    let md = std::fs::metadata(p).ok()?;
    let mtime = md
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some((mtime, md.len()))
}

impl Probe {
    pub fn new() -> Self {
        Self {
            dir: sessions_dir(),
            obs: Vec::new(),
            cached: HashMap::new(),
            prev: HashMap::new(),
            polls: 0,
            reads: 0,
            feeds: 0,
            error: None,
        }
    }

    pub fn interval() -> std::time::Duration {
        std::time::Duration::from_millis(POLL_MS)
    }

    /// 扫目录（只重读变过的文件）。
    fn refresh(&mut self) {
        let Some(dir) = self.dir.clone() else {
            self.obs.clear();
            self.cached.clear();
            return;
        };
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => {
                // 目录不存在是最常见的情况（没装 DSH / 还没跑过 web）。
                // 不要当成错误刷屏，只记一次给诊断看。
                if e.kind() != std::io::ErrorKind::NotFound {
                    self.error = Some(format!("扫不了 {dir:?}: {e}"));
                }
                self.obs.clear();
                self.cached.clear();
                return;
            }
        };

        let mut next: HashMap<String, Cached> = HashMap::with_capacity(self.cached.len());
        let mut out: Vec<Obs> = Vec::new();
        let mut parsed_any = false;
        let mut budget = MAX_FILES;

        for entry in rd.flatten() {
            if budget == 0 {
                break;
            }
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string()) else {
                continue;
            };
            budget -= 1;

            let Some(st) = stamp_of(&path) else { continue };

            // 没变就复用上一拍解析好的结果，连读都不用读。
            if let Some(c) = self.cached.get(&id) {
                if c.stamp == st {
                    out.push(c.obs.clone());
                    next.insert(id, Cached { stamp: st, obs: c.obs.clone() });
                    continue;
                }
            }

            if st.1 > MAX_FILE_BYTES {
                self.error = Some(format!("{id} 超过 8MB，跳过"));
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let Ok(txt) = String::from_utf8(bytes) else {
                self.error = Some(format!("{id} 不是合法 UTF-8"));
                continue;
            };
            parsed_any = true;
            if let Some(o) = parse_session(&id, &txt, st.0 as i64) {
                out.push(o.clone());
                next.insert(id, Cached { stamp: st, obs: o });
            }
            // parse_session 返回 None = blank 会话。**不放进 next**，
            // 这样它下次变了还会被重读（新会话说的第一句话要能被看见）。
        }

        // 目录遍历顺序不稳定；排序是为了让"截断到 MAX_FEED"这件事可复现。
        out.sort_by(|a, b| b.last_prompt_at.cmp(&a.last_prompt_at));

        self.cached = next;
        self.obs = out;
        if parsed_any {
            self.reads = self.reads.saturating_add(1);
            self.error = None;
        }
    }

    /// 走一拍：返回这一拍要灌给状态机的事件序列。空 = 什么都没变。
    pub fn poll(&mut self) -> Vec<Value> {
        self.polls += 1;
        self.refresh();
        self.reconcile()
    }

    fn reconcile(&mut self) -> Vec<Value> {
        let now = now_ms();
        // 留下来的必须是"最近还在动的"，而不是目录遍历顺序里碰巧排前面的。
        let mut live: Vec<Obs> = self
            .obs
            .iter()
            .filter(|o| {
                o.phase() != Phase::Idle
                    || now.saturating_sub(o.last_prompt_at) <= ACTIVE_WINDOW_MS
            })
            .cloned()
            .collect();
        live.sort_by(|a, b| b.last_prompt_at.cmp(&a.last_prompt_at));
        live.truncate(MAX_FEED);

        let mut out: Vec<Value> = Vec::new();
        let mut present: HashSet<String> = HashSet::with_capacity(live.len());

        for o in &live {
            present.insert(o.id.clone());
            let ph = o.phase();
            let is_new = !self.prev.contains_key(&o.id);

            // 新会话的 Track 从 Idle 起算：这样"一发现它就在 working"也会
            // 走一次 PreToolUse，而不是停在 SessionStart 给的 idle 上。
            let t = self.prev.entry(o.id.clone()).or_insert(Track {
                last_prompt_at: o.last_prompt_at,
                phase: Phase::Idle,
                idle_streak: 0,
                stopped: true,
                saw_active: false,
                title: None,
            });

            // 本地记一笔"这条会话这一拍有没有发过东西"。
            // 没有的话，标题如果变了就得单独发一条 Meta（见本段末尾）。
            let mut sent = false;

            if is_new {
                // 新建会话的初值是 idle（state.rs 的约定），标题一并带过去。
                out.push(payload(o, "SessionStart"));
                sent = true;
            }

            // 新的一轮。lastPromptAt 只在用户真的提交提问时前进，
            // 这是所有信号里最不容易误判的一个——**只要它是真的**。
            //
            // `has_prompt_at == false` 意味着这个值是文件 mtime 兜底的（headless 会话）。
            // 那种值会在每次写盘时前进，把它当"用户又提了一轮"就发 UserPromptSubmit，
            // 而这类会话的 phase 永远是 Idle（不写 sessionStats）→ Idle 分支的
            // `saw_active` 闸永远不放行 → 没人发 Stop → 猫一直到天荒地老地 thinking。
            // 用户 2026-11-04 报的就是这个。
            if o.last_prompt_at != t.last_prompt_at {
                let fresh = o.has_prompt_at && o.last_prompt_at > 0;
                t.last_prompt_at = o.last_prompt_at;
                if fresh {
                    out.push(payload(o, "UserPromptSubmit"));
                    sent = true;
                    t.stopped = false;
                    // 我们自己推出来的"在跑"，必须自己也收得回来。
                    // 少了这一行，就成了一句话把会话推进 thinking、然后再没有谁能把它拿出来。
                    t.saw_active = true;
                    t.idle_streak = 0;
                }
            }

            match ph {
                Phase::Working => {
                    if t.phase != Phase::Working {
                        out.push(payload(o, "PreToolUse"));
                        sent = true;
                    }
                    t.saw_active = true;
                    t.stopped = false;
                    t.idle_streak = 0;
                }
                Phase::Thinking => {
                    // 从 working 退回 thinking = 下一个 step 在等首字。
                    // 状态上仍然属于"这一轮在跑"，**不**发事件：发了会让画面
                    // 从 working 闪回 thinking，而用户看到的是"又开始了"。
                    //
                    // 但从 Idle 进 Thinking 必须发：新会话被发现时如果正好在等
                    // 首 token，只发 SessionStart 会把它钉在 idle 上——
                    // 分明在干活，猫却在发呆。UserPromptSubmit 的语义正好是
                    // "开始想一件事"，搭载这一跳最贴切。
                    if t.phase == Phase::Idle {
                        out.push(payload(o, "UserPromptSubmit"));
                        sent = true;
                    }
                    t.saw_active = true;
                    t.stopped = false;
                    t.idle_streak = 0;
                }
                Phase::Idle => {
                    t.idle_streak = t.idle_streak.saturating_add(1);
                    if !t.stopped && t.saw_active && t.idle_streak >= IDLE_POLLS_TO_STOP {
                        out.push(payload(o, "Stop"));
                        sent = true;
                        t.stopped = true;
                    }
                }
            }
            t.phase = ph;

            // 标题回填。DSH 的标题是一轮进行中由 LLM 生成后写回缓存的，
            // 落地时常常**没有任何状态变化**可以搭载——此时必须显式发一条 Meta，
            // 否则这条会话直到下一轮才会有标题（气泡和看板会一直空着）。
            // 这一拍已经发过别的事件就不必了：那些 payload 本身就带着标题。
            if o.title != t.title {
                t.title = o.title.clone();
                if !sent {
                    out.push(payload(o, "Meta"));
                }
            }
        }

        // 掉出窗口的会话：显式收尾，否则状态机里会一直留着一条不动弹的会话。
        let gone: Vec<String> = self
            .prev
            .keys()
            .filter(|k| !present.contains(*k))
            .cloned()
            .collect();
        for id in gone {
            self.prev.remove(&id);
            out.push(json!({ "session_id": id, "event": "SessionEnd" }));
        }

        self.feeds = self.feeds.saturating_add(out.len() as u64);
        out
    }

    pub fn view(&self) -> ProbeView {
        ProbeView {
            home: home().map(|p| p.display().to_string()),
            dir: self.dir.as_ref().map(|p| p.display().to_string()),
            installed: self.dir.as_ref().map(|p| p.exists()).unwrap_or(false),
            polls: self.polls,
            reads: self.reads,
            feeds: self.feeds,
            error: self.error.clone(),
            sessions: self.obs.clone(),
        }
    }

    /// 测试入口：跳过读盘，直接灌观测。
    #[cfg(test)]
    fn push_obs(&mut self, obs: Vec<Obs>) {
        self.obs = obs;
    }

    /// 测试入口：只跑翻译，不读盘。
    ///
    /// 必须和 `poll()` 分开。`poll()` 的第一件事是 refresh，那会把测试刚注入的
    /// 观测用磁盘上的真实缓存覆盖掉——测试就成了"断言真实环境发生了什么"，
    /// 在本机装了 DSH 的情况下必然失败。
    #[cfg(test)]
    fn step(&mut self) -> Vec<Value> {
        self.reconcile()
    }
}

fn payload(o: &Obs, event: &str) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("session_id".into(), json!(o.id));
    m.insert("event".into(), json!(event));
    // 标题/目录/关键词每拍都带：state.rs 那边的语义是"粘的，只有真的拿到才写",
    // 所以重复带同一个值不会被当成覆盖，改了标题也能立刻反映。
    if let Some(t) = &o.title {
        m.insert("title".into(), json!(t));
    }
    if let Some(k) = o.keyword() {
        m.insert("keyword".into(), json!(k));
    }
    if let Some(c) = &o.cwd {
        m.insert("cwd".into(), json!(c));
    }
    // v1 没有工具名（投影里的 pendingCalls 只有 callId → 时刻）。
    Value::Object(m)
}

// ------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    /// 一个固定的"刚刚"。
    ///
    /// 不能让 `obs()` 每次自己调 now_ms()：两次构造可能落在不同毫秒，而
    /// `lastPromptAt` 正是"用户又提了一轮"的判据——差 1ms 就足以让一个本该
    /// "什么都没变"的断言变成"又来了一个新 prompt"。那种测试跑十次绿九次，
    /// 是最难查的一类。
    fn t0() -> i64 {
        static T0: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
        *T0.get_or_init(now_ms)
    }

    fn obs(id: &str, open: bool, first_token: Option<i64>, pending: usize) -> Obs {
        Obs {
            id: id.into(),
            title: Some("改登录页".into()),
            cwd: Some("E:\\work\\proj".into()),
            open_step: open,
            first_token_at: first_token,
            // 默认"刚刚开始"，也就是活着。判死的用例自己把它改老。
            step_started_at: if open { Some(t0()) } else { None },
            pending_at: vec![t0(); pending],
            plan_active: false,
            // 必须是"刚刚"。reconcile 会把超出 ACTIVE_WINDOW_MS 的 idle 会话滤掉，
            // 写成固定的小数字（比如 1000）等于断言"1970 年那次提问还在活跃"。
            last_prompt_at: t0(),
            has_prompt_at: true,
            has_stats: true,
            turns: 0,
            preset: None,
            last_prompt: None,
            last_reply: None,
            last_turn: 0,
            provider: None,
            model: None,
            tokens_in: 0,
            tokens_out: 0,
            ctx_tokens: 0,
            ctx_window: 0,
            steps: 0,
            llm_ms: 0,
            tool_ms: 0,
            agent_preset: None,
        }
    }

    /// 真实样本：本机 ~/.dsh 里一条跑过的会话，只裁掉无关行。
    /// 形状照抄 `{ version, record: { identity, rows } }`——**不是**旧版单文件那套。
    const SAMPLE: &str = r#"{
      "version": 7,
      "record": {
        "identity": { "createdAt": 1788147578033, "cwd": "E:\\JacksonLee\\project\\DeepseekWorkSpace" },
        "rows": {
          "sessionStats": { "ver": 1, "seq": 216, "val": {
            "turns": 4, "steps": 4, "lastTurn": 4, "openStep": null, "pendingCalls": {},
            "llmMs": 6228, "toolMs": 0 } },
          "title": { "ver": 1, "seq": 216, "val": "Hi Who am i" },
          "sessionListMetadata": { "ver": 1, "seq": 216, "val": { "blank": false, "lastPromptAt": 1788150298325 } },
          "plan": { "ver": 2, "seq": 216, "val": { "active": false } },
          "permissions": { "ver": 1, "seq": 216, "val": { "preset": "read-only", "sandbox": "read-only", "approval": "ask" } },
          "agentPreset": { "ver": 1, "seq": 216, "val": "minimal" },
          "modelSelection": { "ver": 1, "seq": 216, "val": {
            "lastUsed": { "provider": "deepseek-official", "model": "Qwen", "reasoningEffort": "off" }, "pending": null } },
          "tokenUsage": { "ver": 2, "seq": 216, "val": {
            "totals": { "uncachedInputTokens": 1124, "outputTokens": 164, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
            "last": null } },
          "contextPressure": { "ver": 5, "seq": 216, "val": { "surfaceTokens": 230, "contextWindow": 1000000, "pressureTokens": 1124 } },
          "turnOutline": { "ver": 2, "seq": 216, "val": { "turns": [
            { "turn": 1, "seq": 12, "prompt": "Hi Who am i", "response": "" },
            { "turn": 4, "seq": 43, "prompt": "Hi Who am i",
              "response": "Hi there!\n\nI don't actually know who you are…" } ], "draft": "" } }
        }
      }
    }"#;

    /// headless 一次性会话：只有 title，没有 sessionStats / sessionListMetadata。
    const SAMPLE_HEADLESS: &str = r#"{
      "version": 7,
      "record": {
        "identity": { "cwd": "E:\\JacksonLee\\project\\clawd-starter" },
        "rows": { "title": { "ver": 1, "seq": 3, "val": "probe" } }
      }
    }"#;

    #[test]
    fn parses_real_session_file_shape() {
        let o = parse_session("session-a", SAMPLE, 0).expect("应该解析出会话");
        assert_eq!(o.id, "session-a");
        assert_eq!(o.title.as_deref(), Some("Hi Who am i"));
        assert_eq!(
            o.cwd.as_deref(),
            Some("E:\\JacksonLee\\project\\DeepseekWorkSpace")
        );
        assert_eq!(o.last_prompt_at, 1788150298325);
        assert_eq!(o.turns, 4);
        assert_eq!(o.preset.as_deref(), Some("read-only"));
        assert!(!o.open_step);
        assert!(o.has_stats);
        assert_eq!(o.phase(), Phase::Idle);
    }

    // 看板要能回答"这条会话在干什么"。这一条把"从投影里读得出人话"钉住：
    // 少了任何一个字段，看板就会退回"只有标题和状态"的样子——也就是用户说的
    // 「没有任何有效信息」。
    #[test]
    fn parses_what_the_session_is_actually_about() {
        let o = parse_session("session-a", SAMPLE, 0).unwrap();
        // 最后的**原话**，不是 LLM 拟的标题
        assert_eq!(o.last_prompt.as_deref(), Some("Hi Who am i"));
        assert_eq!(o.last_turn, 4, "取的是最后一项，不是第一项");
        // 换行必须被压平：看板每行只有一个行高，带换行的原文会把卡片撑成一堵墙
        let reply = o.last_reply.as_deref().unwrap();
        assert!(!reply.contains('\n'), "回复里的换行没压平：{reply:?}");
        assert!(
            reply.starts_with("Hi there! I"),
            "换行要折成空格，不能把两个词粘在一起：{reply:?}"
        );
        // 供应商和模型是用户自己配的，不能写死
        assert_eq!(o.provider.as_deref(), Some("deepseek-official"));
        assert_eq!(o.model.as_deref(), Some("Qwen"));
        assert_eq!((o.tokens_in, o.tokens_out), (1124, 164));
        assert_eq!((o.ctx_tokens, o.ctx_window), (1124, 1_000_000));
        assert_eq!((o.steps, o.llm_ms), (4, 6228));
        // 桌面端建的会话记着 preset，因此不能被桌宠续写——这个事实要在
        // 窗口打开的那一刻就说出来，不能等用户打完字才在报错里看到。
        assert_eq!(o.agent_preset.as_deref(), Some("minimal"));
    }

    // headless 自己建的会话没有 agentPreset 行 → 可以被 `--session-id` 续上。
    // 这一条是整个「从桌宠发消息」功能能不能成立的前提。
    #[test]
    fn headless_session_has_no_preset_and_is_therefore_resumable() {
        let o = parse_session("session-h", SAMPLE_HEADLESS, 1_700_000_000_000).unwrap();
        assert!(o.agent_preset.is_none(), "headless 会话不该有 preset");
    }

    // 投影里存的是全文，一轮动辄几 KB；几十条会话每秒克隆一遍就是几十 MB。
    // 所以解析当场截断——但截断必须留下省略号，否则读者会以为原文就这么短。
    #[test]
    fn long_text_is_truncated_with_an_ellipsis() {
        let long = "字".repeat(MAX_PROMPT_CHARS * 2);
        let raw = format!(
            r#"{{"version":7,"record":{{"identity":{{}},"rows":{{
              "sessionListMetadata":{{"ver":1,"seq":1,"val":{{"blank":false,"lastPromptAt":1}}}},
              "turnOutline":{{"ver":2,"seq":1,"val":{{"turns":[
                {{"turn":1,"seq":1,"prompt":"{long}","response":""}}]}}}}}}}}}}"#
        );
        let o = parse_session("s", &raw, 0).unwrap();
        let p = o.last_prompt.unwrap();
        assert_eq!(p.chars().count(), MAX_PROMPT_CHARS + 1, "截断后应多出一个省略号");
        assert!(p.ends_with('…'));
        assert!(o.last_reply.is_none(), "空回复不能变成空字符串");
    }

    // 旧版单文件那条路已经废弃了，但"喂错形状"必须安静地什么都不产出，
    // 而不是 panic——否则一个残留文件就能让整个探测线程死掉。
    #[test]
    fn wrong_shapes_yield_nothing_instead_of_panicking() {
        assert!(parse_session("x", "not json", 0).is_none());
        assert!(parse_session("x", "{}", 0).is_none());
        // 0.1.x 的旧形状（顶层直接是 identity/rows）
        assert!(parse_session("x", r#"{"identity":{},"rows":{}}"#, 0).is_none());
    }

    #[test]
    fn blank_session_is_skipped() {
        let raw = r#"{"version":7,"record":{"identity":{},"rows":{
          "sessionListMetadata":{"ver":1,"seq":1,"val":{"blank":true}},
          "title":null}}}"#;
        assert!(parse_session("session-blank", raw, 0).is_none());
    }

    // headless 会话没有 lastPromptAt。不拿 mtime 兜底的话它会永远落在
    // 活跃窗口外——也就是"跑了一次 dsh，桌宠毫无反应"。
    #[test]
    fn headless_session_falls_back_to_file_mtime() {
        let o = parse_session("session-h", SAMPLE_HEADLESS, 1_700_000_000_000).unwrap();
        assert_eq!(o.last_prompt_at, 1_700_000_000_000);
        assert!(!o.has_stats, "headless 确实没有 sessionStats");
        assert_eq!(o.title.as_deref(), Some("probe"));
        assert_eq!(o.phase(), Phase::Idle);
    }

    #[test]
    fn phase_tells_waiting_for_first_token_apart_from_decoding() {
        // 有 step、还没首 token = 在等 → thinking
        assert_eq!(obs("s", true, None, 0).phase(), Phase::Thinking);
        // 有 step、首 token 已落地 = 在出字 → working
        assert_eq!(obs("s", true, Some(5), 0).phase(), Phase::Working);
        // 工具在跑（此时 openStep 可能已 null）→ working
        assert_eq!(obs("s", false, None, 2).phase(), Phase::Working);
        // 什么都没有 → idle
        assert_eq!(obs("s", false, None, 0).phase(), Phase::Idle);
    }

    #[test]
    fn plan_active_counts_as_working() {
        let mut o = obs("s", false, None, 0);
        o.plan_active = true;
        assert_eq!(o.phase(), Phase::Working);
    }

    /// 跑着跑着被强杀的会话：投影里会留下悬空的 openStep。
    /// DSH 要等**下次打开这个会话**才补 `turn/end(interrupted)`，
    /// 在那之前桌宠要是照单全收，就会永远显示"正在干活"。
    const SAMPLE_DANGLING: &str = r#"{
      "version": 7,
      "record": {
        "identity": { "cwd": "E:\\w" },
        "rows": {
          "sessionStats": { "ver": 1, "seq": 9, "val": {
            "turns": 1, "steps": 1, "lastTurn": 1,
            "openStep": { "turn": 1, "step": 1, "startTime": 1700000000000, "firstTokenTime": 1700000000500 },
            "pendingCalls": { "call-a": 1700000001000, "call-b": 1700000002000 } } },
          "sessionListMetadata": { "ver": 1, "seq": 9, "val": { "blank": false, "lastPromptAt": 1700000000000 } },
          "title": { "ver": 1, "seq": 9, "val": "跑一半被杀" }
        }
      }
    }"#;

    #[test]
    fn parses_step_start_and_pending_dispatch_times() {
        let o = parse_session("s", SAMPLE_DANGLING, 0).unwrap();
        // openStep.startTime 与 pendingCalls 的值（派发时刻）都要留住——
        // 判"这一步是不是早就死了"全靠它们，丢了就只能看文件 mtime 猜。
        assert_eq!(o.step_started_at, Some(1_700_000_000_000));
        assert_eq!(o.pending_at, vec![1_700_000_001_000, 1_700_000_002_000]);
        // 刚写下的时候确实是"在干活"
        assert_eq!(o.phase_at(1_700_000_002_000), Phase::Working);
    }

    #[test]
    fn dangling_step_is_not_working_forever() {
        let o = parse_session("s", SAMPLE_DANGLING, 0).unwrap();
        // 一步开了半小时还没收尾：进程没了。
        let much_later = 1_700_000_000_000 + STEP_STALE_MS + 60_000;
        assert_eq!(o.phase_at(much_later), Phase::Idle, "悬空步骤不许一直挂着 working");
    }

    #[test]
    fn dangling_pending_call_is_not_working_forever() {
        let mut o = obs("s", false, None, 0);
        o.pending_at = vec![t0() - STEP_STALE_MS - 60_000];
        assert_eq!(o.phase(), Phase::Idle, "悬空的工具调用也不许一直挂着 working");
    }

    // 时间戳缺失（0）时判不了一具死活，按"还活着"处理：
    // 宁可短暂多显示一会儿 working，也不要凭空宣布一条会话干完了。
    #[test]
    fn missing_timestamps_are_treated_as_alive() {
        let mut o = obs("s", false, None, 0);
        o.pending_at = vec![0];
        assert_eq!(o.phase(), Phase::Working);
    }

    // headless 会话的投影里没有 sessionListMetadata，last_prompt_at 只能退到文件 mtime。
    // 那个值每写一次盘就前进（进程收尾时还会再前进一次），但它**不是"用户又提了一轮"**。
    //
    // 老代码在这里发了 UserPromptSubmit，把会话推进 thinking；而这类会话的 phase
    // 永远是 Idle（headless 不写 sessionStats），Idle 分支又要求 saw_active 才发 Stop
    // → 一句话把会话关进 thinking，然后再没有谁能把它放出来。
    #[test]
    fn mtime_fallback_never_starts_a_new_round() {
        let mut p = Probe::new();
        let mut a = obs("s", false, None, 0);
        a.has_prompt_at = false; // = 这个时刻是 mtime 兜底的
        a.has_stats = false; // headless：连 sessionStats 都没有
        p.push_obs(vec![a.clone()]);
        let first = p.step();
        assert!(
            first.iter().all(|v| v["event"] != "UserPromptSubmit"),
            "发现一条 mtime 兜底的会话时不该发 UserPromptSubmit：{first:?}"
        );

        a.last_prompt_at += 5_000; // 文件又写了一次 → mtime 前进
        p.push_obs(vec![a]);
        let second = p.step();
        assert!(
            second.iter().all(|v| v["event"] != "UserPromptSubmit"),
            "mtime 前进被当成新提问了：{second:?}"
        );
    }

    // 用户 2026-11-04 报的现象：没有任何任务，猫一直显示 thinking。
    // 触发它的是"进程死在 step 里"：headless 被杀掉之后投影里 openStep 变回 null，
    // 洞见只有一条——**从 thinking 掉回 idle 也必须发 Stop**，否则状态机里那条会话
    // 永远停在 thinking（thinking 不发事件就没人叫醒它，只有 working/attention 会自己收）。
    #[test]
    fn thinking_that_dies_still_emits_stop() {
        let mut p = Probe::new();
        p.push_obs(vec![obs("s", true, None, 0)]); // 等首字 = thinking
        let first = p.step();
        assert!(
            first.iter().any(|v| v["event"] == "UserPromptSubmit"),
            "从 idle 进 thinking 要发 UserPromptSubmit：{first:?}"
        );
        // 进程没了：openStep 变 null，其余不动
        p.push_obs(vec![obs("s", false, None, 0)]);
        let mut all = Vec::new();
        for _ in 0..3 {
            all.extend(p.step());
        }
        assert!(
            all.iter().any(|v| v["event"] == "Stop"),
            "thinking 掉回 idle 没发 Stop，状态机会永远停在 thinking：{all:?}"
        );
    }

    #[test]
    fn working_then_idle_emits_stop_exactly_once() {
        let mut p = Probe::new();
        p.push_obs(vec![obs("s1", true, Some(1), 0)]);
        let ev = p.step();
        // 第一次见到就带着 working：先建会话，再进 working
        assert_eq!(names(&ev), vec!["SessionStart", "PreToolUse"]);

        // 掉成 idle 第一拍：还不能喊"做完了"（见文件头的去抖理由）
        p.push_obs(vec![obs("s1", false, None, 0)]);
        assert!(names(&p.step()).is_empty(), "第一拍 idle 不该收尾");

        // 第二拍仍 idle：这一轮确实结束了
        p.push_obs(vec![obs("s1", false, None, 0)]);
        assert_eq!(names(&p.step()), vec!["Stop"]);

        // 再继续 idle 也不能重复喊
        p.push_obs(vec![obs("s1", false, None, 0)]);
        assert!(names(&p.step()).is_empty(), "Stop 只能喊一次");
    }

    #[test]
    fn never_busy_session_never_claims_done() {
        let mut p = Probe::new();
        p.push_obs(vec![obs("s1", false, None, 0)]);
        assert_eq!(names(&p.step()), vec!["SessionStart"]);
        for _ in 0..5 {
            p.push_obs(vec![obs("s1", false, None, 0)]);
            assert!(names(&p.step()).is_empty(), "一直闲着的会话不该喊 Stop");
        }
    }

    // 刚被发现的会话如果正好在"等首 token"，光发 SessionStart 会把它钉在 idle 上
    // ——分明在干活，猫却在发呆。这一跳必须补一个"开始想事"的事件。
    #[test]
    fn newly_seen_thinking_session_is_not_left_idle() {
        let mut p = Probe::new();
        p.push_obs(vec![obs("s1", true, None, 0)]); // 有 step、还没首 token
        assert_eq!(names(&p.step()), vec!["SessionStart", "UserPromptSubmit"]);
    }

    // 但 working → thinking 的回落不能再发一次，否则画面会从 working 闪回 thinking。
    #[test]
    fn working_to_thinking_does_not_flap() {
        let mut p = Probe::new();
        p.push_obs(vec![obs("s1", true, Some(1), 0)]);
        p.step(); // SessionStart + PreToolUse
        p.push_obs(vec![obs("s1", true, None, 0)]);
        assert!(names(&p.step()).is_empty(), "轮内 step 换气不该发事件");
    }

    #[test]
    fn new_prompt_starts_a_fresh_round() {
        let mut p = Probe::new();
        let mut o = obs("s1", false, None, 0);
        p.push_obs(vec![o.clone()]);
        p.step();
        o.last_prompt_at += 1000;
        p.push_obs(vec![o.clone()]);
        assert_eq!(names(&p.step()), vec!["UserPromptSubmit"]);
    }

    #[test]
    fn vanished_session_gets_session_end() {
        let mut p = Probe::new();
        p.push_obs(vec![obs("s1", false, None, 0)]);
        p.step();
        p.push_obs(vec![]);
        assert_eq!(names(&p.step()), vec!["SessionEnd"]);
    }

    // 标题是回填的：会话已经闲在那儿了，标题才由 LLM 生成写回来。
    // 此刻没有任何状态变化可搭载，必须单独发 Meta，否则气泡永远是空的。
    #[test]
    fn backfilled_title_goes_out_as_meta() {
        let mut p = Probe::new();
        let mut o = obs("s1", false, None, 0);
        o.title = None;
        p.push_obs(vec![o.clone()]);
        assert_eq!(names(&p.step()), vec!["SessionStart"]);

        o.title = Some("修拖拽".into());
        p.push_obs(vec![o.clone()]);
        assert_eq!(names(&p.step()), vec!["Meta"], "标题回填要单独发一条");

        // 同一个标题不该反复发
        p.push_obs(vec![o]);
        assert!(names(&p.step()).is_empty());
    }

    #[test]
    fn keyword_is_first_chars_of_title() {
        let o = obs("s", false, None, 0);
        assert_eq!(o.keyword().as_deref(), Some("改登录页"));
        let mut long = obs("s", false, None, 0);
        long.title = Some("重构整个项目的状态机并补测试".into());
        assert_eq!(long.keyword().unwrap().chars().count(), KEYWORD_CHARS);
    }

    fn names(v: &[Value]) -> Vec<String> {
        v.iter()
            .map(|x| {
                x.get("event")
                    .and_then(|e| e.as_str())
                    .unwrap_or("?")
                    .to_string()
            })
            .collect()
    }
}
