// 桌面宠物：Rust 侧只做「窗口容器 + 状态机 + HTTP」，画面全部交给 WebView2 里的前端。
//
// 与 Electron 版的对应关系（迁移时逐条对着改，不要凭印象）：
//   main.js 的 BrowserWindow          → 这里三个窗口（main / bubble / dashboard）
//   ipcMain.on(…)/handle(…)           → #[tauri::command]（前端 invoke）
//   webContents.send(…)               → app.emit(…)
//   screen.getCursorScreenPoint()     → sys::cursor_pos()
//   powerMonitor lock/suspend         → sys::is_locked() 轮询
//   Menu.popup                        → tauri::menu 的 ContextMenu
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod permission;
mod risk;
mod server;
mod single;
mod state;
mod sys;
mod theme;

use permission::{Center, Notify, PendingView};
use state::{Snapshot, Store, Timings};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{ContextMenu, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const WIN_W: f64 = 240.0;
const WIN_H: f64 = 240.0;
const BUBBLE_W: f64 = 360.0;
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
// ------------------------------------------------------------

#[tauri::command]
fn drag_start(app: AppHandle, st: tauri::State<'_, AppState>) {
    if st.dragging.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(main) = app.get_webview_window("main") else { return };
    let cursor = sys::cursor_pos();
    let Ok(pos) = main.outer_position() else {
        st.dragging.store(false, Ordering::SeqCst);
        return;
    };
    *st.drag_origin.lock().unwrap() = Some((cursor, (pos.x, pos.y)));
}

#[tauri::command]
fn drag_end(st: tauri::State<'_, AppState>) {
    st.dragging.store(false, Ordering::SeqCst);
    *st.drag_origin.lock().unwrap() = None;
}

#[tauri::command]
fn mouse_ignore(app: AppHandle, ignore: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(ignore);
    }
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
fn pet_hover(app: AppHandle) {
    poke(&app);
}

#[tauri::command]
fn app_quit(app: AppHandle) {
    // 同理：exit() 是往消息循环投一个"退出"消息就返回，
    // 但消息循环要是正卡在命令线程里，那条消息永远没人处理——表现是"点了退出没反应"。
    std::thread::spawn(move || app.exit(0));
}

#[tauri::command]
fn pet_menu(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("没有主窗口")?;
    let dash = MenuItemBuilder::with_id("dashboard", "会话看板")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", "退出")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let menu = MenuBuilder::new(&app)
        .item(&dash)
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn dashboard_toggle(app: AppHandle) {
    // 必须挪到别的线程去建窗，不能在命令线程里直接 build()。
    // 理由写在 ensure_dashboard 上：命令线程 == 主线程，在里面建窗会卡死在
    // WebView2 的创建回调上（消息循环正卡在我们这一帧里，没人去泵它）。
    std::thread::spawn(move || toggle_dashboard(&app));
}

#[tauri::command]
fn dashboard_snapshot(st: tauri::State<'_, AppState>) -> Snapshot {
    st.store.lock().unwrap().snapshot()
}

#[tauri::command]
fn dashboard_copy_path(st: tauri::State<'_, AppState>, id: String) -> bool {
    // id 来自渲染层，但这里只按 Map 精确取，取不到就 false——
    // 不存在"拼一个 id 骗出别的会话路径"的路径。
    let full = {
        let s = st.store.lock().unwrap();
        s.full_cwd(&id).map(|v| v.to_string())
    };
    match full {
        Some(p) => sys::set_clipboard_text(&p),
        None => false,
    }
}

#[tauri::command]
fn theme_get(st: tauri::State<'_, AppState>) -> Option<theme::Theme> {
    st.theme.lock().unwrap().clone()
}

#[tauri::command]
fn theme_list(st: tauri::State<'_, AppState>) -> serde_json::Value {
    let current = st.theme.lock().unwrap().as_ref().map(|t| t.id.clone());
    serde_json::json!({ "current": current, "themes": theme::list_themes() })
}

#[tauri::command]
fn theme_set(app: AppHandle, id: String) -> serde_json::Value {
    match apply_theme(&app, &id, true) {
        Ok(name) => serde_json::json!({ "ok": true, "id": id, "name": name }),
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
fn permission_decide(st: tauri::State<'_, AppState>, id: u64, decision: String) -> bool {
    st.center.decide(id, &decision)
}

#[tauri::command]
fn bubble_ready(app: AppHandle, st: tauri::State<'_, AppState>) {
    st.bubble_ready.store(true, Ordering::SeqCst);
    let pending = st.bubble_pending.lock().unwrap().take();
    if let Some(entry) = pending {
        let current = *st.bubble_current.lock().unwrap();
        // 只有在等待期间这个请求还没被 resolve 掉才需要展示
        if current == Some(entry.id) {
            present_bubble(&app, &entry);
        }
    }
}

#[tauri::command]
fn bubble_height(app: AppHandle, h: f64) {
    let Some(bubble) = app.get_webview_window("bubble") else { return };
    let clamped = clamp(h.round(), 80.0, 460.0);
    let _ = bubble.set_size(tauri::LogicalSize::new(BUBBLE_W, clamped));
    position_bubble(&app);
}

#[tauri::command]
fn bubble_dismiss(st: tauri::State<'_, AppState>, id: u64) {
    // 用户直接关掉气泡 = "不表态"，走 204
    st.center.settle(id, permission::Outcome::NoDecision);
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
    // 状态、头巾上的词、闲了多久，都会在没有 visual 变化时照常变。
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(CAST_PUSH_MS));
            let st = app.state::<AppState>();
            let snap = st.store.lock().unwrap().snapshot();
            let _ = app.emit("cast", &snap.sessions);
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
            let ox = st.gaze_x.load(Ordering::SeqCst) as f64 / 1000.0;
            let oy = st.gaze_y.load(Ordering::SeqCst) as f64 / 1000.0;
            if (nx - ox).abs() < 0.02 && (ny - oy).abs() < 0.02 {
                continue;
            }
            st.gaze_x.store((nx * 1000.0) as i32, Ordering::SeqCst);
            st.gaze_y.store((ny * 1000.0) as i32, Ordering::SeqCst);
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
    {
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
                let st = app.state::<AppState>();
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
        });
    }
}

// ------------------------------------------------------------
// 托盘
// ------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let dash = MenuItemBuilder::with_id("tray-dashboard", "会话看板").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&dash)
        .separator()
        .item(&quit)
        .build()?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id("clawd-tray")
        .icon(icon)
        .tooltip("Clawd · 桌宠")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-dashboard" => toggle_dashboard(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    // ---- 单实例锁：必须在**一切之前** ----
    // 端口、端点文件、托盘图标全是"每个进程一份"的东西。第二份进程一旦走到
    // setup，就会 bind 23333 失败 → 退回随机端口 → 覆盖端点文件，
    // 于是 hook 把事件送进第二份，而用户看的是第一份那只猫：画面永远不动。
    //
    // Electron 版就是这一段（main.js:28 的 requestSingleInstanceLock），
    // 迁移时漏了，现在补上。
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
            });

            // ---- 单实例的另一半：等第二份进程来捅 ----
            // 锁在 main() 开头已经抢过了，这里只开那个命名事件。
            // 为什么要有这一下：Electron 的 second-instance 会 focus 窗口，
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
            // 返回 false——这次变化就永远不会被推出去。Electron 版靠 state.js 的
            // onChange 回调，这里必须补上等价物，否则就是"POST 全成功、画面不动"。
            let state_handle = handle.clone();
            let on_change: server::OnChange = Arc::new(move |snap: &state::Snapshot| {
                let _ = state_handle.emit("state", snap);
            });
            let _srv = server::start(store, center, port_file, token, on_change);

            // ---- 窗口 ----
            let win = build_main_window(&handle)?;
            let _ = win.set_ignore_cursor_events(true); // 先全体穿透，命中宠物才关
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
            pet_hover,
            app_quit,
            pet_menu,
            dashboard_toggle,
            dashboard_snapshot,
            dashboard_copy_path,
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
