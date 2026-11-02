#!/usr/bin/env node
"use strict";
// ============================================================
// Tauri 版回归脚本（S10-5）
//
// 和 verify-electron.js 的关系：**判据同源，宿主不同**。
//   - 能用同一套判据的（主题、分身、头巾、风险评级、裁决回包），照抄同一份断言文案；
//   - 宿主专属的（Electron 的 BrowserWindow 属性、Rust 的窗口样式），各测各的。
//
// 为什么不能直接复用 verify-electron.js：
//   那个脚本靠 `--inspect=9229` 连主进程 Node inspector，断言
//   `BrowserWindow.getAllWindows().length` / `ipcMain.listenerCount(...)`。
//   Tauri 的主进程是 Rust，没有 JS 主进程，这些断言既没有意义也没有入口。
//   硬套只会得到一堆"跳过"，而跳过是不算数的绿。
//
// 连的是谁：WebView2 的 CDP。
//   Electron 用 --remote-debugging-port=9222，Tauri 这边用
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>，
//   WebView2 认这个变量，吐出同样的 /json/list。所以 scripts/cdp.js 是共用的。
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
// 和 verify-electron.js 同一套理由，一行都不用改：
//   1. 端点文件必须隔离，否则会覆盖用户正在用的那份（端口 + token 全变，hook 立刻失效）
//   2. 端口 23333 被占时服务会回退随机端口，这里照样能从临时文件读到真实端口
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-verify-tauri-"));
const PORT_FILE = path.join(TMP_ROOT, "clawd-starter.port");
process.env.CLAWD_PORT_FILE = PORT_FILE;

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

async function main() {
  console.log("Tauri 迁移回归\n" + "=".repeat(56));

  if (!fs.existsSync(EXE)) {
    console.error(`找不到可执行文件：${EXE}\n先跑 cargo build（或加 --release 前先 cargo build --release）`);
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

  const child = spawn(EXE, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAWD_PERMISSION_TIMEOUT_MS: String(BUBBLE_TIMEOUT_MS),
      CLAWD_PORT_FILE: PORT_FILE,
      // WebView2 认这个变量：注入 Chromium 命令行开关。
      // 这是 Tauri 版能被 CDP 驱动的前提，也是整套 Electron 回归能平移过来的原因。
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
      "window.clawd 12 个动作齐全",
      (await R.eval(
        "['onState','onCast','onGaze','dragStart','dragEnd','setIgnoreMouse','wake','quit','petMenu','toggleDashboard','getTheme','onTheme'].every(k=>typeof (window.clawd||{})[k]==='function')"
      )) === true
    );
    ok(
      "window.bubble 4 个动作齐全",
      (await R.eval("['onRequest','decide','setHeight','ready'].every(k=>typeof (window.bubble||{})[k]==='function')")) === true
    );
    ok(
      "window.dashboard 5 个动作齐全",
      (await R.eval(
        "['getSnapshot','copyPath','listThemes','setTheme','onTheme'].every(k=>typeof (window.dashboard||{})[k]==='function')"
      )) === true
    );
    // 和 preload 同一条原则：只暴露具体动作，绝不把 ipc 本身漏出去。
    // Tauri 的 __TAURI__.core.invoke 如果能从 window.clawd 摸到，
    // 渲染层就等于拿到了"调用任意命令"的通用口子，那 16 个命令的边界就白设了。
    ok("桥没有把 invoke 本身漏给渲染层", (await R.eval("typeof window.clawd.invoke === 'undefined'")) === true);
    ok("桥没有把 __TAURI__ 整个挂到 clawd 上", (await R.eval("window.clawd.core === undefined && window.clawd.event === undefined")) === true);

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
    // 把"场上 3 只"和"每只都有词"同时弄错（它没有 keyword）。
    await post("/state", { session_id: "s1", event: "SessionEnd" }, ep.token);
    await sleep(2200);

    // ---------- 6. 分身与头巾 ----------
    for (const [id, kw] of [["c1", "登录页"], ["c2", "迁移"], ["c3", "写测试"]]) {
      await post("/state", { session_id: id, event: "UserPromptSubmit", keyword: kw }, ep.token);
    }
    await sleep(1400); // 分身名单 1s 一推
    let cast = JSON.parse((await R.eval("JSON.stringify(window.petDebug.cast())")) || "{}");
    ok("多条会话 → 进入分身模式", cast.mode === "cast", cast.mode);
    ok("场上出现 3 只猫", (cast.cats || []).length === 3, `实际 ${(cast.cats || []).length} 只`);
    ok("每只猫的头巾都写着各自的词", (cast.cats || []).every((c) => c.keyword && c.keyword.length > 0), JSON.stringify((cast.cats || []).map((c) => c.keyword)));
    ok("词不同（不是所有人都顶着同一个词）", new Set((cast.cats || []).map((c) => c.keyword)).size === 3);
    ok("头巾真的显示出来了", (cast.cats || []).every((c) => c.bandana && c.bandana !== "none"), JSON.stringify((cast.cats || []).map((c) => c.bandana)));
    ok("只有一只猫是聚焦的", (cast.cats || []).filter((c) => c.focus).length === 1);
    // 用户明确要求"横排、有重叠"，所以这里**不能**断言不重叠。
    // 要断言的是"从左到右排开"（没叠成一坨）和"每只都看得见"（没被完全盖住）。
    const layout = JSON.parse((await R.eval(
      "JSON.stringify([...document.querySelectorAll('.cat')].map(e=>{const r=e.getBoundingClientRect();return {l:Math.round(r.left),w:Math.round(r.width),o:getComputedStyle(e).opacity};}))"
    )) || "[]");
    ok("猫是从左到右排开的", layout.every((c, i) => i === 0 || c.l > layout[i - 1].l), JSON.stringify(layout.map((c) => c.l)));
    ok("每只猫都还看得见（没被完全盖住）", layout.length > 0 && layout.every((c) => Number(c.o) > 0.3 && c.w > 20), "");
    ok("相邻两只至少有部分重叠（用户要的是「挤在一起」）", layout.length < 2 || layout[1].l < layout[0].l + layout[0].w);

    // 点另一只 → 聚焦切换
    const otherId = (cast.cats || []).find((c) => !c.focus);
    if (otherId) {
      await R.eval(`(() => { const els=[...document.querySelectorAll('.cat')]; const t=els.find(e=>e.dataset.id==='${otherId.id}'||e.id==='cat-${otherId.id}'); if(t){t.dispatchEvent(new MouseEvent('click',{bubbles:true}));return 1;} const i=els.findIndex(e=>!e.classList.contains('focus')); if(i>=0){els[i].dispatchEvent(new MouseEvent('click',{bubbles:true}));return 1;} return 0; })()`);
      await sleep(400);
      cast = JSON.parse((await R.eval("JSON.stringify(window.petDebug.cast())")) || "{}");
      ok("点一下别的猫能切换聚焦", cast.focused === otherId.id, `focused=${String(cast.focused).slice(0, 8)}`);
    }

    // 上限 4 只
    for (const id of ["c4", "c5", "c6"]) {
      await post("/state", { session_id: id, event: "UserPromptSubmit", keyword: "第" + id }, ep.token);
    }
    await sleep(1400);
    cast = JSON.parse((await R.eval("JSON.stringify(window.petDebug.cast())")) || "{}");
    ok("最多同时 4 只（再多就挤在一起看不清了）", (cast.cats || []).length <= 4, `实际 ${(cast.cats || []).length} 只`);
    ok("聚焦的那只不会被新来的挤掉", (cast.cats || []).some((c) => c.focus && c.id === cast.focused));

    // 收摊：把会话清掉，回到单猫
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
      await post("/state", { session_id: id, event: "SessionEnd" }, ep.token);
    }
    await sleep(2400); // 淡出 1.6s + 名单 1s
    ok("会话结束后回到单猫", (await R.eval("window.petDebug.cast().mode")) === "solo");

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
    ok("gaze 至少推过一次（GetCursorPos → 线程 → emit → 桥 全链路通）", gazeN >= 1, `累计 ${gazeN} 次`);

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
      ok("拒绝话术与 Electron 版一致", r1.body.includes("用户在桌宠气泡里拒绝了这个操作"));
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
      // SEC-09：快照里只出 basename，完整路径不许进渲染层
      const leak = await D.eval("JSON.stringify(window.__lastSnapshot||null) + document.body.textContent");
      ok("快照里没有完整 cwd（SEC-09 分层仍在）", typeof leak === "string" && !/[A-Za-z]:\\\\Users\\\\/.test(leak), "");
      const themes = JSON.parse((await D.eval("window.dashboard.listThemes().then(t=>JSON.stringify(t))")) || "null");
      ok("主题列表至少有一项", !!(themes && Array.isArray(themes.themes) && themes.themes.length > 0), themes && themes.current);
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
  console.log(`结果：PASS ${pass}  FAIL ${fail}`);
  if (fail) console.log("失败项：\n  - " + failures.join("\n  - "));
  process.exit(fail ? 1 : 0);
}

main();
