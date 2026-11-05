//! 把一句话送进 DSH。
//!
//! 机制不是我们发明的：`dsh --profile headless [--session-id <id>] -` 就是这个产品
//! 自带的「接着说话」入口（`dsh headless --help` 的原话：
//! `--session-id <id>  adopt the persisted Session with this id`）。
//!
//! 三条硬规矩，都是踩过才知道的（2026-11-05 实测）：
//!
//! 1. **任务走 stdin（参数写 `-`），不走 argv。**
//!    argv 里一句话可能以 `-` 开头（用户完全可能发「--help」「-1」），
//!    那会被 commander 当成 flag；而转义规则在 Windows 上又是一门玄学。
//!    stdin 两条都躲开了。
//!
//! 2. **cwd 必须是这条会话自己的目录。**
//!    错一个目录 dsh 直接拒：`session "…" was recorded in "…", not "…"`。
//!    会话是按工作目录分桶存的，id 只在桶内唯一。
//!
//! 3. **不是所有会话都能续。**
//!    `assertAdoptable()` 里有一条硬闸：记录过 agentPreset 的会话（桌面端 / 网页端
//!    建的）一律不接受，因为一次性 runner 组不出那套 preset。这不是 bug，是设计——
//!    所以我们**不去绕过它**，而是把原因翻译成人话告诉用户（见 explain）。
//!
//! 为什么不用 `dsh web` 的 HTTP 接口：那要求用户先把 web 开在某个端口、我们再找到
//! 地址和鉴权；headless 是一等公民入口，不依赖任何在跑的服务。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 一句话最多多长。不是安全边界（argv / stdin 都扛得住更长的），
/// 是"防止误粘一整篇文档把这一轮顶爆"的实用上限。
pub const MAX_TEXT_CHARS: usize = 8000;

/// 答案截断长度。必须和 dsh.rs 的 `MAX_REPLY_CHARS` 同一个数——
/// 看板上"从投影读到的回复"和"从这一次运行捡到的回复"会长得一样。
const MAX_REPLY_CHARS: usize = 400;

/// stderr 只留尾部这么多字节。DSH 的报错是**最后一行**，前面全是启动日志。
const TAIL_BYTES: usize = 4096;

/// 一次运行最长等多久。连 reasoning 模型带一堆工具也就几分钟，
/// 45 分钟还不结束只可能是卡死了（比如权限请求没人应答，而这里没有气泡可弹）。
const MAX_RUN: Duration = Duration::from_secs(45 * 60);

const POLL: Duration = Duration::from_millis(200);

// ------------------------------------------------------------
// 找 dsh
// ------------------------------------------------------------

/// 启动 dsh 需要的两样东西：一个 node，和那个包的 bin.js。
///
/// 为什么不直接 `Command::new("dsh")`：Windows 上 `dsh` 是 `.cmd` 批处理，
/// CreateProcess 不执行批处理，Rust 的 Command 也不会替你套一层 `cmd /C`
/// （套了反而又要重新处理一遍引号）。直接调 node 跑 bin.js 是同一件事，
/// 但没有任何 shell 参与。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launcher {
    pub node: PathBuf,
    pub bin: PathBuf,
}

fn bin_under(dir: &Path) -> PathBuf {
    dir.join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

/// 从 PATH 里找。找不到就返回 None——**没装 DSH 不是错误**，只是这个功能不可用。
pub fn locate() -> Option<Launcher> {
    let path = std::env::var_os("PATH")?;
    locate_in(std::env::split_paths(&path))
}

/// 纯函数版，方便拿假目录做测试。
pub fn locate_in<I: IntoIterator<Item = PathBuf>>(dirs: I) -> Option<Launcher> {
    for dir in dirs {
        let bin = bin_under(&dir);
        if !bin.is_file() {
            continue;
        }
        // 同目录的 node.exe 优先：nvm4w 是按版本装的，PATH 上的 `node` 可能是另一个
        // 版本，而 dsh 的依赖是跟它自己那个版本装的。用错版本会在 require 阶段炸。
        let sibling = dir.join("node.exe");
        let node = if sibling.is_file() {
            sibling
        } else {
            PathBuf::from("node")
        };
        return Some(Launcher { node, bin });
    }
    None
}

// ------------------------------------------------------------
// 默认模型
// ------------------------------------------------------------

/// 从 `dsh --profile headless --dump-config` 的输出里挑出 `agent-default-model`。
///
/// 为什么需要这条路：`dsh headless` 建的会话**不在投影里写 `modelSelection`**
/// （那一行由桌面端 / 网页端写），于是看板上"用哪个模型"对它们永远是空的。
/// 而"这条 profile 默认用哪个模型"是确定可查的——`--dump-config` 就是配置的
/// 权威展开（实测 0.24 秒），它比我们自己去读 `cordis.patch.yml` 可靠得多：
/// 用户可以在多层 patch 里覆盖，展开后的才是生效值。
///
/// 为什么不引 YAML 依赖：这里只需要三条 key，而多一个解析库就多一份"上游改个
/// 缩进我们就崩"的面积。认不出就返回 None——那只是看板上少一行字。
pub fn parse_default_model(dump: &str) -> Option<(String, String)> {
    let mut in_block = false;
    let mut provider = None;
    let mut model = None;
    for line in dump.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("- id:") {
            if in_block {
                break; // 下一块开始了，本块到此为止
            }
            in_block = rest.trim() == "agent-default-model";
            continue;
        }
        if !in_block {
            continue;
        }
        if let Some(v) = yaml_field(t, "provider:") {
            provider = Some(v);
        }
        if let Some(v) = yaml_field(t, "model:") {
            model = Some(v);
        }
    }
    Some((provider?, model?))
}

/// 取一行 `key: value` 的 value（去掉引号和空值）。只为上面那个函数服务。
fn yaml_field(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim();
    let v = rest.trim_matches(|c| c == '\'' || c == '"').trim();
    if v.is_empty() || v == "null" || v == "~" {
        None
    } else {
        Some(v.to_string())
    }
}

/// 真跑一次 `--dump-config` 拿默认模型。找不到 node / 跑挂了都只是 None。
///
/// 用 `.output()` 而不是自己接管道：它内部会把三条流都读干，而这里是
/// "活着 -> 打印几十 KB YAML -> 退出"的一次性调用，不存在需要边跑边处理的场景。
pub fn default_model(l: &Launcher) -> Option<(String, String)> {
    let out = Command::new(&l.node)
        .arg(&l.bin)
        .arg("--profile")
        .arg("headless")
        .arg("--dump-config")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_default_model(&String::from_utf8_lossy(&out.stdout))
}

// ------------------------------------------------------------
// 拼命令
// ------------------------------------------------------------

/// 拼一条命令。`id` 为 None = 开一条新会话。
///
/// 抽成独立函数是为了能断言"参数到底长什么样"——发送失败时最想知道的就是这个，
/// 而真跑一次的代价是 8 秒 + 一次真实的模型调用。
///
/// `--json` 不是可选的（见文件头）：没有它，我们既不知道新会话的 id，
/// 也拿不到答案；而这两样恰好是"发了之后有反馈"的全部内容。
pub fn command(l: &Launcher, id: Option<&str>, cwd: &str, text: &str) -> Command {
    let mut c = Command::new(&l.node);
    c.arg(&l.bin)
        .arg("--profile")
        .arg("headless")
        .arg("--json");
    if let Some(id) = id {
        c.arg("--session-id").arg(id);
    }
    // `-` = 任务从 stdin 读（规矩 1）。
    c.arg("-");
    c.current_dir(cwd)
        .stdin(Stdio::piped())
        // 答案走 stdout，**必须接住**：headless 建的会话在投影里没有
        // `turnOutline`（那个由桌面/网页端写），所以这一行 JSON 是我们
        // 唯一能知道"它回了什么"的地方。
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let _ = text; // 文字走 stdin，不进 argv
    c
}

/// 一次运行里我们从 `--json` 流里捡出来的东西。
///
/// 为什么值得为它开一个共享结构：这三样是"发出去之后用户想知道的一切"，
/// 而它们的到达时刻各不相同——id 在第一秒，文字一路流，答案在最后。
#[derive(Clone, Debug, Default)]
pub struct Captured {
    /// headless 建的新会话 id。`--json` 的第一行就给。
    pub session_id: Option<String>,
    /// `final` 事件里的完整答案（权威版本）。
    pub final_text: String,
    /// 流式拼出来的文字，`final` 缺席时兜底。
    pub streamed: String,
}

impl Captured {
    /// 给用户看的那一段。截断和 dsh.rs 用同一个上限，
    /// 保证"桌宠这一次的答案"和"从投影读到的回复"在看板上长得一样。
    pub fn reply(&self) -> Option<String> {
        let raw = if self.final_text.trim().is_empty() {
            &self.streamed
        } else {
            &self.final_text
        };
        let flat = raw
            .chars()
            // 控制字符一律去掉，**但换行/制表留下**：它们在下一步会被
            // split_whitespace 折成空格。先无条件 filter 掉的话，
            // "第一行\n第二行" 会粘成 "第一行第二行"——两个词就此并成一个。
            .filter(|c| !c.is_control() || c.is_whitespace())
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if flat.is_empty() {
            return None;
        }
        let mut out: String = flat.chars().take(MAX_REPLY_CHARS).collect();
        if flat.chars().count() > MAX_REPLY_CHARS {
            out.push('…');
        }
        Some(out)
    }
}

/// 把一行 NDJSON 吸收进 `cap`。抽成纯函数是为了能测——
/// 真跑一次要 8 秒和一次模型调用，而这里要钉的是"哪种事件写哪个字段"。
///
/// **不能因为一行解析不了就退出**：这个流是 dsh 的实现细节，多一种事件类型是常态；
/// 为它崩掉等于"上游加了个字段，桌宠就不发消息了"。
fn absorb(cap: &mut Captured, line: &str) {
    let t = line.trim();
    if t.is_empty() {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
        return;
    };
    match v.get("type").and_then(|x| x.as_str()) {
        Some("session") => {
            if let Some(id) = v.get("sessionId").and_then(|x| x.as_str()) {
                cap.session_id = Some(id.to_string());
            }
        }
        Some("text") => {
            if let Some(s) = v.get("text").and_then(|x| x.as_str()) {
                cap.streamed.push_str(s);
            }
        }
        Some("final") => {
            if let Some(s) = v.get("text").and_then(|x| x.as_str()) {
                cap.final_text = s.to_string();
            }
        }
        _ => {}
    }
}

/// 读 `--json` 的 NDJSON 流。
fn drain_events(r: impl Read + Send + 'static, cap: Arc<Mutex<Captured>>) {
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(r);
        let mut line = String::new();
        loop {
            line.clear();
            match std::io::BufRead::read_line(&mut reader, &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            absorb(&mut cap.lock().unwrap(), &line);
        }
    });
}

/// 起一个进程并把话喂进去。返回值里那个 `Captured` 会随着流被填。
pub fn start(
    l: &Launcher,
    id: Option<&str>,
    cwd: &str,
    text: &str,
) -> Result<(Child, Arc<Mutex<Captured>>), String> {
    let mut child = command(l, id, cwd, text)
        .spawn()
        .map_err(|e| format!("启动 dsh 失败：{e}"))?;

    let cap = Arc::new(Mutex::new(Captured::default()));
    if let Some(so) = child.stdout.take() {
        drain_events(so, cap.clone());
    }

    // 写 stdin 要单独一个线程：管道缓冲写满后 write 会阻塞，而那一刻主线程正在
    // 等进程退出——两边互等。8KB 虽然塞得进缓冲，但这条路径以后会放宽上限，
    // 到时候忘了改这里就是一个只在长输入下复现的死锁。
    if let Some(mut si) = child.stdin.take() {
        let text = text.to_string();
        std::thread::spawn(move || {
            let _ = si.write_all(text.as_bytes());
            // si 在这里 drop → 关掉 stdin → dsh 读到 EOF，开始干活。
        });
    }
    Ok((child, cap))
}

// ------------------------------------------------------------
// 等结果
// ------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// 正常结束（dsh 退出码 0）。
    Ok,
    /// 用户/超时终止，已 kill。
    Cancelled,
    /// 失败，附带给人看的原因。
    Failed(String),
}

/// 收 stderr 的尾巴。
///
/// 必须**边跑边读**：管道满了（64KB）子进程会阻塞在写 stderr 上，而我们先 wait
/// 就是死锁。这条和 stdin 那条是同一个道理的两面。
fn drain_tail(mut r: impl Read + Send + 'static) -> Arc<Mutex<Vec<u8>>> {
    let buf = Arc::new(Mutex::new(Vec::with_capacity(TAIL_BYTES)));
    let out = buf.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut b = out.lock().unwrap();
                    b.extend_from_slice(&chunk[..n]);
                    if b.len() > TAIL_BYTES {
                        let cut = b.len() - TAIL_BYTES;
                        b.drain(..cut);
                    }
                }
            }
        }
    });
    buf
}

/// 等一个进程结束。`cancel` 置真就 kill。
pub fn wait(mut child: Child, cancel: &AtomicBool) -> Verdict {
    let tail = child.stderr.take().map(drain_tail);
    let started = Instant::now();
    let status: Option<ExitStatus> = loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            break None;
        }
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {}
            Err(e) => return Verdict::Failed(format!("等 dsh 退出时出错：{e}")),
        }
        if started.elapsed() > MAX_RUN {
            let _ = child.kill();
            return Verdict::Failed("跑了 45 分钟还没结束，已经把它停了".to_string());
        }
        std::thread::sleep(POLL);
    };
    let Some(status) = status else {
        return Verdict::Cancelled;
    };
    let text = tail
        .map(|b| String::from_utf8_lossy(&b.lock().unwrap()).to_string())
        .unwrap_or_default();
    if status.success() {
        return Verdict::Ok;
    }
    Verdict::Failed(explain(&text))
}

/// 把 DSH 的 stderr 翻成一句人话。
///
/// 为什么值得单独一个函数：dsh 的报错是给开发者看的，而这里要显示在一个 380px 宽的
/// 小窗里。原样贴出去，用户看到的是 `dsh: INVALID_REQUEST: …` 这种读不懂的东西，
/// 而其实每一种都对应一个他能立刻做的动作。
pub fn explain(raw: &str) -> String {
    let line = raw
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("at "))
        .unwrap_or("")
        .to_string();
    let body = line.strip_prefix("dsh: ").unwrap_or(&line).to_string();

    if body.contains("which the one-shot runner does not compose") {
        return "这条会话是在桌面端 / 网页端建的，DSH 不允许一次性 runner 往里写。\
                在桌宠里新起一条，或者在桌面端里继续说。"
            .to_string();
    }
    if body.contains("was recorded in") {
        return "这条会话属于另一个工作目录，没法从这儿接着写".to_string();
    }
    if body.contains("already owned by an active write handle") {
        return "另一个 dsh 正开着这条会话，等它关掉再发".to_string();
    }
    if body.contains("MISSING_CREDENTIAL") {
        return "找不到 API key：`dsh` 的凭据没配好（见 README 的『供应商』一节）".to_string();
    }
    if body.is_empty() {
        return "dsh 没有说原因就退出了（退出码非 0）".to_string();
    }
    // 兜底也要截：DSH 有些报错会带 request id 和一大段 JSON。
    let cut: String = body.chars().take(240).collect();
    if body.chars().count() > 240 {
        format!("{cut}…")
    } else {
        cut
    }
}

// ------------------------------------------------------------
// 测试
// ------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn launcher() -> Launcher {
        Launcher {
            node: PathBuf::from("C:\\node\\node.exe"),
            bin: PathBuf::from("C:\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"),
        }
    }

    fn argv(c: &Command) -> Vec<String> {
        c.get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn new_session_has_no_session_id() {
        let c = command(&launcher(), None, "E:\\work", "跑一下测试");
        assert_eq!(
            argv(&c),
            vec![
                "C:\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
                "--profile",
                "headless",
                "--json",
                "-"
            ]
        );
    }

    #[test]
    fn resuming_puts_the_id_before_the_task_marker() {
        let c = command(&launcher(), Some("session-abc"), "E:\\work", "继续");
        assert_eq!(
            argv(&c),
            vec![
                "C:\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
                "--profile",
                "headless",
                "--json",
                "--session-id",
                "session-abc",
                "-"
            ]
        );
    }

    // 这是最要紧的一条：文字**绝不能**出现在 argv 里。
    // 一旦进去，一句「--help」就变成 flag，一句带引号的话就要赌 Windows 的
    // 转义规则——而这两种情况都只在真实输入下才出现，测试里不钉住就永远不知道。
    #[test]
    fn text_never_reaches_argv() {
        for text in ["--help", "-1", "带\"引号\"和\\反斜杠", "多行\n文本"] {
            let c = command(&launcher(), Some("s"), "E:\\work", text);
            let a = argv(&c);
            assert!(
                !a.iter().any(|x| x == text),
                "文字跑进 argv 了：{text:?} → {a:?}"
            );
            assert_eq!(a.last().unwrap(), "-");
        }
    }

    #[test]
    fn cwd_is_the_sessions_own_directory() {
        let c = command(&launcher(), None, "E:\\work\\proj", "x");
        assert_eq!(
            c.get_current_dir().and_then(|p| p.to_str()),
            Some("E:\\work\\proj")
        );
    }

    #[test]
    fn locate_picks_the_directory_that_actually_has_the_package() {
        let tmp = std::env::temp_dir().join(format!("clawd-say-{}", std::process::id()));
        let good = tmp.join("good");
        let bin_dir = good.join("node_modules/@deepseek-ai/dsh/lib");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::write(bin_dir.join("bin.js"), "").unwrap();
        // 同目录放一个 node.exe，断言"优先用兄弟 node"而不是 PATH 上那个
        std::fs::write(good.join("node.exe"), "").unwrap();

        let l = locate_in(vec![tmp.join("empty"), good.clone()]).expect("应该找到");
        assert_eq!(l.bin, bin_dir.join("bin.js"));
        assert_eq!(l.node, good.join("node.exe"));

        // 没有兄弟 node.exe 时退回裸 `node`（交给 PATH）
        std::fs::remove_file(good.join("node.exe")).unwrap();
        let l2 = locate_in(vec![good]).unwrap();
        assert_eq!(l2.node, PathBuf::from("node"));

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn locate_returns_none_when_dsh_is_not_installed() {
        assert!(locate_in(vec![PathBuf::from("C:\\definitely\\not\\here")]).is_none());
    }

    // 形状照抄真实输出（2026-11-05 从 headless profile 抓的）：
    // 目标块之后紧跟着 `dsh-base` 的一串包，里面也有 `model:`——不能串味。
    const DUMP: &str = "\
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: cmg
    model: DeepSeek-V4.1-Flash-1017
# == @deepseek-ai/dsh-base
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
  config:
    model: 不是这个
";

    #[test]
    fn finds_the_default_model_in_a_dumped_profile() {
        assert_eq!(
            parse_default_model(DUMP),
            Some(("cmg".to_string(), "DeepSeek-V4.1-Flash-1017".to_string()))
        );
    }

    #[test]
    fn stops_at_the_next_block_so_later_models_do_not_leak_in() {
        // 目标块里没有 model 时，绝不能退而求其次去拿后面 jobs 包的那个。
        let no_model = "- id: agent-default-model\n  config:\n    provider: cmg\n- id: jobs\n  config:\n    model: 别拿我\n";
        assert_eq!(parse_default_model(no_model), None);
    }

    #[test]
    fn missing_default_model_is_not_an_error() {
        assert_eq!(parse_default_model(""), None);
        assert_eq!(parse_default_model("- id: something-else\n  config:\n    provider: x\n"), None);
        // 只有一半也必须放弃：显示成 "cmg · " 比不显示更糟。
        assert_eq!(parse_default_model("- id: agent-default-model\n  config:\n    provider: cmg\n"), None);
        // 引号 / null 都要能认
        assert_eq!(
            parse_default_model("- id: agent-default-model\n  config:\n    provider: 'cmg'\n    model: \"M\"\n"),
            Some(("cmg".to_string(), "M".to_string()))
        );
        assert_eq!(parse_default_model("- id: agent-default-model\n  config:\n    provider: cmg\n    model: null\n"), None);
    }

    #[test]
    fn explain_turns_the_preset_wall_into_something_actionable() {
        let raw = "some startup noise\n\ndsh: session \"session-1\" runs under agent preset \"minimal\", which the one-shot runner does not compose\n";
        let msg = explain(raw);
        assert!(msg.contains("桌面端"), "{msg}");
        assert!(!msg.contains("dsh:"), "不该把原始前缀贴给用户：{msg}");
    }

    #[test]
    fn explain_keeps_unknown_errors_but_shortens_them() {
        let raw = format!("dsh: INVALID_REQUEST: {}\n", "x".repeat(500));
        let msg = explain(&raw);
        assert!(msg.starts_with("INVALID_REQUEST"), "{msg}");
        assert!(msg.ends_with('…'));
        assert!(msg.chars().count() <= 241, "截断没生效：{}", msg.chars().count());
    }

    #[test]
    fn explain_handles_empty_stderr() {
        assert!(explain("").contains("没有说原因"));
        assert!(explain("   \n\n").contains("没有说原因"));
    }

    // `--json` 的第一行就是会话 id。整个"发了之后有反馈"的能力都挂在这一行上：
    // 没有它，新会话的答复就没法挂到看板那张卡片上。
    #[test]
    fn absorb_takes_the_session_id_from_the_first_line() {
        let mut c = Captured::default();
        absorb(
            &mut c,
            r#"{"type":"session","sessionId":"session-9f","cwd":"C:\\work"}"#,
        );
        assert_eq!(c.session_id.as_deref(), Some("session-9f"));
    }

    // 上游加一种新事件是常态。解析不了 / 不认识都必须安静跳过——
    // 否则"dsh 多吐了一行"就等于"桌宠不能发消息了"。
    #[test]
    fn absorb_skips_garbage_and_unknown_types() {
        let mut c = Captured::default();
        absorb(&mut c, "not json at all");
        absorb(&mut c, "");
        absorb(&mut c, r#"{"type":"brand-new-thing","x":1}"#);
        absorb(&mut c, r#"{"type":"status","phase":"turn_start"}"#);
        assert!(c.session_id.is_none());
        assert!(c.reply().is_none());
    }

    #[test]
    fn reply_prefers_final_and_flattens_the_text() {
        let mut c = Captured::default();
        absorb(&mut c, r#"{"type":"text","text":"半句"}"#);
        absorb(&mut c, r#"{"type":"text","text":"话"}"#);
        assert_eq!(c.reply().as_deref(), Some("半句话"), "没有 final 时用流式拼的");

        absorb(&mut c, "{\"type\":\"final\",\"text\":\"第一行\\n第二行\"}");
        assert_eq!(
            c.reply().as_deref(),
            Some("第一行 第二行"),
            "final 优先，且换行要压平（看板每行只有一个行高）"
        );
    }

    #[test]
    fn reply_is_truncated_like_the_projection_one() {
        let mut c = Captured::default();
        absorb(
            &mut c,
            &format!(r#"{{"type":"final","text":"{}"}}"#, "字".repeat(MAX_REPLY_CHARS * 2)),
        );
        let r = c.reply().unwrap();
        assert_eq!(r.chars().count(), MAX_REPLY_CHARS + 1);
        assert!(r.ends_with('…'));
    }
}
