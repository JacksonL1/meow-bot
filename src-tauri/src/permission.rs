// ============================================================
// S5-1  权限请求的等待与回写（本项目的"裁决台"）
//
// 生命周期只有一种：
//   POST /permission 进来 → 挂起这个 HTTP 响应 → 弹气泡 → 用户点 → 写回响应 → 结束
//
// 三条红线（来自 SECURITY.md 的 S5 小节）：
//   1. 任何"没拿到明确决定"的结局都返回 204，让 Claude Code 回落到它自己的原生提示。
//      **不要 deny** —— deny 会让工具静默失败，用户还以为自己批准过。
//   2. 请求与响应强绑定：自增 requestId + 内存 Map，已结束的请求不允许再被响应一次。
//   3. 决定只能是 allow 或 deny 两种，"其他"一律按 204 处理。
//
// 与当年 Electron 版（JS，已删）的一处已知差异：JS 侧靠 `res.on("close")`
// 能感知"对端掐断"，tiny_http 没有这个事件，所以连接被对端放弃时只能等超时兜底
// （气泡会晚 2 分钟才消失）。结论不变——仍然是 204，仍然不替用户做决定。
// ============================================================
use crate::risk::{assess_risk, Risk};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

// 2 分钟没人点就回落，比 hook 侧的 timeout（600s）早得多。
// 可以用环境变量压低——只为了回归脚本能真的测到"超时回落 204"。
pub fn timeout_ms() -> u64 {
    std::env::var("CLAWD_PERMISSION_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(120_000)
}

// 入参来自网络，全部限长（气泡 UI 只有这么大，超了也显示不下）
const MAX_TOOL_NAME: usize = 64;
const MAX_SESSION_ID: usize = 64;
const MAX_CWD: usize = 1024;
const MAX_COMMAND: usize = 600;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Allow,
    Deny,
    /// 超时 / 用户关掉气泡 / 退出 / 对端掐断 —— 一律"我不做决定"
    NoDecision,
}

#[derive(Clone, Serialize, Debug)]
pub struct PendingView {
    pub id: u64,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub command: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub risk: Risk,
    pub queued: usize,
}

struct Entry {
    view: PendingView,
    tx: Sender<Outcome>,
}

pub struct Center {
    pending: Mutex<HashMap<u64, Entry>>,
    next_id: AtomicU64,
    /// 通知外层"该弹气泡了 / 该收气泡了"。用普通回调而不是直接依赖 tauri，
    /// 这样裁决台本身可以在单测里跑。
    notify: Box<dyn Fn(Notify) + Send + Sync>,
}

pub enum Notify {
    Show(PendingView),
    Resolved,
}

fn s(v: Option<&serde_json::Value>, max: usize) -> Option<String> {
    v.and_then(|x| x.as_str()).map(|x| x.chars().take(max).collect())
}

/// tool_input 的形状每种工具都不一样（Bash 是 {command}，Edit 是 {file_path, ...}），
/// 这里只把它收敛成一个可显示的字符串，不做语义判断。
fn summarize_input(input: Option<&serde_json::Value>) -> String {
    let Some(input) = input else { return String::new() };
    if !input.is_object() {
        return String::new();
    }
    for key in ["command", "file_path", "pattern", "url", "description"] {
        if let Some(v) = input.get(key).and_then(|x| x.as_str()) {
            return v.to_string();
        }
    }
    // 兜底：把第一个字符串字段拿出来，总比什么都不显示强
    if let Some(obj) = input.as_object() {
        for (_, v) in obj {
            if let Some(sv) = v.as_str() {
                if !sv.is_empty() {
                    return sv.to_string();
                }
            }
        }
    }
    String::new()
}

impl Center {
    pub fn new(notify: Box<dyn Fn(Notify) + Send + Sync>) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            notify,
        }
    }

    pub fn size(&self) -> usize {
        self.pending.lock().map(|p| p.len()).unwrap_or(0)
    }

    /// 取一条还挂着的请求的展示信息（排队下一条时要用）。
    pub fn view_of(&self, id: u64) -> Option<PendingView> {
        let p = self.pending.lock().ok()?;
        p.get(&id).map(|e| e.view.clone())
    }

    /// 收到一条请求：登记 + 弹气泡，返回一个只属于这条请求的决定通道。
    ///
    /// 调用方（HTTP 线程）拿着返回的 Receiver 阻塞等待，**不要**在这里等——
    /// 否则 tiny_http 的 accept 循环会被一条没人点的请求卡死，后面的请求全排队。
    pub fn create(&self, payload: &serde_json::Value) -> (u64, Receiver<Outcome>) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let tool_name = s(payload.get("tool_name"), MAX_TOOL_NAME).unwrap_or_else(|| "Unknown".into());
        let command: String = summarize_input(payload.get("tool_input"))
            .chars()
            .take(MAX_COMMAND)
            .collect();
        let session_id = s(payload.get("session_id"), MAX_SESSION_ID);
        let cwd = s(payload.get("cwd"), MAX_CWD);

        // 风险评级在创建时就算好，和命令一起锁定——渲染层拿到的永远是同一份快照。
        // 它只进 UI，不参与任何决策：下面每一条结局都不受它影响。
        let risk = assess_risk(&tool_name, &command, cwd.as_deref().unwrap_or(""));

        let (tx, rx) = channel();
        let view = PendingView {
            id,
            tool_name,
            command,
            session_id,
            cwd,
            risk,
            queued: 0,
        };

        let queued = {
            let mut p = self.pending.lock().expect("pending 锁坏了");
            let q = p.len();
            p.insert(id, Entry { view: view.clone(), tx });
            q
        };

        let mut view = view;
        view.queued = queued;
        (self.notify)(Notify::Show(view));
        (id, rx)
    }

    /// 给某个 id 一个决定。返回是否真的落到了还挂着的请求上。
    ///
    /// 这是**唯一**的出口：用户点击、超时、退出全走这里，保证不会漏掉响应、
    /// 也不会响应两次（第二次找不到条目就返回 false）。
    pub fn settle(&self, id: u64, outcome: Outcome) -> bool {
        let entry = {
            let mut p = self.pending.lock().expect("pending 锁坏了");
            p.remove(&id)
        };
        let Some(entry) = entry else { return false };
        let _ = entry.tx.send(outcome);
        (self.notify)(Notify::Resolved);
        true
    }

    pub fn decide(&self, id: u64, decision: &str) -> bool {
        let outcome = match decision {
            "allow" => Outcome::Allow,
            "deny" => Outcome::Deny,
            _ => Outcome::NoDecision,
        };
        self.settle(id, outcome)
    }

    /// 有条目要清干净，否则进程退不出去 / 气泡残留。
    pub fn dispose(&self) {
        let ids: Vec<u64> = {
            let p = self.pending.lock().expect("pending 锁坏了");
            p.keys().copied().collect()
        };
        for id in ids {
            self.settle(id, Outcome::NoDecision);
        }
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_millis(timeout_ms())
    }
}

/// allow / deny 的响应体。**与 Claude Code 的 HTTP hook 契约一致**：
/// 不回 204 就表示"我做了决定"，那就必须给 hookSpecificOutput。
pub fn decision_body(outcome: Outcome) -> Option<String> {
    match outcome {
        Outcome::Allow => Some(
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
                .to_string(),
        ),
        Outcome::Deny => Some(
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"用户在桌宠气泡里拒绝了这个操作"}}}"#
                .to_string(),
        ),
        Outcome::NoDecision => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    fn center() -> (Arc<Center>, Arc<AtomicUsize>) {
        let shows = Arc::new(AtomicUsize::new(0));
        let s2 = shows.clone();
        let c = Center::new(Box::new(move |n| {
            if matches!(n, Notify::Show(_)) {
                s2.fetch_add(1, Ordering::SeqCst);
            }
        }));
        (Arc::new(c), shows)
    }

    #[test]
    fn decision_is_delivered_exactly_once() {
        let (c, _) = center();
        let payload = serde_json::json!({
            "tool_name": "Bash",
            "tool_input": { "command": "rm -rf /" },
            "session_id": "s1"
        });
        let (id, rx) = c.create(&payload);
        assert_eq!(c.size(), 1);
        assert!(c.decide(id, "allow"));
        assert_eq!(rx.recv().unwrap(), Outcome::Allow);
        // 第二次点击、或超时兜底，都必须落空
        assert!(!c.decide(id, "deny"));
        assert!(!c.settle(id, Outcome::NoDecision));
    }

    #[test]
    fn timeout_is_not_a_deny() {
        // 这条是硬约束 5 的护栏：没拿到决定就是"不做决定"，不是"拒绝"
        assert!(decision_body(Outcome::NoDecision).is_none());
        assert!(decision_body(Outcome::Deny).unwrap().contains("\"deny\""));
    }

    #[test]
    fn risk_is_snapshotted_into_the_view() {
        let (c, _) = center();
        let payload = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": "rm -rf /" } });
        let (id, _rx) = c.create(&payload);
        let p = c.pending.lock().unwrap();
        let v = &p.get(&id).unwrap().view;
        assert_eq!(v.risk.label, "极高");
        assert_eq!(v.command, "rm -rf /");
    }

    #[test]
    fn dispose_settles_everything() {
        let (c, _) = center();
        let p = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } });
        let (_id1, rx1) = c.create(&p);
        let (_id2, rx2) = c.create(&p);
        c.dispose();
        assert_eq!(rx1.recv().unwrap(), Outcome::NoDecision);
        assert_eq!(rx2.recv().unwrap(), Outcome::NoDecision);
        assert_eq!(c.size(), 0);
    }
}
