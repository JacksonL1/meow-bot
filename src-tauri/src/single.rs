// ============================================================
// 单实例锁（当年对应 Electron 的 app.requestSingleInstanceLock，现为唯一实现）
//
// 为什么必须有：端点文件里写的是固定端口 27333。第二份进程真正的问题不是
// "多一个进程"，而是它会去 bind 同一个端口——被占就回退随机端口 **并覆盖端点文件**。
// 于是 hook 拿着新端口去找"第二份"，而用户屏幕上看到的是"第一份"那只猫：
// 事件全进了没人看的那个进程，画面永远不动。这条链断得很安静。
//
// 为什么用命名互斥量而不是锁文件：
//   锁文件在进程被强杀 / 崩溃 / 断电之后会留下。下次启动要么误判"已经在跑"，
//   要么得靠 pid 查活 + 超时清理，两种都会出错（pid 会被复用）。
//   互斥量的句柄归内核管，进程无论怎么消失，内核都会释放它。所以
//   "ERROR_ALREADY_EXISTS" 这个判断永远是真的，**不需要任何清理逻辑**。
//
// 为什么名字带 Local\ 前缀：只在本登录会话里唯一。两个用户各自登录、各跑一份
// 是正确行为——他们的端点文件本来就在各自的 %APPDATA% 下。
// ============================================================
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE,
    INFINITE,
};

const MUTEX_BASE: &str = "Local\\com.clawd.starter.singleton.v1";
const EVENT_BASE: &str = "Local\\com.clawd.starter.second-instance.v1";

/// 锁的身份 = **端点文件的路径**。
///
/// 这一条不是随手加的后缀，是两个真实需求撞出来的：
///   1. 要保护的东西本来就是"一个端点文件 + 它里面那个固定端口"，
///      不是"这台机器上只能有一个 clawd 进程"。
///   2. 回归脚本（`scripts/verify-tauri.js`）用 `CLAWD_PORT_FILE` 指向临时文件，
///      就是**为了能在用户自己正开着桌宠的时候跑**。名字要是固定的，
///      回归一启动就会被自己拦下来——那一整套断言会变成"进程秒退、全挂"。
///
/// 所以：同一个端点文件 = 同一个实例；不同端点文件 = 不同的实例，各管各的。
/// 生产环境下没有 `CLAWD_PORT_FILE`，两边都落到同一个 userData 路径，行为不变。
fn suffix() -> String {
    match std::env::var("CLAWD_PORT_FILE") {
        Ok(p) if !p.is_empty() => {
            // FNV-1a：只为把路径压成一个稳定的短后缀。
            // 不用 DefaultHasher——它的输出没有跨版本保证，改一次 Rust
            // 就可能换一个锁名，那属于"升级编译器导致能开两份"的隐形 bug。
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            for b in p.as_bytes() {
                h ^= *b as u64;
                h = h.wrapping_mul(0x1000_0000_01b3);
            }
            format!(".{h:016x}")
        }
        _ => String::new(),
    }
}

/// 锁的持有者。**故意不实现 Drop**：互斥量要活到进程结束，
/// 提前 CloseHandle 等于把锁交出去；而进程结束时内核会替我们收。
pub struct Guard {
    _handle: HANDLE,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 抢锁。返回 None 表示已经有一份在跑（调用方应该立刻退出）。
///
/// 注意 `GetLastError()` 必须紧跟在 `CreateMutexW` 后面读——中间插一个
/// `CloseHandle` 就会把它冲掉，那就永远判不出"已存在"了。
pub fn acquire() -> Option<Guard> {
    acquire_named(&format!("{MUTEX_BASE}{}", suffix()))
}

fn acquire_named(name: &str) -> Option<Guard> {
    let name = wide(name);
    unsafe {
        let h = CreateMutexW(std::ptr::null(), 1, name.as_ptr());
        if h.is_null() {
            // 连锁都抢不到（极少见：句柄耗尽）。此时**宁可放行**：
            // 让用户看到猫，而不是让程序毫无提示地退不退、起不起。
            eprintln!("[single] 建互斥量失败，跳过单实例检查");
            return Some(Guard { _handle: std::ptr::null_mut() });
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(h);
            return None;
        }
        Some(Guard { _handle: h })
    }
}

/// 第二份进程调用：捅一下第一份，让它知道"用户又点了一次图标"。
/// 第一份没在等着也不报错——那说明它正好在退出，用户本来就要重新启动。
pub fn wake_first() {
    wake_named(&format!("{EVENT_BASE}{}", suffix()));
}

fn wake_named(name: &str) {
    let name = wide(name);
    unsafe {
        let h = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
        if h.is_null() {
            return;
        }
        let _ = SetEvent(h);
        let _ = CloseHandle(h);
    }
}

/// 第一份进程调用：开一个自动重置的命名事件，起一个线程死等它。
///
/// 为什么不是"第二份直接给第一份发窗口消息"：那要先找到窗口（FindWindowW 按标题，
/// 标题是可以被改的），还得自定义 WndProc 接管消息。命名事件是纯粹的
/// 内核同步对象，两行就能用，也不需要让 Tauri 的消息循环参与进来。
pub fn watch<F>(on_second: F)
where
    F: FnMut() + Send + 'static,
{
    watch_named(&format!("{EVENT_BASE}{}", suffix()), on_second);
}

fn watch_named<F>(name: &str, mut on_second: F)
where
    F: FnMut() + Send + 'static,
{
    let name = wide(name);
    std::thread::spawn(move || unsafe {
        // bManualReset = 0（自动重置）：SetEvent 之后一次 Wait 就清掉，
        // 不需要在回调里手动 Reset，也不会把两次连点合并成一次漏掉。
        let h = CreateEventW(std::ptr::null(), 0, 0, name.as_ptr());
        if h.is_null() {
            eprintln!("[single] 建唤醒事件失败：第二份进程点了图标不会有反应");
            return;
        }
        loop {
            if WaitForSingleObject(h, INFINITE) != WAIT_OBJECT_0 {
                break;
            }
            on_second();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // 内核按**名字**在会话的对象表里查，所以同一进程里用同一个名字建两次，
    // 行为和两个进程完全一致。这两条因此能真测到多开拦截，
    // 而不是只能让人起两个 exe 手点一遍。
    //
    // 名字带 .test 后缀：回归可能在本体正在跑的时候被跑起来，
    // 用生产名字会直接撞上"真的已经有一份"。
    const T_MUTEX: &str = "Local\\com.clawd.starter.test.singleton";
    const T_EVENT: &str = "Local\\com.clawd.starter.test.second-instance";

    #[test]
    fn second_acquire_is_rejected() {
        let first = acquire_named(T_MUTEX);
        assert!(first.is_some(), "第一次抢锁应该成功");
        assert!(acquire_named(T_MUTEX).is_none(), "同一名字再抢一次必须被拒");
        // 锁不能提前放：Guard 活到这里，内核对象还在，
        // 所以上面那句才判得出来。掉出作用域也不等于释放（没有 Drop）。
    }

    #[test]
    fn wake_first_reaches_watcher() {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        watch_named(T_EVENT, move || {
            let _ = tx.send(());
        });
        // 线程里 CreateEventW 之后才开始等。这里等它把事件建出来，
        // 否则 wake 打在一个还不存在的名字上，OpenEventW 直接失败。
        std::thread::sleep(Duration::from_millis(150));
        wake_named(T_EVENT);
        assert!(
            rx.recv_timeout(Duration::from_millis(2000)).is_ok(),
            "第二份进程的唤醒信号没有到达等待线程"
        );
    }

    #[test]
    fn wake_on_missing_event_is_silent() {
        // 第一份还没起来就点了第二次（或者正好在退出）：不能崩、不能卡。
        wake_named("Local\\com.clawd.starter.test.nobody-home");
    }
}
