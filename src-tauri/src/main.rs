// 桌面宠物：Rust 侧只做「窗口容器 + 状态机 + HTTP」，画面全部交给 WebView2 里的前端。
//
// 与 Electron 版的对应关系（迁移期的对照表，留作历史注脚——Electron 容器
// 已于 2026-11-03 删除，src/main.js / preload.js 等原件只能从 git 历史里找）：
//   main.js 的 BrowserWindow          → 这里三个窗口（main / bubble / dashboard）
//   ipcMain.on(…)/handle(…)           → #[tauri::command]（前端 invoke）
//   webContents.send(…)               → app.emit(…)
//   screen.getCursorScreenPoint()     → sys::cursor_pos()
//   powerMonitor lock/suspend         → sys::is_locked() 轮询
//   Menu.popup                        → tauri::menu 的 ContextMenu
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dsh;
mod permission;
mod risk;
mod say;
mod server;
mod single;
mod state;
mod sys;
mod theme;

use permission::{Center, Notify, PendingView};
use state::{Snapshot, Store, Timings};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, ContextMenu, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const WIN_W: f64 = 240.0;
/// 窗口比猫高：多出来的那 220px 是**消息泡泡**的画布（S11，2026-11-04）。
///
/// 为什么不是单独开一个泡泡窗口（权限气泡就是那么做的）：
/// 泡泡要跟着猫走、跟着猫长大缩小、还要能被拖动时一起移动——两个窗口做这件事
/// 得同步位置，而同步永远会慢一帧，慢一帧看起来就是"泡泡在飘"。
/// 放同一个窗口里，它天然是钉在猫头顶的。
///
/// 数值不是拍的：猫头在 pet 盒里离顶 32px，pet 离窗口底还有 32px 留白，
/// 所以耳尖大约在窗口底往上 192px（见 index.html 里 #bubble-wrap 的 bottom: 200）。
/// 上面留出的那 260px 要装得下"4 条任务 + 展开一条详情"，不然泡泡会开始滚动。
///
/// 代价是窗口变大，但**用户看不出来**：窗口是透明的，而且只有猫和泡泡的矩形
/// 会关掉穿透（见 HIT_PAD / hit_test），多出来的区域点上去直接落到底下的桌面。
/// 猫在屏幕上的位置也没变——窗口是往上长的，底边不动（见 build_main_window）。
const WIN_H: f64 = 460.0;
const BUBBLE_W: f64 = 360.0;
/// 输入窗的尺寸。宽度刻意比猫（240）宽得多：这是**唯一**一个用户要往里打字的
/// 窗口，一行的可用宽度直接决定它好不好用。高度够放下「目标 + 一行输入 + 提示」。
const COMPOSE_W: f64 = 400.0;
const COMPOSE_H: f64 = 128.0;
const DEFAULT_THEME_ID: &str = "ragdoll";
const CAST_PUSH_MS: u64 = 1000;

struct AppState {
    store: Arc<Mutex<Store>>,
    center: Arc<Center>,
    theme: Mutex<Option<theme::Theme>>,
    bubble_current: Mutex<Option<u64>>,
    bubble_queue: Mutex<std::collections::VecDeque<u64>>,
    bubble_ready: AtomicBool,
    bubble_pending: Mutex<Option<PendingView>>,
    dragging: AtomicBool,
    drag_origin: Mutex<Option<((i32, i32), (i32, i32))>>, // (光标, 窗口)
    hidden_by_lock: AtomicBool,
    gaze_x: AtomicI32,
    gaze_y: AtomicI32,
    /// 猫的命中区（CSS px，相对窗口客户区）。由渲染层上报——只有它知道
    /// 分身后每只猫在哪、淡出到哪一步。
    hit: Mutex<Vec<[f64; 4]>>,
    /// 当前窗口是不是"整块穿透"。看门狗与 `mouse_ignore` 命令都写它，
    /// 是为了不重复调 Win32（每次调用都要走一遍 SetWindowLong）。
    ignore: AtomicBool,
    /// gaze 线程活着的证据：每拍 +1，与光标动没动无关。
    /// 为什么需要它：`gazePushes`（页面上那个）只在光标**真的动了**才涨，
    /// 光标不动时 0 是正确行为——所以它证明不了"线程还在跑"。
    /// 用户报"眼睛不追鼠标"时，这两个数一起看：ticks 不涨 = 线程死了；
    /// ticks 涨而 pushes 不涨 = 线程活着但没发出（窗口不可见 / 变化太小）。
    gaze_ticks: AtomicU64,
    gaze_pushes: AtomicU64,
    /// DSH 适配层的最近一次观测。探测线程每秒刷新，`dsh_state` 命令读它。
    /// 存的是**视图快照**而不是 Probe 本体：Probe 的 prev 表要独占，
    /// 让命令去抢同一把锁，只会让调试动作干扰正在跑的探测。
    dsh: Mutex<dsh::ProbeView>,
    /// 正在飞的「说」：目标 key（session id 或 "(new)"）→ 取消旗标。
    /// 同一目标只允许一条——理由见 say_send 里的注释。
    say_jobs: Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    /// 桌宠自己发出去的那几次：session id → 说了什么 / 回了什么。
    ///
    /// 为什么需要单独存一份：`dsh headless` 建的会话在投影里**没有**
    /// `turnOutline`（那一行是桌面/网页端写的），所以看板从投影只能读到标题和用量，
    /// 读不到"我说了什么、它答了什么"。而这两段文字此刻正从我们手里过——
    /// 不接住，用户从桌宠发完消息就永远看不到回答。
    ///
    /// 只保留最近若干条：它是"补充说明"，不是第二份会话数据库。
    say_reply: Mutex<std::collections::HashMap<String, SayNote>>,
    /// 输入窗这一次要发给谁。写在宿主侧而不是让页面自己记：
    /// 窗口是复用的，页面可能是上一次打开的那份（甚至还没加载完），
    /// 谁都能出错，只有"打开它的那一刻"知道正确答案。
    compose_target: Mutex<Option<ComposeTarget>>,
    /// 新会话该起在哪个目录——**第一次算出来就钉住**。
    ///
    /// 原来每次现算（"最近有动静的那条会话的目录"），结果是输入窗显示
    /// `…\Users\Think`、消息却落到 `…\project\DeepseekWorkSpace`：这两个查询之间
    /// 隔着几百毫秒，而"最近有动静"在这段时间里换了人。目录选错的代价不是
    /// 提示难看，是这条会话起在了另一个项目里（DSH 按目录分桶存会话）。
    /// 钉住之后，"你看到的"和"它落到的"就是同一个值。
    new_session_cwd: Mutex<Option<String>>,
    /// headless profile 的默认模型（provider, model）。
    ///
    /// 为什么需要它：`dsh headless` 建的会话**不在投影里写 `modelSelection`**
    /// （那一行由桌面/网页端写），所以看板上"用哪个模型"对这些会话永远是空的。
    /// 而默认模型是确定可查的：`dsh --profile headless --dump-config`（0.2s）。
    /// 启动时查一次就够——它由用户的 profile 决定，不会在一次运行里变。
    headless_model: Mutex<Option<(String, String)>>,
}

/// 桌宠替用户说的一句话，以及 dsh 的回答。
#[derive(Clone, serde::Serialize)]
struct SayNote {
    prompt: String,
    reply: String,
}

/// 输入窗的「发给谁」。
#[derive(Clone, serde::Serialize)]
struct ComposeTarget {    /// Some = 接着这条说；None = 新起一条。
    id: Option<String>,
    /// 会话标题（新会话时是 None）。只用于显示。
    title: Option<String>,
    /// 这句话会落到哪个目录——**只给最后两段**（SEC-09：完整路径不出宿主）。
    /// 为什么不给 basename：DSH 按目录分桶存会话，起错目录等于起在空工作区里，
    /// 而 `…\project\a` 和 `…\work\a` 的 basename 一模一样——只看一段等于没确认。
    cwd: Option<String>,
    /// 这条会话能不能被一次性 runner 续写。false 时页面上要说明原因，
    /// 而不是让用户点了发送才在错误里看到（见 say::explain 的第一条）。
    can_resume: bool,
    /// 是谁叫出来的：`main`（桌宠）或 `dashboard`（看板）。
    /// 决定了输入窗贴在哪扇窗上方——从看板点「说」，窗口却蹦到屏幕角落的猫头上，
    /// 用户会以为点错了。
    origin: String,
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

// ------------------------------------------------------------
// 窗口
// ------------------------------------------------------------

fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let (ax, ay, aw, ah) = sys::work_area();
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let w = (WIN_W * scale) as i32;
    let h = (WIN_H * scale) as i32;
    let x = ax + aw - w - 40;
    let y = ay + ah - h - 40;

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("clawd-starter · 布偶猫")
        .inner_size(WIN_W, WIN_H)
        .position(x as f64, y as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()
}

fn ensure_bubble(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("bubble") {
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, "bubble", WebviewUrl::App("bubble.html".into()))
        .title("clawd · 权限")
        .inner_size(BUBBLE_W, 140.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .ok()?;
    Some(w)
}

fn ensure_dashboard(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("dashboard") {
        return Some(w);
    }
    // 它是个"正常窗口"：有边框、不置顶、不透明。
    // 和桌宠/气泡刻意不同——那两个是"突然出现在你屏幕上"，这个是你主动要看。
    WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App("dashboard.html".into()))
        .title("Clawd · 会话")
        .inner_size(420.0, 460.0)
        .min_inner_size(340.0, 260.0)
        .visible(false)
        .build()
        .map_err(|e| eprintln!("[dashboard] 建窗失败：{e}"))
        .ok()
}

/// 输入窗。和权限气泡一样是"transparent + 无边框 + 置顶"，但有一处关键不同：
/// **它要拿键盘**。所以 show 之后必须 set_focus，而且不能设 skip_taskbar 之外的
/// 那些"不参与激活"的开关——一个收不到焦点的小窗，用户会以为程序卡了。
fn ensure_compose(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("compose") {
        return Some(w);
    }
    WebviewWindowBuilder::new(app, "compose", WebviewUrl::App("compose.html".into()))
        .title("clawd · 说句话")
        .inner_size(COMPOSE_W, COMPOSE_H)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| eprintln!("[compose] 建窗失败：{e}"))
        .ok()
}

/// 输入窗贴在**叫它出来的那扇窗**上方（和权限气泡同一套算法，只是尺寸与锚点不同）。
///
/// 锚点必须跟着来源走：从看板点「说」，窗口却蹦到桌面角上的猫头前，
/// 用户会以为点错了；反过来从猫身上点，窗口蹦到屏幕中间的看板上，同理。
fn position_compose(app: &AppHandle, origin: &str) {
    let anchor = app
        .get_webview_window(origin)
        .or_else(|| app.get_webview_window("main"));
    let (Some(anchor), Some(w)) = (anchor, app.get_webview_window("compose")) else {
        return;
    };
    let (ax, ay, aw, ah) = sys::work_area();
    let (Ok(ap), Ok(ws)) = (anchor.outer_position(), w.outer_size()) else {
        return;
    };
    let asz = anchor.outer_size().unwrap_or(tauri::PhysicalSize::new(0, 0));
    let (ww, wh) = (ws.width as i32, ws.height as i32);

    // 水平居中于来源窗；竖直优先放上方，上方不够就放下方，都不够就贴工作区顶。
    let x = ap.x + (asz.width as i32) / 2 - ww / 2;
    let above = ap.y - wh - 12;
    let below = ap.y + asz.height as i32 + 12;
    let y = if above >= ay {
        above
    } else if below + wh <= ay + ah {
        below
    } else {
        ay + 8
    };
    let x = clamp(x as f64, (ax + 8) as f64, (ax + aw - ww - 8) as f64) as i32;
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
}

fn position_bubble(app: &AppHandle) {
    let (Some(main), Some(bubble)) = (
        app.get_webview_window("main"),
        app.get_webview_window("bubble"),
    ) else {
        return;
    };
    let (ax, ay, aw, _ah) = sys::work_area();
    let (Ok(mp), Ok(bs)) = (main.outer_position(), bubble.outer_size()) else {
        return;
    };
    let scale = main.scale_factor().unwrap_or(1.0);
    let win_w = (WIN_W * scale) as i32;
    let win_h = (WIN_H * scale) as i32;
    let bw = bs.width as i32;
    let bh = bs.height as i32;
    let x = mp.x + win_w / 2 - bw / 2;
    let mut y = mp.y - bh - 12;
    if y < ay {
        y = mp.y + win_h + 12;
    }
    let x = clamp(x as f64, (ax + 8) as f64, (ax + aw - bw - 8) as f64) as i32;
    let _ = bubble.set_position(tauri::PhysicalPosition::new(x, y));
}

// ------------------------------------------------------------
// 气泡：投递 / 排队 / 握手
// ------------------------------------------------------------

fn present_bubble(app: &AppHandle, entry: &PendingView) {
    let Some(bubble) = ensure_bubble(app) else { return };
    let _ = bubble.emit("permission:request", entry.clone());
    position_bubble(app);
    let _ = bubble.show();
    let _ = bubble.set_focus();
}

fn show_bubble(app: &AppHandle, entry: PendingView) {
    let st = app.state::<AppState>();
    *st.bubble_current.lock().unwrap() = Some(entry.id);
    // 页面还没 ready 就先存着，等 bubble_ready 再投。
    // 这一段是踩过坑才加的：直接 send 的话消息会丢，气泡会一直空白到超时。
    if st.bubble_ready.load(Ordering::SeqCst) {
        present_bubble(app, &entry);
    } else {
        // ⚠️ 但**必须先把窗建出来**。
        //
        // 这一步漏掉的后果不是"少显示一点"，而是整个权限气泡功能彻底不工作：
        // 窗口不存在 → 页面不加载 → 永远不会调 bubble_ready → 待投槽里的请求
        // 就一直躺着，HTTP 那头挂到超时才回落 204，用户从头到尾什么都没看见。
        // （Electron 版是 createBubbleWindow() 里建窗 + once('did-finish-load')
        // 再投，两件事绑在一起；这里被拆成了两个函数，就容易漏。）
        if ensure_bubble(app).is_none() {
            eprintln!("[bubble] 建窗失败，这条权限请求会挂到超时");
            // 建不出来就别装作在处理：立刻以"不表态"结束，让对端回落原生提示。
            st.center.settle(entry.id, permission::Outcome::NoDecision);
            *st.bubble_current.lock().unwrap() = None;
            return;
        }
        *st.bubble_pending.lock().unwrap() = Some(entry);
    }
}

fn handle_notify(app: &AppHandle, n: Notify) {
    let st = app.state::<AppState>();
    match n {
        Notify::Show(view) => {
            let busy = st.bubble_current.lock().unwrap().is_some();
            if busy {
                // 一次只弹一个，避免气泡叠气泡
                st.bubble_queue.lock().unwrap().push_back(view.id);
            } else {
                show_bubble(app, view);
            }
        }
        Notify::Resolved => {
            *st.bubble_current.lock().unwrap() = None;
            if let Some(b) = app.get_webview_window("bubble") {
                let _ = b.hide();
            }
            let next = st.bubble_queue.lock().unwrap().pop_front();
            if let Some(id) = next {
                // 从中心取回这条请求的展示信息
                if let Some(view) = st.center.view_of(id) {
                    show_bubble(app, view);
                }
            }
        }
    }
}

// ------------------------------------------------------------
// 主题
// ------------------------------------------------------------

fn pick_theme_candidates() -> Vec<String> {
    // 优先级：环境变量（回归用）→ 命令行 → 上次选的 → 内置默认。
    let mut out = Vec::new();
    if let Ok(v) = std::env::var("CLAWD_THEME") {
        out.push(v);
    }
    for a in std::env::args() {
        if let Some(v) = a.strip_prefix("--theme=") {
            out.push(v.to_string());
        }
    }
    if let Some(p) = theme::read_preference() {
        out.push(p);
    }
    out.push(DEFAULT_THEME_ID.to_string());
    out
}

fn apply_theme(app: &AppHandle, id: &str, remember: bool) -> Result<String, String> {
    let loaded = theme::load_theme(id)?;
    for w in &loaded.warnings {
        eprintln!("[theme] {w}");
    }
    let name = loaded.theme.name.clone();
    // timings 立刻同步给状态机：换主题后新的 oneshot 时长要马上生效
    if let Some(st) = app.try_state::<AppState>() {
        let t = loaded.theme.timings.clone();
        let mut store = st.store.lock().unwrap();
        store.set_timings(match t {
            Some(t) => Timings {
                oneshot: t.oneshot.into_iter().collect(),
                sleep_after_ms: t.sleep_after_ms,
            },
            None => Timings::default(),
        });
        *st.theme.lock().unwrap() = Some(loaded.theme.clone());
    }
    if remember {
        theme::write_preference(id);
    }
    let _ = app.emit("theme", &loaded.theme);
    // 看板只需要 id 与名字，几百 KB 的帧数据没必要再送一份
    if let Some(d) = app.get_webview_window("dashboard") {
        let _ = d.emit(
            "theme",
            serde_json::json!({ "id": loaded.theme.id, "name": loaded.theme.name }),
        );
    }
    Ok(name)
}

fn toggle_dashboard(app: &AppHandle) {
    let Some(d) = ensure_dashboard(app) else { return };
    if d.is_visible().unwrap_or(false) {
        let _ = d.hide();
        return;
    }
    // 贴着桌宠放，省得用户去任务栏找窗口
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(mp), Ok(ds)) = (main.outer_position(), d.outer_size()) {
            let (ax, ay, aw, ah) = sys::work_area();
            let scale = main.scale_factor().unwrap_or(1.0);
            let win_w = (WIN_W * scale) as i32;
            let win_h = (WIN_H * scale) as i32;
            let dw = ds.width as i32;
            let dh = ds.height as i32;
            let x = mp.x + win_w / 2 - dw / 2;
            let mut y = mp.y - dh - 12;
            if y < ay {
                y = mp.y + win_h + 12;
            }
            let x = clamp(x as f64, (ax + 8) as f64, (ax + aw - dw - 8) as f64) as i32;
            let y = clamp(y as f64, (ay + 8) as f64, (ay + ah - dh - 8) as f64) as i32;
            let _ = d.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = d.show();
    let _ = d.set_focus();
}

// ------------------------------------------------------------
// 命令（前端 invoke 的入口，只暴露"具体动作"）
//
// 每个命令都带一个 `window: WebviewWindow` 参数——Tauri 会把**调用方那个
// webview** 注入进来，于是每条命令都能自己判断"这扇窗有没有资格调我"。
//
// 为什么需要这一层：`withGlobalTauri` 关掉之后，页面上仍留着
// `window.__TAURI_INTERNALS__.invoke`（属性描述符是 writable:false +
// configurable:false，摘不掉）。也就是说**任何能注入脚本的东西都能调任意命令**。
// 前端那 12 个动作只是"方便"，不是边界；边界必须在 Rust 这边。
//
// 不做的替代方案：Tauri v2 的 ACL 能给自定义命令写权限清单，但那要
// build.rs 里生成 manifest + 每个命令一份 toml，改一个命令要动三处。
// 这里 16 条命令、3 个窗口，一张表看得完，就这么写。
// ------------------------------------------------------------

/// 允许调用某条命令的窗口。`main` = index.html（桌宠本体）。
const W_MAIN: &[&str] = &["main"];
const W_BUBBLE: &[&str] = &["bubble"];
const W_DASH: &[&str] = &["dashboard"];
const W_COMPOSE: &[&str] = &["compose"];
/// 「说一句话」的入口有四个，但能力只有一份：猫本体（右键菜单）、输入窗自己
/// （按 Enter / Esc / 重发）、看板（对着某条会话说）。
/// 权限气泡不在名单里——它是一个"拦住你"的窗口，不该同时是一个"替你发话"的窗口。
const W_SAY: &[&str] = &["main", "compose", "dashboard"];

/// 每窗口白名单：不在名单里的调用一律拒绝，并且**要留痕**——
/// 静默返回 Err 的话，将来真出问题时会分不清"没调"和"被拒了"。
fn only(window: &WebviewWindow, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&window.label()) {
        return Ok(());
    }
    eprintln!(
        "[ipc] 拒绝：窗口 {} 调用了不属于它的命令",
        window.label()
    );
    Err(format!("forbidden: window `{}`", window.label()))
}

#[tauri::command]
fn drag_start(window: WebviewWindow, app: AppHandle, st: tauri::State<'_, AppState>) -> Result<(), String> {
    only(&window, W_MAIN)?;
    if st.dragging.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let Some(main) = app.get_webview_window("main") else { return Ok(()) };
    let cursor = sys::cursor_pos();
    let Ok(pos) = main.outer_position() else {
        st.dragging.store(false, Ordering::SeqCst);
        return Ok(());
    };
    *st.drag_origin.lock().unwrap() = Some((cursor, (pos.x, pos.y)));
    Ok(())
}

#[tauri::command]
fn drag_end(window: WebviewWindow, st: tauri::State<'_, AppState>) -> Result<(), String> {
    only(&window, W_MAIN)?;
    st.dragging.store(false, Ordering::SeqCst);
    *st.drag_origin.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
fn mouse_ignore(window: WebviewWindow, app: AppHandle, st: tauri::State<'_, AppState>, ignore: bool) -> Result<(), String> {
    only(&window, W_MAIN)?;
    st.ignore.store(ignore, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(ignore);
    }
    Ok(())
}

// ------------------------------------------------------------
// 命中区：谁决定"这一下点的是猫，还是点穿到桌面"
//
// 为什么这件事必须由宿主来做（2026-11-04 修的一个真 bug）：
//
// 迁移时照抄了 Electron 那套「启动先把整窗设成穿透，渲染层收到 mousemove
// 命中 #pet 再关掉穿透」。这在 Electron 上成立，因为它在 Windows 上用一个
// 低级鼠标钩子把 mousemove **转发**给窗口（`forward: true`）。
//
// Tauri 没有这个能力。`tao` 的 Windows 实现只做一件事：
//     style_ex |= WS_EX_TRANSPARENT | WS_EX_LAYERED
// （`tao-0.37.2/src/platform_impl/windows/window_state.rs`）
// WS_EX_TRANSPARENT 的意思是"我不参与命中测试"——鼠标消息直接交给下层窗口，
// WebView2 一个 mousemove 都收不到。于是那句"收到 mousemove 就关掉穿透"
// **永远等不到触发条件**：整窗永久穿透，拖不动、点不了、双击和右键菜单全哑。
//
// 回归没抓到，因为 CDP 的 `Input.dispatchMouseEvent` 直接注入渲染进程，
// 绕过 OS 的命中测试——合成事件照常触发 DOM 监听，75 条全绿。
//
// 现在的分工：
//   渲染层  上报「猫在哪」（矩形列表，CSS px）——只有它知道分身后每只猫的位置
//   宿主    每 60ms 读一次真实光标，落在矩形里就关掉穿透，离开就开回来
// 这样不依赖 WebView2 能收到鼠标消息，也就不受 WS_EX_TRANSPARENT 影响。
// ------------------------------------------------------------

/// 命中矩形的外扩容差（CSS px）。手指点边比几何边界松一点更顺手。
const HIT_PAD: f64 = 6.0;

fn hit_test(rects: &[[f64; 4]], x: f64, y: f64) -> bool {
    rects.iter().any(|r| {
        x >= r[0] - HIT_PAD && x <= r[0] + r[2] + HIT_PAD && y >= r[1] - HIT_PAD && y <= r[1] + r[3] + HIT_PAD
    })
}

#[tauri::command]
fn hit_rects(window: WebviewWindow, st: tauri::State<'_, AppState>, rects: Vec<[f64; 4]>) -> Result<(), String> {
    only(&window, W_MAIN)?;
    // 最多 4 只猫（渲染层 MAX_CATS），给到 8 已经翻倍有余；再多的直接丢，
    // 免得某天有人把整个 DOM 的 rect 全塞进来。
    let next: Vec<[f64; 4]> = rects
        .into_iter()
        .take(8)
        .map(|r| [r[0], r[1], r[2].max(0.0), r[3].max(0.0)])
        .collect();
    *st.hit.lock().unwrap() = next;
    Ok(())
}

/// 只读诊断：DSH 适配层现在看到了什么。
///
/// 用户说"接上 DSH 了但猫不动"时，这一条能一次区分三种情况：
///   installed=false          路径不对（DSH_HOME / USERPROFILE）
///   polls 在涨但 reads 不涨   文件没变过——不是我们的问题，是那边真的没动静
///   reads 在涨 feeds=0        读到了但没产出事件——会话全是 blank 或全在窗口外
#[tauri::command]
fn dsh_state(window: WebviewWindow, st: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    only(&window, W_MAIN)?;
    let v = st.dsh.lock().unwrap().clone();
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// 只读诊断：用户报"点不到"时，这一条能一次说清是"没命中"还是"没人关穿透"。
#[tauri::command]
fn hit_state(window: WebviewWindow, app: AppHandle, st: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    only(&window, W_MAIN)?;
    let rects = st.hit.lock().unwrap().clone();
    let (cx, cy) = sys::cursor_pos();
    let (pos, scale) = match app.get_webview_window("main").and_then(|w| w.outer_position().ok()) {
        Some(p) => (p, app.get_webview_window("main").and_then(|w| w.scale_factor().ok()).unwrap_or(1.0)),
        None => ((0, 0).into(), 1.0),
    };
    let x = (cx - pos.x) as f64 / scale;
    let y = (cy - pos.y) as f64 / scale;
    Ok(serde_json::json!({
        "ignore": st.ignore.load(Ordering::SeqCst),
        "inside": hit_test(&rects, x, y),
        "rects": rects.len(),
        "cursor": [cx, cy],
        "window": [pos.x, pos.y],
        "scale": scale,
        "local": [x, y],
        "gazeTicks": st.gaze_ticks.load(Ordering::SeqCst),
        "gazePushes": st.gaze_pushes.load(Ordering::SeqCst),
    }))
}

/// 把猫从睡着里叫醒一次。三条来源共用：鼠标压在宠物上（`pet:hover`）、
/// 用户第二次点开图标（单实例锁）、以后可能还有别的"招呼一下"。
fn poke(app: &AppHandle) {
    let Some(st) = app.try_state::<AppState>() else { return };
    let woke = {
        let mut s = st.store.lock().unwrap();
        s.wake()
    };
    if woke {
        let snap = st.store.lock().unwrap().snapshot();
        let _ = app.emit("state", &snap);
        let _ = app.emit("cast", &snap.sessions);
    }
}

#[tauri::command]
fn pet_hover(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, W_MAIN)?;
    poke(&app);
    Ok(())
}

#[tauri::command]
fn app_quit(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, W_MAIN)?;
    // 同理：exit() 是往消息循环投一个"退出"消息就返回，
    // 但消息循环要是正卡在命令线程里，那条消息永远没人处理——表现是"点了退出没反应"。
    std::thread::spawn(move || app.exit(0));
    Ok(())
}

#[tauri::command]
fn pet_menu(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, W_MAIN)?;
    // 菜单挂在**调用方那扇窗**上。白名单已经保证它是 main，
    // 再按 label 取一次只会拿到同一个东西——而且那样写会让
    // "菜单弹在谁身上"取决于两次查询是否一致，多一个不必有的假设。
    let dash = MenuItemBuilder::with_id("dashboard", "会话看板")
        .build(&app)
        .map_err(|e| e.to_string())?;
    // 「说句话」放在第一项：这是桌宠上**唯一**一个能让它替你做点什么的入口，
    // 其余两项（看板 / 退出）都是"看"和"关"。
    let speak = MenuItemBuilder::with_id("say", "说句话…")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(&app)
        .item(&speak)
        .separator()
        .item(&dash)
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn dashboard_toggle(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, W_MAIN)?;
    // 必须挪到别的线程去建窗，不能在命令线程里直接 build()。
    // 理由写在 ensure_dashboard 上：命令线程 == 主线程，在里面建窗会卡死在
    // WebView2 的创建回调上（消息循环正卡在我们这一帧里，没人去泵它）。
    std::thread::spawn(move || toggle_dashboard(&app));
    Ok(())
}

#[tauri::command]
fn dashboard_snapshot(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
) -> Result<Snapshot, String> {
    only(&window, W_DASH)?;
    Ok(st.store.lock().unwrap().snapshot())
}

#[tauri::command]
fn dashboard_copy_path(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    only(&window, W_DASH)?;
    // id 来自渲染层，但这里只按 Map 精确取，取不到就 false——
    // 不存在"拼一个 id 骗出别的会话路径"的路径。
    let full = {
        let s = st.store.lock().unwrap();
        s.full_cwd(&id).map(|v| v.to_string())
    };
    Ok(match full {
        Some(p) => sys::set_clipboard_text(&p),
        None => false,
    })
}

/// 看板的**内容**来源：投影里那些"这条会话到底在干什么"的字段。
///
/// 为什么和 `dashboard_snapshot` 分成两个命令，而不是塞进同一个快照：
///   · 数据源不同——那个来自状态机（250ms 一拍，知道"猫在演什么"），
///     这个来自 DSH 探测线程（1s 一拍，知道"会话里发生了什么"）。
///   · 生命周期不同——`Snapshot` 还会被 HTTP `/state` 和 emit 复用，
///     往里加字段等于让所有消费方一起变；这个只服务看板。
/// 前端按 session id join 起来，两边各给一半事实。
#[tauri::command]
fn dsh_sessions(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
) -> Result<Vec<dsh::RichSession>, String> {
    only(&window, W_DASH)?;
    let v = st.dsh.lock().unwrap();
    let notes = st.say_reply.lock().unwrap();
    let default_model = st.headless_model.lock().unwrap().clone();
    Ok(v.sessions
        .iter()
        .map(|o| {
            let mut r = o.rich();
            // 投影里没有这一轮问答（headless 建的会话就是这样）时，用我们自己
            // 手上那一段补上——否则用户从桌宠发完消息，看板上永远只有标题。
            if let Some(note) = notes.get(&r.id) {
                if r.last_reply.is_none() {
                    r.last_reply = Some(note.reply.clone());
                    r.reply_from_say = true;
                }
                if r.last_prompt.is_none() {
                    r.last_prompt = Some(note.prompt.clone());
                }
            }
            // 同理：headless 会话不写 modelSelection，用 profile 的默认模型补。
            // 必须带 `model_default` 标记出门——"它就是这么配的"和"这条会话
            // 实际用的是它"是两句话，看板上要把这个差别说出来。
            if r.model.is_none() {
                if let Some((p, m)) = default_model.as_ref() {
                    r.provider = Some(p.clone());
                    r.model = Some(m.clone());
                    r.model_default = true;
                }
            }
            r
        })
        .collect())
}

// ------------------------------------------------------------
// 「说一句话」：桌宠 → DSH
//
// 整条链路只有一件事需要判断对：**这句话落到哪个目录、哪条会话上**。
// 两种可能：
//   · 接着某条会话说（`--session-id`）—— 目录必须是它自己的，错了 dsh 直接拒；
//   · 新起一条 —— 目录取"最近干过活的那个"，而不是家目录。
// 两者都由宿主从状态机里查，**不接受渲染层传来的路径**：一个能传路径的接口，
// 就是一个能把 agent 起在任意目录的接口。
// ------------------------------------------------------------

/// 新会话落在哪个目录。第一次算出来就钉在 `new_session_cwd` 上。
///
/// 唯一的判据是"最近真的干过活的那个目录"（`latest_cwd`），但**只算一次**：
/// 输入窗打开时算出的值，就是等下真正 spawn 时用的值。之前是两处各算一次，
/// 于是"窗里写着 A 目录、消息落进 B 目录"——而这不是显示错误，是这条会话
/// 真的起在了另一个项目里。
fn pinned_new_cwd(st: &AppState) -> String {
    let mut pin = st.new_session_cwd.lock().unwrap();
    if let Some(c) = pin.as_ref() {
        return c.clone();
    }
    let c = st
        .store
        .lock()
        .unwrap()
        .latest_cwd()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_else(|| ".".to_string());
    *pin = Some(c.clone());
    c
}

/// 组装"这一次发给谁"，顺便把能不能续判掉。
///
/// 为什么不在点发送的时候才判：`can_resume` 要在窗口打开的那一刻就显示出来。
/// 用户打了半屏字、按回车、然后才知道"这条会话不能续"，那是设计问题不是提示问题。
fn compose_target_of(
    st: &AppState,
    id: Option<String>,
    origin: &str,
) -> Result<ComposeTarget, String> {
    // DSH 侧"这条会话记过 agentPreset 吗"——记过就不能被一次性 runner 续。
    // 判据见 say.rs 文件头第 3 条（`assertAdoptable`）。
    let resumable: std::collections::HashSet<String> = st
        .dsh
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|o| o.agent_preset.is_none())
        .map(|o| o.id.clone())
        .collect();

    match id {
        Some(id) => {
            let (cwd, title) = {
                let store = st.store.lock().unwrap();
                let cwd = store.full_cwd(&id).map(|s| s.to_string());
                let title = store
                    .snapshot()
                    .sessions
                    .into_iter()
                    .find(|s| s.id == id)
                    .and_then(|s| s.title);
                (cwd, title)
            };
            Ok(ComposeTarget {
                can_resume: resumable.contains(&id),
                cwd: state::tail_cwd(&cwd),
                id: Some(id),
                title,
                origin: origin.to_string(),
            })
        }
        None => Ok(ComposeTarget {
            id: None,
            title: None,
            cwd: state::tail_cwd(&Some(pinned_new_cwd(st))),
            // 新会话没有 preset，天然可以（也就是等下一条消息还能接着它）。
            can_resume: true,
            origin: origin.to_string(),
        }),
    }
}

/// 打开输入窗。`id` 为空 = 新起一条。
///
/// 抽成自由函数是因为它有两个调用方：命令（渲染层点泡泡里的 ✎）和
/// **右键菜单**（用户从猫身上直接发起）。后者没有调用方窗口可注入，
/// 只能走这条路。
fn open_compose(app: &AppHandle, id: Option<String>, origin: &str) -> Result<ComposeTarget, String> {
    let target = {
        let st = app.state::<AppState>();
        let t = compose_target_of(&st, id.filter(|s| !s.is_empty()), origin)?;
        *st.compose_target.lock().unwrap() = Some(t.clone());
        t
    };
    // 建窗必须离开命令线程（理由见 dashboard_toggle）：菜单事件跑在主线程上，
    // 直接 build() 会卡在 WebView2 的创建回调里，而消息循环正停在处理这一帧。
    let app = app.clone();
    let t = target.clone();
    let origin = origin.to_string();
    std::thread::spawn(move || {
        let Some(w) = ensure_compose(&app) else { return };
        // 先把这一次的目标告诉页面，再显示——反过来会有一帧显示的是上一次的目标。
        let _ = w.emit("compose:open", t);
        position_compose(&app, &origin);
        let _ = w.show();
        // 必须抢焦点：这个窗存在的意义就是"接下你要打的字"。
        let _ = w.set_focus();
    });
    Ok(target)
}

#[tauri::command]
fn compose_open(
    window: WebviewWindow,
    app: AppHandle,
    id: Option<String>,
) -> Result<ComposeTarget, String> {
    // 两扇窗都能叫它：桌宠（右键菜单 / 泡泡）和看板（每条会话的「说」）。
    only(&window, &["main", "dashboard"])?;
    open_compose(&app, id, window.label())
}

/// 页面加载完自己来要一次目标（第一次打开时 emit 会赶在页面就绪之前）。
#[tauri::command]
fn compose_context(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
) -> Result<Option<ComposeTarget>, String> {
    only(&window, W_COMPOSE)?;
    Ok(st.compose_target.lock().unwrap().clone())
}

#[tauri::command]
fn compose_close(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, W_COMPOSE)?;
    if let Some(w) = app.get_webview_window("compose") {
        let _ = w.hide();
    }
    Ok(())
}

/// 真正把话送出去。立即返回（不阻塞 UI），结局通过 `say:done` 事件回传。
#[tauri::command]
fn say_send(
    window: WebviewWindow,
    app: AppHandle,
    st: tauri::State<'_, AppState>,
    id: Option<String>,
    text: String,
) -> Result<serde_json::Value, String> {
    only(&window, W_SAY)?;

    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("还没写要说什么".to_string());
    }
    if text.chars().count() > say::MAX_TEXT_CHARS {
        return Err(format!("太长了（最多 {} 字）", say::MAX_TEXT_CHARS));
    }

    // 目标与目录一律从状态机里查（见本节开头）。
    // 新会话走 `pinned_new_cwd`：和输入窗上显示的是同一个值——不然用户看到的
    // 目录和实际落地的目录会分叉（那段注释在 pinned_new_cwd 上）。
    let (id, cwd) = match id.filter(|s| !s.is_empty()) {
        Some(id) => {
            let cwd = st
                .store
                .lock()
                .unwrap()
                .full_cwd(&id)
                .ok_or_else(|| "这条会话已经不在了".to_string())?
                .to_string();
            (Some(id), cwd)
        }
        None => (None, pinned_new_cwd(&st)),
    };
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(format!("目录不在了：{cwd}"));
    }

    let Some(l) = say::locate() else {
        return Err("找不到 dsh（PATH 里没有 @deepseek-ai/dsh）".to_string());
    };

    // 同一目标只允许一条在飞：
    //   · 两个进程同时写一条会话，后来的那个会被独占写句柄直接拒（实测 8 抢 1），
    //     也就是"点了没反应还得等报错"；
    //   · 连点两下 = 起两个 node 各跑一遍同一条指令，用户看到的是"发了两遍"。
    let key = id.clone().unwrap_or_else(|| "(new)".to_string());
    let cancel = {
        let mut jobs = st.say_jobs.lock().unwrap();
        if jobs.contains_key(&key) {
            return Err("还在回上一条，等它说完".to_string());
        }
        let c = Arc::new(std::sync::atomic::AtomicBool::new(false));
        jobs.insert(key.clone(), c.clone());
        c
    };

    let (child, captured) = match say::start(&l, id.as_deref(), &cwd, &text) {
        Ok(c) => c,
        Err(e) => {
            st.say_jobs.lock().unwrap().remove(&key);
            return Err(e);
        }
    };

    let emit_id = id.clone();
    let job_key = key.clone();
    let said = text.clone();
    std::thread::spawn(move || {
        let verdict = say::wait(child, &cancel);
        // 先取快照再收尾：`captured` 里的 id 是**新会话真正的那一个**，
        // 前端只有拿到它，看板才能把这次的回答挂到正确的卡片上。
        let (sid, reply) = {
            let c = captured.lock().unwrap();
            (c.session_id.clone(), c.reply())
        };
        let final_id = sid.clone().or(emit_id);
        if let (Some(sid), Some(reply)) = (sid.as_ref(), reply.as_ref()) {
            if let Some(st) = app.try_state::<AppState>() {
                let mut m = st.say_reply.lock().unwrap();
                m.insert(
                    sid.clone(),
                    SayNote {
                        prompt: said.clone(),
                        reply: reply.clone(),
                    },
                );
                // 只留最近 40 条：这是"补充说明"，不是第二份会话数据库。
                if m.len() > 40 {
                    let drop: Vec<String> = m.keys().take(m.len() - 40).cloned().collect();
                    for k in drop {
                        m.remove(&k);
                    }
                }
            }
        }
        if let Some(st) = app.try_state::<AppState>() {
            st.say_jobs.lock().unwrap().remove(&job_key);
        }
        let (ok, message) = match verdict {
            say::Verdict::Ok => (true, String::new()),
            say::Verdict::Cancelled => (false, "已停止".to_string()),
            say::Verdict::Failed(m) => (false, m),
        };
        let _ = app.emit(
            "say:done",
            serde_json::json!({
                "id": final_id, "ok": ok, "message": message,
                "reply": reply,
                // 原话带回去：失败时输入窗要把它放回输入框，用户改一改就能重发。
                "prompt": said,
            }),
        );
        // 这扇窗在"送出"那一刻就自己藏了（420ms 的即时反馈），而失败是几十秒后才知道的
        // （模型 401 / 网络断 / 45 分钟超时）。不把它重新亮出来，用户就永远看不到——
        // **这是唯一一处"发送之后还有话说"的场合**，所以宁可打扰一次。
        if !ok {
            if let Some(w) = app.get_webview_window("compose") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        // 一条诊断：用户说"发了没反应"时，先看这一行有没有出现。
        // 它同时回答了三个问题：进程结束了没有、有没有拿到 id、有没有抓到答案。
        eprintln!(
            "[say] 收工 ok={ok} id={:?} reply={}",
            final_id,
            reply.as_ref().map(|r| r.lines().next().unwrap_or("").chars().take(24).collect::<String>()).unwrap_or_default()
        );
    });

    Ok(serde_json::json!({ "ok": true, "target": key, "cwd": state::public_cwd(&Some(cwd)) }))
}

#[tauri::command]
fn theme_get(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
) -> Result<Option<theme::Theme>, String> {
    only(&window, W_MAIN)?;
    Ok(st.theme.lock().unwrap().clone())
}

#[tauri::command]
fn theme_list(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    only(&window, W_DASH)?;
    let current = st.theme.lock().unwrap().as_ref().map(|t| t.id.clone());
    Ok(serde_json::json!({ "current": current, "themes": theme::list_themes() }))
}

#[tauri::command]
fn theme_set(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
) -> Result<serde_json::Value, String> {
    only(&window, W_DASH)?;
    Ok(match apply_theme(&app, &id, true) {
        Ok(name) => serde_json::json!({ "ok": true, "id": id, "name": name }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    })
}

#[tauri::command]
fn permission_decide(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
    id: u64,
    decision: String,
) -> Result<bool, String> {
    only(&window, W_BUBBLE)?;
    Ok(st.center.decide(id, &decision))
}

#[tauri::command]
fn bubble_ready(
    window: WebviewWindow,
    app: AppHandle,
    st: tauri::State<'_, AppState>,
) -> Result<(), String> {
    only(&window, W_BUBBLE)?;
    st.bubble_ready.store(true, Ordering::SeqCst);
    let pending = st.bubble_pending.lock().unwrap().take();
    if let Some(entry) = pending {
        let current = *st.bubble_current.lock().unwrap();
        // 只有在等待期间这个请求还没被 resolve 掉才需要展示
        if current == Some(entry.id) {
            present_bubble(&app, &entry);
        }
    }
    Ok(())
}

#[tauri::command]
fn bubble_height(window: WebviewWindow, app: AppHandle, h: f64) -> Result<(), String> {
    only(&window, W_BUBBLE)?;
    let Some(bubble) = app.get_webview_window("bubble") else { return Ok(()) };
    let clamped = clamp(h.round(), 80.0, 460.0);
    let _ = bubble.set_size(tauri::LogicalSize::new(BUBBLE_W, clamped));
    position_bubble(&app);
    Ok(())
}

#[tauri::command]
fn bubble_dismiss(
    window: WebviewWindow,
    st: tauri::State<'_, AppState>,
    id: u64,
) -> Result<(), String> {
    only(&window, W_BUBBLE)?;
    // 用户直接关掉气泡 = "不表态"，走 204
    st.center.settle(id, permission::Outcome::NoDecision);
    Ok(())
}

// ------------------------------------------------------------
// 定时器
// ------------------------------------------------------------

fn spawn_timers(app: AppHandle) {
    // ---- 状态机心跳 250ms ----
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(state::TICK_MS));
            let st = app.state::<AppState>();
            let (snap, changed) = {
                let mut s = st.store.lock().unwrap();
                let changed = s.tick();
                (s.snapshot(), changed)
            };
            if changed {
                let _ = app.emit("state", &snap);
            }
        });
    }

    // ---- 分身名单 1s ----
    // 为什么不能顺手塞进 state：state 只在 visual 变化时推，而每条会话自己的
    // 状态、泡泡里那行标题、闲了多久，都会在没有 visual 变化时照常变。
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(CAST_PUSH_MS));
            let st = app.state::<AppState>();
            let snap = st.store.lock().unwrap().snapshot();
            let _ = app.emit("cast", &snap.sessions);
        });
    }

    // ---- DSH 适配层 1s ----
    //
    // 这是第二个**事件来源**（第一个是 server.rs 的 /state，hook 在用）。
    // 两者最终都走 Store::apply，所以仲裁、oneshot 时长、睡意计时完全一致。
    //
    // 为什么必须在这里 emit：apply() 内部会调 tick()，而 tick() 把 last_visual
    // 一并更新了。也就是说上面那个 250ms 的心跳线程**看不到**这次变化
    // （它比较的就是 last_visual），不在这里推，这一帧就永远不发出去。
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut probe = dsh::Probe::new();
            loop {
                std::thread::sleep(dsh::Probe::interval());
                let events = probe.poll();
                if !events.is_empty() {
                    let st = app.state::<AppState>();
                    let (snap, changed) = {
                        let mut s = st.store.lock().unwrap();
                        let mut changed = false;
                        for p in &events {
                            let (_, c) = s.apply(p);
                            changed = changed || c;
                        }
                        (s.snapshot(), changed)
                    };
                    if changed {
                        let _ = app.emit("state", &snap);
                    }
                }
                // 诊断视图每拍都刷：polls / reads 这两个计数本身要能看出"线程还在跑"，
                // 只在有事件时更新的话，一个安静的 DSH 会看起来像死了。
                *app.state::<AppState>().dsh.lock().unwrap() = probe.view();
            }
        });
    }

    // ---- 命中看门狗 60ms：整窗穿不穿透，由「真实光标在不在猫身上」决定 ----
    //
    // 这是 2026-11-04 那个"拖不动、完全没交互"的修复点。为什么必须由宿主轮询、
    // 不能等页面告诉我"鼠标进来了"——见上面 hit_rects 那段注释（WS_EX_TRANSPARENT
    // 一旦设上，WebView2 连 mousemove 都收不到，等它回话就是死锁）。
    //
    // 60ms 是"手感"与"空闲开销"的折中：比它慢，鼠标已经在猫身上了窗口还没接管；
    // 比它快，GetCursorPos + Mutex 的唤醒频率白涨。GetCursorPos 本身不进内核等待，
    // 代价可以忽略——gaze 线程已经在用同样的节拍读它。
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(60));
            let Some(win) = app.get_webview_window("main") else { continue };
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let st = app.state::<AppState>();
            let Ok(pos) = win.outer_position() else { continue };
            let scale = win.scale_factor().unwrap_or(1.0);
            let (cx, cy) = sys::cursor_pos();
            let inside = {
                let rects = st.hit.lock().unwrap();
                // 渲染层还没上报（启动后的头几十毫秒，或者页面挂了）：当成整窗可交互。
                // 宁可暂时挡一下桌面，也不要让用户面对一只点不动的猫。
                if rects.is_empty() {
                    true
                } else {
                    let x = (cx - pos.x) as f64 / scale;
                    let y = (cy - pos.y) as f64 / scale;
                    hit_test(&rects, x, y)
                }
            };
            // 拖动中一律不穿透。这一条不是保险，是必需的：拖窗口时窗口在追光标，
            // 60ms 的判定会慢半拍，某一拍算出的 local 可能落在矩形外——一旦那一拍
            // 把窗口设成穿透，页面就收不到 pointerup，`drag_end` 永远不会来，
            // `dragging` 卡在 true，之后鼠标怎么动窗口都跟着走。
            let inside = inside || st.dragging.load(Ordering::SeqCst);
            let want = !inside;
            if st.ignore.swap(want, Ordering::SeqCst) != want {
                let _ = win.set_ignore_cursor_events(want);
            }
        });
    }

    // ---- gaze：主进程读全局光标，归一化后推给渲染层 ----
    // 窗口只有 240×240，光标绝大多数时间在窗口外面，renderer 根本收不到 mousemove。
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(100));
            let Some(win) = app.get_webview_window("main") else { continue };
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { continue };
            let (cx, cy) = sys::cursor_pos();
            let nx = clamp((cx - (pos.x + size.width as i32 / 2)) as f64 / 260.0, -1.0, 1.0);
            let ny = clamp((cy - (pos.y + size.height as i32 / 2)) as f64 / 260.0, -1.0, 1.0);
            // 变化太小就不发，省 IPC 也省电
            let st = app.state::<AppState>();
            st.gaze_ticks.fetch_add(1, Ordering::SeqCst);
            let ox = st.gaze_x.load(Ordering::SeqCst) as f64 / 1000.0;
            let oy = st.gaze_y.load(Ordering::SeqCst) as f64 / 1000.0;
            if (nx - ox).abs() < 0.02 && (ny - oy).abs() < 0.02 {
                continue;
            }
            st.gaze_x.store((nx * 1000.0) as i32, Ordering::SeqCst);
            st.gaze_y.store((ny * 1000.0) as i32, Ordering::SeqCst);
            st.gaze_pushes.fetch_add(1, Ordering::SeqCst);
            let _ = app.emit("gaze", serde_json::json!({ "x": nx, "y": ny }));
        });
    }

    // ---- 拖动：16ms 轮询全局光标 ----
    // 为什么必须轮询？窗口跟着光标移动后，光标在窗口内的相对位置不变，
    // renderer 就再也收不到 mousemove 了。
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let st = app.state::<AppState>();
            if !st.dragging.load(Ordering::SeqCst) {
                continue;
            }
            let Some(origin) = *st.drag_origin.lock().unwrap() else { continue };
            let (cx, cy) = sys::cursor_pos();
            let x = origin.1 .0 + (cx - origin.0 .0);
            let y = origin.1 .1 + (cy - origin.0 .1);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            }
        });
    }

    // ---- SEC-07：锁屏 / 休眠时把窗口收起来 ----
    // 'screen-saver' 是最高常规层级，不收起来会浮在锁屏界面之上；
    // 而气泡里会显示"正在执行什么命令"，看板会列出项目目录名——那就是信息泄露。
    //
    // S10-6③ 起走事件（`WTSRegisterSessionNotification`），不再是 2s 轮询。
    // 轮询留着，但只在注册失败时启动：非交互会话 / 以后换权限模型都可能注册不上，
    // 那时不能让 SEC-07 直接失效——**宁可 2 秒后才藏，也不要一直亮在锁屏界面上**。
    {
        let watcher_app = app.clone();
        let wired = sys::watch_session(move |locked| {
            // 回调跑在那条消息线程上。这里再 spawn 一次，是为了不在 WndProc 里
            // 长时间阻塞（隐藏/显示窗口要投递到主线程并能等到回执）。
            // 锁屏事件一天也就几次，一个线程的代价可以忽略。
            let app = watcher_app.clone();
            std::thread::spawn(move || apply_lock(&app, locked));
        });
        if !wired {
            eprintln!("[lock] 会话通知注册失败，退回 2s 轮询（最多晚 2 秒藏窗口）");
            let app = app.clone();
            std::thread::spawn(move || {
                let mut last = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                    let locked = sys::is_locked();
                    if locked == last {
                        continue;
                    }
                    last = locked;
                    apply_lock(&app, locked);
                }
            });
        }
    }
}

/// 锁屏时把三扇窗收起来，解锁时只把"本来就该在的"放回去。
///
/// 放回去的判据是 `hidden_by_lock`：只有"被我们藏起来的"才需要重新显示。
/// 看板不参与——它是用户自己开的窗口，锁屏前没开就不该在解锁后凭空出现。
fn apply_lock(app: &AppHandle, locked: bool) {
    let Some(st) = app.try_state::<AppState>() else { return };
    if locked {
        st.hidden_by_lock.store(true, Ordering::SeqCst);
        for id in ["main", "bubble", "dashboard"] {
            if let Some(w) = app.get_webview_window(id) {
                let _ = w.hide();
            }
        }
    } else if st.hidden_by_lock.swap(false, Ordering::SeqCst) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
        }
        if st.bubble_current.lock().unwrap().is_some() {
            if let Some(b) = app.get_webview_window("bubble") {
                let _ = b.show();
            }
        }
    }
}

// ------------------------------------------------------------
// 托盘
// ------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let dash = MenuItemBuilder::with_id("tray-dashboard", "会话看板").build(app)?;
    // 勾是**从注册表读回来的**，不是本地变量——别的进程（或重装）改过之后，
    // 菜单上显示的就是错的。读一次很便宜，错一次很难查。
    let auto = CheckMenuItemBuilder::with_id("tray-autostart", "开机自启")
        .checked(sys::autostart_enabled())
        .build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&dash)
        .item(&auto)
        .separator()
        .item(&quit)
        .build()?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let auto_for_event = auto.clone();
    TrayIconBuilder::with_id("clawd-tray")
        .icon(icon)
        .tooltip("Clawd · 桌宠")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "tray-dashboard" => toggle_dashboard(app),
            "tray-autostart" => toggle_autostart(app, &auto_for_event),
            "tray-quit" => app.exit(0),
            // 猫身上那个弹出菜单（pet_menu）。它没有 per-menu 回调，
            // 走的就是这条全局事件——所以在写「说句话」这一项时顺手把
            // 原来那两项也接上：它们此前只存在于模板里，没人处理。
            "say" => {
                if let Err(e) = open_compose(app, None, "main") {
                    eprintln!("[compose] 打不开发消息窗口：{e}");
                }
            }
            "dashboard" => toggle_dashboard(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// 开关开机自启，并把勾同步回菜单。
///
/// 先按"读回来的当前状态"取反，再真的去写，写成功才动勾——
/// 顺序反过来（先动勾再写）会让菜单在写入失败时说谎。
fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<tauri::Wry>) {
    let want = !sys::autostart_enabled();
    match sys::autostart_set(want) {
        Ok(()) => {
            if let Err(e) = item.set_checked(want) {
                eprintln!("[autostart] 状态已改，但菜单上的勾没同步：{e}");
            }
            let _ = app.emit("autostart", want);
        }
        Err(e) => eprintln!("[autostart] 改开机自启失败：{e}"),
    }
}

fn main() {
    // ---- 单实例锁：必须在**一切之前** ----
    // 端口、端点文件、托盘图标全是"每个进程一份"的东西。第二份进程一旦走到
    // setup，就会 bind 23333 失败 → 退回随机端口 → 覆盖端点文件，
    // 于是 hook 把事件送进第二份，而用户看的是第一份那只猫：画面永远不动。
    //
    // （历史上 Electron 版靠 main.js 的 requestSingleInstanceLock 干这件事，
    // 迁移时漏了，现在补上。）
    let Some(_instance) = single::acquire() else {
        eprintln!("[single] 已经有一份在跑，这份只负责叫醒它");
        single::wake_first();
        return;
    };

    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // 主题必须先定：渲染层一加载就会 invoke("theme:get")，
            // 那时 theme 必须有值，否则第一帧是空白。
            let resolved = theme::resolve_theme(&pick_theme_candidates(), DEFAULT_THEME_ID);
            if let Some(err) = &resolved.1 {
                eprintln!("[theme] 有主题没加载成功：{err}");
            }
            let initial_timings = match resolved.0.as_ref().and_then(|t| t.timings.as_ref()) {
                Some(t) => Timings {
                    oneshot: t.oneshot.clone().into_iter().collect(),
                    sleep_after_ms: t.sleep_after_ms,
                },
                None => Timings::default(),
            };

            let store = Arc::new(Mutex::new(Store::new(initial_timings)));
            let notify_handle = handle.clone();
            let center = Arc::new(Center::new(Box::new(move |n| {
                handle_notify(&notify_handle, n);
            })));

            app.manage(AppState {
                store: store.clone(),
                center: center.clone(),
                theme: Mutex::new(resolved.0.clone()),
                bubble_current: Mutex::new(None),
                bubble_queue: Mutex::new(std::collections::VecDeque::new()),
                bubble_ready: AtomicBool::new(false),
                bubble_pending: Mutex::new(None),
                dragging: AtomicBool::new(false),
                drag_origin: Mutex::new(None),
                hidden_by_lock: AtomicBool::new(false),
                gaze_x: AtomicI32::new(0),
                gaze_y: AtomicI32::new(0),
                hit: Mutex::new(Vec::new()),
                ignore: AtomicBool::new(true),
                gaze_ticks: AtomicU64::new(0),
                gaze_pushes: AtomicU64::new(0),
                dsh: Mutex::new(dsh::ProbeView::default()),
                say_jobs: Mutex::new(std::collections::HashMap::new()),
                say_reply: Mutex::new(std::collections::HashMap::new()),
                compose_target: Mutex::new(None),
                new_session_cwd: Mutex::new(None),
                headless_model: Mutex::new(None),
            });

            // ---- headless 的默认模型 ----
            // 看板上这些会话的「用哪个模型」只能这样拿：`dsh headless` 建的会话
            // 在投影里不写 `modelSelection`（那一行是桌面/网页端写的）。
            // `--dump-config` 是配置的权威展开（0.2 秒），查一次就够——
            // 它由用户的 profile 决定，改了 profile 本来就要重启应用。
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                    let Some(l) = say::locate() else { return };
                    let Some(pm) = say::default_model(&l) else { return };
                    let st = h.state::<AppState>();
                    *st.headless_model.lock().unwrap() = Some(pm);
                });
            }

            // ---- 单实例的另一半：等第二份进程来捅 ----
            // 锁在 main() 开头已经抢过了，这里只开那个命名事件。
            // 为什么要有这一下：Electron 的 second-instance 语义会 focus 窗口，
            // 但桌宠窗口是 skip_taskbar + focused(false) 的，抢焦点等于打断用户；
            // 让它醒一下是同一个意思又不动别人的鼠标。
            {
                let h = handle.clone();
                single::watch(move || poke(&h));
            }

            // ---- HTTP ----
            let token = server::random_token();
            let port_file = server::port_file_path();
            // 推画面的回调。server 不认识 tauri，由这里把"变了"翻译成 emit。
            //
            // 为什么非得有这么一条：apply() 内部已经调过 tick()，tick() 会顺手
            // 把 last_visual 更新掉。等 250ms 心跳再 tick()，它比的是"新值 vs 新值"，
            // 返回 false——这次变化就永远不会被推出去。这条回调就是当年 Electron 版
            // onChange 的等价物（迁移时的教训，留下防止哪天"顺手优化"掉它）。
            let state_handle = handle.clone();
            let on_change: server::OnChange = Arc::new(move |snap: &state::Snapshot| {
                let _ = state_handle.emit("state", snap);
            });
            let _srv = server::start(store, center, port_file, token, on_change);

            // ---- 窗口 ----
            let win = build_main_window(&handle)?;
            // 先整窗穿透（四角不该挡住桌面），但**不靠页面通知来解除**——
            // 由 spawn_timers 里的 60ms 命中看门狗按"光标在不在猫身上"纠正。
            // 参见 hit_rects 的注释：Windows 上设了 WS_EX_TRANSPARENT 之后，
            // 页面收不到 mousemove，"页面说可以了"这条路是死的。
            let _ = win.set_ignore_cursor_events(true);
            let _ = win.show();

            let _ = build_tray(&handle);
            spawn_timers(handle.clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "bubble" {
                    let app = window.app_handle().clone();
                    let st = app.state::<AppState>();
                    st.bubble_ready.store(false, Ordering::SeqCst);
                    *st.bubble_pending.lock().unwrap() = None;
                    *st.bubble_current.lock().unwrap() = None;
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            drag_start,
            drag_end,
            mouse_ignore,
            hit_rects,
            hit_state,
            dsh_state,
            pet_hover,
            app_quit,
            pet_menu,
            dashboard_toggle,
            dashboard_snapshot,
            dashboard_copy_path,
            dsh_sessions,
            compose_open,
            compose_context,
            compose_close,
            say_send,
            theme_get,
            theme_list,
            theme_set,
            permission_decide,
            bubble_ready,
            bubble_height,
            bubble_dismiss,
        ])
        .build(tauri::generate_context!())
        .expect("tauri 启动失败");

    // 退出清理：把挂着的权限请求全部以 204 结束（否则对端的 HTTP 连接会一直悬着，
    // 而用户已经看不到气泡了），再删掉端点文件（否则 hook 会拿着旧端口去连）。
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(st) = app_handle.try_state::<AppState>() {
                st.center.dispose();
            }
            let _ = std::fs::remove_file(server::port_file_path());
        }
    });
}
