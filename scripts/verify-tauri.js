#!/usr/bin/env node
"use strict";
// ============================================================
// Tauri 版回归脚本（S10-5）
//
// 这是本项目唯一一道 UI 闸门（2026-11-03 起：Electron 容器已删，见 DEVLOG）。
//
// 历史备注：它曾经和 verify-electron.js 判据同源、宿主不同——凡是能用同一套
// 判据的（主题、分身、头巾、风险评级、裁决回包），两边照抄同一份断言文案；
// 宿主专属的各测各的。那份对照的价值已经兑现完：迁移期间它证明了
// "渲染层一行没改"，删掉 Electron 之后这些断言就是唯一的守护。
//
// 连的是谁：WebView2 的 CDP。
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>，
//   WebView2 认这个变量，吐出标准的 /json/list。所以 scripts/cdp.js 是共用的。
//
// 用法：
//   node scripts/verify-tauri.js            # 用 target/debug
//   node scripts/verify-tauri.js --release  # 用 target/release
// 退出码 0 = 全过；1 = 有失败项。
// ============================================================

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Cdp, sleep } = require("./cdp");

const ROOT = path.join(__dirname, "..");
const CDP_PORT = 9333;
const BUBBLE_TIMEOUT_MS = 6000;

// ---------- 测试隔离 ----------
// 端点文件测试隔离的理由（原先与 Electron 版同一套，一行都不用改）：
//   1. 端点文件必须隔离，否则会覆盖用户正在用的那份（端口 + token 全变，hook 立刻失效）
//   2. 端口 27333 被占时服务会回退随机端口，这里照样能从临时文件读到真实端口
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-verify-tauri-"));
const PORT_FILE = path.join(TMP_ROOT, "clawd-starter.port");
process.env.CLAWD_PORT_FILE = PORT_FILE;

// ---------- DSH 夹具 ----------
// 为什么不拿本机真实的 ~/.dsh 做断言：那里面有哪些会话、它们是不是"还在活跃窗口内"，
// 完全由用户的历史决定。用它做断言，闸门就成了看运气——本机所有会话都超过 30 分钟
// 没动静时必然 FAIL，而那是**正确行为**。
// 所以造一个临时 DSH_HOME，把 目录扫描 → 解析 → 翻译 → 状态机 → /state 整条链跑通；
// 顺带也就验了 DSH_HOME 这个环境变量覆盖真的生效。
const DSH_FIXTURE = path.join(TMP_ROOT, "dsh-home");
const DSH_FIXTURE_ID = "session-dsh-verify";

function writeDshFixture(phase, promptAt) {
  const dir = path.join(DSH_FIXTURE, "storages", "session_projcache", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const openStep =
    phase === "idle"
      ? null
      : {
          turn: 1,
          step: 1,
          startTime: Date.now(),
          // phase === "thinking" 时首 token 还没落地，这正是它和 working 的分界
          firstTokenTime: phase === "thinking" ? null : Date.now(),
        };
  const record = {
    version: 7,
    record: {
      identity: { createdAt: Date.now(), cwd: "E:\\JacksonLee\\project\\clawd-starter" },
      rows: {
        sessionStats: {
          ver: 1,
          seq: 9,
          val: { turns: 1, steps: 1, lastTurn: 1, llmMs: 10, toolMs: 0, openStep, pendingCalls: {} },
        },
        title: { ver: 1, seq: 9, val: "DSH 验证会话" },
        sessionListMetadata: { ver: 1, seq: 9, val: { blank: false, lastPromptAt: promptAt } },
        plan: { ver: 2, seq: 9, val: { active: false } },
        permissions: { ver: 1, seq: 9, val: { preset: "read-only" } },
        // 2026-11-05：看板开始显示"这条会话在干什么"，夹具要带上这些行，
        // 否则"卡片里有最后一轮对话"这条断言永远只能靠真机碰运气。
        modelSelection: {
          ver: 1,
          seq: 9,
          val: { lastUsed: { provider: "fixture-provider", model: "fixture-model" }, pending: null },
        },
        tokenUsage: {
          ver: 2,
          seq: 9,
          val: {
            totals: { uncachedInputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0 },
            last: null,
          },
        },
        contextPressure: {
          ver: 5,
          seq: 9,
          val: { surfaceTokens: 230, contextWindow: 200000, pressureTokens: 1200 },
        },
        turnOutline: {
          ver: 2,
          seq: 9,
          val: {
            turns: [{ turn: 1, seq: 8, prompt: "验证看板的最后一轮", response: "这一行来自夹具的 turnOutline" }],
            draft: "",
          },
        },
      },
    },
  };
  fs.writeFileSync(path.join(dir, DSH_FIXTURE_ID + ".json"), JSON.stringify(record));
}

const RELEASE = process.argv.includes("--release");
const EXE = path.join(
  ROOT,
  "src-tauri",
  "target",
  RELEASE ? "release" : "debug",
  process.platform === "win32" ? "clawd-starter.exe" : "clawd-starter"
);

let pass = 0;
let fail = 0;
// 跳过项：**要响**。环境做不到的事（读不到剪贴板、调不动系统光标）既不冒充 PASS，
// 也不判 FAIL —— 但必须在结尾列出来，否则闸门就成了"反正它绿"的装饰。
// 判据同 Electron 时代那条剪贴板：[warn] + 计数 + 结尾列项。
const skipped = [];
function skip(name, why) {
  skipped.push(name + " — " + why);
  console.log(`SKIP  ${name}  ${why}`);
}
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

// ------------------------------------------------------------
// HTTP：直连 Rust 服务，绕过渲染层
//
// 为什么要绕过渲染层：这一层是 hook 真正打交道的边界。从渲染层里
// 调 invoke 只能证明"桥通了"，证明不了"hook 发过来的字节被怎么处理"。
// ------------------------------------------------------------
function readEndpoint() {
  try {
    return JSON.parse(fs.readFileSync(PORT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function post(pathname, body, token, opts = {}) {
  const ep = readEndpoint();
  if (!ep) return Promise.resolve({ code: 0, body: "no endpoint" });
  const data = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
  const headers = Object.assign(
    { Host: opts.host || `127.0.0.1:${ep.port}`, Origin: "null" },
    data ? { "Content-Type": opts.contentType || "application/json", "Content-Length": data.length } : {},
    token ? { "X-Clawd-Token": token } : {}
  );
  return new Promise((resolve) => {
    const r = http.request(
      { host: "127.0.0.1", port: ep.port, path: pathname, method: opts.method || "POST", headers, timeout: opts.timeout || 15000 },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ code: res.statusCode, body: b }));
      }
    );
    r.on("error", (e) => resolve({ code: 0, body: String(e) }));
    r.on("timeout", () => {
      r.destroy();
      resolve({ code: 0, body: "timeout" });
    });
    if (data) r.write(data);
    r.end();
  });
}

function getJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 1200 }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

// 按 URL 片段找 target：三个窗口是三个 WebView2，各自一条 CDP 目标。
async function waitTarget(match, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = await getJson(CDP_PORT, "/json/list");
    const hit = (list || []).find((t) => t.type === "page" && match(t.url || ""));
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

// 把系统光标挪一下再挪回去。
//
// 唯一目的是给 gaze 线程一个"看得见的输入变化"——它按设计只在光标动了才 emit，
// 所以"没推送"在光标静止时是正确行为，测不出链路好坏。
//
// **挪几像素是有下限的**：宿主把像素偏差归一化时除以 260，再和阈值 0.02 比
// （`main.rs` 的 gaze 线程），也就是"至少 5.2px"才可能触发。原来这里挪 3px
// （≈0.0115），永远够不着阈值——于是这条断言在没人碰鼠标时必然红，
// 而"红"和"链路断了"看起来一模一样。现在挪 8px（≈0.031）。
//
// 为什么用 PowerShell 而不是 Node：Node 没有调 user32 的入口，而这里要动的
// 就是**操作系统**的光标，不是我们自己进程里的状态。（这和"用 PowerShell 的
// 注册表 provider 绕过被拦的 reg.exe"不是一回事：那是同一动作换个壳，
// 这里是没有第二个壳可选。）非 Windows 直接跳过，断言会如实报 0。
const NUDGE_PX = 8; // 8 / 260 ≈ 0.031，必须大于 main.rs 里的 0.02

function nudgeCursor(px = NUDGE_PX) {
  if (process.platform !== "win32") return false;
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$p=[System.Windows.Forms.Cursor]::Position;",
    `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(($p.X+${px}),($p.Y+${px}));`,
    "Start-Sleep -Milliseconds 120;",
    "[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point($p.X,$p.Y)",
  ].join(" ");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "ignore",
    timeout: 8000,
  });
  return r.status === 0;
}

// 把光标**传送**到绝对坐标（nudge 只会相对挪 8px，光标在远处时钳制让它无效）。
// 给 gaze 断言用：先传送到桌宠窗口内，nudge 才造得出"变化"。
function moveCursorTo(x, y) {
  if (process.platform !== "win32") return false;
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`,
  ].join(" ");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "ignore",
    timeout: 8000,
  });
  return r.status === 0;
}

async function main() {
  console.log("Tauri 迁移回归\n" + "=".repeat(56));

  if (!fs.existsSync(EXE)) {
    console.error(`找不到可执行文件：${EXE}\n先跑 cargo build（或加 --release 前先 cargo build --release）`);
    process.exit(1);
  }

  // 陈旧二进制守卫。
  //
  // 为什么值得单独一段：debug 目录里躺着的是一份**几小时前的**二进制，
  // 而 `withGlobalTauri`、IPC 白名单、/health 的 lock 字段全是编译期就定死的。
  // 于是拿旧二进制跑，会得到 8 条看起来像"代码坏了"的 FAIL——
  // 真实原因是那几个修复根本没编进去。这类失败最贵：它会让人回头去改
  // 一段本来就对的代码。宁可在开跑前拦下来。
  const srcDirs = [path.join(ROOT, "src"), path.join(ROOT, "src-tauri", "src")];
  const newest = (dir) => {
    if (!fs.existsSync(dir)) return 0;
    let t = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) t = Math.max(t, newest(p));
      else if (/\.(rs|js|json|html|css)$/.test(e.name)) t = Math.max(t, fs.statSync(p).mtimeMs);
    }
    return t;
  };
  const srcAt = Math.max(...srcDirs.map(newest));
  const exeAt = fs.statSync(EXE).mtimeMs;
  if (srcAt > exeAt) {
    const ages = Math.round((srcAt - exeAt) / 1000);
    console.error(
      `可执行文件比源码旧 ${ages}s：${EXE}\n` +
        `它不含你刚改的东西，跑出来的失败会是假的。先跑：\n` +
        `  cd src-tauri && cargo build${RELEASE ? " --release" : ""}`
    );
    process.exit(1);
  }

  if (!(await portFree(CDP_PORT))) {
    console.error(`调试端口 ${CDP_PORT} 被占用，先关掉其他调试实例。`);
    process.exit(1);
  }

  // 清掉可能残留的端点文件，保证"启动时写端点"这条路径是真的执行了
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {}

  // 启动前**不要**摆夹具：那份 "working" 的会话会从第一秒就多出一只猫，
  // 把后面所有"场上有几只猫 / attention 播完回 idle"的断言全部带偏。
  // 夹具在 DSH 那一段里现造现撤（见下文）。

  const child = spawn(EXE, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAWD_PERMISSION_TIMEOUT_MS: String(BUBBLE_TIMEOUT_MS),
      CLAWD_PORT_FILE: PORT_FILE,
      // 指向临时夹具，不碰用户真实的 ~/.dsh
      DSH_HOME: DSH_FIXTURE,
      // WebView2 认这个变量：注入 Chromium 命令行开关。
      // 这是 Tauri 版能被 CDP 驱动的前提，也是当年整套 Electron 回归能平移过来的原因。
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let childOut = "";
  child.stdout.on("data", (c) => (childOut += c));
  child.stderr.on("data", (c) => (childOut += c));

  let R = null;
  let B = null; // 气泡窗口
  let D = null; // 看板窗口
  const pageErrors = [];

  try {
    // ---------- 0. 启动 ----------
    const t0 = Date.now();
    const mainTarget = await waitTarget((u) => !u.includes("bubble") && !u.includes("dashboard"), 20000);
    if (!mainTarget) {
      console.error("主窗口 20s 内没暴露 CDP。子进程输出：\n" + childOut);
      process.exit(1);
    }
    ok("主窗口启动并暴露 CDP", true, `${Date.now() - t0}ms`);

    R = await Cdp.connect(mainTarget.webSocketDebuggerUrl);
    await R.send("Runtime.enable");
    R.on("Runtime.exceptionThrown", (p) => pageErrors.push((p && p.exceptionDetails && p.exceptionDetails.text) || "?"));
    R.on("Runtime.consoleAPICalled", (p) => {
      if (p && p.type === "error") pageErrors.push("console.error: " + JSON.stringify(p.args && p.args[0] && p.args[0].value).slice(0, 120));
    });

    for (let i = 0; i < 60; i++) {
      const ready = await R.eval("document.readyState");
      const painted = await R.eval("!!document.querySelector('.layer.show svg')");
      if (ready === "complete" && painted) break;
      await sleep(150);
    }

    // ---------- 1. 宿主与桥 ----------
    // 这几条是整个迁移的地基。桥没装上的话下面全部会以一种很难看的方式失败
    // （画面是"浏览器预览模式"的呆滞造型，而不是报错），所以先钉死。
    ok("页面加载完成", (await R.eval("document.readyState")) === "complete");
    ok("宿主标记为 tauri（桥真的装了，不是空转）", (await R.eval("window.__CLAWD_HOST__")) === "tauri");
    ok(
      "window.clawd 20 个动作齐全",
      (await R.eval(
        "['onState','onCast','onGaze','dragStart','dragEnd','setIgnoreMouse','setHitRects','hitState','dshState','wake','quit','petMenu','toggleDashboard','getTheme','onTheme','openCompose','saySend','onSayDone','composeContext','composeClose'].every(k=>typeof (window.clawd||{})[k]==='function')"
      )) === true
    );
    ok(
      "window.bubble 4 个动作齐全",
      (await R.eval("['onRequest','decide','setHeight','ready'].every(k=>typeof (window.bubble||{})[k]==='function')")) === true
    );
    ok(
      "window.dashboard 8 个动作齐全",
      (await R.eval(
        "['getSnapshot','copyPath','listThemes','setTheme','onTheme','dshSessions','saySend','onSayDone'].every(k=>typeof (window.dashboard||{})[k]==='function')"
      )) === true
    );
    // 和 preload 同一条原则：只暴露具体动作，绝不把 ipc 本身漏出去。
    // Tauri 的 __TAURI__.core.invoke 如果能从 window.clawd 摸到，
    // 渲染层就等于拿到了"调用任意命令"的通用口子，那 16 个命令的边界就白设了。
    ok("桥没有把 invoke 本身漏给渲染层", (await R.eval("typeof window.clawd.invoke === 'undefined'")) === true);
    ok("桥没有把 __TAURI__ 整个挂到 clawd 上", (await R.eval("window.clawd.core === undefined && window.clawd.event === undefined")) === true);

    // ---------- 1.5 命令边界（S10-6②） ----------
    // withGlobalTauri 关掉之后，页面上少了一整套便利 API（里面有 core.invoke）。
    // 但**通用的口子并没有消失**：__TAURI_INTERNALS__.invoke 还在，而且它的
    // 属性描述符是 writable:false + configurable:false，删不掉也改不掉。
    // 所以"关掉 withGlobalTauri"缩小的是可发现面，真正的边界是 Rust 侧的
    // 每窗口白名单（main.rs 的 only()）。下面三条把这两件事一起钉住。
    ok("withGlobalTauri 已关：window.__TAURI__ 不存在", (await R.eval("typeof window.__TAURI__")) === "undefined");

    // 开机自启的能力落点（S10-7①）。2026-11-03 之前这里是"两套容器逐条对齐"
    // 的静态检查（硬约束 35）；Electron 容器删掉之后，剩下的这一侧就是唯一实现，
    // 检查退化成"注册表那两个函数还在"——防止哪天被顺手删掉而托盘勾选悄悄失灵。
    const sysRsSrc = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "sys.rs"), "utf8");
    ok(
      "开机自启：Tauri 侧有 autostart_set / autostart_enabled",
      sysRsSrc.includes("pub fn autostart_set") && sysRsSrc.includes("pub fn autostart_enabled")
    );
    const internalsDesc = String(
      await R.eval(
        "JSON.stringify(Object.getOwnPropertyDescriptor(window,'__TAURI_INTERNALS__'),(k,v)=>typeof v==='function'?'[fn]':v)"
      )
    );
    ok(
      "__TAURI_INTERNALS__ 仍在且不可配置（所以边界必须在 Rust 侧）",
      /"configurable":false/.test(internalsDesc) && /"writable":false/.test(internalsDesc),
      internalsDesc.slice(0, 70)
    );
    // 用**主窗口**去调只有气泡才有资格调的命令。走 __TAURI_INTERNALS__ 直连，
    // 不经过 window.clawd——这一条测的是 Rust 那边拦不拦得住，不是桥拦不拦。
    const crossMain = String(
      await R.eval(
        "window.__TAURI_INTERNALS__.invoke('permission_decide',{id:1,decision:'allow'}).then(()=>'ALLOWED').catch(e=>'ERR:'+String(e))"
      )
    );
    ok("主窗口调气泡的命令 → 被 Rust 白名单拒掉", /ERR:.*forbidden/.test(crossMain), crossMain.slice(0, 60));
    const crossQuit = String(
      await R.eval(
        "window.__TAURI_INTERNALS__.invoke('dashboard_snapshot',{}).then(()=>'ALLOWED').catch(e=>'ERR:'+String(e))"
      )
    );
    ok("主窗口调看板的命令（读会话快照）→ 也被拒", /ERR:.*forbidden/.test(crossQuit), crossQuit.slice(0, 60));

    // ---------- 2. 主题（绕不过 CSP 的那一步） ----------
    // getTheme 走的是 invoke → fetch("http://ipc.localhost/theme_get")，
    // 这是**唯一**会被 connect-src 拦的路径。它通，说明 CSP 那条口子开对了；
    // 它不通，主题会是 null，画面是空白。
    let themeInfo = null;
    for (let i = 0; i < 60; i++) {
      themeInfo = await R.eval("window.petDebug ? window.petDebug.theme() : null");
      if (themeInfo && themeInfo.id) break;
      await sleep(150);
    }
    ok("主题经 IPC 拉回来了（CSP 放行 ipc 生效）", !!(themeInfo && themeInfo.id), themeInfo && themeInfo.id);
    ok("主题带了完整的状态帧", !!(themeInfo && themeInfo.frames && themeInfo.frames.idle > 0));
    ok("骨架引擎是弹簧模式（不是贴帧）", themeInfo && themeInfo.rig === "spring", themeInfo && themeInfo.rig);

    // ---------- 3. DOM / 画面 ----------
    ok("#pet 存在", (await R.eval("!!document.getElementById('pet')")) === true);
    ok("至少画出一个 svg", (await R.eval("document.querySelectorAll('#pet svg').length")) >= 1);
    ok("窗口背景是透明的", (await R.eval("getComputedStyle(document.body).backgroundColor")) === "rgba(0, 0, 0, 0)");
    const springs = await R.eval("JSON.stringify(Object.keys((window.petDebug && window.petDebug.springs()) || {}).length)");
    ok("弹簧通道在同一条线上（不是静态图）", Number(springs) > 10, `通道 ${springs} 个`);
    // 硬约束 19 是**源码级**的：命令是不可信字符串，只有"src 下 innerHTML 出现 0 次"
    // 才是真正被守住的东西。在页面里数一遍 DOM 什么也证明不了。
    const innerHtmlHits = [];
    for (const dir of [path.join(ROOT, "src"), path.join(ROOT, "src-tauri", "src")]) {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(js|rs)$/.test(f)) continue;
        // 必须先把注释剥掉：好几处注释本身就在写"不要用 innerHTML"，
        // 直接 includes() 会把"守规矩的说明"判成"违规的代码"。
        const code = fs
          .readFileSync(path.join(dir, f), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .filter((line) => !/^\s*\/\//.test(line))
          .join("\n");
        if (/innerHTML/.test(code)) innerHtmlHits.push(f);
      }
    }
    ok("src/ 与 src-tauri/src 下 innerHTML 出现 0 次（硬约束 19 依然成立）", innerHtmlHits.length === 0, innerHtmlHits.join(","));

    // ---------- 4. HTTP 的四道锁 ----------
    const ep = readEndpoint();
    ok("启动时写了端点文件（hook 靠它找端口）", !!(ep && ep.port && ep.token), ep ? `port=${ep.port}` : "");
    ok("端点文件权限不外泄（token 是 64 位十六进制）", !!(ep && /^[0-9a-f]{64}$/.test(ep.token)));

    const noToken = await post("/state", { session_id: "sec", event: "PreToolUse" }, null);
    ok("/state 无 token → 401", noToken.code === 401, String(noToken.code));
    const badToken = await post("/state", { session_id: "sec", event: "PreToolUse" }, "0".repeat(64));
    ok("/state 错 token → 401", badToken.code === 401, String(badToken.code));
    const badHost = await post("/state", { session_id: "sec", event: "PreToolUse" }, ep.token, { host: "evil.example.com" });
    ok("Host 不是本机回环 → 403（DNS rebinding 挡在这里）", badHost.code === 403, String(badHost.code));
    const badType = await post("/state", { session_id: "sec", event: "PreToolUse" }, ep.token, { contentType: "text/plain" });
    ok("Content-Type 不是 json → 415（挡住免预检的简单请求）", badType.code === 415, String(badType.code));
    const health = await post("/health", null, ep.token, { method: "GET" });
    ok("/health 带 token → 200", health.code === 200, health.body.slice(0, 40));
    // S10-6③：锁屏走的是事件还是 2s 轮询。/health 里带这个字段就是为了
    // "锁屏后没藏窗口"这种没法当场复现的问题——两种模式的失败长得一模一样。
    let healthJson = null;
    try {
      healthJson = JSON.parse(health.body);
    } catch {}
    ok(
      "锁屏走事件（WTSRegisterSessionNotification 注册成功，不是退回轮询）",
      healthJson && healthJson.lock === "event",
      healthJson && healthJson.lock
    );

    // ---------- 5. 状态推送：从 HTTP 一路走到画面 ----------
    //
    // 这一段是迁移里最容易"看起来绿其实是红"的地方，因为 apply() 内部
    // 已经调过 tick()，tick() 会顺手更新 last_visual。心跳再 tick() 比的是
    // "新值 vs 新值"，返回 false —— 变化就永远不会被推出去。
    // 所以这里断言的不是"接口返回了 working"，而是"画面真的变成了 working"。
    await post("/state", { session_id: "s1", event: "PreToolUse", tool_name: "Bash" }, ep.token);
    let visual = null;
    for (let i = 0; i < 20; i++) {
      visual = await R.eval("window.petDebug.state()");
      if (visual === "working") break;
      await sleep(100);
    }
    ok("POST /state 之后画面立刻变成 working（推送没被 tick 吞掉）", visual === "working", String(visual));
    const evs = await R.eval("JSON.stringify((window.petDebug.events()||[]).slice(-1))");
    ok("事件时间线记下了 from→to", typeof evs === "string" && evs.includes('"to":"working"'));

    // Stop 映射的是 attention（"干完了，看你一眼"），不是 idle。
    // 它是 oneshot：默认 2400ms 播完自动回 idle —— 这条也要测，
    // 否则"猫永远在喊"这种 bug 只能靠盯着屏幕发现。
    await post("/state", { session_id: "s1", event: "Stop" }, ep.token);
    await sleep(400);
    ok("Stop 之后进入 attention", (await R.eval("window.petDebug.state()")) === "attention", await R.eval("window.petDebug.state()"));
    await sleep(2600);
    ok("attention 播完自动回 idle（oneshot 真的在走）", (await R.eval("window.petDebug.state()")) === "idle", await R.eval("window.petDebug.state()"));

    // 收掉这条会话，否则它会作为"第 4 只猫"混进分身那一段，
    // 把"场上 3 只"和"泡泡 3 行"同时弄错（它是一个没有标题的会话）。
    await post("/state", { session_id: "s1", event: "SessionEnd" }, ep.token);
    await sleep(2200);

    // ---------- 6. 分身与泡泡 ----------
    //
    // 这里原来测的是"每只猫的头巾上写着各自的词"。2026-11-04 头巾删掉了，
    // 那套信息搬到了猫头顶的消息泡泡里——判据跟着搬，覆盖的东西没变：
    // 谁是谁、各自什么状态、点了能不能切换。
    //
    // c1 给 PreToolUse（working + 工具名），c2/c3 只给 UserPromptSubmit（thinking）。
    // 刻意让状态不一样：全都一样的话，"泡泡里的状态真的是各自会话的"这件事
    // 就退化成"三个同样的字符串"，断言看着绿其实没判什么。
    await post("/state", { session_id: "c1", event: "PreToolUse", tool_name: "Bash", title: "登录页重构" }, ep.token);
    await post("/state", { session_id: "c2", event: "UserPromptSubmit", title: "数据迁移" }, ep.token);
    await post("/state", { session_id: "c3", event: "UserPromptSubmit", title: "写测试" }, ep.token);
    await sleep(1400); // 分身名单 1s 一推
    let cast = JSON.parse((await R.eval("JSON.stringify(window.petDebug.cast())")) || "{}");
    ok("多条会话 → 进入分身模式", cast.mode === "cast", cast.mode);
    ok("场上出现 3 只猫", (cast.cats || []).length === 3, `实际 ${(cast.cats || []).length} 只`);
    ok("只有一只猫是聚焦的", (cast.cats || []).filter((c) => c.focus).length === 1);
    ok("猫身上不再写关键词（头巾已删）", !("keyword" in ((cast.cats || [])[0] || {})), JSON.stringify(Object.keys((cast.cats || [])[0] || {})));

    // 泡泡：显示 / 行数 / 状态 / 标题
    let bub = JSON.parse((await R.eval("JSON.stringify(window.petDebug.bubble())")) || "{}");
    ok("泡泡出现了（有任务就常驻）", bub.visible === true, JSON.stringify(bub.visible));
    ok("一行一个任务，和台上的猫一一对应", (bub.rows || []).length === 3, `实际 ${(bub.rows || []).length} 行`);
    ok("每行前面都带状态词", (bub.rows || []).every((r) => r.tag && r.tag.length > 0), JSON.stringify((bub.rows || []).map((r) => r.tag)));
    const stateById = new Map((cast.cats || []).map((c) => [c.id, c.state]));
    ok(
      "泡泡里的状态和那只猫在演的状态一致（各是各的，不是同一个词）",
      (bub.rows || []).every((r) => r.tag === stateById.get(r.id)) && new Set((bub.rows || []).map((r) => r.tag)).size > 1,
      JSON.stringify((bub.rows || []).map((r) => [r.id, r.tag]))
    );
    ok("标题各不相同", new Set((bub.rows || []).map((r) => r.title)).size === 3, JSON.stringify((bub.rows || []).map((r) => r.title)));
    ok(
      "标题就是会话的标题（不是 id 兜底）",
      (bub.rows || []).map((r) => r.title).sort().join(",") === ["数据迁移", "写测试", "登录页重构"].sort().join(","),
      JSON.stringify((bub.rows || []).map((r) => r.title))
    );

    // 命中区必须含泡泡那一块。缺了它泡泡就是"看得见点不到"——
    // 而窗口整体是穿透的，这个失败在屏幕上完全看不出来（鼠标就是划过去了）。
    await sleep(400); // reportHits 200ms 一拍
    const bubHitSig = await R.eval("window.petDebug.hitRects()");
    const bubHitCount = String(bubHitSig || "").split("|").filter(Boolean).length;
    ok("命中区含泡泡那一块（3 只猫 + 1 个泡泡 = 4 块）", bubHitCount === 4, `实际 ${bubHitCount} 块：${bubHitSig}`);

    // 用户明确要求"横排、有重叠"，所以这里**不能**断言不重叠。
    // 要断言的是"从左到右排开"（没叠成一坨）和"每只都看得见"（没被完全盖住）。
    const layout = JSON.parse((await R.eval(
      "JSON.stringify([...document.querySelectorAll('.cat')].map(e=>{const r=e.getBoundingClientRect();return {l:Math.round(r.left),w:Math.round(r.width),o:getComputedStyle(e).opacity};}))"
    )) || "[]");
    ok("猫是从左到右排开的", layout.every((c, i) => i === 0 || c.l > layout[i - 1].l), JSON.stringify(layout.map((c) => c.l)));
    ok("每只猫都还看得见（没被完全盖住）", layout.length > 0 && layout.every((c) => Number(c.o) > 0.3 && c.w > 20), "");
    ok("相邻两只至少有部分重叠（用户要的是「挤在一起」）", layout.length < 2 || layout[1].l < layout[0].l + layout[0].w);

    // 泡泡不压猫的脸：泡泡的下沿必须在猫耳尖之上。
    // 这条只有几何能证明——截图里"刚好压住一点"和"没压住"看起来都很自然。
    // 量的是耳尖（#rig-ear-l）不是 .cat 的盒子：#pet 是 176 的方盒，
    // 但画出来的猫只占下半截，拿盒子比会把一大片空气当成"猫头"。
    const geom = JSON.parse((await R.eval(
      "JSON.stringify((()=>{const b=document.getElementById('bubble-wrap').getBoundingClientRect();const e=document.querySelector('.cat #rig-ear-l')||document.querySelector('#rig-ear-l');const r=e.getBoundingClientRect();return {bBottom:Math.round(b.bottom),earTop:Math.round(r.top)};})())"
    )) || "{}");
    ok("泡泡在猫耳尖之上（没有压住脸）", geom.bBottom <= geom.earTop, JSON.stringify(geom));
    // "在上面"还不够：离着一百像素也算在上面，但那样尾巴就是指着空气。
    // 这条钉的是"贴着"——判据上限 40px（实测 18px，留给 FX 图标的）。
    ok(
      "泡泡贴着猫（间距 0–40px，不是悬在半空）",
      geom.earTop - geom.bBottom >= 0 && geom.earTop - geom.bBottom <= 40,
      `间距 ${geom.earTop - geom.bBottom}px`
    );

    // 点一行 = 聚焦那只猫 + 展开详情
    const targetRow = (bub.rows || []).find((r) => r.id !== cast.focused) || (bub.rows || [])[0];
    await R.eval(`window.petDebug.clickBubble(${JSON.stringify(targetRow.id)})`);
    await sleep(400);
    cast = JSON.parse((await R.eval("JSON.stringify(window.petDebug.cast())")) || "{}");
    ok("点泡泡里的一行 → 对应的分身猫到前面来", cast.focused === targetRow.id, `focused=${String(cast.focused)} 期望=${targetRow.id}`);
    bub = JSON.parse((await R.eval("JSON.stringify(window.petDebug.bubble())")) || "{}");
    const opened = (bub.rows || []).find((r) => r.id === targetRow.id) || {};
    ok("点一行 → 展开这一条的详情", bub.expanded === targetRow.id && opened.open === true, JSON.stringify({ expanded: bub.expanded, open: opened.open }));
    ok(
      "详情里有阶段 / 已跑 / 目录",
      /阶段/.test(opened.more || "") && /已跑/.test(opened.more || "") && /目录/.test(opened.more || ""),
      JSON.stringify(opened.more || "")
    );
    ok(
      "展开的那条能读到「已跑」的具体时长（不是空占位）",
      /已跑\s*\d+\s*(秒|分)/.test(opened.more || ""),
      JSON.stringify((opened.more || "").slice(0, 80))
    );

    // 再点一下：收起详情，但**聚焦不该跟着撤销**
    await R.eval(`window.petDebug.clickBubble(${JSON.stringify(targetRow.id)})`);
    await sleep(300);
    const bubCollapsed = JSON.parse((await R.eval("JSON.stringify(window.petDebug.bubble())")) || "{}");
    const castAfter = JSON.parse((await R.eval("JSON.stringify(window.petDebug.cast())")) || "{}");
    ok("再点一下收起详情", bubCollapsed.expanded === null, JSON.stringify(bubCollapsed.expanded));
    ok("收起详情不会把聚焦也撤掉（用户只是想关掉详情）", castAfter.focused === targetRow.id, String(castAfter.focused));

    // 上限 4 只
    for (const id of ["c4", "c5", "c6"]) {
      await post("/state", { session_id: id, event: "UserPromptSubmit", title: "第" + id }, ep.token);
    }
    await sleep(1400);
    cast = JSON.parse((await R.eval("JSON.stringify(window.petDebug.cast())")) || "{}");
    bub = JSON.parse((await R.eval("JSON.stringify(window.petDebug.bubble())")) || "{}");
    ok("最多同时 4 只（再多就挤在一起看不清了）", (cast.cats || []).length <= 4, `实际 ${(cast.cats || []).length} 只`);
    ok("泡泡的行数跟着上限走（不会列出没上台的会话）", (bub.rows || []).length === (cast.cats || []).length, `泡泡 ${(bub.rows || []).length} 行 / 猫 ${(cast.cats || []).length} 只`);
    ok("聚焦的那只不会被新来的挤掉", (cast.cats || []).some((c) => c.focus && c.id === cast.focused));

    // 收摊：把会话清掉，回到单猫
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
      await post("/state", { session_id: id, event: "SessionEnd" }, ep.token);
    }
    await sleep(2400); // 淡出 1.6s + 名单 1s
    ok("会话结束后回到单猫", (await R.eval("window.petDebug.cast().mode")) === "solo");
    const bubEmpty = JSON.parse((await R.eval("JSON.stringify(window.petDebug.bubble())")) || "{}");
    ok("没有任务了泡泡就收起（不留空壳）", bubEmpty.visible === false && (bubEmpty.rows || []).length === 0, JSON.stringify(bubEmpty));

    // ---------- 6.5 说一句话：从桌宠发消息的入口（2026-11-05） ----------
    //
    // 这一节只钉**入口和边界**，不真的发一条消息出去：
    // 真发一次 = 起一个 node + 一次真实的模型调用（约 8 秒、要花钱），
    // 而"发得出去"这件事是 dsh 自己的责任，我们的责任是"把话交对地方"。
    //
    // 三个入口都在这里测：泡泡底部的「说一句」（新会话）、行右侧的 ✎（对着这条说）、
    // 以及——最要紧的——**输入窗自己有没有资格调别的窗口的命令**。
    await post("/state", { session_id: "s-say", event: "UserPromptSubmit", title: "对着这条说" }, ep.token);
    await sleep(1200);

    ok("点泡泡底部「说一句」→ 交给宿主", (await R.eval("window.petDebug.clickSayNew()")) === true);
    let composeTarget = null;
    for (let i = 0; i < 40 && !composeTarget; i++) {
      composeTarget = await waitTarget((u) => u.includes("compose"), 800);
    }
    ok("输入窗被建出来了", !!composeTarget);
    if (composeTarget) {
      const W = await Cdp.connect(composeTarget.webSocketDebuggerUrl);
      await W.send("Runtime.enable");
      await sleep(500);
      const st = JSON.parse((await W.eval("JSON.stringify(window.composeDebug.state())")) || "{}");
      ok("新会话时目标写的是「新会话」+ 会落在哪个目录", /新会话/.test(st.to || "") && /·/.test(st.to || ""), JSON.stringify(st.to));
      ok("输入框已聚焦（打开就能打字）", (await W.eval("document.activeElement && document.activeElement.id")) === "text");

      // 行右侧的 ✎：换成"接着这一条说"，目标行要跟着换
      await R.eval("window.petDebug.clickSay('s-say'), 1");
      // 900ms 留给两条路都走完：compose:open 事件（路 A）和页面自己每 500ms 问一次
      // （路 B，见 compose-renderer.js 的 startPolling）。两条都在是刻意的——
      // 路 A 一度因为输入窗没进 capabilities 而整条被 ACL 拒掉，
      // 而当时只有路 A，"目标不刷新"看起来像时序问题（见本文件下面那条 ACL 断言）。
      await sleep(900);
      const st2 = JSON.parse((await W.eval("JSON.stringify(window.composeDebug.state())")) || "{}");
      ok("点某一行的 ✎ → 目标变成那条会话", /对着这条说/.test(st2.to || ""), JSON.stringify(st2.to));
      ok("目标行同时报出了它属于哪个目录", /·/.test(st2.to || ""), JSON.stringify(st2.to));

      // 空文字不许发出去（也不该起进程）
      const empty = String(
        await W.eval("window.clawd.saySend(null,'   ').then(()=>'ALLOWED').catch(e=>'ERR:'+String(e))")
      );
      ok("空的一句话发不出去（在宿主侧就被拦住）", /ERR:.*还没写/.test(empty), empty.slice(0, 60));

      // ---- 答案必须落在卡上（2026-11-10 用户报「发完消息任何地方都看不到返回」）----
      //
      // 旧行为：发送成功 → 420ms 后自动关窗 → 答案回来时只发给看板；
      // 看板没开就等于发进黑洞。现在窗口留着，`say:done` 把答案写进这张卡。
      //
      // 不真的调模型（一次 8 秒起、有时一分半，还花钱）：把 saySend 换成桩，
      // 其余全走真实路径——submit() 自己会记下发出去的那句原文，handleDone
      // 靠它判断"这个结局是不是我这一发的"。桩换掉的是"网络那头"，不是逻辑。
      await W.eval(
        "window.__realSay = window.clawd.saySend; window.clawd.saySend = () => Promise.resolve({ok:true,cwd:'…\\\\Users\\\\Think'}); 1"
      );
      const beforeH = Number(await W.eval("window.outerHeight"));
      await W.eval(
        "(()=>{const t=document.getElementById('text');t.value='测试一句';t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return 1})()"
      );
      await sleep(400);
      const sentSt = JSON.parse((await W.eval("JSON.stringify(window.composeDebug.state())")) || "{}");
      ok("送出之后窗口不关、提示改成等回话", sentSt.busy === true && /等它回话/.test(sentSt.msg || ""), sentSt.msg);

      // 迟到的结局不能串台：原文对不上就当没这回事
      await W.eval("window.composeDebug.sayDone({ok:true, reply:'别人的答案', prompt:'另一句话'}), 1");
      await sleep(250);
      const crossed = JSON.parse((await W.eval("JSON.stringify(window.composeDebug.state())")) || "{}");
      ok("对不上的结局被丢掉（关窗重开不会串台）", !crossed.ans, JSON.stringify(crossed.ans).slice(0, 40));

      await W.eval("window.composeDebug.sayDone({ok:true, reply:'第一行答案\\n第二行答案', prompt:'测试一句'}), 1");
      await sleep(600);
      const answered = JSON.parse((await W.eval("JSON.stringify(window.composeDebug.state())")) || "{}");
      ok(
        "答案真的写进了输入窗（不再是发完就没下文）",
        /第一行答案/.test(answered.ans || "") && /第二行答案/.test(answered.ans || ""),
        JSON.stringify(answered.ans).slice(0, 60)
      );
      ok("答案落地后提示行改成「说完了」", /说完了/.test(answered.msg || ""), answered.msg);
      const afterH = Number(await W.eval("window.outerHeight"));
      ok("窗口跟着答案长高（固定 128px 放不下几行字）", afterH > beforeH, `${beforeH} → ${afterH}`);
      await W.eval("window.clawd.saySend = window.__realSay; 1");

      // 重新叫出来时必须清干净：上一轮的答案不能挂在下一句话下面
      await R.eval("window.petDebug.clickSayNew()");
      await sleep(700);
      const fresh = JSON.parse((await W.eval("JSON.stringify(window.composeDebug.state())")) || "{}");
      ok("重新打开输入窗 → 上一轮的答案已清空", !fresh.ans, JSON.stringify(fresh.ans).slice(0, 40));
      // 还原目标，下面"关掉之后目标还在"那条要的是 s-say
      await R.eval("window.petDebug.clickSay('s-say'), 1");
      await sleep(900);

      // 窗口白名单又扩了一扇窗，必须钉住：输入窗只能"说话"，不能顺走别人的命令。
      const cross = String(
        await W.eval(
          "window.__TAURI_INTERNALS__.invoke('theme_get',{}).then(()=>'ALLOWED').catch(e=>'ERR:'+String(e))"
        )
      );
      ok("输入窗调别的窗口的命令 → 被拒", /ERR:.*forbidden/.test(cross), cross.slice(0, 60));

      // 这扇窗是**新加的**（S12），而 Tauri 的 ACL 是"没列进 capabilities 的窗口
      // 一条 core 权限都没有"。漏掉它的表现极其安静：`invoke('plugin:event|listen')`
      // 直接被拒，页面收不到 compose:open / say:done，界面上只是"目标不刷新、发完没回音"。
      // 第一版就漏了——当时把这现象误判成"emit 赶在窗口 show 的那一帧丢了"，
      // 于是加了 500ms 轮询兜底，把 bug 盖住了（轮询走的是普通命令，不受 ACL 管）。
      const listen = String(
        await W.eval(
          "window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'verify-probe',target:{kind:'Any'},handler:1}).then(r=>'OK:'+String(r)).catch(e=>'ERR:'+String(e))"
        )
      );
      ok("输入窗拿到事件权限（capabilities/compose.json 真生效了）", /^OK:/.test(listen), listen.slice(0, 70));

      // 给了事件权限不等于把窗口能力也给了：compose 那份 capability 只有 core:event:default。
      const winCall = String(
        await W.eval(
          "window.__TAURI_INTERNALS__.invoke('plugin:window|set_position',{label:'compose',value:{x:0,y:0}}).then(()=>'ALLOWED').catch(e=>'ERR:'+String(e))"
        )
      );
      ok("输入窗没有窗口能力（最小面：它不该能挪自己）", /ERR:/.test(winCall), winCall.slice(0, 70));

      // 关闭是 hide 而不是 destroy：下次点 ✎ 要能立刻复用（重建成 8 秒不值）
      await W.eval("window.clawd.composeClose(), 1");
      await sleep(300);
      const again = JSON.parse((await W.eval("window.clawd.composeContext().then(t=>JSON.stringify(t))")) || "null");
      ok("关掉之后窗口还在、目标还在（下次打开不用重建）", !!(again && again.id === "s-say"), JSON.stringify(again));
      W.close();
    }
    await post("/state", { session_id: "s-say", event: "SessionEnd" }, ep.token);

    // ---------- 7. gaze：Rust 侧的光标线程 ----------
    //
    // Electron 版主进程用 screen.getCursorScreenPoint()，Rust 版用 GetCursorPos。
    // 这一条断言的是"线程还活着并且在推"，而不是瞳孔的几何 —— 几何在
    // petDebug.gaze 那两条里单独测（那是纯渲染层的数学，和宿主无关）。
    // 注意这条**不能**断言"1.2 秒内至少 N 条"：gaze 线程有变化检测
    // （偏差小于 0.02 就不发，省 IPC 也省电），光标不动的时候本来就该是 0 条。
    // 该断言的是"至少成功推过一次"——它同时证明 GetCursorPos 拿到了坐标、
    // 线程在跑、emit 到了、桥接上了。一次都没收到才是真的坏了。
    const gazeN = Number(await R.eval("window.petDebug.gazePushes()"));
    // 光标没动时这一条本来是 0——gaze 线程有变化检测（偏差 < 0.02 不发），
    // 那是**正确行为**，不是"链路不通"。所以判据不能是"跑完这一轮有没有推过"：
    // 那样它的成败取决于测试期间有没有人碰鼠标，红了也说不清是谁的错。
    // 做法：自己把 OS 光标挪一下再挪回（8px，必须超过归一化阈值 5.2px），
    // 造出"变化"，然后才断言。一次都不推才是真坏了。
    // 拆成两条，因为它们是两件不同的事：
    //   ① 线程活着（宿主每拍 +1，与光标动没动无关）—— 这一条永远可判
    //   ② 真的往页面推过 —— 需要光标**动**，而"动得了动不了"取决于环境
    const hsA = await R.eval("window.clawd.hitState()");
    await sleep(400);
    const hsB = await R.eval("window.clawd.hitState()");
    const ticksA = Number((hsA && hsA.gazeTicks) || 0);
    const ticksB = Number((hsB && hsB.gazeTicks) || 0);
    ok("gaze 线程在跑（宿主侧节拍计数在涨）", ticksB > ticksA, `${ticksA} → ${ticksB}`);

    let gazeNow = gazeN;
    if (gazeNow < 1) {
      // 造一次"光标动了"的变化：被动等别人碰鼠标，这条断言就成了看运气。
      //
      // **只挪 8px 还不够**（2026-11-06 实测：两次连续 FAIL，"累计 0 次"）。
      // gaze 的变化检测是对**钳制后**的归一化坐标做的（clamp(±1)，见 main.rs
      // 的 gaze 线程）：光标离桌宠超过约 260px 时 nx/ny 恒为 ±1，挪 8px
      // 不会有任何变化。这条断言以前全靠"跑测试的人恰好把光标放在桌宠旁边"，
      // 是一道看运气的闸门。修法：先把光标**传送**到桌宠窗口内（宿主的
      // hitState 正好带窗口物理坐标和 scale），等一拍存下位置，再挪 8px。
      const hsC = await R.eval("window.clawd.hitState()");
      const winPos = (hsC && Array.isArray(hsC.window) && hsC.window) || [100, 100];
      const scale = Number((hsC && hsC.scale) || 1);
      moveCursorTo(Math.round(winPos[0] + 120 * scale), Math.round(winPos[1] + 120 * scale));
      await sleep(300); // 等 gaze 线程把传送后的位置存进基准值
      const nudged = nudgeCursor();
      await sleep(400);
      gazeNow = Number(await R.eval("window.petDebug.gazePushes()"));
      if (gazeNow < 1 && !nudged) {
        // 连挪光标都做不到（受限环境会拒绝执行那条 WinForms 脚本）：这条**不判失败**，
        // 但必须喊出来。判据本身没被证伪，只是这个环境下测不了。
        skip("gaze 至少推过一次（GetCursorPos → 线程 → emit → 桥）", "本环境调不动系统光标");
      } else {
        ok("gaze 至少推过一次（GetCursorPos → 线程 → emit → 桥 全链路通）", gazeNow >= 1, `累计 ${gazeNow} 次`);
      }
    } else {
      ok("gaze 至少推过一次（GetCursorPos → 线程 → emit → 桥 全链路通）", true, `累计 ${gazeNow} 次`);
    }

    // ---------- 7.5 命中区与整窗穿透（2026-11-04 修复的"拖不动"） ----------
    //
    // 这一组钉的是一个**回归天生看不见**的 bug：Windows 上窗口一旦被设成
    // `WS_EX_TRANSPARENT`（Tauri 的 set_ignore_cursor_events(true) 就只干这个），
    // WebView2 收不到 mousemove，于是"收到 mousemove 就关掉穿透"永远等不到触发条件，
    // 整窗永久穿透 → 拖不动、点不了、双击和右键菜单全哑。
    // CDP 的 Input.dispatchMouseEvent 直接注入渲染进程、绕过 OS 命中测试，
    // 所以合成事件照常工作——闸门可以全绿而真机全废。
    //
    // 能自动验的是**判据那一半**：渲染层有没有把猫的矩形交给宿主、宿主的看门狗
    // 会不会据此翻转 ignore。真机上那一下拖拽仍要人工试，所以断言文案里不写
    // "能拖了"——它只证明判据连着。
    const hitSig = String((await R.eval("window.petDebug.hitRects()")) || "");
    ok("渲染层把命中区交给了宿主（签名非空）", hitSig.length > 0, hitSig);

    const hs0 = await R.eval("window.clawd.hitState()");
    ok(
      "hitState 三个字段都有货（ignore / inside / rects）",
      hs0 && typeof hs0.ignore === "boolean" && typeof hs0.inside === "boolean" && Number(hs0.rects) >= 1,
      JSON.stringify(hs0)
    );

    // 注入一个覆盖整个屏幕的矩形 → 光标必然"在猫身上" → 看门狗必须关掉穿透。
    await R.eval("window.clawd.setHitRects([[-100000,-100000,200000,200000]])");
    await sleep(400);
    const hs1 = await R.eval("window.clawd.hitState()");
    ok("命中判定：矩形盖住光标时关掉整窗穿透", hs1 && hs1.ignore === false, JSON.stringify(hs1));

    // 再注入一个远在天边的矩形 → 必须恢复穿透（否则四角会挡住桌面）。
    await R.eval("window.clawd.setHitRects([[100000,100000,10,10]])");
    await sleep(300);
    const hs2 = await R.eval("window.clawd.hitState()");
    ok("命中判定：离开矩形后恢复整窗穿透", hs2 && hs2.ignore === true, JSON.stringify(hs2));

    // 还原成真实的猫矩形（签名是 "x,y,w,h|x,y,w,h"）
    const realRects = hitSig
      .split("|")
      .filter(Boolean)
      .map((g) => g.split(",").map(Number))
      .filter((r) => r.length === 4 && r.every((n) => Number.isFinite(n)));
    if (realRects.length) {
      await R.eval("window.clawd.setHitRects(" + JSON.stringify(realRects) + ")");
      await sleep(300);
    }

    // ---- DSH 适配层（S11）----
    // 这条路与 hook 那条 HTTP 路**完全无关**：它读的是 DSH 的投影缓存。
    // 与上面命中区同一套说法——全绿只证明判据连着，真机上猫动没动仍要人工看。
    const d1 = await R.eval("window.clawd.dshState()");
    ok(
      "dshState 返回探测视图（home / dir / polls / reads / feeds 都有）",
      d1 && typeof d1.polls === "number" && typeof d1.reads === "number" && typeof d1.feeds === "number" && "dir" in d1,
      JSON.stringify({ home: d1 && d1.home, installed: d1 && d1.installed })
    );
    // Windows 路径大小写/分隔符不敏感，直接比字符串会给出假失败
    const normPath = (p) => String(p || "").replace(/[\\/]+/g, "\\").replace(/\\$/, "").toLowerCase();
    ok(
      "DSH_HOME 覆盖生效（接的是夹具，没碰真实 ~/.dsh）",
      normPath(d1 && d1.home) === normPath(DSH_FIXTURE),
      (d1 && d1.home) || ""
    );

    await sleep(2200);
    const d2 = await R.eval("window.clawd.dshState()");
    ok("DSH 探测线程在跑（polls 在涨）", Number(d2.polls) > Number(d1.polls), `${d1.polls} → ${d2.polls}`);
    ok("DSH 探测没报错", !d2.error, d2.error || "无");

    // 现造夹具。此时目录是新出现的——顺带验了"目录晚于进程启动才存在"这条路。
    const dshPromptAt = Date.now();
    writeDshFixture("working", dshPromptAt);
    await sleep(2200);

    const d3 = await R.eval("window.clawd.dshState()");
    ok("DSH 投影缓存读到了（reads ≥ 1）", Number(d3.reads) >= 1, `reads=${d3.reads}`);

    const seen = (d3.sessions || []).find((s) => s.id === DSH_FIXTURE_ID);
    ok(
      "DSH 会话被认出来了（id / 标题 / 目录 / 在跑）",
      !!seen && seen.title === "DSH 验证会话" && !!seen.cwd && seen.open_step === true,
      JSON.stringify(seen)
    );

    // 端到端第一段：夹具是 working，状态机就该是 working。
    const st1 = await post("/state", null, ep.token, { method: "GET" });
    let snap1 = null;
    try {
      snap1 = JSON.parse(st1.body);
    } catch (_) {}
    const row1 = ((snap1 && snap1.sessions) || []).find((s) => s.id === DSH_FIXTURE_ID);
    ok("DSH 会话进了状态机（/state 里能看到它）", !!row1, row1 ? JSON.stringify(row1) : st1.body.slice(0, 200));
    ok("DSH 会话让猫变成 working", !!snap1 && snap1.visual === "working", (snap1 && snap1.visual) || "null");
    ok(
      "标题与关键词跟着进来了（看板/泡泡要用）",
      !!row1 && row1.title === "DSH 验证会话" && row1.keyword === "DSH 验证会话",
      JSON.stringify({ title: row1 && row1.title, keyword: row1 && row1.keyword })
    );

    // 端到端第二段：把夹具改回 idle，这一轮就该被判定为"结束"。
    // 这是整个适配层最容易误判的一处（openStep 在步骤之间也会变 null），
    // 所以必须让它在真实进程中跑一遍，而不是只靠单测。
    writeDshFixture("idle", dshPromptAt);
    await sleep(3800);
    const st2 = await post("/state", null, ep.token, { method: "GET" });
    let snap2 = null;
    try {
      snap2 = JSON.parse(st2.body);
    } catch (_) {}
    const stopped = ((snap2 && snap2.recent) || []).some(
      (e) => e.event === "Stop" && String(e.sid).startsWith("session-")
    );
    ok("DSH 会话这一轮结束后发了 Stop", stopped, ((snap2 && snap2.recent) || []).map((e) => e.event).join(","));
    ok("结束后猫不再挂着 working", !!snap2 && snap2.visual !== "working", (snap2 && snap2.visual) || "null");

    // 撤掉夹具并等一拍，把状态机还原成干净状态：
    // 后面还有"场上有几只猫""attention 播完回 idle"这些断言，不能被这只猫带偏。
    fs.rmSync(DSH_FIXTURE, { recursive: true, force: true });
    await sleep(1800);
    const after = await R.eval("window.clawd.dshState()");
    ok("夹具撤掉后探测不再报它（SessionEnd 已收尾）", (after.sessions || []).every((s) => s.id !== DSH_FIXTURE_ID), (after.sessions || []).map((s) => s.id).join(","));

    await R.eval("window.petDebug.gaze({x:1,y:1}, true)");
    await sleep(500);
    const gazeFull = await R.eval("window.petDebug.eyeTracking()");
    ok("状态声明了追光标", gazeFull === true, String(gazeFull));
    await R.eval("window.petDebug.gaze({x:0,y:0}, true)");

    // ---------- 8. 权限气泡 ----------
    //
    // 全链路：HTTP 挂起 → 建窗 → 页面 ready 握手 → 投递 → 用户点 → 回包。
    // 这五步里任何一步断掉，用户在界面上看到的都是"什么都没发生"。
    const p1 = post("/permission", { session_id: "perm1", tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "E:/work/demo" }, null, { timeout: 20000 });
    const bubbleTarget = await waitTarget((u) => u.includes("bubble"));
    ok("第一条权限请求把气泡窗口建起来了", !!bubbleTarget);

    if (bubbleTarget) {
      B = await Cdp.connect(bubbleTarget.webSocketDebuggerUrl);
      await B.send("Runtime.enable");
      B.on("Runtime.exceptionThrown", (p) => pageErrors.push("bubble: " + ((p && p.exceptionDetails && p.exceptionDetails.text) || "?")));
      await sleep(500);

      ok("气泡里显示了工具名", (await B.eval("document.getElementById('tool').textContent")) === "Bash");
      ok("气泡里显示了命令原文", (await B.eval("document.getElementById('cmd').textContent")) === "rm -rf /");
      // S10 的核心：风险评级
      ok("rm -rf / 被判为 critical", (await B.eval("document.getElementById('card').getAttribute('data-risk')")) === "critical");
      ok("评级带中文标签（不只是颜色）", (await B.eval("document.getElementById('risk').textContent")) === "风险 极高", await B.eval("document.getElementById('risk').textContent"));
      const why = JSON.parse((await B.eval("JSON.stringify([...document.querySelectorAll('#why li')].map(x=>x.textContent))")) || "[]");
      ok("评级给出了人能读懂的理由", why.length > 0 && /删/.test(why[0]), why[0] || "");
      // 高度自适应：窗口跟着卡片长
      const h = await B.eval("document.getElementById('card').getBoundingClientRect().height");
      const winH = await B.eval("window.outerHeight");
      ok("窗口高度跟着卡片走（±8px）", Math.abs(Number(h) - Number(winH)) <= 8, `卡片 ${Math.round(h)} / 窗口 ${winH}`);

      await B.eval("document.getElementById('btnDeny').click(), 1");
      const r1 = await p1;
      ok("点拒绝 → 200 且回包是 deny", r1.code === 200 && r1.body.includes('"behavior":"deny"'), r1.body.slice(0, 60));
      ok("拒绝话术是固定文案（不跟着命令内容变）", r1.body.includes("用户在桌宠气泡里拒绝了这个操作"));
    }

    // 第二条：允许
    const p2 = post("/permission", { session_id: "perm2", tool_name: "Read", tool_input: { file_path: "a.txt" } }, null, { timeout: 20000 });
    const bt2 = await waitTarget((u) => u.includes("bubble"));
    if (bt2) {
      const B2 = await Cdp.connect(bt2.webSocketDebuggerUrl);
      await B2.send("Runtime.enable");
      await sleep(400);
      ok("低危命令判为 low", (await B2.eval("document.getElementById('card').getAttribute('data-risk')")) === "low");
      ok("第二次请求按钮被重新启用（不是一次性的）", (await B2.eval("document.getElementById('btnAllow').disabled")) === false);
      await B2.eval("document.getElementById('btnAllow').click(), 1");
      B2.close();
    }
    const r2 = await p2;
    ok("点允许 → 200 且回包是 allow", r2.code === 200 && r2.body.includes('"behavior":"allow"'), r2.body.slice(0, 60));

    // ---- 8.1 「点了允许，没有任何返回」（2026-11-06 用户报障）----
    //
    // 旧实现有两处静默死路，两条都长成"卡片在、按钮在、点完什么也不发生"：
    //   ① `decide()` 先把 currentId 清空再 fire-and-forget 发出去。主进程说
    //      "这条请求已经不在账上"（超时回落 / 已被结掉）时没人接这个 false。
    //   ② 请求早就结束了，页面手上还拿着它的 id，点下去同样无声无息。
    // 现在：回执照收（call 而不是 send），卡片会写明"已经结束"，窗口自己收掉。
    const bt4 = await waitTarget((u) => u.includes("bubble"));
    if (bt4) {
      const B4 = await Cdp.connect(bt4.webSocketDebuggerUrl);
      await B4.send("Runtime.enable");
      await sleep(300);

      const stale = String(
        await B4.eval("window.bubble.decide(999999,'allow').then(r=>'R:'+r).catch(e=>'ERR:'+e)")
      );
      ok("对不存在的请求做决定 → 回执 false（不再被 send 静默吞掉）", stale === "R:false", stale);

      // 复刻用户真正撞上的那一刻：卡片还亮着，但请求刚刚超时回落。
      // 页面手上还拿着它的 id，按钮是亮的——这时点「允许」，
      // 旧实现会静默冻住，现在必须给一句说明并把窗收掉。
      const p4 = post("/permission", { session_id: "perm4", tool_name: "Read", tool_input: { file_path: "b.txt" } }, null, { timeout: 25000 });
      await sleep(700);
      ok("第四条卡片确实显示出来了", (await B4.eval("document.getElementById('tool').textContent")) === "Read");
      // 等它超时回落（回归里把超时压到 6s，见 CLAWD_PERMISSION_TIMEOUT_MS）
      const r4 = await p4;
      ok("第四条没人点 → 超时回落 204", r4.code === 204, `code=${r4.code}`);
      await B4.eval("document.getElementById('btnAllow').click(), 1");
      await sleep(500);
      const note2 = String(await B4.eval("document.getElementById('note').textContent"));
      ok("超时后点「允许」→ 卡片说明情况（不是静默无事发生）", /已经结束/.test(note2), note2.slice(0, 48));

      const crossClose = String(
        await R.eval("window.__TAURI_INTERNALS__.invoke('bubble_close',{id:null}).then(()=>'ALLOWED').catch(e=>'ERR:'+e)")
      );
      ok("主窗口调气泡的收窗命令 → 被拒（白名单没松）", /ERR:.*forbidden/.test(crossClose), crossClose.slice(0, 60));
      B4.close();
    } else {
      ok("气泡窗口还活着（后续断言需要一个 CDP 目标）", false);
    }

    // 第三条：什么都不点 → 超时回落 204
    //
    // 这是「评级不改变默认行为」的兑现点：即使是 critical，超时也仍然是 204。
    // 评级只影响显示，从来没有、也不允许有"高危就自动拒绝"这种逻辑。
    const p3 = post("/permission", { session_id: "perm3", tool_name: "Bash", tool_input: { command: "rm -rf /" } }, null, { timeout: 20000 });
    const bt3 = await waitTarget((u) => u.includes("bubble"));
    if (bt3) {
      const B3 = await Cdp.connect(bt3.webSocketDebuggerUrl);
      await B3.send("Runtime.enable");
      await sleep(300);
      ok("超时前它确实是 critical", (await B3.eval("document.getElementById('card').getAttribute('data-risk')")) === "critical");
      B3.close();
    }
    const r3 = await p3;
    ok("critical 不点任何按钮 → 超时仍回落 204（评级不改变默认行为）", r3.code === 204, `code=${r3.code}`);

    // ---------- 9. 看板 ----------
    await R.eval("window.clawd.toggleDashboard(), 1");
    const dashTarget = await waitTarget((u) => u.includes("dashboard"), 6000);
    ok("看板窗口能打开", !!dashTarget);
    if (dashTarget) {
      D = await Cdp.connect(dashTarget.webSocketDebuggerUrl);
      await D.send("Runtime.enable");
      await sleep(600);
      ok("看板经 IPC 拿到快照", (await D.eval("typeof window.dashboard.getSnapshot === 'function'")) === true);
      const snap = JSON.parse((await D.eval("window.dashboard.getSnapshot().then(s=>JSON.stringify(s))")) || "null");
      ok("快照有会话列表字段", !!(snap && Array.isArray(snap.sessions)));

      // ---- 9.1 看板的内容：从"谁在发呆"变成"这条会话在干什么" ----
      // 用户 2026-11-05 的原话是「现在的看板没有任何有效信息」。
      // 这两条断言钉的就是"有效"这两个字：
      //   dshSessions 得真的把投影里那些字段带出来；
      //   卡片 DOM 里得真的把它们写出来（不是"函数被调用了"）。
      //
      // 夹具在 7.5 那节末尾被删掉了（当时要还原成干净状态），这里补回来——
      // 否则这节测的是"没有会话时的看板"，那恰好是最没有信息量的一屏。
      writeDshFixture("idle", Date.now());
      await sleep(1800);
      const rich = JSON.parse((await D.eval("window.dashboard.dshSessions().then(r=>JSON.stringify(r))")) || "null");
      ok("看板拿到了会话内容（dsh_sessions）", Array.isArray(rich), Array.isArray(rich) ? `${rich.length} 条` : "null");
      const one = (Array.isArray(rich) ? rich : []).find((r) => r.id === DSH_FIXTURE_ID);
      ok(
        "内容里有最后一轮问答 / 模型 / token / 上下文",
        !!one &&
          one.last_prompt === "验证看板的最后一轮" &&
          /这一行来自夹具/.test(one.last_reply || "") &&
          one.model === "fixture-model" &&
          one.tokens_out === 340 &&
          one.ctx_window === 200000,
        one ? JSON.stringify({ p: one.last_prompt, m: one.model, out: one.tokens_out }) : "没有夹具那条"
      );
      const cardText = String(await D.eval("document.getElementById('list').textContent"));
      ok(
        "卡片上真的写出了对话与用量",
        /验证看板的最后一轮/.test(cardText) && /这一行来自夹具/.test(cardText) && /fixture-model/.test(cardText),
        JSON.stringify(cardText.slice(0, 80))
      );
      ok("卡片上写出了上下文占比（不是只给一个裸数字）", /上下文\s*[\d.<]+\s*%/.test(cardText), JSON.stringify(cardText.slice(0, 120)));
      ok("顶部有聚合（几条 / 在跑 / token）", /条/.test(String(await D.eval("document.getElementById('sum').textContent"))), "");

      // 演示模式：光投屏的时候，对话内容比标题更不能露
      await D.eval("document.getElementById('demo').click(), 1");
      await sleep(300);
      const demoText = String(await D.eval("document.getElementById('list').textContent"));
      ok(
        "演示模式把对话内容也藏起来（不只是标题）",
        !/验证看板的最后一轮/.test(demoText) && !/这一行来自夹具/.test(demoText),
        JSON.stringify(demoText.slice(0, 60))
      );
      await D.eval("document.getElementById('demo').click(), 1");
      // 收摊：夹具用完就撤，后面的章节不该多出一条会话
      fs.rmSync(DSH_FIXTURE, { recursive: true, force: true });
      await sleep(600);
      // SEC-09：快照里只出 basename，完整路径不许进渲染层
      const leak = await D.eval("JSON.stringify(window.__lastSnapshot||null) + document.body.textContent");
      ok("快照里没有完整 cwd（SEC-09 分层仍在）", typeof leak === "string" && !/[A-Za-z]:\\\\Users\\\\/.test(leak), "");
      const themes = JSON.parse((await D.eval("window.dashboard.listThemes().then(t=>JSON.stringify(t))")) || "null");
      ok("主题列表至少有一项", !!(themes && Array.isArray(themes.themes) && themes.themes.length > 0), themes && themes.current);
      // 反过来再验一次：看板调主窗口的命令也必须被拒。
      // 两向都测，是因为单向只能证明"白名单没把某一条放错"，不能证明它真的在按窗口判。
      const crossDash = String(
        await D.eval(
          "window.__TAURI_INTERNALS__.invoke('theme_get',{}).then(()=>'ALLOWED').catch(e=>'ERR:'+String(e))"
        )
      );
      ok("看板调主窗口的命令（取主题帧）→ 被拒", /ERR:.*forbidden/.test(crossDash), crossDash.slice(0, 60));
      D.close();
    }
    await R.eval("window.clawd.toggleDashboard(), 1");

    // ---------- 10. 单实例锁 ----------
    // 测的是"第二份进程不该活着"，但真正要钉的判据是**端点文件一个字节都没变**。
    // 只看进程有没有退是不够的：原来的毛病正是"退是没退，可它已经把端口换成
    // 随机值并覆盖了端点文件"，于是 hook 拿着新端口去找第二份，
    // 而用户屏幕上还是第一份那只猫——事件全部落进没人看的进程。
    const before = fs.readFileSync(PORT_FILE, "utf8");
    const env2 = { ...process.env, CLAWD_PORT_FILE: PORT_FILE };
    delete env2.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS; // 第二份不该活到建窗口那一步
    const t2 = Date.now();
    const second = spawn(EXE, [], { cwd: ROOT, env: env2, stdio: ["ignore", "pipe", "pipe"] });
    const secondCode = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const t = setTimeout(() => {
        try {
          spawnSync("taskkill", ["/PID", String(second.pid), "/T", "/F"], { stdio: "ignore" });
        } catch {}
        done("timeout");
      }, 5000);
      second.once("exit", (code) => {
        clearTimeout(t);
        done(code);
      });
    });
    ok("第二份进程 5s 内自己退出（单实例锁生效）", secondCode === 0, `${Date.now() - t2}ms code=${secondCode}`);
    ok("第二份没动端点文件（端口与 token 一字未变）", fs.readFileSync(PORT_FILE, "utf8") === before);
    // 用端点文件里那个 token 去打 /health：200 同时证明两件事——
    // 第一份还活着，且它认的还是原来那个 token（没被第二份换掉）。
    const still = await post("/health", null, readEndpoint().token, { method: "GET" });
    ok("第一份仍然健康、且认的还是原来那个 token", still.code === 200, `code=${still.code}`);

    // ---------- 11. 页面无异常 ----------
    ok("整轮跑下来页面没抛过未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));

    // ---------- 12. 退出清理 ----------
    // 挂着的请求必须被 204 掉，否则对端的 HTTP 连接会一直悬着，
    // 而用户已经看不到任何气泡了 —— 那是最难受的一种"卡住"。
    const hanging = post("/permission", { session_id: "bye", tool_name: "Bash", tool_input: { command: "ls" } }, null, { timeout: 15000 });
    await waitTarget((u) => u.includes("bubble"), 6000);
    await R.eval("window.clawd.quit(), 1");

    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(child.exitCode !== null), 8000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    ok("quit() 能正常关闭进程（右键菜单里『退出』走的就是它）", exited, `exitCode=${child.exitCode}`);
    const rr = await hanging;
    ok("退出时挂着的权限请求以 204 收尾（对端不会一直悬着）", rr.code === 204 || rr.code === 0, `code=${rr.code}`);
    await sleep(300);
    ok("退出后端点文件已删除", !fs.existsSync(PORT_FILE));
  } catch (err) {
    console.error("\n回归脚本自身出错：", err && err.message);
    console.error(childOut.slice(-2000));
    fail++;
  } finally {
    if (R) R.close();
    if (B) B.close();
    if (D) D.close();
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n" + "=".repeat(56));
  console.log(`结果：PASS ${pass}  FAIL ${fail}${skipped.length ? "  SKIP " + skipped.length : ""}`);
  if (fail) console.log("失败项：\n  - " + failures.join("\n  - "));
  if (skipped.length) console.log("跳过项（环境不具备，不是通过）：\n  - " + skipped.join("\n  - "));
  process.exit(fail ? 1 : 0);
}

main();
