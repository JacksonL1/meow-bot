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
///
/// `pre` / `env` 这两项是为桌面版（见 `desktop_at`）加的：那边"node"其实是
/// Electron 本体，得靠环境变量告诉它"别开 GUI，你现在是 node"。
/// npm 那份两项都为空，命令行和以前一个字都不差。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launcher {
    pub node: PathBuf,
    pub bin: PathBuf,
    /// node 之后、脚本之前的参数。
    pub pre: &'static [&'static str],
    /// 要额外设的环境变量。
    pub env: &'static [(&'static str, &'static str)],
    /// 这份 dsh 是从哪种安装找来的（"npm" / "desktop"），只用于诊断输出。
    pub from: &'static str,
}

fn bin_under(dir: &Path) -> PathBuf {
    dir.join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

/// 桌面版（Electron 安装包）里那个 CLI 入口，相对安装根目录。
///
/// 和 `dsh.cmd` 指的是同一个东西：
/// `"%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"`
/// 它支持我们用的全部参数（`--profile headless`、`--json`、`--session-id`、`-`），
/// 2026-11-10 逐条对着 `--help` 核过。
///
/// 这是**内部路径**，上游改布局就会变。所以这条路径是"按当前版本的形状拼出来的猜"：
/// 拼错了 Electron 会在 stderr 上说 `Cannot find module`，由 `explain()` 翻译成人话。
const DESKTOP_BIN: &str =
    "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";

/// 找 dsh。两条路，按"谁更可能是用户真在用的"排序：
///
///   1. `PATH` 上的 npm 全局安装（`node_modules/@deepseek-ai/dsh/lib/bin.js`）；
///   2. 桌面版 `DeepSeek Harness` 自带的那个。
///
/// 为什么要第二条（2026-11-10 用户报「找不到 dsh」）：npm 那份是装在 node 的
/// 全局目录里的，而 node 一换版本 / nvm 一清理，它就连着目录一起没了——
/// 本机 `C:\nvm4w` 就是这么空掉的。桌面版则一直躺在一个稳定位置。
/// 两条都不在就返回 None——**没装 DSH 不是错误**，只是这个功能不可用。
pub fn locate() -> Option<Launcher> {
    let found = npm_installed().or_else(desktop);
    if found.is_none() {
        // 报错只说"没找到"没有用；说清"我在哪儿找过"才让人能自己判断。
        eprintln!(
            "[say] 没找到 dsh：PATH 里没有 npm 那份，桌面版候选目录里也没有（{:?}）",
            desktop_roots()
        );
    }
    found
}

/// `PATH` 上 npm 全局装的那份。
fn npm_installed() -> Option<Launcher> {
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
        return Some(Launcher {
            node,
            bin,
            pre: &[],
            env: &[],
            from: "npm",
        });
    }
    None
}

/// 一个安装根目录是不是桌面版；是就拼出启动器。
///
/// 判据两条，缺一不可：
///   1. `resources/app.asar` 在（证明这是个打包好的 Electron 应用）；
///   2. 那个 exe 或它所在目录的名字里有 `deepseek`（证明它是**这个**应用）。
///
/// 第 2 条不是洁癖，是实测踩出来的：本机 `%LOCALAPPDATA%\Programs` 下还有
/// Cherry Studio 等好几个 Electron 应用，只按第 1 条判会直接把 Cherry Studio
/// 的 exe 当成 node 去跑 dsh 的脚本（2026-11-10 用临时探针抓到的）。
///
/// 名字被彻底改掉的情况用 `CLAWD_DSH_ROOT` 兜，不靠猜。
///
/// 注意 `DESKTOP_BIN` 落在 asar 里面，磁盘上查不到这个文件（asar 是个归档，
/// 由 Electron 自己解析），所以这里只能校验"根目录像不像"，不能校验"入口在不在"。
pub fn desktop_at(root: &Path) -> Option<Launcher> {
    if !root.join("resources").join("app.asar").is_file() {
        return None;
    }
    let node = electron_exe(root)?;
    let dir = root.file_name()?.to_string_lossy().to_lowercase();
    let exe = node.file_stem()?.to_string_lossy().to_lowercase();
    if !dir.contains("deepseek") && !exe.contains("deepseek") {
        return None;
    }
    Some(Launcher {
        node,
        bin: root.join(DESKTOP_BIN),
        // 照抄它自己的 `resources/runtime/bin/node.cmd`：
        // `set ELECTRON_RUN_AS_NODE=1` + `--expose-internals`。
        // 少了前者，Electron 会把整个 GUI 启起来——桌宠"发消息"变成"又开一个 DSH"。
        pre: &["--expose-internals"],
        env: &[("ELECTRON_RUN_AS_NODE", "1")],
        from: "desktop",
    })
}

/// 从安装根目录里挑出那个 Electron 可执行文件。
///
/// 规则：`.exe` 里排除卸载器；剩多个时优先取名字与目录同名的那个——
/// electron-builder 的命名就是 `<productName>.exe` 放在 `<productName>\` 里。
fn electron_exe(root: &Path) -> Option<PathBuf> {
    let want = root.file_name()?.to_string_lossy().to_string();
    let mut fallback = None;
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) {
            continue;
        }
        let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if stem.to_ascii_lowercase().starts_with("uninstall") {
            continue;
        }
        if stem == want {
            return Some(p);
        }
        if fallback.is_none() {
            fallback = Some(p);
        }
    }
    fallback
}

/// 桌面版可能装在哪些目录。
///
/// 三个来源，都是"列一层子目录"这种便宜操作（每个子目录两次 stat）：
///   · `%LOCALAPPDATA%\Programs` —— electron-builder 的 per-user 默认位置
///   · `%PROGRAMFILES%` / `%PROGRAMFILES(X86)%` —— per-machine 安装
///
/// 不查注册表：`InstallLocation` 确实更权威（装到自定义路径也能拿到），但枚举
/// Uninstall 下那几十个 GUID 子键要一大段 unsafe，而它换来的只是"装到 D 盘也能找到"。
/// 那种情况用 `CLAWD_DSH_ROOT` 直接指一下就行（见 `desktop`）。
fn desktop_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        let Some(base) = std::env::var_os(var).map(PathBuf::from) else {
            continue;
        };
        let dir = if var == "LOCALAPPDATA" {
            base.join("Programs")
        } else {
            base
        };
        let Ok(list) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in list.flatten() {
            let p = entry.path();
            if p.is_dir() {
                roots.push(p);
            }
        }
    }
    roots
}

/// 手动指定优先：`CLAWD_DSH_ROOT` 既可以指向 npm 布局的那个
/// "装着 node_modules 的目录"，也可以指向桌面版的安装根目录——两种都试，
/// 用户不用记自己装的是哪一种。
fn override_root() -> Option<Launcher> {
    let p = PathBuf::from(std::env::var_os("CLAWD_DSH_ROOT")?);
    locate_in([p.clone()]).or_else(|| desktop_at(&p))
}

/// 在候选目录里找桌面版。
fn desktop() -> Option<Launcher> {
    override_root()
        .or_else(|| desktop_roots().into_iter().find_map(|p| desktop_at(&p)))
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

/// 起一条 "node 在跑脚本" 的命令：可执行文件 + 前置参数 + 环境变量 + bin.js。
///
/// 两处调用（`--dump-config` 和真发消息）**必须**走这一条：桌面版的
/// `ELECTRON_RUN_AS_NODE` 只在一处生效的话，另一处就会去启 GUI。
fn base(l: &Launcher) -> Command {
    let mut c = Command::new(&l.node);
    c.args(l.pre);
    for (k, v) in l.env {
        c.env(k, v);
    }
    c.arg(&l.bin);
    c
}

/// 真跑一次 `--dump-config` 拿默认模型。找不到 node / 跑挂了都只是 None。
///
/// 用 `.output()` 而不是自己接管道：它内部会把三条流都读干，而这里是
/// "活着 -> 打印几十 KB YAML -> 退出"的一次性调用，不存在需要边跑边处理的场景。
pub fn default_model(l: &Launcher) -> Option<(String, String)> {
    let out = base(l)
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
    let mut c = base(l);
    c.arg("--profile")
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
    // 桌面版那条路是按"当前版本的内部布局"拼出来的（见 DESKTOP_BIN）。
    // 上游改了布局就是这句 —— 它对用户毫无意义，得翻译。
    if body.contains("Cannot find module") || body.contains("ERR_MODULE_NOT_FOUND") {
        return "桌面版里的 dsh 入口和预期不一样（DeepSeek Harness 可能刚升级过）".to_string();
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
            pre: &[],
            env: &[],
            from: "npm",
        }
    }

    /// 桌面版那一份：node 换成 Electron 本体，参数和环境变量都要跟着来。
    fn desktop_launcher() -> Launcher {
        Launcher {
            node: PathBuf::from("C:\\app\\DeepSeek Harness.exe"),
            bin: PathBuf::from("C:\\app\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js"),
            pre: &["--expose-internals"],
            env: &[("ELECTRON_RUN_AS_NODE", "1")],
            from: "desktop",
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

    // ---- 桌面版（2026-11-10 用户报「找不到 dsh」）----
    //
    // 背景：npm 那份装在 node 的全局目录里，nvm 一清理就连目录一起没了
    // （本机 `C:\nvm4w` 就是这么空掉的），而桌面版一直在。

    /// 造一个"像 Electron 安装包"的根目录：`<app>` 目录 + 同名 exe + `resources\app.asar`。
    ///
    /// `tag` 必须每个测试各不相同：这些测试是并行跑的，共用一个目录时
    /// 一边 `remove_dir_all`、另一边还在写，会随机报"拒绝访问"。
    fn fake_electron(app: &str, tag: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("clawd-say-{}-{tag}", std::process::id()))
            .join(app);
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join("resources").join("app.asar"), "asar").unwrap();
        std::fs::write(root.join(format!("{app}.exe")), "").unwrap();
        root
    }

    #[test]
    fn desktop_install_yields_a_launcher() {
        let root = fake_electron("DeepSeek Harness", "install");
        std::fs::write(root.join("Uninstall DeepSeek Harness.exe"), "").unwrap();

        let l = desktop_at(&root).expect("应该认出这是桌面版");
        assert_eq!(l.node, root.join("DeepSeek Harness.exe"), "卸载器不能当 node 用");
        assert_eq!(l.bin, root.join(DESKTOP_BIN));
        assert_eq!(l.from, "desktop");
        // 这两样是桌面版能当 node 用的**全部**条件，少一样就会去启 GUI。
        assert_eq!(l.pre, ["--expose-internals"]);
        assert_eq!(l.env, [("ELECTRON_RUN_AS_NODE", "1")]);

        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    // 本机实测过的真事：`%LOCALAPPDATA%\Programs` 下有一堆 Electron 应用，
    // 第一版判据只认 `resources/app.asar`，于是把 Cherry Studio 的 exe 选中了。
    #[test]
    fn does_not_mistake_another_electron_app_for_dsh() {
        let root = fake_electron("Cherry Studio", "cherry");
        assert!(desktop_at(&root).is_none(), "别的 Electron 应用不是 dsh");
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn a_bare_exe_without_app_asar_is_not_a_desktop_install() {
        let root = std::env::temp_dir().join(format!("clawd-say-{}-bare", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("DeepSeek Bare.exe"), "").unwrap();
        assert!(desktop_at(&root).is_none(), "没有 resources/app.asar 就不是它");
        std::fs::remove_dir_all(&root).ok();
    }

    // 安装目录可以自定义，所以 exe 名不一定等于目录名。优先同名（electron-builder
    // 的命名），退而求其次取第一个非卸载器的 exe——但绝不能把 Uninstall 挑走。
    #[test]
    fn the_exe_named_like_the_directory_wins() {
        let root = fake_electron("DeepSeek Harness", "exe-wins");
        std::fs::write(root.join("Other.exe"), "").unwrap();
        let l = desktop_at(&root).unwrap();
        assert_eq!(l.node, root.join("DeepSeek Harness.exe"));

        std::fs::remove_file(root.join("DeepSeek Harness.exe")).unwrap();
        let l2 = desktop_at(&root).expect("名字对不上目录也不要紧，还有 exe 名兜着");
        assert_eq!(l2.node, root.join("Other.exe"));

        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    // 桌面版的 `pre`/`env` 必须真的进了命令行才叫修好了。只断言 struct 里存了
    // 一遍是不够的——`base()` 忘了转手一次，"找不到 GUI 又冒出来一个"就回来了。
    #[test]
    fn desktop_command_actually_runs_electron_as_node() {
        let c = command(&desktop_launcher(), Some("s1"), "E:\\work", "你好");
        let a = argv(&c);
        assert_eq!(a[0], "--expose-internals", "前置参数必须在脚本之前");
        assert_eq!(a[1], "C:\\app\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js");
        assert_eq!(a[a.len() - 1], "-");
        let envs: Vec<_> = c
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string())))
            .collect();
        assert_eq!(
            envs,
            vec![("ELECTRON_RUN_AS_NODE".to_string(), Some("1".to_string()))]
        );
    }

    // npm 那份不能因为加了桌面版支持就被带上多余的东西。
    #[test]
    fn npm_command_is_unchanged() {
        let c = command(&launcher(), None, "E:\\work", "x");
        assert_eq!(argv(&c)[0], "C:\\node\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js");
        assert_eq!(c.get_envs().count(), 0, "npm 版不该设任何环境变量");
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

    // 桌面版那条路拼的是"当前版本的内部布局"。上游换了布局就只有这一句英文，
    // 而它会被显示在 380px 的小窗里——必须翻成人话，否则用户只能看到一个堆栈。
    #[test]
    fn explain_translates_a_missing_module_from_the_desktop_build() {
        let raw = "node:internal/modules/cjs/loader:1143\nError: Cannot find module 'electron/main'\n";
        let msg = explain(raw);
        assert!(msg.contains("桌面版"), "{msg}");
        assert!(!msg.contains("Cannot find"), "别把原始报错贴给用户：{msg}");
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
