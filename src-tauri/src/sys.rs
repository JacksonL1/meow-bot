// ============================================================
// Windows 系统集成（Electron 版由 Electron API 提供的四件事）
//
//   screen.getCursorScreenPoint()   → cursor_pos()      拖动 + gaze 都要
//   screen.getPrimaryDisplay().workArea → work_area()   贴边定位
//   clipboard.writeText()           → set_clipboard_text()
//   powerMonitor lock-screen/suspend → is_locked()       SEC-07 锁屏时收起窗口
//
// 为什么不用 Tauri 的插件：托盘/剪贴板各自要带一个插件 + 一份权限声明，
// 而这里只需要四个系统调用。直接调 user32 更小、也没有额外的 IPC 层。
// ============================================================
#![allow(unused_unsafe)]

use windows_sys::Win32::Foundation::{BOOL, HWND, POINT, RECT};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, SystemParametersInfoW, SPI_GETWORKAREA,
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
/// Electron 版用 powerMonitor 的事件；Tauri 没有等价物，轮询成本极低（2s 一次）。
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

pub fn bool_ok(v: BOOL) -> bool {
    v != 0
}
