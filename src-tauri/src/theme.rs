// ============================================================
// S7  主题加载（themes/<id>/theme.json + assets/*.svg）
//
// 失败一律**整体拒绝**，不返回半个主题。原因：半个主题的表现是"画面停在
// 某次状态切换上"，用户会以为是状态机坏了，而真正的原因在主题文件里。
//
// 与 src/theme.js 等价（配置项、钳制区间、warnings 文案都对齐）。
// ============================================================
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const SCHEMA_VERSION: i64 = 1;
const STATE_NAMES: [&str; 7] = [
    "idle",
    "thinking",
    "working",
    "attention",
    "error",
    "notification",
    "sleeping",
];
const ONESHOT_STATES: [&str; 3] = ["error", "notification", "attention"];

const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_THEME_BYTES: u64 = 4 * 1024 * 1024;
const MAX_FRAMES_PER_STATE: usize = 12;
const MIN_FPS: u32 = 1;
const MAX_FPS: u32 = 30;
const MIN_ONESHOT_MS: u64 = 200;
const MAX_ONESHOT_MS: u64 = 30_000;
const MIN_SLEEP_AFTER_MS: u64 = 2_000;
const MAX_SLEEP_AFTER_MS: u64 = 3_600_000;
const MAX_VARIANTS: usize = 4;

#[derive(Clone, Debug, Serialize)]
pub struct FrameSet {
    pub fps: u32,
    #[serde(rename = "eyeTracking")]
    pub eye_tracking: bool,
    pub frames: Vec<String>,
    pub variants: Vec<Variant>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Variant {
    pub id: String,
    pub fps: u32,
    #[serde(rename = "eyeTracking")]
    pub eye_tracking: bool,
    pub frames: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeTimings {
    pub oneshot: BTreeMap<String, u64>,
    #[serde(rename = "sleepAfterMs", skip_serializing_if = "Option::is_none")]
    pub sleep_after_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    // rigType 是主题自报的"我需要哪套渲染器"。透传出去，渲染层才不用靠
    // id/name 字符串猜（原来只有 id==="ragdoll" 兜底，意味着任何叫 ragdoll
    // 的主题都会掉进同一个分支）。
    #[serde(rename = "rigType")]
    pub rig_type: String,
    pub states: BTreeMap<String, FrameSet>,
    pub timings: Option<ThemeTimings>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ThemeSummary {
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub ok: bool,
    pub error: Option<String>,
    pub warnings: Vec<String>,
}

pub struct Loaded {
    pub theme: Theme,
    pub warnings: Vec<String>,
}

// ------------------------------------------------------------
// 路径
// ------------------------------------------------------------

/// themes/ 的位置。顺序：环境变量（回归/多实例隔离）→ 当前目录 → 可执行文件旁边
/// → 开发期的仓库根。最后那个是给 `cargo run` 用的：那时 exe 在 target/debug/。
pub fn themes_dir() -> PathBuf {
    if let Ok(p) = std::env::var("CLAWD_THEMES_DIR") {
        return PathBuf::from(p);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("themes"));
    }
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        candidates.push(dir.join("themes"));
        candidates.push(dir.join("../../themes"));
        candidates.push(dir.join("../../../themes"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../themes"));
    candidates
        .iter()
        .find(|p| p.is_dir())
        .cloned()
        .unwrap_or_else(|| PathBuf::from("themes"))
}

/// SEC-02 / SEC-10：端点与偏好统一放 userData，不再写项目根目录。
///   Windows  %APPDATA%\clawd-starter\
pub fn user_data_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("clawd-starter");
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        return PathBuf::from(home).join("AppData").join("Roaming").join("clawd-starter");
    }
    PathBuf::from(".").join("clawd-starter")
}

fn pref_path() -> PathBuf {
    user_data_dir().join("clawd-starter.theme")
}

fn id_re_ok(id: &str) -> bool {
    let b = id.as_bytes();
    if b.is_empty() || b.len() > 40 {
        return false;
    }
    let first = b[0] as char;
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    b.iter().all(|&c| {
        let c = c as char;
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'
    })
}

fn asset_re_ok(name: &str) -> bool {
    let b = name.as_bytes();
    if b.is_empty() || b.len() > 64 || !name.ends_with(".svg") {
        return false;
    }
    let first = b[0] as char;
    if !(first.is_ascii_alphanumeric()) {
        return false;
    }
    b.iter().all(|&c| {
        let c = c as char;
        c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'
    })
}

/// 列出磁盘上真实存在的主题 id。**所有**对外接口都以这个结果为准，
/// 外部传进来的 id 先在这里比对，比对不上就直接拒——这一步比任何正则都可靠。
pub fn theme_ids() -> Vec<String> {
    let dir = themes_dir();
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut ids: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.') && id_re_ok(n))
        .collect();
    ids.sort();
    ids
}

/// 读一个资产文件。三道检查：名字合法 → 真实路径仍在 assets/ 内 → 大小与内容可用。
fn read_asset(id: &str, name: &str, budget: &mut u64) -> Result<String, String> {
    if !asset_re_ok(name) {
        return Err(format!(
            "资产名不合法：{name:?}（只允许 字母数字._-，且必须以 .svg 结尾）"
        ));
    }
    let base = themes_dir().join(id).join("assets");
    let abs = base.join(name);

    // 双保险：即使正则被绕过，路径也必须落在 assets/ 这一层里。
    let real_base = base.canonicalize().unwrap_or_else(|_| base.clone());
    let real_abs = abs.canonicalize().map_err(|_| format!("资产不存在：{name}"))?;
    if !real_abs.starts_with(&real_base) {
        return Err(format!("资产越界：{name}"));
    }

    let meta = std::fs::metadata(&real_abs).map_err(|_| format!("资产不存在：{name}"))?;
    if !meta.is_file() {
        return Err(format!("资产不是文件：{name}"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "资产过大：{name}（{} 字节，上限 {}）",
            meta.len(),
            MAX_FILE_BYTES
        ));
    }
    *budget += meta.len();
    if *budget > MAX_THEME_BYTES {
        return Err(format!("主题总大小超限（上限 {MAX_THEME_BYTES} 字节）"));
    }

    let markup = std::fs::read_to_string(&real_abs).map_err(|e| format!("读不了资产 {name}：{e}"))?;
    // 便宜的预筛：内容里必须真的有个 <svg。真正挡恶意内容的是渲染层的白名单，
    // 这里只是把「把 .txt 改名成 .svg」这种低级情况在加载阶段就报出来。
    let lower = markup.to_ascii_lowercase();
    if !(lower.contains("<svg ") || lower.contains("<svg>") || lower.contains("<svg\n")) {
        return Err(format!("资产不是 SVG：{name}"));
    }
    Ok(markup)
}

fn clamp_u64(v: f64, lo: u64, hi: u64) -> u64 {
    (v as u64).max(lo).min(hi)
}

fn normalize_timings(
    raw: Option<&serde_json::Value>,
) -> Result<(Option<ThemeTimings>, Vec<String>), String> {
    let mut warnings = Vec::new();
    let Some(raw) = raw else {
        return Ok((None, warnings));
    };
    if !raw.is_object() {
        return Err("timings 必须是对象".into());
    }
    let obj = raw.as_object().unwrap();

    let mut oneshot_map: BTreeMap<String, u64> = BTreeMap::new();
    let oneshot_raw = match obj.get("oneshot") {
        None => None,
        Some(v) if v.is_object() => v.as_object(),
        Some(_) => return Err("timings.oneshot 必须是对象".into()),
    };

    if let Some(or) = oneshot_raw {
        for name in ONESHOT_STATES {
            let Some(v) = or.get(name) else { continue };
            let Some(n) = v.as_f64() else {
                warnings.push(format!("timings.oneshot.{name} 不是数字，已忽略"));
                continue;
            };
            let ms = clamp_u64(n.round(), MIN_ONESHOT_MS, MAX_ONESHOT_MS);
            if ms as f64 != n {
                warnings.push(format!(
                    "timings.oneshot.{name} 被钳到 {ms}ms（允许 {MIN_ONESHOT_MS}~{MAX_ONESHOT_MS}）"
                ));
            }
            oneshot_map.insert(name.to_string(), ms);
        }
        // 主题写了状态机不认的 oneshot 键：它永远不会生效，必须说出来。
        let unknown: Vec<&str> = or
            .keys()
            .map(|k| k.as_str())
            .filter(|n| !ONESHOT_STATES.contains(n))
            .collect();
        if !unknown.is_empty() {
            warnings.push(format!(
                "timings.oneshot 里有状态机不认识的状态（永不会生效）：{}",
                unknown.join(", ")
            ));
        }
    }

    let mut sleep_after = None;
    if let Some(v) = obj.get("sleepAfterMs") {
        match v.as_f64() {
            None => warnings.push("timings.sleepAfterMs 不是数字，已忽略".into()),
            Some(n) => {
                let ms = clamp_u64(n.round(), MIN_SLEEP_AFTER_MS, MAX_SLEEP_AFTER_MS);
                if ms as f64 != n {
                    warnings.push(format!(
                        "timings.sleepAfterMs 被钳到 {ms}ms（允许 {MIN_SLEEP_AFTER_MS}~{MAX_SLEEP_AFTER_MS}）"
                    ));
                }
                sleep_after = Some(ms);
            }
        }
    }

    let unknown: Vec<&str> = obj
        .keys()
        .map(|k| k.as_str())
        .filter(|k| *k != "oneshot" && *k != "sleepAfterMs")
        .collect();
    if !unknown.is_empty() {
        warnings.push(format!("timings 里有不认识的字段（已忽略）：{}", unknown.join(", ")));
    }

    Ok((
        Some(ThemeTimings { oneshot: oneshot_map, sleep_after_ms: sleep_after }),
        warnings,
    ))
}

/// 读一个状态的两套资产（主资产 + 变体）。规则必须一模一样，
/// 否则会分叉成"主资产钳了、变体没钳"，而那种 bug 只在换到第 2 套时才看得见。
fn read_set(
    id: &str,
    raw: &serde_json::Value,
    label: &str,
    fallback_fps: u32,
    fallback_track: bool,
    budget: &mut u64,
) -> Result<FrameSet, String> {
    let frames_raw = raw.get("frames").and_then(|v| v.as_array());
    let Some(frames_raw) = frames_raw else {
        return Err(format!("状态 {label} 的 frames 必须是非空数组"));
    };
    if frames_raw.is_empty() {
        return Err(format!("状态 {label} 的 frames 必须是非空数组"));
    }
    if frames_raw.len() > MAX_FRAMES_PER_STATE {
        return Err(format!(
            "状态 {label} 帧数超限（{} > {MAX_FRAMES_PER_STATE}）",
            frames_raw.len()
        ));
    }
    let fps = raw
        .get("fps")
        .and_then(|v| v.as_f64())
        .map(|n| (n.round() as u32).max(MIN_FPS).min(MAX_FPS))
        .unwrap_or(fallback_fps);
    let eye_tracking = raw
        .get("eyeTracking")
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback_track);

    let mut frames = Vec::new();
    for f in frames_raw {
        let name = f.as_str().unwrap_or("");
        let markup = read_asset(id, name, budget).map_err(|e| format!("状态 {label}：{e}"))?;
        frames.push(markup);
    }

    let mut variants = Vec::new();
    if let Some(vs) = raw.get("variants") {
        let Some(arr) = vs.as_array() else {
            return Err(format!("状态 {label} 的 variants 必须是数组"));
        };
        if arr.len() > MAX_VARIANTS {
            return Err(format!(
                "状态 {label} 变体超限（{} > {MAX_VARIANTS}）",
                arr.len()
            ));
        }
        for (i, v) in arr.iter().enumerate() {
            if !v.is_object() {
                return Err(format!("状态 {label} 的第 {} 个变体必须是对象", i + 1));
            }
            let set = read_set(id, v, &format!("{label} 变体#{}", i + 1), fps, eye_tracking, budget)?;
            variants.push(Variant {
                id: v.get("id").and_then(|x| x.as_str()).unwrap_or("").chars().take(32).collect(),
                fps: set.fps,
                eye_tracking: set.eye_tracking,
                frames: set.frames,
            });
        }
    }

    Ok(FrameSet { fps, eye_tracking, frames, variants })
}

pub fn load_theme(id: &str) -> Result<Loaded, String> {
    if !id_re_ok(id) {
        return Err("主题 id 不合法".into());
    }
    if !theme_ids().iter().any(|x| x == id) {
        return Err(format!("没有这个主题：{id}"));
    }

    let json_path = themes_dir().join(id).join("theme.json");
    let raw = std::fs::read_to_string(&json_path)
        .map_err(|e| format!("theme.json 读不了或不是合法 JSON：{e}"))?;
    let meta: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("theme.json 读不了或不是合法 JSON：{e}"))?;
    if !meta.is_object() {
        return Err("theme.json 顶层必须是对象".into());
    }
    if meta.get("schemaVersion").and_then(|v| v.as_i64()) != Some(SCHEMA_VERSION) {
        return Err(format!(
            "schemaVersion 必须是 {SCHEMA_VERSION}（读到 {}）",
            meta.get("schemaVersion").map(|v| v.to_string()).unwrap_or_else(|| "undefined".into())
        ));
    }
    let Some(states_obj) = meta.get("states").and_then(|v| v.as_object()) else {
        return Err("缺少 states 对象".into());
    };
    if !states_obj.contains_key("idle") {
        return Err("必须定义 idle 状态（它是所有缺失状态的兜底）".into());
    }

    let mut budget: u64 = 0;
    let mut states: BTreeMap<String, FrameSet> = BTreeMap::new();
    for name in STATE_NAMES {
        let Some(def) = states_obj.get(name) else { continue };
        if !def.is_object() {
            return Err(format!("状态 {name} 必须是对象"));
        }
        let set = read_set(id, def, name, 4, false, &mut budget)?;
        states.insert(name.to_string(), set);
    }

    // 缺失的状态用 idle 兜住。理由：状态机随时可能切到任何一个状态，
    // 少一个就在那一刻变成"画面不动"，而作者很难联想到是主题缺项。
    let idle = states.get("idle").cloned().ok_or("必须定义 idle 状态")?;
    for name in STATE_NAMES {
        if !states.contains_key(name) {
            let mut copy = idle.clone();
            copy.eye_tracking = false;
            copy.variants.clear();
            states.insert(name.to_string(), copy);
        }
    }

    let mut warnings: Vec<String> = Vec::new();
    // 主题里写了但状态机不认识的状态名：**报出来，别静默丢**。
    let unknown: Vec<&str> = states_obj
        .keys()
        .map(|k| k.as_str())
        .filter(|n| !STATE_NAMES.contains(n))
        .collect();
    if !unknown.is_empty() {
        warnings.push(format!(
            "不认识的状态名（状态机没有，永不会触发）：{}",
            unknown.join(", ")
        ));
    }

    let (timings, w) = normalize_timings(meta.get("timings"))?;
    warnings.extend(w);

    let s = |k: &str, max: usize| -> String {
        meta.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(max)
            .collect()
    };

    Ok(Loaded {
        theme: Theme {
            id: id.to_string(),
            name: if meta.get("name").and_then(|v| v.as_str()).is_some() {
                s("name", 80)
            } else {
                id.to_string()
            },
            author: s("author", 80),
            version: s("version", 32),
            description: s("description", 300),
            rig_type: s("rigType", 40),
            states,
            timings,
        },
        warnings,
    })
}

/// 给看板/调试用：每个主题一行摘要，加载失败的也列出来并带上原因。
pub fn list_themes() -> Vec<ThemeSummary> {
    theme_ids()
        .into_iter()
        .map(|id| match load_theme(&id) {
            Ok(l) => ThemeSummary {
                id: l.theme.id,
                name: l.theme.name,
                author: l.theme.author,
                version: l.theme.version,
                ok: true,
                error: None,
                warnings: l.warnings,
            },
            Err(e) => ThemeSummary {
                id: id.clone(),
                name: id,
                author: String::new(),
                version: String::new(),
                ok: false,
                error: Some(e),
                warnings: vec![],
            },
        })
        .collect()
}

pub fn read_preference() -> Option<String> {
    let raw = std::fs::read_to_string(pref_path()).ok()?;
    let id = raw.trim().to_string();
    if id_re_ok(&id) {
        Some(id)
    } else {
        None
    }
}

pub fn write_preference(id: &str) {
    let p = pref_path();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(p, id);
}

/// 优先级：环境变量（回归用）→ 命令行 → 上次选的 → 内置默认。
///
/// 最后那个不能省：没有它就会按字母序取第一个可用的主题，
/// 于是"默认主题"变成了"名字最小的主题"——加一个 aaa 主题就把默认换了。
pub fn resolve_theme(candidates: &[String], default_id: &str) -> (Option<Theme>, Option<String>) {
    let mut errs: Vec<String> = Vec::new();
    for id in candidates {
        match load_theme(id) {
            Ok(l) => return (Some(l.theme), None),
            Err(e) => errs.push(e),
        }
    }
    match load_theme(default_id) {
        Ok(l) => (Some(l.theme), None),
        Err(e) => {
            errs.push(e);
            (None, Some(errs.join("；")))
        }
    }
}

pub fn themes_root_display() -> String {
    themes_dir().display().to_string()
}

pub fn _unused(_: &Path) {}
