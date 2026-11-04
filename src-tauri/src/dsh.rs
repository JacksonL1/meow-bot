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

/// 头巾上只有那么大地方，state.rs 那边也会再截一次；这里先截是为了
/// 让"关键词从哪来"这件事在本文件里一目了然。
const KEYWORD_CHARS: usize = 8;

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
    /// 还没落地的工具调用数。工具期 openStep 可能已经是 null，靠它补。
    pub pending_calls: usize,
    /// plan 模式在跑（它自己就是一个"在干活"的理由）。
    pub plan_active: bool,
    /// 最后一次用户提问题的时刻（ms）。这是"新一轮"唯一可靠的信号。
    /// 投影里没有这个字段时（headless 会话）用文件 mtime 兜底，见 parse_session。
    pub last_prompt_at: i64,
    /// 投影里到底有没有 sessionStats 行。没有 = 这个会话的状态我们其实看不见，
    /// 只能靠 mtime 说"它最近动过"。诊断时这一位比状态本身更能解释问题。
    pub has_stats: bool,
    /// 累计 turn 数。只用于诊断展示。
    pub turns: u64,
    /// 权限预设（read-only / ask …）。只用于诊断展示。
    pub preset: Option<String>,
}

impl Obs {
    pub fn phase(&self) -> Phase {
        // 工具在跑 / plan 在跑，都是"确实在干活"，压过模型侧的判断。
        if self.pending_calls > 0 || self.plan_active {
            return Phase::Working;
        }
        if !self.open_step {
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

    /// 头巾上的词。v1 直接取标题前几个字——DSH 的 title 是"这一轮在干什么"
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

    let pending_calls = stats
        .and_then(|x| x.get("pendingCalls"))
        .and_then(|x| x.as_object())
        .map(|m| m.len())
        .unwrap_or(0);

    // headless 一次性会话在投影里只有 title，没有 sessionListMetadata，
    // 于是没有 lastPromptAt。那种情况下用文件 mtime 兜底：
    // 至少能说"这个会话最近被动过"，而不是让它永远落在活跃窗口外、彻底看不见。
    let last_prompt_at = match meta
        .and_then(|m| m.get("lastPromptAt"))
        .and_then(|x| x.as_i64())
    {
        Some(t) if t > 0 => t,
        _ => mtime_ms,
    };

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
        pending_calls,
        plan_active: row(rows, "plan")
            .and_then(|p| p.get("active"))
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        last_prompt_at,
        has_stats: stats.is_some(),
        turns: stats
            .and_then(|x| x.get("turns"))
            .and_then(|x| x.as_i64())
            .unwrap_or(0)
            .max(0) as u64,
        preset: row(rows, "permissions")
            .and_then(|p| p.get("preset"))
            .and_then(|x| x.as_str())
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
            // 这是所有信号里最不容易误判的一个。
            if o.last_prompt_at > 0 && o.last_prompt_at != t.last_prompt_at {
                t.last_prompt_at = o.last_prompt_at;
                out.push(payload(o, "UserPromptSubmit"));
                sent = true;
                t.stopped = false;
                t.idle_streak = 0;
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
            pending_calls: pending,
            plan_active: false,
            // 必须是"刚刚"。reconcile 会把超出 ACTIVE_WINDOW_MS 的 idle 会话滤掉，
            // 写成固定的小数字（比如 1000）等于断言"1970 年那次提问还在活跃"。
            last_prompt_at: t0(),
            has_stats: true,
            turns: 0,
            preset: None,
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
            "turns": 4, "steps": 4, "lastTurn": 4, "openStep": null, "pendingCalls": {} } },
          "title": { "ver": 1, "seq": 216, "val": "Hi Who am i" },
          "sessionListMetadata": { "ver": 1, "seq": 216, "val": { "blank": false, "lastPromptAt": 1788150298325 } },
          "plan": { "ver": 2, "seq": 216, "val": { "active": false } },
          "permissions": { "ver": 1, "seq": 216, "val": { "preset": "read-only", "sandbox": "read-only", "approval": "ask" } }
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
