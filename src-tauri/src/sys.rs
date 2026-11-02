// ============================================================
// Windows 系统集成（Electron 版由 Electron API 提供的五件事）
//
//   screen.getCursorScreenPoint()   → cursor_pos()      拖动 + gaze 都要
//   screen.getPrimaryDisplay().workArea → work_area()   贴边定位
//   clipboard.writeText()           → set_clipboard_text()
//   powerMonitor lock-screen/suspend → watch_session()   SEC-07 锁屏时收起窗口
//   app.setLoginItemSettings()      → autostart_set()   开机自启（默认关）
//
// 为什么不用 Tauri 的插件：托盘/剪贴板各自要带一个插件 + 一份权限声明，
// 而这里只需要几个系统调用。直接调 user32 更小、也没有额外的 IPC 层。
// 开机自启同理——`tauri-plugin-autostart` 会连带 11 个包（auto-launch / dirs /
// os_info / objc2-* …），而它做的事就是往 HKCU 的 Run 里写一个值。
#![allow(unused_unsafe)]

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use windows_sys::Win32::Foundation::{BOOL, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_SZ,
};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetCursorPos, GetMessageW, PostMessageW,
    RegisterClassW, SystemParametersInfoW, TranslateMessage, DestroyWindow, HWND_MESSAGE, MSG,
    SPI_GETWORKAREA, WNDCLASSW, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK, WTS_SESSION_UNLOCK,
};

/// 全局光标位置。窗口跟着光标移动后，光标在窗口内的相对位置不变，
/// 渲染层就再也收不到 mousemove 了——只有系统级的坐标才能拖动窗口。
pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

/// 主显示器工作区（不含任务栏）：(x, y, w, h)
pub fn work_area() -> (i32, i32, i32, i32) {
    let mut r = RECT { left: 0, top: 0, right: 1920, bottom: 1080 };
    unsafe {
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut RECT as *mut _, 0);
    }
    (r.left, r.top, r.right - r.left, r.bottom - r.top)
}

/// 把文本塞进剪贴板。返回是否成功。
/// 这是**唯一**会离开进程的完整路径（看板的"复制路径"），
/// 所以调用点必须是"用户对某一条显式点了按钮"。
pub fn set_clipboard_text(text: &str) -> bool {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * 2;
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return false;
        }
        let _ = EmptyClipboard();
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if h.is_null() {
            let _ = CloseClipboard();
            return false;
        }
        let p = GlobalLock(h);
        if p.is_null() {
            let _ = CloseClipboard();
            return false;
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), p as *mut u16, wide.len());
        let _ = GlobalUnlock(h);
        // SetClipboardData 成功后所有权归系统，不能再 GlobalFree
        let ok = !SetClipboardData(CF_UNICODETEXT as u32, h).is_null();
        let _ = CloseClipboard();
        ok
    }
}

/// 当前是否处在锁屏 / 安全桌面。
///
/// 原理：锁屏时输入桌面（Default）不再可打开，OpenInputDesktop 会失败。
///
/// **现在这是兜底路径**，正常路径是 `watch_session()` 的事件（S10-6③）。
/// 保留它的理由：`WTSRegisterSessionNotification` 有可能注册失败
/// （非交互会话、服务里跑、以后换权限模型），那时不能让 SEC-07 直接失效——
/// 「宁可 2 秒后藏起来，也不要一直亮在锁屏界面上」。
pub fn is_locked() -> bool {
    unsafe {
        let h: HWND = OpenInputDesktop(0, 0, 0x0001 /* DESKTOP_READOBJECTS */);
        if h.is_null() {
            return true;
        }
        let _ = CloseDesktop(h);
        false
    }
}

// ------------------------------------------------------------
// 锁屏 / 解锁事件（S10-6③）
//
// 为什么不用轮询：原来是 2s 一次 `OpenInputDesktop`。那条路的问题是**延迟不可控**，
// 而它决定的是"锁屏时要不要把窗口藏起来"——窗口里会显示正在执行的命令和项目目录名，
// 藏晚了的代价是被锁屏截图 / 屏幕共享录进去。
//
// 做法：自己开一个**消息专用窗口**（`HWND_MESSAGE` 作父窗口：不显示、不在任务栏、
// 不参与 Z 序），向它注册 `WTSRegisterSessionNotification`，然后在这个线程里
// 跑自己的消息循环。三个理由：
//   1. 不进 Tauri 的消息循环。tao 的 WndProc 不归我们改，硬塞进去等于跟框架抢消息。
//   2. 消息专用窗口没有任何 UI 副作用，进程退出时内核一起收。
//   3. 一条线程 + 一个 GetMessageW，锁屏时也基本零开销。
// ------------------------------------------------------------

/// 事件回调。为什么用全局而不是挂在窗口的 user data 上：
/// 一个进程只需要一个会话通知窗口（这是 Windows 的模型，不是我们的选择），
/// 而且 WndProc 是 C 函数指针，除了全局没有干净的地方放闭包。
/// 用 Mutex 而不是 OnceLock：单测要能重装回调。
static SESSION_CB: Mutex<Option<Box<dyn Fn(bool) + Send + Sync>>> = Mutex::new(None);

/// 消息专用窗口的句柄。单测要靠它 PostMessageW 模拟一次锁屏消息。
static SESSION_HWND: AtomicIsize = AtomicIsize::new(0);

/// 锁屏到底是"事件"还是"轮询"（注册失败才会退回轮询）。
///
/// 为什么要暴露出来：`/health` 里带一个 `"lock":"event"|"poll"` 字段。
/// "锁屏后没藏窗口"这类问题最难查的地方是——你没法当场锁一次屏看它反应，
/// 而两种模式的失败长得一模一样。有这个字段，一眼就能分清是"事件没注册上"
/// 还是"注册上了但隐藏逻辑有问题"。
static LOCK_IS_EVENT: AtomicBool = AtomicBool::new(false);

pub fn lock_is_event() -> bool {
    LOCK_IS_EVENT.load(Ordering::SeqCst)
}

unsafe extern "system" fn session_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_WTSSESSION_CHANGE {
        // 只认 LOCK / UNLOCK。同一族里还有 REMOTE_DISCONNECT / CONSOLE_DISCONNECT /
        // LOGOFF 等等，它们不该触发"藏起来"——用户还在，只是换了显示通道。
        let locked = match wparam as u32 {
            WTS_SESSION_LOCK => Some(true),
            WTS_SESSION_UNLOCK => Some(false),
            _ => None,
        };
        if let Some(locked) = locked {
            if let Ok(guard) = SESSION_CB.lock() {
                if let Some(cb) = guard.as_ref() {
                    cb(locked);
                }
            }
        }
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// 注册锁屏 / 解锁事件，成功返回 true（失败时调用方应退回 `is_locked()` 轮询）。
///
/// 回调在**消息线程**上执行。调用方要是想做"建窗 / 隐藏窗口"这类事，
/// 请自己再 spawn 一个线程或者用 Tauri 的 API（它们内部会投递到主线程）——
/// 在 WndProc 里长时间阻塞会卡住这条线程的整个消息队列。
pub fn watch_session<F>(cb: F) -> bool
where
    F: Fn(bool) + Send + Sync + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    std::thread::spawn(move || unsafe {
        if let Ok(mut slot) = SESSION_CB.lock() {
            *slot = Some(Box::new(cb));
        }

        // 类名要活到 UnregisterClass（我们从不注销），所以故意泄漏成 'static。
        let class: &'static [u16] = Box::leak(wide("clawd-starter.session-watch").into_boxed_slice());
        let class_ptr = class.as_ptr();
        let hinst = GetModuleHandleW(std::ptr::null());

        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(session_wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_ptr,
        };
        if RegisterClassW(&wc) == 0 {
            let _ = tx.send(false);
            return;
        }

        let hwnd = CreateWindowExW(
            0,
            class_ptr,
            class_ptr,
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE, // 消息专用窗口：不显示、不进任务栏、不参与 Z 序
            std::ptr::null_mut(),
            hinst,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            let _ = tx.send(false);
            return;
        }

        if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
            // 注册不上就不要留着这个空窗口，也别让调用方以为成了。
            let _ = DestroyWindow(hwnd);
            let _ = tx.send(false);
            return;
        }

        SESSION_HWND.store(hwnd as isize, Ordering::SeqCst);
        LOCK_IS_EVENT.store(true, Ordering::SeqCst);
        let _ = tx.send(true);

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });

    // 等线程把"注册成没成"报回来。1.5s 足够——它只是一串同步的系统调用。
    rx.recv_timeout(Duration::from_millis(1500)).unwrap_or(false)
}

// ---- 开机自启 --------------------------------------------------------
// Windows 的"开机自启"就一件事：HKCU 的 Run 里有没有这一项。
// 用 HKCU 而不是 HKLM，是因为后者要管理员权限——桌宠不需要，也不该要。
//
// 值是**带引号的完整路径**。引号不是装饰：路径里一旦有空格，
// Windows 启动时会把空格后面那截当成参数，结果是"开机弹一个错误对话框"。
const RUN_SUBKEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "clawd-starter";

/// 开机自启开没开。读不到就当没开（此时 `autostart_set(true)` 会把它补上）。
pub fn autostart_enabled() -> bool {
    let Some(key) = open_run_key(KEY_READ) else { return false };
    unsafe {
        let mut len: u32 = 0;
        // lpData 传 null、只问长度：够判断"在不在"，且不用先猜缓冲多大
        let rc = RegQueryValueExW(key, wide(RUN_VALUE).as_ptr(), std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(), &mut len);
        let _ = RegCloseKey(key);
        rc == 0
    }
}

/// 开 / 关开机自启。写入的是**当前进程的 exe 路径**（dev 与安装版各自正确）。
pub fn autostart_set(on: bool) -> Result<(), String> {
    let Some(key) = open_run_key(KEY_SET_VALUE | KEY_READ) else {
        return Err("打不开 HKCU 的 Run 键".to_string());
    };
    let rc = unsafe {
        if on {
            let path = std::env::current_exe().map_err(|e| format!("拿不到当前 exe 路径：{e}"))?;
            let cmd = format!("\"{}\"", path.to_string_lossy());
            let bytes: Vec<u16> = cmd.encode_utf16().chain(std::iter::once(0)).collect();
            RegSetValueExW(key, wide(RUN_VALUE).as_ptr(), 0, REG_SZ, bytes.as_ptr() as *const u8, bytes.len() as u32 * 2)
        } else {
            RegDeleteValueW(key, wide(RUN_VALUE).as_ptr())
        }
    };
    // 删一个不存在的值会返回 2（ERROR_FILE_NOT_FOUND），那也算"关掉了"
    let ok = rc == 0 || (!on && rc == 2);
    unsafe {
        let _ = RegCloseKey(key);
    }
    if ok { Ok(()) } else { Err(format!("写开机自启失败：RegSetValueExW 返回 {rc}")) }
}

fn open_run_key(rights: windows_sys::Win32::System::Registry::REG_SAM_FLAGS) -> Option<HKEY> {
    let mut key: HKEY = std::ptr::null_mut();
    let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, wide(RUN_SUBKEY).as_ptr(), 0, rights, &mut key) };
    if rc == 0 { Some(key) } else { None }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn bool_ok(v: BOOL) -> bool {
    v != 0
}

#[cfg(test)]
mod autostart_tests {
    use super::*;

    // 只有一个测试，不是懒得拆：开机自启的真身是**这台机器上 HKCU Run 里的一个值**，
    // 也就是进程外的全局状态。拆成"测关"和"测往返"两个测试，cargo 会并行跑它们——
    // 一个刚把它写上，另一个就读到"开着"，于是红的那个看起来像"自启没生效"，
    // 其实是两个测试在抢同一个注册表项（和 sys::tests 里 SESSION_CB 那件事一样）。
    //
    // 默认只验"关得掉"（幂等、跑完不留痕迹）；**"打得开"要显式开开关**才验：
    //   CLAWD_AUTOSTART_TEST=1 cargo test --release autostart
    // 因为它会真的往登录项里写一条——中途崩了，下次登录会自己弹一只猫。
    #[test]
    fn autostart_off_is_idempotent_and_on_round_trips_when_asked() {
        assert!(autostart_set(false).is_ok(), "关掉开机自启失败");
        assert!(!autostart_enabled(), "关掉之后仍然读得到 Run 里的值");

        if std::env::var("CLAWD_AUTOSTART_TEST").as_deref() != Ok("1") {
            eprintln!("[autostart] 往返测试没跑（设 CLAWD_AUTOSTART_TEST=1 才会真开一次）");
            return;
        }

        assert!(autostart_set(true).is_ok(), "打开开机自启失败");
        assert!(autostart_enabled(), "打开之后读不到 Run 里的值");
        assert!(autostart_set(false).is_ok(), "关掉开机自启失败");
        assert!(!autostart_enabled(), "关掉之后仍然读得到 Run 里的值");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 这条测的是**消息通路**，不是锁屏本身：往自己的消息专用窗口投 WM_WTSSESSION_CHANGE，
    // 看回调有没有按 wParam 收到 true / false。
    // 真锁屏没法在回归里做（会把跑测试的人踢出桌面），所以判据只能到这一层。
    //
    // 只写一个测试、不拆成两三个：`SESSION_CB` 和 `SESSION_HWND` 是进程级单例，
    // 拆开之后 cargo 会在多个线程里并行跑，两个测试互相覆盖回调 —— 那时
    // "偶发失败"会被归因成"消息不可靠"，而真正的原因是测试自己抢同一个静态。
    #[test]
    fn session_messages_drive_the_callback() {
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let ok = watch_session(move |locked| {
            let _ = tx.send(locked);
        });
        assert!(ok, "WTSRegisterSessionNotification 失败（非交互会话里会这样）");

        let hwnd = SESSION_HWND.load(Ordering::SeqCst) as HWND;
        assert!(!hwnd.is_null(), "消息专用窗口没建出来");

        unsafe {
            PostMessageW(hwnd, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK as WPARAM, 0);
        }
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(2000)),
            Ok(true),
            "锁屏消息没有传到回调"
        );

        unsafe {
            PostMessageW(hwnd, WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK as WPARAM, 0);
        }
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(2000)),
            Ok(false),
            "解锁消息没有传到回调"
        );

        // 同族的其它消息不该被当成锁屏：REMOTE_DISCONNECT(3) / CONSOLE_DISCONNECT(4) /
        // LOGOFF(5) 都不该让桌宠藏起来 —— 用户还在，只是换了显示通道。
        unsafe {
            for wparam in [3u32, 4, 5] {
                PostMessageW(hwnd, WM_WTSSESSION_CHANGE, wparam as WPARAM, 0);
            }
        }
        assert!(
            rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "REMOTE_DISCONNECT / CONSOLE_DISCONNECT / LOGOFF 不该触发锁屏回调"
        );
    }
}
