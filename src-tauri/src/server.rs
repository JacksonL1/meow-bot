// ============================================================
// S2-2  本地 HTTP 接收器
//
// 为什么用 HTTP 而不是文件监听 / 管道？
//   因为 hook 是独立的短命进程，它需要一种"对方没开就立刻失败"的通信方式。
//   端点写在文件里 → hook 读文件 → POST 一发即走，桌宠没开就静默退出。
//
// 两个端点，两道不同的门：
//   /state       观察用，四道锁（Host / Origin / Token / Content-Type）
//   /permission  裁决用，三道锁（Host / Origin / Content-Type）——**没有 Token**
//
// 为什么 /permission 不能有 token？因为它的调用方是 Claude Code 自己，
// 它不知道我们的 token，也带不上。这是 HTTP hook 架构的固有属性，只能靠
// "拒绝浏览器发起的请求"来收敛；详见 SECURITY.md 的 S5 小节。
//
// 端口固定（23333）：HTTP hook 的 url 写在 settings.json 里，是静态的。
// 端口每次启动都变的话，上次装好的 hook 就指向了一个死端口。
// ============================================================
use crate::permission::{decision_body, Center, Outcome};
use crate::state::{Snapshot, Store};
use serde_json::json;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tiny_http::{Header, Request, Response, Server, StatusCode};

/// "状态变了，该推一次画面了"的回调。
///
/// 为什么是回调而不是让 server 自己去 emit：server 这一层刻意不认识 tauri
/// （它只认 tiny_http + 两个 Arc），这样它才能被单测直接调用。
/// 把 AppHandle 塞进来的话，这个文件的每一条测试都要先起一个 Tauri 应用。
pub type OnChange = Arc<dyn Fn(&Snapshot) + Send + Sync>;

pub const MAX_BODY_BYTES: u64 = 256 * 1024;
pub const DEFAULT_PORT: u16 = 23333;

pub struct ServerHandle {
    pub port: u16,
    pub token: String,
}

fn json_header() -> Header {
    Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).expect("头写错了")
}

fn respond_json(req: Request, code: u16, body: &str) {
    let resp = Response::from_string(body)
        .with_status_code(StatusCode(code))
        .with_header(json_header());
    let _ = req.respond(resp);
}

/// 被拒时不回任何内容：不给对方反馈"你差在哪一步"
fn respond_empty(req: Request, code: u16) {
    let _ = req.respond(Response::empty(StatusCode(code)));
}

fn header_value(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

/// 定长比较，避免通过响应时间猜 token。
fn safe_equal(got: &str, expected: &str) -> bool {
    let a = got.as_bytes();
    let b = expected.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

fn read_body(req: &mut Request) -> Option<serde_json::Value> {
    let mut buf = Vec::new();
    let mut r = req.as_reader().take(MAX_BODY_BYTES);
    if r.read_to_end(&mut buf).is_err() {
        return None;
    }
    let text = String::from_utf8_lossy(&buf).trim().to_string();
    if text.is_empty() {
        return Some(json!({}));
    }
    serde_json::from_str(&text).ok()
}

fn handle(
    mut req: Request,
    actual_port: u16,
    expected_token: Arc<String>,
    store: Arc<Mutex<Store>>,
    center: Arc<Center>,
    on_change: OnChange,
) {
    // ---- 1. Host：必须是本机回环 + 本进程端口 ----
    // DNS rebinding 就是靠"域名解析到 127.0.0.1"来绕同源策略的，这道锁专治它
    let want_host = format!("127.0.0.1:{actual_port}");
    if header_value(&req, "Host").as_deref() != Some(want_host.as_str()) {
        return respond_empty(req, 403);
    }

    // ---- 2. Origin：浏览器发起的跨源请求一律拒绝 ----
    // "null" 是 file:// 页面与沙箱 iframe 的 Origin，放行它由 token 兜底。
    if let Some(origin) = header_value(&req, "Origin") {
        if origin != "null" {
            return respond_empty(req, 403);
        }
    }

    let method = req.method().as_str().to_ascii_uppercase();
    let is_post = method == "POST";

    // ---- 3. Content-Type：挡住不需要预检的简单请求 ----
    // text/plain 属于 CORS 简单请求，浏览器不发预检，请求会真的打到服务端。
    if is_post {
        let ct = header_value(&req, "Content-Type").unwrap_or_default().to_ascii_lowercase();
        if !ct.starts_with("application/json") {
            return respond_empty(req, 415);
        }
    }

    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();

    // ---- /permission：裁决端点，没有 token 可校，三道边界已过完 ----
    if is_post && path == "/permission" {
        let Some(payload) = read_body(&mut req) else {
            return respond_empty(req, 400);
        };
        if !payload.is_object() {
            return respond_empty(req, 400);
        }

        let (id, rx) = center.create(&payload);
        // 挂起这个响应，等用户在气泡里点。超时自己兜底。
        let outcome = rx.recv_timeout(center.timeout()).unwrap_or(Outcome::NoDecision);
        if outcome == Outcome::NoDecision {
            // 超时路径也要把条目清掉，否则气泡关不掉、内存也不掉
            center.settle(id, Outcome::NoDecision);
        }
        match decision_body(outcome) {
            Some(body) => respond_json(req, 200, &body),
            // 204 = 我不做决定，交给 Claude Code 原生流程
            None => respond_empty(req, 204),
        }
        return;
    }

    // ---- 4. Token：只有 /state 与 /health 需要 ----
    let got = header_value(&req, "X-Clawd-Token").unwrap_or_default();
    if !safe_equal(&got, &expected_token) {
        return respond_json(req, 401, r#"{"error":"bad token"}"#);
    }

    if method == "GET" && path == "/health" {
        let lock = if crate::sys::lock_is_event() { "event" } else { "poll" };
        return respond_json(req, 200, &format!(r#"{{"ok":true,"lock":"{lock}"}}"#));
    }

    if method == "GET" && path == "/state" {
        let snap = {
            let st = store.lock().expect("store 锁坏了");
            st.snapshot()
        };
        return respond_json(req, 200, &serde_json::to_string(&snap).unwrap_or_else(|_| "{}".into()));
    }

    if is_post && path == "/state" {
        let Some(payload) = read_body(&mut req) else {
            return respond_json(req, 400, r#"{"error":"invalid json"}"#);
        };
        if !payload.is_object() {
            return respond_json(req, 400, r#"{"error":"body must be an object"}"#);
        }
        let (snap, changed) = {
            let mut st = store.lock().expect("store 锁坏了");
            st.apply(&payload)
        };
        // 回包把"当前该显示什么"告诉 hook，方便它自己决定是否继续阻塞
        let body = json!({
            "ok": true,
            "visual": snap.visual.map(|v| v.as_str()),
        });
        // ⇒ 这里必须自己推一次。
        //
        // 这是迁移时踩到的一个**静默**退化：apply() 内部已经调过 tick()，
        // 而 tick() 会顺手把 last_visual 更新成新值。等 250ms 心跳再跑 tick()，
        // 它比的是"新值 vs 新值"，返回 false —— 这次变化就**永远不会被推出去**。
        // 表现是：hook 一路 POST 成功，/state 回包里的 visual 也对，
        // 但画面停在旧状态，直到下一次状态变化才追上来。
        // （当年 Electron 版没这个问题，因为 JS 版 apply() 末尾直接走 onChange 回调。）
        //
        // 顺序：先回包再推。回包先走，hook 不会因为渲染层慢而被拖住。
        respond_json(req, 200, &body.to_string());
        if changed {
            on_change(&snap);
        }
        return;
    }

    respond_json(req, 404, r#"{"error":"not found"}"#);
}

/// 起服务。返回实际端口（固定端口被占时回退随机端口，并明确报警）。
pub fn start(
    store: Arc<Mutex<Store>>,
    center: Arc<Center>,
    port_file: PathBuf,
    token: String,
    on_change: OnChange,
) -> ServerHandle {
    let server = match Server::http(("127.0.0.1", DEFAULT_PORT)) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "[clawd] 端口 {DEFAULT_PORT} 被占用，改用随机端口——已装的 PermissionRequest \
                 HTTP hook 会失效，需要重跑 npm run install:hooks"
            );
            Server::http(("127.0.0.1", 0)).expect("随机端口也起不来")
        }
    };

    let actual_port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(DEFAULT_PORT);

    // SEC-02 / SEC-10：内容是 { port, token }
    write_port_file(&port_file, actual_port, &token);

    let token_arc = Arc::new(token.clone());
    let server = Arc::new(server);
    let srv = server.clone();
    std::thread::spawn(move || {
        for request in srv.incoming_requests() {
            let store = store.clone();
            let center = center.clone();
            let tok = token_arc.clone();
            let on_change = on_change.clone();
            // 每条请求一个线程：/permission 会阻塞到用户点为止，
            // 不分开的话第二条请求就被第一条挡在门外了。
            std::thread::spawn(move || handle(request, actual_port, tok, store, center, on_change));
        }
    });

    println!("[clawd] state      POST http://127.0.0.1:{actual_port}/state");
    println!("[clawd] permission POST http://127.0.0.1:{actual_port}/permission");
    println!("[clawd] 端点已写入 {}（含 token）", port_file.display());
    if actual_port != DEFAULT_PORT {
        eprintln!("[clawd] 注意：不是默认端口 {DEFAULT_PORT}，已装的 HTTP hook 需要更新");
    }

    ServerHandle { port: actual_port, token }
}

fn write_port_file(file: &PathBuf, port: u16, token: &str) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = json!({ "port": port, "token": token }).to_string();
    if let Ok(mut f) = std::fs::File::create(file) {
        let _ = f.write_all(body.as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
        }
    }
}

pub fn port_file_path() -> PathBuf {
    // 测试 / 多实例隔离：回归脚本要在「用户自己正开着桌宠」的情况下也能跑。
    if let Ok(p) = std::env::var("CLAWD_PORT_FILE") {
        return PathBuf::from(p);
    }
    crate::theme::user_data_dir().join("clawd-starter.port")
}

pub fn random_token() -> String {
    // 不用 rand crate：从系统熵源读 32 字节足够，且少一个依赖。
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(64);
    while out.len() < 64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out.truncate(64);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare_is_length_safe() {
        assert!(safe_equal("abc", "abc"));
        assert!(!safe_equal("abc", "abd"));
        assert!(!safe_equal("abc", "abcd"));
        assert!(!safe_equal("", "abc"));
    }

    #[test]
    fn token_is_64_hex_chars() {
        let t = random_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn port_file_path_honours_env() {
        std::env::set_var("CLAWD_PORT_FILE", "E:\\tmp\\x.port");
        assert_eq!(port_file_path(), PathBuf::from("E:\\tmp\\x.port"));
        std::env::remove_var("CLAWD_PORT_FILE");
    }
}
