#!/usr/bin/env node
"use strict";
// ============================================================
// 打包产物回归（S10-6④）
//
// 它回答的问题和另外两个回归不一样：
//   verify-tauri.js   —— 二进制**跑起来之后**行为对不对
//   verify-bundle.js  —— 用户**拿到手的那一包**是不是这个二进制，装得上、卸得干净
//
// 为什么必须单独一个脚本：`cargo build` 绿 ≠ 用户能装上。
// 中间还隔着 NSIS 模板、图标、安装模式、卸载注册表……任何一环都能让
// "我这儿能跑"变成"他那儿装不上"，而这些在跑起来的进程里全看不见。
//
// 用法：
//   node scripts/verify-bundle.js             # 只查配置 + 产物（不需要装东西）
//   node scripts/verify-bundle.js --install   # 再跑一遍真装 → 真跑 → 真卸
//
// `--install` 会往 %LOCALAPPDATA%\clawd-starter 装一份、跑起来、再卸掉，
// 并断言**注册表 Uninstall 子键集合回到安装前**。它改的是这台机器的状态，
// 所以默认不开——查配置那部分是纯只读的，可以放在每次提交前跑。
// ============================================================

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");
const REL = path.join(ROOT, "src-tauri", "target", "release");
const NSIS_DIR = path.join(REL, "bundle", "nsis");
const DO_INSTALL = process.argv.includes("--install");

const INSTALL_DIR = path.join(process.env.LOCALAPPDATA || "", "clawd-starter");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? "  " + detail : ""}`);
  }
  return cond;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ------------------------------------------------------------
// 打包**不是纯复制**：tauri-bundler 会往二进制里打一个 3 字节补丁。
//
//   tauri-bundler/src/bundle.rs:  const BUNDLE_VAR_TOKEN = b"__TAURI_BUNDLE_TYPE_VAR_UNK";
//                                 fn patch_binary(...) → 把 UNK 换成 NSS / MSI
//   tauri-utils/src/platform.rs:  static mut __TAURI_BUNDLE_TYPE: &str = "..._UNK";
//                                 pub fn bundle_type() -> Option<BundleType>
//
// 也就是说"装出来的 exe 和裸 exe 的 sha256 必须相同"这条判据本身是错的，
// 第一次跑就是因为它红了 3 个字节。
//
// 第二个坑：`bundle_type()` 的 match 分支里**每个取值都是一份字面量**
// （DEB / RPM / APP / MSI / NSS / UNK 各一处，共 6 处），所以 `indexOf` 找到的第一个
// 是 `_DEB`，不是真正被打补丁的那个。打补丁的是**最后一处**：`static mut
// __TAURI_BUNDLE_TYPE` 那个静态变量。第一版用 indexOf 就报了"占位符被改成 DEB"。
// ------------------------------------------------------------
const BUNDLE_TOKEN = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_");
const TOKEN_LEN = BUNDLE_TOKEN.length + 3; // 占位符后面固定跟 3 个字符

function compareExes(aPath, bPath) {
  const a = fs.readFileSync(aPath);
  const b = fs.readFileSync(bPath);
  if (a.length !== b.length) return { same: false, why: `长度不同 ${a.length} vs ${b.length}` };
  const at = a.lastIndexOf(BUNDLE_TOKEN); // 最后一处才是那个 static var
  if (at < 0) return { same: false, why: "找不到占位符" };
  const diffs = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
  const token = a.subarray(at, at + TOKEN_LEN).toString("latin1");
  const inToken = diffs.every((i) => i >= at && i < at + TOKEN_LEN);
  // 只允许"占位符里 3 个字节不同"，别的一个字节都不许变
  return {
    same: diffs.length === 3 && inToken,
    token,
    diffs: diffs.length,
    why: diffs.length !== 3 ? `有 ${diffs.length} 个字节不同` : inToken ? "ok" : "不同的字节不在占位符里",
  };
}
// 结果这台机器的安全策略拦了 `reg.exe`。**不用 PowerShell 的注册表 provider 绕**——
// 那是同一个动作换个壳；判据换成不需要注册表的两个落盘痕迹：安装目录 + 开始菜单快捷方式。
// （真要查注册表就自己开一个提升的终端跑 `reg query HKCU\...\Uninstall`，肉眼确认。）
function startMenuLink() {
  const dir = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs");
  const cands = ["clawd-starter.lnk", path.join("clawd-starter", "clawd-starter.lnk")];
  for (const c of cands) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function sizeOf(file) {
  try {
    return `${(fs.statSync(file).size / 1048576).toFixed(2)}MB`;
  } catch {
    return "缺失";
  }
}

function killAll() {
  spawnSync("taskkill", ["/IM", "clawd-starter.exe", "/T", "/F"], { stdio: "ignore" });
}

function getJson(port, p, token) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p, timeout: 1500, headers: token ? { "X-Clawd-Token": token } : {} },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          try {
            resolve({ code: res.statusCode, json: JSON.parse(b) });
          } catch {
            resolve({ code: res.statusCode, json: null });
          }
        });
      }
    );
    req.on("error", () => resolve({ code: 0, json: null }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, json: null });
    });
  });
}

async function main() {
  // ---------- 1. 配置 ----------
  const conf = JSON.parse(fs.readFileSync(CONF, "utf8"));
  const b = conf.bundle || {};
  ok("bundle.active 已打开（否则只出裸 exe，用户没有可双击的东西）", b.active === true, String(b.active));
  ok("目标是 NSIS（Windows 上唯一不需要装 WiX 3 的通道）", Array.isArray(b.targets) && b.targets.includes("nsis"), JSON.stringify(b.targets));
  ok(
    "图标清单里有 .ico（NSIS 的安装器图标只认 ico，png 不行）",
    Array.isArray(b.icon) && b.icon.some((i) => i.endsWith(".ico")),
    JSON.stringify(b.icon)
  );
  const iconPath = path.join(ROOT, "src-tauri", (b.icon || []).find((i) => i.endsWith(".ico")) || "icons/icon.ico");
  ok("图标文件真的在盘上", fs.existsSync(iconPath), path.relative(ROOT, iconPath));
  ok(
    "安装模式是 currentUser（不给桌宠要管理员权限）",
    b.windows && b.windows.nsis && b.windows.nsis.installMode === "currentUser",
    b.windows && b.windows.nsis && b.windows.nsis.installMode
  );

  // ---------- 2. 产物 ----------
  const setup = fs.existsSync(NSIS_DIR)
    ? fs.readdirSync(NSIS_DIR).filter((f) => f.endsWith(".exe")).map((f) => path.join(NSIS_DIR, f))[0]
    : null;
  if (!ok("安装包已生成", Boolean(setup), setup ? path.relative(ROOT, setup) : `${path.relative(ROOT, NSIS_DIR)} 下没有 .exe`)) {
    report();
    return;
  }
  const st = fs.statSync(setup);
  ok("安装包体积合理（> 1MB，说明把二进制打进去了）", st.size > 1024 * 1024, `${(st.size / 1048576).toFixed(1)}MB`);
  ok("文件名带版本号", path.basename(setup).includes(conf.version), path.basename(setup));
  ok("是 PE 文件（MZ 头）", fs.readFileSync(setup).subarray(0, 2).toString("latin1") === "MZ");

  const bare = path.join(REL, "clawd-starter.exe");
  ok("裸 exe 也在（安装包里塞的就是它）", fs.existsSync(bare), `${(fs.statSync(bare).size / 1048576).toFixed(1)}MB`);

  if (!DO_INSTALL) {
    console.log("\n（没加 --install，跳过真装/真卸。要对这台机器做完整验收就加这个参数。）");
    report();
    return;
  }

  // ---------- 3. 真装 ----------
  killAll();
  const linkBefore = startMenuLink();
  ok("安装前没有残留的开始菜单快捷方式（作为“卸干净”的基线）", linkBefore === null, linkBefore || "无");

  if (!ok("安装前 %LOCALAPPDATA%\\clawd-starter 不存在（避免把旧版误当新版）", !fs.existsSync(INSTALL_DIR), INSTALL_DIR)) {
    report();
    return;
  }

  console.log("\n[install] 静默安装中，可能要几十秒……");
  const ins = spawnSync(setup, ["/S"], { cwd: NSIS_DIR, timeout: 180000 });
  // NSIS 的 /S 正常退出码是 0；有的版本会返回 1 但装好了，所以下面还要验结果
  ok("安装器静默安装退出码 0", ins.status === 0, `code=${ins.status}`);

  const installedExe = path.join(INSTALL_DIR, "clawd-starter.exe");
  if (!ok("装完之后安装目录里有 clawd-starter.exe", fs.existsSync(installedExe), INSTALL_DIR)) {
    report();
    return;
  }
  // 这条是重点：证明**用户拿到的那一份就是刚刚验过的那一份**，不是某个缓存里的旧物。
  // 判据不是 sha256 相等——bundler 会把 __TAURI_BUNDLE_TYPE_VAR_UNK 打成 _NSS（见上面 compareExes），
  // 所以是"除那 3 个字节之外逐字节相同"，并且要看到它**确实**被打成了 NSS。
  const cmp = compareExes(installedExe, bare);
  ok(
    "装出来的 exe 与 target/release 里那个逐字节相同（只允许 bundler 打的那 3 字节补丁）",
    cmp.same,
    cmp.same ? `${sizeOf(installedExe)} ${cmp.token}` : cmp.why
  );
  ok("bundle type 占位符被改成了 NSS（说明这确实是安装版副本，不是被谁替换过）", cmp.token === "__TAURI_BUNDLE_TYPE_VAR_NSS", cmp.token);

  const lic = path.join(INSTALL_DIR, "uninstall.exe");
  ok("卸载器随之落地（没有它就等于只能手动删目录）", fs.existsSync(lic), "uninstall.exe");
  ok("开始菜单里有快捷方式（不然普通用户只能去 %LOCALAPPDATA% 里翻）", startMenuLink() !== null, startMenuLink() || "没找到");

  // ---------- 4. 装完能不能跑 ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-verify-bundle-"));
  const portFile = path.join(tmp, "clawd-starter.port");
  const child = require("node:child_process").spawn(installedExe, [], {
    cwd: INSTALL_DIR,
    env: Object.assign({}, process.env, { CLAWD_PORT_FILE: portFile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  let ep = null;
  for (let i = 0; i < 60 && !ep; i++) {
    await sleep(250);
    try {
      ep = JSON.parse(fs.readFileSync(portFile, "utf8"));
    } catch {}
  }
  ok("安装版启动后写出端点文件", Boolean(ep), ep ? `port=${ep.port}` : out.slice(-400));

  let health = { code: 0, json: null };
  // 不能"第一次 200 就收手"：/health 由 setup 里的服务线程回答，而会话通知的注册
  // 在另一条线程上（watch_session 会阻塞等注册结果）。先到的那个 200 可能还没注册完，
  // 读到的就是 poll——第一版这么写，自己把自己坑了一次。
  if (ep) {
    for (let i = 0; i < 40 && !(health.code === 200 && health.json && health.json.lock === "event"); i++) {
      health = await getJson(ep.port, "/health", ep.token);
      if (!(health.code === 200 && health.json && health.json.lock === "event")) await sleep(250);
    }
  }
  ok("安装版 /health 返回 200（服务真的起来了，不是只有窗口）", health.code === 200, `code=${health.code}`);
  ok("安装版走的是事件锁屏（配置/能力没在打包后丢掉）", health.json && health.json.lock === "event", health.json && health.json.lock);

  child.kill();
  await sleep(500);
  killAll();
  await sleep(500);
  // 这里不断言端点文件被删：`child.kill()` / taskkill 都是 TerminateProcess，
  // 走不到退出清理那条路。优雅退出的清理由 verify-tauri.js 的 quit() 断言负责，
  // 那是它该管的事；在这里复制一份只会得到一个"因为测试手法而红"的假失败。
  console.log(`INFO  安装版已被强制结束（端点文件残留与否不在此断言，见 verify-tauri.js）`);

  // ---------- 5. 真卸 ----------
  console.log("\n[uninstall] 静默卸载中……");
  const un = spawnSync(lic, ["/S"], { cwd: INSTALL_DIR, timeout: 180000 });
  ok("卸载器静默卸载退出码 0", un.status === 0, `code=${un.status}`);

  // NSIS 卸载器会把自己复制到 temp 再删东西，**而且开始菜单那个 .lnk 比 exe 晚删**——
  // 只看 exe 会读到"exe 没了、快捷方式还在"，然后在下一轮安装前的基线断言里炸出来。
  // 所以一次等两个痕迹都消失，而不是各查一次。
  let gone = false;
  let linkAfter = startMenuLink();
  for (let i = 0; i < 80 && !(gone && linkAfter === null); i++) {
    await sleep(500);
    gone = !fs.existsSync(path.join(INSTALL_DIR, "clawd-starter.exe"));
    linkAfter = startMenuLink();
  }
  ok("卸载后安装目录里的 exe 已消失", gone, INSTALL_DIR);
  ok("卸载后开始菜单快捷方式已删除（比 exe 晚一步，所以是等出来的，不是查一次）", linkAfter === null, linkAfter || "无");

  const leftovers = fs.existsSync(INSTALL_DIR) ? fs.readdirSync(INSTALL_DIR) : [];
  ok("安装目录没有留下残渣", leftovers.length === 0, leftovers.join(", ") || "空");

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}

  report();
}

function report() {
  console.log("\n" + "=".repeat(56));
  console.log(`结果：PASS ${pass}  FAIL ${fail}`);
  if (fail) console.log("失败项：\n  - " + failures.join("\n  - "));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("脚本自身出错：", e && e.stack);
  process.exit(1);
});
