//! 从磁盘读"别的 agent 的会话"。
//!
//! 为什么需要它（2026-11-10，用户说「现在的会话太乱了」）：
//! DeepSeek Harness 有会话概念，我们能列出来；WorkBuddy 其实也有，只是我们以前
//! **只用 hook 事件**——而状态机里的会话十几分钟就过期了。于是看板上 WorkBuddy 只有
//! "正在跑的那一条"，没有"我这周用过哪些会话"。用户看到的就是一堆平铺的卡片，
//! 分不清哪个来自哪个平台、哪些是还在的。
//!
//! 它们的会话落盘形状几乎一样：`<家目录>/projects/<项目 slug>/<会话 uuid>.jsonl`，
//! 一行一个 JSON。所以这一层只做一件事：**把那些文件读成"一条会话的摘要"**。
//!
//! 三条自觉的边界：
//!
//! 1. **只读**。这些文件是别的产品的数据，我们只在内存里留摘要（标题 / 最后一轮 /
//!    轮数 / 目录），不写、不复制、不落盘。
//! 2. **只读摘要，不读全文进内存**：整份文件按行解析，但只留最后需要的那几段；
//!    目录出去之前照 S6 的老规矩过一遍 `public_cwd`（只给最后一段）。
//! 3. **不能往里说话**。DSH 有 `headless --session-id` 这个一等公民入口，
//!    WorkBuddy / Claude Code 在本机没有任何 CLI（2026-11-10 查遍 `PATH` 与
//!    `~/.workbuddy/binaries`），所以这两家的会话是**只能看**的。这一点必须由
//!    界面说出来，不能靠用户点了才发现。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 一句话最多留多长。和 `say.rs` / `dsh.rs` 同一个量级：
/// 看板一行放不下更多，留长了只是把内存和 DOM 撑大。
const MAX_TEXT: usize = 400;

/// 标题长度。看板这一行还要放徽标和时间。
const MAX_TITLE: usize = 80;

/// 只认最近这么多天有动静的会话。
///
/// 为什么要有这个窗口：`projects/` 下是**全部历史**（本机已经上百个文件），
/// 全列出来是"另一个收纳问题"，而且每次轮询都要 stat 一遍。
/// 用户要的是"我最近在哪儿干过活"，不是档案室。
const KEEP_DAYS: i64 = 7;

/// 每个平台最多显示多少条。超出的部分不是被删了，只是这一屏不列。
const MAX_PER_AGENT: usize = 20;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 一条会话在看板上要显示的东西。
///
/// 刻意**不带完整 cwd** 的那一半语义：`cwd` 这里是全路径，出门前由调用方过
/// `public_cwd`（S6 的 SEC-09 分层：快照里不给完整 cwd）。留着全路径是为了
/// 「复制路径」——那件事只能由宿主做，不能让页面传路径进来。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    /// 平台 id：`workbuddy` / `claude-code`。前端拿它做一级分组。
    pub agent: String,
    pub id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub last_prompt: Option<String>,
    pub last_reply: Option<String>,
    /// 文件最后一次被写入的时刻（ms）。
    ///
    /// 用 mtime 而不是转录里的 `timestamp`：后者两家格式还不一样（WorkBuddy 是
    /// 毫秒数，Claude Code 是 ISO 字符串），而"这份文件最后一次动是什么时候"
    /// 本来就是同一个问题，且**不需要解析任何时间格式**。
    pub updated_ms: i64,
    /// 用户问了几次。只数真正的提问（见 `extract_prompt`）。
    pub turns: u64,
}

// ------------------------------------------------------------
// 去哪儿找
// ------------------------------------------------------------

/// 本机哪些 agent 把会话落成了"一会话一文件"的形状。
///
/// 路径直接从环境变量拼，不去猜别的位置：目录不存在就整段跳过——**没装就是没装**，
/// 不是错误（和 `say.rs::locate` 同一个口径）。
pub fn roots() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    else {
        return Vec::new();
    };
    [
        ("workbuddy", home.join(".workbuddy").join("projects")),
        ("claude-code", home.join(".claude").join("projects")),
    ]
    .into_iter()
    .filter(|(_, p)| p.is_dir())
    .collect()
}

// ------------------------------------------------------------
// 解析一份转录
// ------------------------------------------------------------

/// 从一份 transcript 里抽出看板要的那几样。纯函数，方便拿真样本做测试。
///
/// 两家的**行**形状不同（这是实测的，不是猜的）：
///
/// ```text
/// WorkBuddy : {"type":"message","role":"user","content":[{"type":"input_text","text":"…"}],"cwd":"…"}
/// Claude    : {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
/// ```
///
/// 所以 `message_of` 把两种都归一成 `(role, blocks)`，后面只管 blocks。
pub fn parse(agent: &str, id: &str, raw: &str, updated_ms: i64) -> Option<Card> {
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    let mut last_prompt: Option<String> = None;
    let mut last_reply: Option<String> = None;
    let mut turns = 0u64;
    let mut saw_anything = false;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // 半行 / 不认识的行都跳过：这是别的产品的内部格式
        };
        if let Some(p) = v.get("cwd").and_then(|x| x.as_str()) {
            cwd = Some(p.to_string());
        }
        let Some((role, blocks)) = message_of(&v) else {
            continue;
        };
        let text = join_text(blocks);
        if text.trim().is_empty() {
            continue;
        }
        saw_anything = true;
        match role.as_str() {
            "user" => {
                // 只数"用户真的说了话"的那几条：工具结果也以 user 身份回灌，
                // 把它们算成一轮，界面上的"轮"就成了"工具调用次数"。
                if let Some(q) = extract_prompt(&text) {
                    turns += 1;
                    if title.is_none() {
                        title = Some(q.clone());
                    }
                    last_prompt = Some(q);
                }
            }
            "assistant" => {
                last_reply = Some(clip(&text, MAX_TEXT));
            }
            _ => {}
        }
    }

    if !saw_anything {
        return None; // 空文件 / 只有元信息：不值得占一行
    }
    Some(Card {
        agent: agent.to_string(),
        id: id.to_string(),
        title: title.map(|t| one_line(&t, MAX_TITLE)),
        cwd,
        last_prompt,
        last_reply,
        updated_ms,
        turns,
    })
}

/// 把两种行形状归一成 `(role, content-blocks)`。
fn message_of(v: &serde_json::Value) -> Option<(String, &serde_json::Value)> {
    let ty = v.get("type").and_then(|x| x.as_str())?;
    if ty == "message" {
        // WorkBuddy / CodeBuddy：role 和 content 都在顶层
        let role = v.get("role").and_then(|x| x.as_str())?;
        return Some((role.to_string(), v.get("content")?));
    }
    if ty == "user" || ty == "assistant" {
        // Claude Code：真正的消息裹在 `message` 里
        let m = v.get("message")?;
        let role = m.get("role").and_then(|x| x.as_str()).unwrap_or(ty);
        return Some((role.to_string(), m.get("content")?));
    }
    None
}

/// 把一个 content 数组里的文字拼起来。工具调用块没有 `text`，自然被忽略。
fn join_text(blocks: &serde_json::Value) -> String {
    if let Some(s) = blocks.as_str() {
        return s.to_string();
    }
    let Some(arr) = blocks.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for b in arr {
        if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
            out.push_str(t);
            out.push('\n');
        }
    }
    out
}

/// 从一条 user 消息里挖出"用户真说的那句话"。
///
/// WorkBuddy 会把系统提示、IDE 上下文、身份文件一整套塞进同一条 user 消息里
/// （开头那一大坨 `<system-reminder>`，实测 9000 多字符），真实提问裹在
/// `<user_query>` 里。不挖出来的后果很具体：看板上**每条会话的标题都是同一段
/// 系统提示**，用户看到一整列一模一样的东西——这正是"太乱了"的一部分。
fn extract_prompt(raw: &str) -> Option<String> {
    let body = match raw.find("<user_query>") {
        Some(at) => {
            let after = &raw[at + "<user_query>".len()..];
            after.split("</user_query>").next().unwrap_or(after).to_string()
        }
        None => strip_reminders(raw),
    };
    let body = strip_wrappers(&body);
    let flat = one_line(&body, MAX_TEXT);
    if flat.is_empty() {
        None
    } else {
        Some(flat)
    }
}

/// 把所有 `<system-reminder …>…</system-reminder>` 整段删掉。
///
/// 为什么要循环：一条消息里可能有好几段（用户上下文一段、当前时间一段……），
/// 而且**只删不嵌套**——真遇到嵌套就退化成"删到最后一个闭合标签"，最坏是把正文
/// 一起吃掉了，但那段正文后面还有 `<user_query>` 那条路兜着。
fn strip_reminders(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    const OPEN: &str = "<system-reminder";
    const CLOSE: &str = "</system-reminder>";
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i]);
        match rest[i..].find(CLOSE) {
            Some(j) => rest = &rest[i + j + CLOSE.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 去掉一层包裹标签（`<user_query>` 已单独处理；这里清掉别家用的几对）。
fn strip_wrappers(s: &str) -> String {
    let mut t = s.trim().to_string();
    for (open, close) in [("<user_context>", "</user_context>"), ("<user_message>", "</user_message>")] {
        if let (Some(a), Some(b)) = (t.find(open), t.rfind(close)) {
            if b > a {
                t = t[a + open.len()..b].trim().to_string();
            }
        }
    }
    t
}

/// 压平空白 + 截断。标题和正文共用，区别只在长度。
fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    clip(&flat, max)
}

fn clip(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = flat.chars().count();
    if n <= max {
        return flat;
    }
    let cut: String = flat.chars().take(max).collect();
    format!("{cut}…")
}

// ------------------------------------------------------------
// 扫盘（带缓存）
// ------------------------------------------------------------

/// 扫盘器。为什么要缓存：看板 1s 一问，而一份转录动辄几百 KB、几十个文件，
/// 每秒全量重解析就是"看板一开风扇就转"。缓存键是 `(mtime, size)`——
/// 文件没动就复用上次的解析结果。
pub struct Scanner {
    cache: HashMap<PathBuf, Entry>,
    /// `agent/id` → 这条会话的**完整目录**。只给「复制路径」用，不出进程。
    paths: HashMap<String, String>,
}

struct Entry {
    mtime_ms: i64,
    size: u64,
    card: Option<Card>,
}

impl Scanner {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
            paths: HashMap::new(),
        }
    }

    /// 「复制路径」用的完整目录。查不到就是查不到（页面上会显示"无路径"）。
    pub fn full_cwd(&self, key: &str) -> Option<String> {
        self.paths.get(key).cloned()
    }

    /// 扫一轮。`now_ms` 由调用方给（便于测试钉住时间）。
    pub fn poll(&mut self, now_ms: i64) -> Vec<Card> {
        let cutoff = now_ms - KEEP_DAYS * DAY_MS;
        let mut out = Vec::new();
        for (agent, root) in roots() {
            out.extend(self.one_agent(agent, &root, cutoff));
        }
        // 新的排前面：用户找的是"我刚才那条"，不是字母序
        out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.id.cmp(&b.id)));
        // 每个平台各自截断（不能对整体截，否则一个活跃平台会把另一个挤没）
        let mut per: HashMap<String, usize> = HashMap::new();
        out.retain(|c| {
            let n = per.entry(c.agent.clone()).or_insert(0);
            *n += 1;
            *n <= MAX_PER_AGENT
        });
        self.paths.retain(|k, _| out.iter().any(|c| format!("{}/{}", c.agent, c.id) == *k));
        out
    }

    fn one_agent(&mut self, agent: &str, root: &Path, cutoff: i64) -> Vec<Card> {
        let mut out = Vec::new();
        let Some(projects) = std::fs::read_dir(root).ok() else {
            return out;
        };
        for project in projects.flatten() {
            let dir = project.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&dir) else {
                continue;
            };
            for f in files.flatten() {
                let path = f.path();
                if path.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let Some(card) = self.one_file(agent, &path, cutoff) else {
                    continue;
                };
                if let Some(full) = card.cwd.clone() {
                    self.paths.insert(format!("{agent}/{}", card.id), full);
                }
                out.push(card);
            }
        }
        out
    }

    fn one_file(&mut self, agent: &str, path: &Path, cutoff: i64) -> Option<Card> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)?;
        if mtime_ms < cutoff {
            return None;
        }
        let size = meta.len();
        if let Some(e) = self.cache.get(path) {
            if e.mtime_ms == mtime_ms && e.size == size {
                return e.card.clone();
            }
        }
        let raw = std::fs::read_to_string(path).unwrap_or_default();
        // 会话 id 就是文件名（两家都一样）：转录内容里那串 `sessionId` 只在个别行出现，
        // 而 hook 上报的 `session_id` 与文件名是同一个值——两边靠它对上号。
        let id = path.file_stem()?.to_string_lossy().to_string();
        let card = parse(agent, &id, &raw, mtime_ms);
        self.cache.insert(
            path.to_path_buf(),
            Entry {
                mtime_ms,
                size,
                card: card.clone(),
            },
        );
        card
    }
}

impl Default for Scanner {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 形状照抄真样本（2026-11-10 从 `~/.workbuddy/projects/…jsonl` 抓的）。
    fn wb_line(role: &str, text: &str) -> String {
        let kind = if role == "user" { "input_text" } else { "output_text" };
        format!(
            r#"{{"type":"message","role":"{role}","cwd":"C:\\work\\proj","timestamp":1,"content":[{{"type":"{kind}","text":{}}}]}}"#,
            serde_json::to_string(text).unwrap()
        )
    }

    #[test]
    fn workbuddy_transcript_becomes_a_card() {
        let raw = [
            r#"{"type":"session-meta","sessionId":"s1"}"#.to_string(),
            wb_line("user", "帮我把看板改成两级"),
            wb_line("assistant", "好，我先把数据源理一遍。"),
        ]
        .join("\n");
        let c = parse("workbuddy", "s1", &raw, 1234).unwrap();
        assert_eq!(c.agent, "workbuddy");
        assert_eq!(c.id, "s1");
        assert_eq!(c.title.as_deref(), Some("帮我把看板改成两级"));
        assert_eq!(c.last_prompt.as_deref(), Some("帮我把看板改成两级"));
        assert_eq!(c.last_reply.as_deref(), Some("好，我先把数据源理一遍。"));
        assert_eq!(c.cwd.as_deref(), Some("C:\\work\\proj"));
        assert_eq!(c.turns, 1);
        assert_eq!(c.updated_ms, 1234);
    }

    // 这条是看板"太乱了"的一半原因：不挖 `<user_query>`，每条会话的标题都是同一段
    // 系统提示，一列长得一模一样的东西。
    #[test]
    fn the_real_question_is_dug_out_of_the_system_reminder() {
        let text = "<system-reminder data-role=\"user-context\">\nOS: win32\n很多很多行\n</system-reminder>\n\n<user_query>现在的会话太乱了</user_query>";
        let c = parse("workbuddy", "s", &wb_line("user", text), 0).unwrap();
        assert_eq!(c.title.as_deref(), Some("现在的会话太乱了"));
        assert!(!c.title.unwrap().contains("system-reminder"));
    }

    #[test]
    fn a_user_message_without_user_query_still_works() {
        let text = "<system-reminder>\n上下文\n</system-reminder>\n跑一下测试";
        let c = parse("workbuddy", "s", &wb_line("user", text), 0).unwrap();
        assert_eq!(c.title.as_deref(), Some("跑一下测试"));
    }

    // Claude Code 是另一种行形状（真正的内容裹在 message 里）。看板不区分来源，
    // 所以这一层必须同时认两种，否则 Claude 那组永远是空的。
    #[test]
    fn claude_style_lines_are_understood_too() {
        let raw = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"修一下签名脚本"}]},"cwd":"D:\\work"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"看完了，是路径拼接的问题。"}]}}"#;
        let c = parse("claude-code", "c1", raw, 7).unwrap();
        assert_eq!(c.title.as_deref(), Some("修一下签名脚本"));
        assert_eq!(c.last_reply.as_deref(), Some("看完了，是路径拼接的问题。"));
        assert_eq!(c.turns, 1);
    }

    // 工具结果也以 user 身份回灌。把它算成一轮，界面上的"轮"就成了"工具调用次数"。
    #[test]
    fn tool_results_are_not_counted_as_rounds() {
        let tool = r#"{"type":"message","role":"user","content":[{"type":"tool_result","content":"一堆输出"}]}"#;
        let raw = [wb_line("user", "第一句"), tool.to_string(), wb_line("user", "第二句")].join("\n");
        let c = parse("workbuddy", "s", &raw, 0).unwrap();
        assert_eq!(c.turns, 2, "两次提问，不是三次");
        assert_eq!(c.last_prompt.as_deref(), Some("第二句"));
    }

    #[test]
    fn empty_or_meta_only_files_are_dropped() {
        assert!(parse("workbuddy", "s", "", 0).is_none());
        assert!(parse("workbuddy", "s", r#"{"type":"session-meta","sessionId":"x"}"#, 0).is_none());
        assert!(parse("workbuddy", "s", "这不是 json", 0).is_none());
    }

    #[test]
    fn long_text_is_clipped_with_an_ellipsis() {
        let c = parse("workbuddy", "s", &wb_line("user", &"字".repeat(1000)), 0).unwrap();
        let t = c.title.unwrap();
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= MAX_TITLE + 1);
        assert_eq!(c.last_prompt.unwrap().chars().count(), MAX_TEXT + 1);
    }

    #[test]
    fn strip_reminders_keeps_the_text_between_blocks() {
        let s = "<system-reminder>a</system-reminder>中间<system-reminder>b</system-reminder>尾巴";
        assert_eq!(strip_reminders(s), "中间尾巴");
    }

    // 缓存的意义是"文件没动就别再解析一遍"。这条同时钉住"文件动了必须重解析"。
    #[test]
    fn scanner_reuses_the_parse_until_the_file_changes() {
        let dir = std::env::temp_dir().join(format!("clawd-agents-{}", std::process::id()));
        let sub = dir.join("proj");
        std::fs::create_dir_all(&sub).unwrap();
        let f = sub.join("s1.jsonl");
        std::fs::write(&f, wb_line("user", "第一句")).unwrap();

        let mut sc = Scanner::new();
        let first = sc.one_file("workbuddy", &f, 0).unwrap();
        assert_eq!(first.turns, 1);
        // 再读一次：走缓存（内容一样）
        let again = sc.one_file("workbuddy", &f, 0).unwrap();
        assert_eq!(again.turns, 1);

        std::fs::write(&f, format!("{}\n{}", wb_line("user", "第一句"), wb_line("user", "第二句"))).unwrap();
        let after = sc.one_file("workbuddy", &f, 0).unwrap();
        assert_eq!(after.turns, 2, "文件变了必须重解析");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn old_files_are_filtered_by_the_window() {
        let dir = std::env::temp_dir().join(format!("clawd-agents-old-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s1.jsonl");
        std::fs::write(&f, wb_line("user", "很久以前")).unwrap();
        let mut sc = Scanner::new();
        // cutoff 设到未来：这份文件的 mtime 一定早于它
        assert!(sc.one_file("workbuddy", &f, i64::MAX / 2).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
