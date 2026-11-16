//! 2026-11-16 · DSH 的「写句柄」在 Windows 上到底是什么
//!
//! 起因：桌宠往一条会话发消息，DSH 报
//! `session "…" is already owned by an active write handle`，
//! 但磁盘上**没有** `session.lock`、`tasklist` 里没有别的 dsh、
//! 客户端看起来也没开那条会话。
//!
//! 真相（从桌面版 `app.asar` 的 `dsh-session-persistence-jsonl/lease` 读出来的）：
//!   · POSIX 用 `flock(session.lock)`，锁文件会留在磁盘上；
//!   · **Windows 用命名信号量**：
//!       Local\dsh-session-lock-<sha256(小写化的 <会话目录>\session.lock 绝对路径)>
//!     `session.lock` 只是**名字的原料**，这个文件在 Windows 上一个字节都不会写。
//!
//! 所以"看有没有锁文件"永远得到"没有"——这是上一版探测错的地方，也是
//! "用户把三个嫌疑人都排除掉、错误却每次都在"的原因：占用者根本不在文件系统里，
//! 而是一个**活着的进程**手里的一根信号量句柄。
//!
//! 判读：
//!   · OpenSemaphoreW 失败          → 没有对象：没有任何进程持有（锁空闲）；
//!   · WaitForSingleObject(0) 拿到   → 对象在但空闲（持有者放开了计数，句柄还开着）；
//!   · WaitForSingleObject(0) 超时   → **正被持有**。
//! 信号量随最后一个句柄关闭消失，所以"Held"等价于"还有一个活着的进程拿着它"。

use std::path::{Path, PathBuf};

/// 这条会话在各目录桶里的 artifact 目录（`$DSH_HOME/sessions/<bucket>/<id>`）。
///
/// 会话按 cwd 分桶，同一个 id 只可能在其中一个里；全扫一遍而不是按 cwd 拼桶名，
/// 是因为桶名的转义规则（盘符、分隔符、大小写）没有文档，猜错就查不到。
pub fn session_dirs(id: &str) -> Vec<PathBuf> {
    if id.is_empty() {
        return Vec::new();
    }
    let Some(home) = crate::dsh::home() else {
        return Vec::new();
    };
    let root = home.join("sessions");
    let Ok(buckets) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for b in buckets.flatten() {
        let dir = b.path().join(id);
        if dir.is_dir() {
            out.push(dir);
        }
    }
    out
}

/// DSH 给这个锁路径起的信号量名。
///
/// 两个细节都是从它的实现里抄的，不能"差不多"：路径要**小写**（Windows 大小写不敏感），
/// 哈希前要先 `resolve()` 成绝对路径（我们拿到的本来就是绝对路径）。
pub fn semaphore_name(lock_path: &Path) -> String {
    let lower = lock_path.to_string_lossy().to_lowercase();
    format!("Local\\dsh-session-lock-{}", sha256_hex(lower.as_bytes()))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LockState {
    /// 正被某个活着的进程持有。
    Held,
    /// 对象在，但计数是满的：持有者已经放开，只是句柄还没关。
    Free,
    /// 连对象都没有：没有任何进程碰过这个锁。
    Absent,
}

/// 查一个锁路径的当前状态。查不出来一律当 `Absent`——**不编"有人占着"**。
pub fn state(lock_path: &Path) -> LockState {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            OpenSemaphoreW, ReleaseSemaphore, WaitForSingleObject, SEMAPHORE_MODIFY_STATE,
        };

        // SYNCHRONIZE 在 windows-sys 里挂在 Foundation 下（0x00100000）。
        // 不 import 那一整块也行：它是 Win32 的稳定常量，写死加注释更不容易被误改。
        const SYNCHRONIZE: u32 = 0x0010_0000;

        let name: Vec<u16> = semaphore_name(lock_path)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let h = OpenSemaphoreW(SEMAPHORE_MODIFY_STATE | SYNCHRONIZE, 0, name.as_ptr());
            if h.is_null() {
                return LockState::Absent;
            }
            let wait = WaitForSingleObject(h, 0);
            let out = match wait {
                // 拿到了：说明计数是满的。必须还回去，否则我们自己的探测会把锁"吃掉"。
                WAIT_OBJECT_0 => {
                    let _ = ReleaseSemaphore(h, 1, std::ptr::null_mut());
                    LockState::Free
                }
                WAIT_TIMEOUT => LockState::Held,
                _ => LockState::Absent,
            };
            let _ = CloseHandle(h);
            out
        }
    }
    #[cfg(not(windows))]
    {
        // 本项目只发 Windows 版；别的平台上不假装知道。
        let _ = lock_path;
        LockState::Absent
    }
}

/// 按会话 id 查：只要有一个桶里的锁被持有，就是 `Held`。
pub fn state_for(id: &str) -> (LockState, Vec<PathBuf>) {
    let dirs = session_dirs(id);
    let mut worst = LockState::Absent;
    for d in &dirs {
        match state(&d.join("session.lock")) {
            LockState::Held => return (LockState::Held, dirs),
            LockState::Free => worst = LockState::Free,
            LockState::Absent => {}
        }
    }
    (worst, dirs)
}

// ------------------------------------------------------------
// SHA-256（只为算信号量名，引一个 crate 不值当）
// ------------------------------------------------------------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d) = (h[0], h[1], h[2], h[3]);
        let (mut e, mut f, mut g, mut hh) = (h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, v) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(v);
        }
    }

    h.iter().map(|v| format!("{v:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_standard_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // 跨过分组边界的那条：448-bit 填充 + 两个块
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    /// 真机探针（默认不跑）：给一条当前确实被占着的会话 id，
    /// 验证 OpenSemaphoreW 这条路在我们这台机器上真的能判出 Held。
    ///   $env:CLAWD_PROBE_SESSION="session-…"; cargo test live_probe -- --ignored --nocapture
    #[test]
    #[ignore = "需要本机真有一条被占着的 DSH 会话"]
    fn live_probe_reports_held_for_a_locked_session() {
        let id = std::env::var("CLAWD_PROBE_SESSION").expect("设 CLAWD_PROBE_SESSION=<会话 id>");
        let (state, dirs) = state_for(&id);
        println!("{} -> {state:?}（{dirs:?}）", id);
        assert_eq!(state, LockState::Held);
    }

    /// 查不到就是"没有"，不是"可能有人占着"。
    /// 这条守的是输入窗：查错一律当 Absent 只会让"发送"亮着（用户按下去最多收一句
    /// 真错），反过来一律当 Held 会让**所有**历史会话都显示"发不出去"，那是更糟的谎。
    #[test]
    fn an_unknown_session_is_absent_not_held() {
        let (state, dirs) = state_for("session-does-not-exist-verify");
        assert_eq!(state, LockState::Absent);
        assert!(dirs.is_empty());
        let (empty, dirs2) = state_for("");
        assert_eq!(empty, LockState::Absent);
        assert!(dirs2.is_empty());
    }

    /// 自己造一把锁，再让 `state()` 去判——这条守的是整条探测链的前提：
    /// "别人手里的锁，我们能看见"。前面那条假阴性的根因就是**看见了另一个对象**，
    /// 所以这里必须真的 `createSemaphoreW` 造出来，而不是 mock 一个状态。
    #[cfg(windows)]
    #[test]
    fn a_lock_we_hold_ourselves_is_seen_as_held_then_absent_after_release() {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            CreateSemaphoreW, ReleaseSemaphore, WaitForSingleObject,
        };

        // 路径不需要真的存在：信号量名只由字符串算出来。用临时目录是防撞名。
        let p = std::env::temp_dir()
            .join("clawd-lock-probe-test")
            .join("session.lock");
        let name: Vec<u16> = semaphore_name(&p)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            // 初始计数 1、上限 1：和 DSH 的 createSemaphoreW(null, 1, 1, name) 一致。
            let h = CreateSemaphoreW(std::ptr::null(), 1, 1, name.as_ptr());
            assert!(!h.is_null(), "造不出信号量");
            // 自己把它拿走，等价于"另一个进程正持有"。
            assert_eq!(WaitForSingleObject(h, 0), WAIT_OBJECT_0);
            assert_eq!(state(&p), LockState::Held, "持有态必须看得见");
            // 还回去 = 句柄还在、计数已满：DSH 里对应"刚写完还没关句柄"。
            let _ = ReleaseSemaphore(h, 1, std::ptr::null_mut());
            assert_eq!(state(&p), LockState::Free);
            let _ = CloseHandle(h);
            // 句柄全关掉，对象就没了。
            assert_eq!(state(&p), LockState::Absent);
        }
    }

    /// 名字必须和 DSH 自己算出来的一字不差——差一个字符就查的是另一个信号量，
    /// 得到的"空闲"会是一个假阴性。expected 由 DSH 的规则（PowerShell 侧
    /// 用同一路径算出来）核对过。
    #[test]
    fn semaphore_name_matches_dsh_rule() {
        let p = Path::new(
            r"C:\Users\Think\.dsh\sessions\--C-Users-Think--\session-5d5fab92-15b0-4f89-b645-bce648cf4a3f\session.lock",
        );
        assert_eq!(
            semaphore_name(p),
            "Local\\dsh-session-lock-f2b42ca7c55f80a8767c7f185ff496b45265b30d2b781a8a4b4ef62d1f5c6819"
        );
    }
}
