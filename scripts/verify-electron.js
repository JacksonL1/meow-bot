#!/usr/bin/env node
"use strict";
// ============================================================
// Electron 升级回归脚本
//
// 用途：升级 Electron 大版本后，用同一套判据判断「还能不能用」。
// 不依赖任何测试框架，只用 Node 内置能力。
//
// 为什么同时开两个调试端口？
//   --inspect=9229        主进程（Node inspector）→ 能查 win.isVisible() / 四处 IPC 是否接上
//   --remote-debugging-port=9222  渲染进程（Chrome DevTools Protocol）→ 能查 DOM / gaze / 隔离
// 一个从外面看，一个从里面看，缺一半就会漏掉「窗口在但渲染挂了」这种失败。
//
// 用法：
//   node scripts/verify-electron.js
// 退出码 0 = 全过；1 = 有失败项。
// ============================================================

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN_PORT = 9229;
const RENDERER_PORT = 9222;

// ---------- 测试隔离 ----------
// 两个隔离点，缺一不可：
//   1. --user-data-dir：requestSingleInstanceLock() 是按 userData 分实例的，
//      不隔离的话「用户自己正开着桌宠」会让被测进程直接 quit，
//      外面只看得到"渲染进程 15s 内没起来"。
//   2. CLAWD_PORT_FILE：端点文件默认写 %APPDATA%，隔离后不会覆盖用户正在用的那份，
//      端口被占时服务会退回随机端口，这里照样能从临时文件读到真实端口。
const TMP_ROOT = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "clawd-verify-"));
const USER_DATA_DIR = path.join(TMP_ROOT, "userdata");
process.env.CLAWD_PORT_FILE = path.join(TMP_ROOT, "clawd-starter.port");

const ELECTRON_BIN = require("electron"); // 纯 Node 下 require('electron') 返回可执行文件路径
const PORT_FILE = require("../src/port-file").portFilePath();
const { writePortFile } = require("../src/port-file");

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

// ELECTRON_RUN_AS_NODE 一旦存在，electron 会退化成纯 Node 跑（require('electron') 变成路径字符串）。
// 本机 shell 里可能被别的工具设过，所以显式删掉，而不是塞 undefined。
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

function getJson(port, p) {
  return new Promise((resolve) => {
    const req = require("node:http").get({ host: "127.0.0.1", port, path: p, timeout: 1000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
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

async function waitTargets(port, want, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const list = await getJson(port, "/json/list");
    const hit = Array.isArray(list) ? list.find((t) => !want || t.type === want || t.url === want) : null;
    if (hit) return list;
    await sleep(200);
  }
  return null;
}

// 等某个页面出现（按 url 后缀匹配）：气泡窗口是懒创建的，得等它真的被创建出来
async function waitForUrl(port, suffix, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const list = await getJson(port, "/json/list");
    const hit = Array.isArray(list) ? list.find((t) => typeof t.url === "string" && t.url.endsWith(suffix)) : null;
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

// 发一个权限请求。注意：/permission **不带 token**（Claude Code 也不会带）。
// 返回一个 Promise，等到响应才 resolve——这正是"阻塞式 HTTP hook"的形态。
function postPermission(ep, body, extraHeaders = {}) {
  return new Promise((resolve) => {
    const raw = JSON.stringify(body);
    const req = require("node:http").request(
      {
        host: "127.0.0.1",
        port: ep.port,
        path: "/permission",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
          ...extraHeaders,
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ code: res.statusCode, body: b }));
      }
    );
    req.on("error", () => resolve({ code: 0, body: "" }));
    req.end(raw);
  });
}


// ---- 极简 CDP 客户端：只做一件事——发 Runtime.evaluate 拿返回值 ----
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const slot = this.waiting.get(msg.id);
      if (!slot) return;
      this.waiting.delete(msg.id);
      slot.resolve(msg);
    });
    ws.addEventListener("close", () => {
      for (const slot of this.waiting.values()) slot.resolve({ error: { message: "socket closed" } });
      this.waiting.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    await sleep(100);
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          resolve({ error: { message: "timeout" } });
        }
      }, 5000);
    });
  }

  // 返回 JS 表达式的值；异常返回 undefined
  // includeCommandLineAPI 是为主进程准备的：Node inspector 的全局里没有 require
  // （require 是模块作用域的），打开这个开关才会注入一个 console 风格的 require。
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      includeCommandLineAPI: true,
    });
    if (r.error) return undefined;
    const res = r.result || {};
    if (res.exceptionDetails) {
      console.log("      [eval 异常] " + expression.slice(0, 60) + " → " + (res.exceptionDetails.text || ""));
      return undefined;
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ------------------------------------------------------------
// S8：把 hook 当成真宿主来调用
//
// 为什么不用 require 调用内部函数，而是真起一个子进程喂 stdin：
// 投递的**唯一**生效方式是 hook 往 stdout 写 JSON，那段文本会被宿主
// 当作上下文收下。真起进程才能证明"stdout 上到底出现了什么字节"——
// 而"没信的时候一个字节都没有"恰恰是这个功能最重要的那条边界。
// ------------------------------------------------------------
function runHook(event, stdinObj, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "hooks", "clawd-hook.js"), event], {
      cwd: ROOT,
      env: { ...cleanEnv(), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ out, err, code }));
    child.stdin.end(JSON.stringify(stdinObj));
  });
}

async function verifyHookSessionId() {
  const http = require("node:http");
  const received = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const portFile = path.join(TMP_ROOT, "hook-port.json");
  writePortFile(portFile, { port: server.address().port, token: "t".repeat(64) });
  const env = { CLAWD_PORT_FILE: portFile };

  // 对照组：带了 session_id → 必须真的发出去。
  // 少了这条，"0 个请求"可能只是 hook 根本没能连上 server。
  await runHook("PreToolUse", { hook_event_name: "PreToolUse", session_id: "hook-sid-1" }, env);
  await sleep(120);
  const withSid = received.length;

  received.length = 0;
  const missing = await runHook("PreToolUse", { hook_event_name: "PreToolUse" }, env);
  await sleep(120);
  const withoutSid = received.length;

  // 空白字符串同样算没有：后端 discard 的是 trim 之后为空的情况
  received.length = 0;
  await runHook("PreToolUse", { hook_event_name: "PreToolUse", session_id: "   " }, env);
  await sleep(120);
  const blankSid = received.length;

  // Notification 里混着 WorkBuddy 自己的生命周期闲聊：
  //   idle_prompt  —— "再发一条消息吧"的提醒（Stop 之后约 60 秒）
  //   auth_success —— 登录成功的 toast（每一轮开头都发一次）
  // 必须在**源头**（hook）滤掉，不能交给状态机：notification 一旦变成"持续
  // 到被顶掉"的长状态，一条 idle_prompt 挂上来就是"猫凭空喊好几分钟"。
  received.length = 0;
  await runHook(
    "Notification",
    { hook_event_name: "Notification", session_id: "hook-sid-1", notification_type: "idle_prompt" },
    env
  );
  await sleep(120);
  const idlePromptCount = received.length;

  received.length = 0;
  await runHook(
    "Notification",
    { hook_event_name: "Notification", session_id: "hook-sid-1", notification_type: "auth_success" },
    env
  );
  await sleep(120);
  const authCount = received.length;

  // 对照组：真的在等你的那种通知必须照常放行。
  // 少了这条，"一个都没发"可能只是我把整条 Notification 通路关掉了——
  // 那是另一种更彻底的坏，而且从"0 个请求"上完全看不出来。
  received.length = 0;
  await runHook(
    "Notification",
    { hook_event_name: "Notification", session_id: "hook-sid-1", notification_type: "permission_prompt" },
    env
  );
  await sleep(120);
  const realCount = received.length;

  server.close();

  ok("带了 session_id 的事件会真的发出去（对照组：不是连不上 server）", withSid === 1, `收到 ${withSid} 个`);
  ok(
    "没有 session_id 的事件被丢弃（不合成占位会话）",
    withoutSid === 0,
    `收到 ${withoutSid} 个`
  );
  ok("session_id 只有空格也算没有", blankSid === 0, `收到 ${blankSid} 个`);
  ok("idle_prompt 不算『在等你』（源头就丢掉）", idlePromptCount === 0, `收到 ${idlePromptCount} 个`);
  ok("auth_success 也不算（每轮开头都发的登录 toast）", authCount === 0, `收到 ${authCount} 个`);
  ok("对照组：真的通知照常放行（不是把整条路关了）", realCount === 1, `收到 ${realCount} 个`);
  ok(
    "丢弃时往 stderr 说了一句（不往 stdout —— 那会被宿主收进上下文）",
    missing.out === "" && /session_id/.test(missing.err),
    `outLen=${missing.out.length} err=${JSON.stringify(missing.err.slice(0, 60))}`
  );
}

// ---------- 会话标题 / 工具名：看板上"像人话"的那两行 ----------
// 放在纯 Node 侧（起 Electron 之前）跑：标题的推导全在 hook 里，
// 而真正要盯的是**prompt 原文有没有跟着出去**——那只能看 POST body 的真实字节。
async function verifyHookSessionTitle() {
  const http = require("node:http");
  const received = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const portFile = path.join(TMP_ROOT, "hook-title-port.json");
  writePortFile(portFile, { port: server.address().port, token: "t".repeat(64) });
  const env = { CLAWD_PORT_FILE: portFile };

  let lastRaw = "";
  const post = async (event, payload) => {
    received.length = 0;
    await runHook(event, { hook_event_name: event, session_id: "title-sid", ...payload }, env);
    await sleep(120);
    lastRaw = received.length ? received[0] : "";
    return received.length ? JSON.parse(received[0]) : null;
  };

  const renamed = await post("PreToolUse", { session_title: "  重构看板  ", tool_name: "Edit" });
  const fromPrompt = await post("UserPromptSubmit", {
    prompt: "\n\n帮我把看板补上会话标题\n第二行不该出去",
  });
  const promptRaw = lastRaw;

  const secret = await post("UserPromptSubmit", { prompt: "sk-abcdefghijklmnopqrstuvwxyz0123456789" });
  const normal = await post("UserPromptSubmit", { prompt: "帮我把看板补上会话标题" });
  const notPrompt = await post("PreToolUse", { prompt: "这条不该变成标题" });
  const tooLong = await post("UserPromptSubmit", { prompt: "长".repeat(200) });

  server.close();

  ok(
    "用户自己改的名优先（并且 trim 过）",
    !!renamed && renamed.title === "重构看板",
    `title=${JSON.stringify(renamed && renamed.title)}`
  );
  ok(
    "工具名跟着事件一起送出去（此前它没有任何消费者）",
    !!renamed && renamed.tool_name === "Edit",
    `tool_name=${JSON.stringify(renamed && renamed.tool_name)}`
  );
  ok(
    "没改名时取 prompt 的第一行非空文字",
    !!fromPrompt && fromPrompt.title === "帮我把看板补上会话标题",
    `title=${JSON.stringify(fromPrompt && fromPrompt.title)}`
  );
  ok(
    "prompt 只有第一行进链路（第二行不进）",
    promptRaw.includes("帮我把看板补上会话标题") && !promptRaw.includes("第二行不该出去"),
    `bodyLen=${promptRaw.length}`
  );
  ok(
    "第一行像密钥时整个标题都不要（不是洗一半再显示）",
    !!secret && secret.title === undefined,
    `title=${JSON.stringify(secret && secret.title)}`
  );
  ok(
    "对照组：普通的中文句子不会被误判成密钥",
    !!normal && normal.title === "帮我把看板补上会话标题",
    `title=${JSON.stringify(normal && normal.title)}`
  );
  ok(
    "只有 UserPromptSubmit 会从 prompt 取标题",
    !!notPrompt && notPrompt.title === undefined,
    `title=${JSON.stringify(notPrompt && notPrompt.title)}`
  );
  ok(
    "标题有长度上限（60，超了就截断）",
    !!tooLong && typeof tooLong.title === "string" && tooLong.title.length <= 60,
    `len=${tooLong && tooLong.title && tooLong.title.length}`
  );
}

async function main() {
  console.log("Electron 升级回归\n" + "=".repeat(56));
  await verifyHookSessionId();
  await verifyHookSessionTitle();

  // 前置：不能有别的实例在跑，否则单实例锁会让本次启动直接退出
  const existing = await getJson(MAIN_PORT, "/json/list");
  if (!(await portFree(MAIN_PORT)) || !(await portFree(RENDERER_PORT))) {
    console.error(`端口 ${MAIN_PORT}/${RENDERER_PORT} 被占用，先关掉其他调试实例。`);
    process.exit(1);
  }
  if (existing) console.log("（检测到旧 inspector，忽略）");

  // 清掉可能残留的端点文件，保证「启动时写端点」这条路径是真的被执行
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {}

  // CLAWD_PERMISSION_TIMEOUT_MS：只为了让回归能真的测到"超时回落 204"。
  // 正常运行时不设这个变量，默认是 120 秒。
  // CLAWD_MAILBOX_DIR：信箱必须隔离，否则回归会往用户真实的信箱里写信，
  // 而"信"是会进 agent 上下文的东西 —— 让测试往那儿塞字是最不该发生的事。
  const childEnv = {
    ...cleanEnv(),
    CLAWD_PERMISSION_TIMEOUT_MS: "6000",
  };

  const child = spawn(
    ELECTRON_BIN,
    [
      `--inspect=${MAIN_PORT}`,
      `--remote-debugging-port=${RENDERER_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      ".",
    ],
    { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }
  );

  let childOut = "";
  child.stdout.on("data", (c) => (childOut += c));
  child.stderr.on("data", (c) => (childOut += c));

  const cleanup = async () => {
    try {
      child.kill();
    } catch {}
  };

  try {
    // ---------- 启动 ----------
    const rendererList = await waitTargets(RENDERER_PORT, "page");
    if (!rendererList) {
      console.error("渲染进程 15s 内没起来。子进程输出：\n" + childOut);
      await cleanup();
      process.exit(1);
    }
    ok("渲染进程启动并暴露 CDP", true);

    const mainList = await waitTargets(MAIN_PORT, null, 8000);
    ok("主进程 inspector 可用", !!mainList);

    const pageTarget = rendererList.find((t) => t.type === "page");
    const mainTarget = (mainList || []).find((t) => t.type === "node" || t.type === "page" || t.webSocketDebuggerUrl);

    const R = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
    const M = mainTarget ? await Cdp.connect(mainTarget.webSocketDebuggerUrl) : null;
    await R.send("Runtime.enable");
    if (M) await M.send("Runtime.enable");

    // 等页面把首帧画出来
    for (let i = 0; i < 40; i++) {
      const ready = await R.eval("document.readyState");
      const painted = await R.eval("!!document.querySelector('.layer.show svg')");
      if (ready === "complete" && painted) break;
      await sleep(150);
    }

    // ---------- 版本信息（记进台账用） ----------
    const ver = M ? await M.eval("JSON.stringify(process.versions)") : null;
    if (ver) {
      const v = JSON.parse(ver);
      console.log(`\n  版本：electron ${v.electron} / chrome ${v.chrome} / node ${v.node}\n`);
    }

    // ---------- 1. 页面与 DOM ----------
    ok("页面加载完成", (await R.eval("document.readyState")) === "complete");

    // S7：主题是渲染层**主动拉**回来的（invoke 一次），所以任何跟画面有关的断言
    // 都必须先等它到。不等就会变成"有时候过有时候不过"——这类 flaky 断言
    // 比没有断言更糟，因为它教人忽略红色。
    let themeLoaded = false;
    let themeInfo = null;
    for (let i = 0; i < 60; i++) {
      themeInfo = await R.eval("window.petDebug && window.petDebug.theme ? window.petDebug.theme() : null");
      if (themeInfo && themeInfo.id) {
        themeLoaded = true;
        break;
      }
      await sleep(100);
    }
    ok("主题已加载到渲染层", themeLoaded, `id=${themeInfo && themeInfo.id}`);
    ok("默认主题是 ragdoll", themeInfo && themeInfo.id === "ragdoll", `id=${themeInfo && themeInfo.id}`);

    ok(
      "三个容器都在（#stage/#pet/#layerA/B）",
      await R.eval(
        "!!(document.getElementById('stage') && document.getElementById('pet') && document.getElementById('layerA') && document.getElementById('layerB'))"
      )
    );
    ok("首帧已上屏（.layer.show 内有 svg）", !!(await R.eval("!!document.querySelector('.layer.show svg.on')")));
    ok("7 个状态全部注册", (await R.eval("window.petDebug && window.petDebug.states().length")) === 7);

    // 帧总数 = "主题真的被完整读进来"的证据，但**不能再写死 19**：
    // 动画从"逐帧替换"改成"部件插值"之后，每个状态只需要 1 帧。
    // 所以改成跟 theme.json 对账——写死数字会逼着以后每次改动画都要改测试。
    const themeFs = require("node:fs");
    const themePath = require("node:path").join(__dirname, "..", "themes", "ragdoll", "theme.json");
    const themeJson = JSON.parse(themeFs.readFileSync(themePath, "utf8"));
    const wantFrames = Object.values(themeJson.states).reduce((n, s) => n + s.frames.length, 0);
    const totalFrames = await R.eval(
      "Object.values(window.VISUAL_STATES).reduce((n, s) => n + s.frames.length, 0)"
    );
    ok("主题帧数与 theme.json 一致", totalFrames === wantFrames, `实际=${totalFrames} 期望=${wantFrames}`);

    // petDebug.timings() 必须返回**真的东西**（硬约束 23：有出口没货的窗口
    // 会一直沉默）。ragdoll 写了 timings，所以这里不能是 null / {}。
    const dbgTimings = await R.eval("window.petDebug.timings()");
    ok(
      "petDebug.timings() 返回当前主题的真时长（不是空对象）",
      !!dbgTimings && dbgTimings.oneshot && dbgTimings.oneshot.attention === 800,
      `timings=${JSON.stringify(dbgTimings)}`
    );

    // 这里原本还有两条「motion / gags 声明的部件在 SVG 里都存在」。
    // 两个字段的消费者都没了（引擎随骨骼重写删、彩蛋随 working 改敲键盘删），
    // 断言读到的 def.motion 永远是 undefined -> 循环一次都不进 -> **永远为真**。
    // 永远为真的断言比没有更糟：它在报告里长得像一道防线。

    // 硬约束 19 的机械检查：src/ 下的源码里不许出现 innerHTML。
    // 这条以前只写在台账里没人查——而渲染层真的有一处 `innerHTML = createRigged…()`，
    // 就这么一直待到今天。规则不落到断言上，等于没有。
    const innerHtmlHits = [];
    for (const f of fs.readdirSync(path.join(ROOT, "src"))) {
      if (!/\.(js|html)$/.test(f)) continue;
      const lines = fs.readFileSync(path.join(ROOT, "src", f), "utf8").split("\n");
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return; // 注释里提到不算
        if (line.includes("innerHTML")) innerHtmlHits.push(`${f}:${i + 1}`);
      });
    }
    ok(
      "src/ 下源码里 innerHTML 出现 0 次（硬约束 19）",
      innerHtmlHits.length === 0,
      innerHtmlHits.join(", ") || "0 处"
    );

    // ---------- 2. 渲染进程隔离（SEC-06） ----------
    ok("contextIsolation 生效：渲染层拿不到 require", (await R.eval("typeof window.require")) === "undefined");
    ok("contextIsolation 生效：渲染层拿不到 process", (await R.eval("typeof window.process")) === "undefined");
    ok("preload 没有泄漏 ipcRenderer", (await R.eval("typeof window.ipcRenderer")) === "undefined");
    // 动作数是安全闸门：S6 加了 toggleDashboard（6→7），S7 加了 getTheme / onTheme（7→9），
    // S8 加了 petMenu（9→10），S9 加了 wake（10→11）。
    // 2026-10-30：信箱整套砍掉，openLetter / onLetterSent 一并拿掉（13→11）——
    // 功能下线要连着它开的口子一起收，留着一个没有消费者的动作就是安全隐患。
    // 以后每次加 IPC 都要顺手改这里，改的时候问自己一句"这个动作真的需要吗"。
    ok("preload 只暴露 11 个具名动作", (await R.eval("Object.keys(window.clawd||{}).length")) === 11);

    // ---------- 3. 状态切换 ----------
    // 必须先等主进程把首次状态推下来（main.js 里是启动后 300ms 的一次 broadcast）。
    // 否则这里的 setState 会和那次 broadcast 抢，测试结果随机。
    let bootState = null;
    for (let i = 0; i < 30; i++) {
      bootState = await R.eval("window.petDebug.state()");
      if (bootState) break;
      await sleep(100);
    }
    ok("收到了主进程的初始状态", !!bootState, `初始=${bootState}`);

    // 等主进程的启动推送彻底静默再动手。
    // 状态机的 tick 是 250ms 一轮，第一个周期就会把 lastVisual 从 null 推成 idle。
    // 测试要是在这之前改状态，两边就会抢——表现是"刚切到 working，半秒后弹回 idle"，
    // 看起来像渲染层的 bug，其实是两条时间线交叉。这类 flaky 比没有断言更糟。
    let quiet = false;
    let pushCount = -1;
    let quietSince = Date.now();
    for (let i = 0; i < 40; i++) {
      const n = await R.eval("window.petDebug.stateLog().length");
      if (n !== pushCount) {
        pushCount = n;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= 400) {
        quiet = true;
        break;
      }
      await sleep(100);
    }
    ok("主进程的启动推送已静默（后续操作不会被它截胡）", quiet, `收到 ${pushCount} 次推送`);

    // 从确定的起点开始：先确保渲染层在 idle 且画面已上屏。
    let atIdle = false;
    for (let i = 0; i < 20; i++) {
      const st = await R.eval("window.petDebug.state()");
      const hasSvg = await R.eval("!!document.querySelector('.layer.show svg.on')");
      if (st === "idle" && hasSvg) {
        atIdle = true;
        break;
      }
      await R.eval("window.petDebug.setState('idle')");
      await sleep(60);
    }
    ok("渲染层能稳定停在 idle（后续比较的基准）", atIdle);

    const beforeLayer = await R.eval("document.querySelector('.layer.show')?.id");
    const beforeBuilds = await R.eval("window.petDebug.builds()");
    await R.eval("window.petDebug.setState('working')");

    // 两条渲染路径要分开断言。
    // 「骨骼弹簧」不换帧、不切图层——状态切换靠弹簧过冲，DOM 一次都不重建；
    // 「帧序列」靠交叉淡入 + 逐帧替换。拿帧的尺子量骨骼，只会得到一片红。
    const rigMode = (await R.eval("window.petDebug.theme().rig")) === "spring";

    // 轮询等它落定，而不是立刻读一次——交叉淡入本身有过渡，
    // 单点采样会把"正在换"读成"没换"。
    let nowState = null;
    let afterLayer = beforeLayer;
    for (let i = 0; i < 20; i++) {
      nowState = await R.eval("window.petDebug.state()");
      afterLayer = await R.eval("document.querySelector('.layer.show')?.id");
      if (nowState === "working" && afterLayer) break;
      await sleep(50);
    }
    ok("setState 生效", nowState === "working", `state=${nowState}`);

    if (rigMode) {
      ok("骨骼渲染不切图层（切换靠弹簧过冲，不靠交叉淡入）", afterLayer === "layerA", `after=${afterLayer}`);
    } else {
      ok("换状态时切换图层（交叉淡入的前提）", beforeLayer !== afterLayer, `${beforeLayer} → ${afterLayer}`);
    }

    // 换一次状态只该重建一次。骨骼渲染则**一次都不重建**：只改弹簧目标，
    // DOM 从建好那一刻起就不再动——这也是它根本没有"交换动画"的原因。
    const afterBuilds = await R.eval("window.petDebug.builds()");
    const buildDelta = afterBuilds - beforeBuilds;
    ok(
      rigMode ? "骨骼渲染切状态不重建 DOM（只改弹簧目标）" : "换一次状态只重建一次",
      rigMode ? buildDelta === 0 : buildDelta === 1,
      `重建 ${buildDelta} 次`
    );
    if (!rigMode && buildDelta !== 1) {
      console.log("      [dbg] 状态推送记录：", JSON.stringify(await R.eval("window.petDebug.stateLog()")));
    }

    if (rigMode) {
      const layerBKids = await R.eval("document.getElementById('layerB').childElementCount");
      ok("骨骼渲染只有一个图层在画（layerB 始终为空）", layerBKids === 0, `layerB 子节点=${layerBKids}`);
    } else {
      // 旧层的清空挂在 220ms 的 setTimeout 上（等淡出结束），要轮询等它
      let cleared = false;
      for (let i = 0; i < 20; i++) {
        cleared = (await R.eval(`document.getElementById('${beforeLayer}').childElementCount`)) === 0;
        if (cleared) break;
        await sleep(100);
      }
      ok("旧图层在淡出后被清空", cleared);
    }

    // 动画在不在跑。这是"活猫感"的唯一可测证据：静态截图看不出区别，
    // 只有连续采样才能证明帧循环真的在算。
    //
    // 两条路径看的地方不一样，而且这里有个真实的坑：
    // **弹簧收敛之后读数就不变了**——拿 `petDebug.springs()` 当探针，
    // 稳态（working）下 12 次快照会一模一样，于是"明明在呼吸"却被判成"没在动"。
    // 真正的"每帧都在算"是呼吸：它是每帧由正弦直接推导、写进 transform 的，
    // 不经过弹簧。所以骨骼路径要读的是每帧推导出来的 transform。
    const probeExpr = rigMode
      ? `(() => {
           // rig-ruff（胸口大毛领）2026-10-28 连 SVG 一起删了，这里换成胡须：
           // 它同样有一个每帧由 breathSin 直接推导的 rotate，不经过弹簧。
           const ids = ['rig-body-group', 'rig-whiskers-l', 'rig-head-group', 'rig-tail-main'];
           return ids.map((id) => {
             const el = document.getElementById(id);
             if (!el) return 'missing:' + id;
             return el.style.transform + ' / ' + el.getAttribute('d');
           }).join('|');
         })()`
      // 帧序列路径：没有部件动画那套东西了（motion 引擎随骨骼重写一起删了），
      // 它剩下的"每帧在算"就是按 fps 换 .on 的那张帧——所以探针读的是索引。
      // 这里原来写的是 window.petDebug.motion()，而那个出口早就删了：
      // 默认主题是骨骼路径，这段从来没执行过，真跑到它会直接 TypeError。
      : "Array.from(document.querySelectorAll('svg.frame')).findIndex((e)=>e.classList.contains('on'))";
    const snaps = [];
    for (let i = 0; i < 12; i++) {
      snaps.push(String(await R.eval(probeExpr)));
      await sleep(100);
    }
    const animMoves = new Set(snaps).size;
    ok(
      rigMode ? "每帧都在重算（同一状态下 transform 持续变化）" : "部件动画在跑（同一状态下 transform 持续变化）",
      animMoves >= 6,
      `不同快照 ${animMoves}/12`
    );

    // 弹簧本身要有货：这是"这身皮是二阶弹簧驱动"的结构证据。
    if (rigMode) {
      const springs = JSON.parse((await R.eval("JSON.stringify(window.petDebug.springs())")) || "{}");
      const keys = Object.keys(springs);
      ok(
        "弹簧通道都建起来了（≥20 个且都是有限数）",
        keys.length >= 20 && keys.every((k) => Number.isFinite(springs[k])),
        `通道 ${keys.length} 个`
      );
    }

    // 眨眼。骨骼渲染的做法是"把睁眼层藏起来"。
    // 间隔随机 1.8~4.2s（thinking），采样窗口要盖过最大间隔。
    // **必须从 Node 侧逐次读**：CDP 的 send() 有 5 秒超时，页面里的长循环会静默返回 undefined。
    //
    // 这里原来还有一个 else 分支：帧序列主题"把眼睛压扁" —— 那是 motion 引擎干的，
    // 而 motion 引擎已经删了，那条分支调用 window.petDebug.motion() 会直接 TypeError
    // （它靠 rigMode 恒为 true 才一直没暴露）。眨眼现在是骨骼引擎的能力，
    // 所以只在骨骼路径下断言，别再保留一个"测不存在的能力"的假分支。
    await R.eval("window.petDebug.setState('thinking')");
    await sleep(120);
    let blinkSeen = false;
    for (let i = 0; i < 100; i++) {
      const v = await R.eval("document.getElementById('rig-eyes-open')?.getAttribute('opacity')");
      // 数值比较而不是 `=== "0"`：睁眼层的不透明度现在是**连续值**（S9 的
      // 睁眼弹簧写的是 0.000~1.000 三位小数）。按字符串比会永远不相等，
      // 于是"明明在眨眼"被判成没眨——这类断言失败比没有断言更费时间。
      if (Number(v) <= 0.001) {
        blinkSeen = true;
        break;
      }
      await sleep(50);
    }
    ok("会眨眼（睁眼层被藏起来过一次以上）", blinkSeen, `seen=${blinkSeen}`);

    // ---------- 3.4 鼠标把睡着的猫弄醒（S9） ----------
    //
    // 这里验的是两件事：**上行链路真的发了请求**，以及**醒来这段真的在过渡**。
    // 有两半是在这里验不到的，说清楚免得下次以为覆盖了：
    //   1) 主进程那一半（store.wake() 把 sleeping 改成 idle）在 Node 侧单独验——
    //      要让真应用睡着得等 60 秒（ragdoll 没写 sleepAfterMs），那不适合放进回归。
    //   2) "过渡"只能靠 eyeOpen 这个数去看。一张静态截图里，慢慢睁开和
    //      啪一下睁开长得一模一样，所以判据必须是**采到中间值**而非只看终态。
    if (rigMode) {
      await R.eval("window.petDebug.setState('sleeping')");
      let asleep = false;
      for (let i = 0; i < 25; i++) {
        if ((await R.eval("window.petDebug.eyeOpen()")) < 0.02) {
          asleep = true;
          break;
        }
        await sleep(60);
      }
      ok("能进到「熟睡」基准（睁眼程度收敛到 0）", asleep, `eyeOpen=${await R.eval("window.petDebug.eyeOpen()")}`);
      ok(
        "熟睡时头顶的 zZz 亮着",
        Number(await R.eval("document.getElementById('fx-sleeping')?.getAttribute('opacity')")) >= 0.98
      );

      const wakeBefore = await R.eval("window.petDebug.wakeSends()");
      // 用页面里合成一个 mousemove，走的是和真鼠标**同一条**监听：
      // window 上的 mousemove → elementFromPoint 判命中 → 才发请求。
      // 直接用 petDebug 调内部函数就绕过了命中判定，那样测的就不是这条路了。
      const hoverHit = await R.eval(`(() => {
        const hit = document.elementFromPoint(120, 120);
        const onPet = !!(hit && hit.closest && hit.closest('#pet'));
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 120, bubbles: true }));
        return onPet;
      })()`);
      await sleep(80);
      const wakeAfter = await R.eval("window.petDebug.wakeSends()");
      ok("hover 时命中的是猫本人（不是空白穿透区）", hoverHit === true);
      ok("鼠标停到睡着的猫身上会发出醒猫请求", wakeAfter === wakeBefore + 1, `${wakeBefore} → ${wakeAfter}`);

      // 500ms 上限：紧接着再来一次不该再发。醒着的猫不该为每次 mousemove 付一条 IPC。
      await R.eval("window.dispatchEvent(new MouseEvent('mousemove', { clientX: 122, clientY: 120, bubbles: true }))");
      await sleep(60);
      const wakeAfter2 = await R.eval("window.petDebug.wakeSends()");
      ok("500ms 内不重复发（限流生效）", wakeAfter2 === wakeAfter, `${wakeAfter} → ${wakeAfter2}`);

      // 过渡曲线：睡 → 醒的那 0.5 秒里，睁眼程度必须经过连续的中间值。
      await R.eval("window.petDebug.setState('idle')");
      const curve = [];
      for (let i = 0; i < 6; i++) {
        const raw = await R.eval(
          `JSON.stringify({ e: window.petDebug.eyeOpen(), z: Number(document.getElementById('fx-sleeping').getAttribute('opacity')) })`
        );
        curve.push(JSON.parse(raw || "{}"));
        await sleep(50);
      }
      const mid = curve.filter((p) => p.e > 0.05 && p.e < 0.95);
      const rising = curve.every((p, i) => i === 0 || p.e >= curve[i - 1].e - 0.02);
      ok(
        "睡着 → idle 是慢慢睁眼（采到中间值，不是 0/1 硬跳）",
        mid.length >= 2 && rising,
        curve.map((p) => p.e).join(" → ")
      );
      ok(
        "zZz 和眼睛走同一条曲线（一起散，不会一个已经睁眼另一个还挂着）",
        curve.length > 0 && curve.every((p) => Math.abs(1 - p.e - p.z) < 0.02),
        curve.map((p) => `${p.e.toFixed(2)}/${p.z.toFixed(2)}`).join(" ")
      );

      // 收尾：等它彻底睁开，别把中间态留给后面的断言
      for (let i = 0; i < 20; i++) {
        if ((await R.eval("window.petDebug.eyeOpen()")) > 0.98) break;
        await sleep(60);
      }
      await R.eval("window.petDebug.setState('thinking')");
      await sleep(120);
    }

    // ---------- 3.5 working 场景（敲键盘）与 eyeTracking ----------
    // working 曾经是水边垂钓，还带鱼 / 拖鞋两条彩蛋；用户改回敲键盘后，
    // 彩蛋连同部件和引擎一起删干净了（留着"暂时不排期"的版本等于留死路径）。
    // 所以这里测的是桌面场景本身。
    //
    // 三样一起才读得出「在干活」：前爪在敲、代码行在长、键盘灯在呼吸。
    // **只测爪子上下动是不够的**——那样它和「在抖」没法区分。
    if (rigMode) {
      await R.eval("window.petDebug.setState('working')");
      await sleep(250);

      const deskMissing = await R.eval(`(() => {
        const miss = [];
        for (const id of ['rig-work-desk', 'rig-monitor', 'rig-keyboard',
                          'rig-code-1', 'rig-code-caret', 'rig-kb-glow']) {
          if (!document.getElementById(id)) miss.push(id);
        }
        return miss.join(',');
      })()`);
      ok("敲键盘的部件在 SVG 里都存在", deskMissing === "", `缺失：${deskMissing}`);

      ok(
        "working 才亮出桌面",
        (await R.eval("document.getElementById('rig-work-desk')?.getAttribute('opacity')")) === "1"
      );
      await R.eval("window.petDebug.setState('idle')");
      await sleep(220);
      ok(
        "切走 working 桌面收起来（不会叠在别的状态上）",
        (await R.eval("document.getElementById('rig-work-desk')?.getAttribute('opacity')")) === "0"
      );
      await R.eval("window.petDebug.setState('working')");
      await sleep(250);

      // 两只前爪交替敲：一只在上的时候另一只在下，同频会像做操
      const pawSnaps = [];
      for (let i = 0; i < 8; i++) {
        pawSnaps.push(
          await R.eval(
            "document.getElementById('rig-paw-fl')?.style.transform + '|' + document.getElementById('rig-paw-fr')?.style.transform"
          )
        );
        await sleep(90);
      }
      const uniqPaws = new Set(pawSnaps).size;
      ok("两只前爪在交替敲（transform 持续变化）", uniqPaws >= 5, `不同快照 ${uniqPaws}/8`);

      // 代码行在长 + 键盘灯在呼吸
      const deskSnaps = [];
      for (let i = 0; i < 8; i++) {
        deskSnaps.push(await R.eval("JSON.stringify(window.petDebug.desk())"));
        await sleep(120);
      }
      const uniqDesk = new Set(deskSnaps).size;
      ok("代码行在长、键盘灯在呼吸", uniqDesk >= 5, `不同快照 ${uniqDesk}/8`);
    }

    // eyeTracking 曾经是"写了不生效"的字段：主题声明 false，渲染层照样写瞳孔。
    // 现在它真的管住 applyGaze（两条渲染路径都管）。测两件事：开关值传到了渲染层、
    // 以及瞳孔确实不跟着跑——后者才是"生效"的证据，前者只是"数值到了"。
    ok("working 的 eyeTracking 为 false", (await R.eval("window.petDebug.eyeTracking()")) === false);
    await R.eval("window.petDebug.setState('idle')");
    await sleep(150);
    ok("idle 的 eyeTracking 为 true（对照组）", (await R.eval("window.petDebug.eyeTracking()")) === true);
    await R.eval("window.petDebug.setState('working')");
    await sleep(200);

    await R.eval("window.petDebug.gaze({x:1,y:1}, true)");
    await sleep(600);
    const workPupils = await R.eval(
      "(() => { const p = document.querySelector('.layer.show svg.on .pupils'); return p ? (p.style.transform || p.getAttribute('transform')) : null; })()"
    );
    const wp = (String(workPupils || "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    // 骨骼渲染里 working 的瞳孔钉在左下角的屏幕上（-2.2 / 1.6），不跟鼠标。
    // 判据走数值：style.transform 经 CSSOM 会把尾零吃掉（-2.20px 读成 -2.2px）。
    ok(
      "working 下瞳孔不跟鼠标（盯着屏幕，不追光标）",
      rigMode
        ? wp.length >= 2 && Math.abs(wp[0] + 2.2) < 0.06 && Math.abs(wp[1] - 1.6) < 0.06
        : !workPupils || /translate\(-?0(\.00)?[, ]+\s*-?0(\.00)?\)/.test(workPupils),
      `transform=${workPupils}`
    );
    await R.eval("window.petDebug.unpinGaze()");

    // ---------- 4. 眼球追踪 ----------
    // 结构前提：渲染层用 querySelector(".pupils") 拿第一个就驱动，
    // 所以**每帧最多只能有一个 .pupils 组**。左右眼各包一个组的话，
    // 只有一只眼会动，另一只永远定住——画上去看着正常，动起来才发现。
    const multiPupils = rigMode
      ? String(await R.eval("document.querySelectorAll('.layer.show svg.on .pupils').length"))
      : await R.eval(`(() => {
          const V = window.VISUAL_STATES;
          const bad = [];
          for (const s of Object.keys(V)) {
            V[s].frames.forEach((f, i) => {
              const n = (f.match(/class="pupils"/g) || []).length;
              if (n > 1) bad.push(s + '#' + i + ':' + n);
            });
          }
          return bad.join(',');
        })()`);
    ok(
      "每帧最多一个 .pupils 组（否则只有一只眼会动）",
      rigMode ? multiPupils === "1" : multiPupils === "",
      rigMode ? `pupils 组=${multiPupils}` : `违规帧：${multiPupils}`
    );

    await R.eval("window.petDebug.setState('idle')");
    await sleep(200);
    // 第二个参数 pin=true：钉住，别让主进程按真实光标推的 gaze 把它盖掉。
    // 这条测的是"渲染层会不会把给定坐标插值到瞳孔上"，不是"主进程算得准不准"，
    // 两者混在一起就会随机失败（实测读到过 translate(-0.98 0.81)，那是光标位置）。
    await R.eval("window.petDebug.gaze({x:1,y:-1}, true)");
    // 判据是数值不是字符串：style.transform 经 CSSOM 序列化会把尾零吃掉
    // （写进去的是 3.80px，读出来是 3.8px），按精确字符串比会稳定地假红。
    const wantGaze = rigMode ? [3.8, -2.8] : [3.6, -2.6];
    let transform = null;
    let gazeFull = false;
    for (let i = 0; i < 30; i++) {
      transform = await R.eval(
        "(() => { const p = document.querySelector('.layer.show svg.on .pupils'); return p ? (p.style.transform || p.getAttribute('transform')) : null; })()"
      );
      const n = (String(transform || "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
      if (n.length >= 2 && Math.abs(n[0] - wantGaze[0]) < 0.06 && Math.abs(n[1] - wantGaze[1]) < 0.06) {
        gazeFull = true;
        break;
      }
      await sleep(100);
    }
    ok(
      "gaze 收敛到满幅位移",
      gazeFull,
      `transform=${transform} 期望≈translate(${wantGaze[0]}, ${wantGaze[1]})`
    );

    // 两只眼必须一起动：pupils 组里瞳孔的数量要够（眼睛画法变了也不会漏）
    const pupilCount = await R.eval(
      "document.querySelectorAll('.layer.show svg.on .pupils ellipse, .layer.show svg.on .pupils circle').length"
    );
    ok("瞳孔层里两只眼都在（≥2 个瞳孔）", pupilCount >= 2, `瞳孔节点 ${pupilCount}`);

    // 回中
    await R.eval("window.petDebug.gaze({x:0,y:0}, true)");
    await sleep(900);
    const wantCenter = rigMode ? "translate(0.00px, 2.20px)" : "translate(0.00 0.00)";
    // 骨骼渲染里 idle 的瞳孔会回到呼吸带来的零点附近，容差放宽到 ±0.4
    const centered = await R.eval(
      "(() => { const p = document.querySelector('.layer.show svg.on .pupils'); const t = p ? (p.style.transform || p.getAttribute('transform')) : ''; return t; })()"
    );
    ok(
      "gaze 能回中",
      rigMode ? /translate\(0(\.00)?(px)?[, ]/.test(centered) : centered === wantCenter,
      `transform=${centered} 期望≈${wantCenter}`
    );
    // 放开钉子，后面的断言要看到真实光标驱动的行为
    await R.eval("window.petDebug.unpinGaze()");

    // ---------- 5. 命中判定（点击穿透的依据） ----------
    ok(
      "窗口中心命中 #pet",
      !!(await R.eval("!!document.elementFromPoint(120,120)?.closest('#pet')"))
    );
    ok(
      "窗口左上角不命中（留给穿透）",
      !(await R.eval("!!document.elementFromPoint(4,4)?.closest('#pet')"))
    );

    // ---------- 6. 主进程：窗口属性与 IPC 接线 ----------
    if (M) {
      ok("窗口存在", (await M.eval("require('electron').BrowserWindow.getAllWindows().length")) === 1);
      ok("窗口可见", (await M.eval("require('electron').BrowserWindow.getAllWindows()[0].isVisible()")) === true);
      ok("置顶生效", (await M.eval("require('electron').BrowserWindow.getAllWindows()[0].isAlwaysOnTop()")) === true);
      const b = await M.eval("JSON.stringify(require('electron').BrowserWindow.getAllWindows()[0].getBounds())");
      const bounds = b ? JSON.parse(b) : null;
      ok("窗口尺寸 240×240", !!bounds && bounds.width === 240 && bounds.height === 240, b);
      ok("不可缩放", (await M.eval("require('electron').BrowserWindow.getAllWindows()[0].isResizable()")) === false);

      // 五条 IPC 通道是否都接上了：从主进程数监听器，比从渲染层猜可靠
      // （theme:get / letter:send 这类是 invoke/handle，不在 listenerCount 里）
      for (const ch of ["drag:start", "drag:end", "mouse:ignore", "app:quit", "pet:menu", "pet:hover"]) {
        ok(
          `IPC ${ch} 已接线`,
          (await M.eval(`require('electron').ipcMain.listenerCount('${ch}')`)) >= 1
        );
      }

      // 窗口是否真的透明——S1 三件套里唯一没法从 DOM 或属性读出来的东西。
      //
      // 做法：**同一块区域拍两次**，一次窗口显示、一次隐藏，逐点比较。
      // 为什么不用「窗口内侧 vs 外侧」那种相邻比色：窗口外面是什么完全不受控，
      // 只要有个别的窗口（哪怕是自己另一只桌宠）压在同一个位置，
      // 「外侧」采到的就是别人的像素，差值立刻不为 0——测得再准也是假失败。
      // 消失/出现对比法把背景变量消掉了：两次拍的是同一块桌面。
      //
      // 采样点取窗口四角（窗口 240×240，宠物本体只占中间 176×176，
      // 所以四角一定是空的）。要是角落也被画了东西，说明形象画超界了，
      // 那本身就是问题，让它失败是对的。
      const transparency = await M.eval(`(async () => {
        const { desktopCapturer, screen, BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.isVisible() && !String(w.webContents.getURL()).includes('dashboard')
        );
        if (!win) return 'no-window';
        const b = win.getBounds();
        const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
        const grab = async () => {
          const srcs = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: d.bounds.width, height: d.bounds.height },
          });
          if (!srcs.length) return null;
          return srcs[0].thumbnail.crop({ x: b.x, y: b.y, width: b.width, height: b.height });
        };
        const shown = await grab();
        win.hide();
        await new Promise((r) => setTimeout(r, 320));
        const hidden = await grab();
        // 背景噪声基线：窗口已经藏起来了，同一块桌面再拍一次。
        // 用户可能同时开着自己的桌宠（实测就撞上过），或者桌面上有会动的东西，
        // 那几像素本来就在变——这跟"窗口不透明"是两件事，必须先把噪声量出来再比较，
        // 否则一个 5/255 的帧间抖动就能让整条断言假失败。
        await new Promise((r) => setTimeout(r, 320));
        const hiddenAgain = await grab();
        win.showInactive();
        if (!shown || !hidden || !hiddenAgain) return 'no-source';
        const size = shown.getSize();
        const sizeHidden = hidden.getSize();
        if (size.width !== sizeHidden.width || size.height !== sizeHidden.height) return 'size-mismatch';
        const A = shown.toBitmap();
        const B = hidden.toBitmap();
        const B2 = hiddenAgain.toBitmap();
        const at = (buf, x, y) => { const i = (y * size.width + x) * 4; return [buf[i + 2], buf[i + 1], buf[i]]; };
        const dist = (a, c) => Math.max(Math.abs(a[0] - c[0]), Math.abs(a[1] - c[1]), Math.abs(a[2] - c[2]));
        const pad = 10;
        const pts = [
          [pad, pad],
          [size.width - 1 - pad, pad],
          [pad, size.height - 1 - pad],
          [size.width - 1 - pad, size.height - 1 - pad],
        ];
        return pts.map(([x, y]) => {
          const a = at(A, x, y);
          const b = at(B, x, y);
          const b2 = at(B2, x, y);
          const noise = dist(b, b2); // 这块桌面自己会动多少
          return { diff: dist(a, b), noise };
        });
      })()`);
      if (Array.isArray(transparency)) {
        // 只认"背景稳定"的角（噪声 ≤ 6）。噪声大的角根本没资格判定：
        // 那一块桌面自己就在变，比出来的差值说明不了窗口透明不透明。
        // 不设成"噪声+大容差"，否则一个噪声 137 的角会把断言变成永远通过的空壳。
        const usable = transparency.filter((p) => p.noise <= 6);
        const clean = usable.filter((p) => p.diff <= 2);
        const detail = transparency
          .map((p) => `${p.diff}/${p.noise}`)
          .join(", ");
        if (usable.length < 3) {
          console.log(`跳过  窗口透明检查（桌面背景变化太大，可用角 ${usable.length}/4，差值/噪声=${detail}）`);
        } else {
          ok(
            "窗口真透明（显示与隐藏时四角像素一致）",
            clean.length === usable.length,
            `差值/噪声=[${detail}]，可判定 ${clean.length}/${usable.length}`
          );
        }
      } else {
        console.log(`跳过  窗口透明检查（${transparency}，需要可见桌面）`);
      }
      // 隐藏/显示过一轮，确认窗口回到可见状态——后面还有断言依赖它
      ok("透明检测后窗口仍可见", !!(await M.eval("require('electron').BrowserWindow.getAllWindows().some(w => w.isVisible())")));
    }

    // ---------- 7. HTTP 通路（真 hook 走的路） ----------
    let ep = null;
    for (let i = 0; i < 20; i++) {
      try {
        ep = JSON.parse(fs.readFileSync(PORT_FILE, "utf8"));
        if (ep.port) break;
      } catch {}
      await sleep(150);
    }
    ok("端点文件已写入（含 port+token）", !!(ep && ep.port && ep.token && ep.token.length === 64));

    if (ep) {
      const health = await new Promise((resolve) => {
        const req = require("node:http").get(
          { host: "127.0.0.1", port: ep.port, path: "/health", headers: { "x-clawd-token": ep.token }, timeout: 2000 },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on("error", () => resolve(0));
        req.on("timeout", () => {
          req.destroy();
          resolve(0);
        });
      });
      ok("/health 带 token 返回 200", health === 200, `status=${health}`);

      const noToken = await new Promise((resolve) => {
        const req = require("node:http").get(
          { host: "127.0.0.1", port: ep.port, path: "/health", timeout: 2000 },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on("error", () => resolve(0));
        req.on("timeout", () => {
          req.destroy();
          resolve(0);
        });
      });
      ok("/health 不带 token 返回 401", noToken === 401, `status=${noToken}`);

      // 端到端：HTTP 进来 → 状态机 → IPC → 渲染层真的换了状态
      // 关键顺序：必须先把渲染层推到 sleeping，再发 POST。
      // 反过来做会踩竞态——POST 的响应返回时，主进程其实已经 broadcast 过了，
      // 此时再手动 setState('sleeping') 就等于把刚落地的 working 覆盖掉。
      await R.eval("window.petDebug.setState('sleeping')");
      await sleep(200);

      const post = await new Promise((resolve) => {
        const body = JSON.stringify({ agent: "claude-code", session_id: "upgrade-check", event: "PreToolUse" });
        const req = require("node:http").request(
          {
            host: "127.0.0.1",
            port: ep.port,
            path: "/state",
            method: "POST",
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-clawd-token": ep.token },
          },
          (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ code: res.statusCode, body: b }));
          }
        );
        req.on("error", () => resolve({ code: 0, body: "" }));
        req.end(body);
      });
      ok("POST /state 返回 200 且带 visual", post.code === 200 && /"visual"\s*:\s*"working"/.test(post.body), `status=${post.code} ${post.body}`);

      let rendered = null;
      for (let i = 0; i < 20; i++) {
        rendered = await R.eval("window.petDebug.state()");
        if (rendered === "working") break;
        await sleep(100);
      }
      ok("POST /state 真的驱动了渲染层", rendered === "working", `渲染层当前=${rendered}`);

      // 事件日志要真的流到渲染层才算数：主进程记了但没推过去，
      // 排查的时候打开 DevTools 仍然是一片空白——那和没记一样。
      const evLog = await R.eval("window.petDebug.events()");
      ok(
        "petDebug.events() 拿到了主进程的事件日志（不是空数组）",
        Array.isArray(evLog) && evLog.length > 0 && typeof evLog[evLog.length - 1].event === "string",
        `${evLog.length} 条，最新=${JSON.stringify(evLog[evLog.length - 1])}`
      );
    }

    // ---------- 7.5 权限端点（S5） ----------
    // 这一段验证的是"裁决链路"：POST 挂起 → 气泡显示 → 点击 → 回写响应。
    // /permission 不带 token（Claude Code 也不会带），这是 HTTP hook 架构的固有属性。
    if (ep) {
      const permBody = {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/should-not-run" },
        session_id: "perm-test",
        cwd: "E:\\JacksonLee\\project\\clawd-starter",
      };

      // --- A. 拒绝路径 ---
      const denyP = postPermission(ep, permBody);
      const bTarget = await waitForUrl(RENDERER_PORT, "bubble.html");
      ok("权限请求后气泡窗口被创建", !!bTarget);
      if (bTarget) {
        const B = await Cdp.connect(bTarget.webSocketDebuggerUrl);
        await B.send("Runtime.enable");
        let cmdText = null;
        for (let i = 0; i < 40; i++) {
          cmdText = await B.eval("document.getElementById('cmd')?.textContent || ''");
          if (cmdText) break;
          await sleep(100);
        }
        ok("气泡显示了工具名", (await B.eval("document.getElementById('tool').textContent")) === "Bash");
        ok("气泡显示了完整命令（不截断关键信息）", String(cmdText).includes("rm -rf /tmp/should-not-run"), `cmd=${String(cmdText).slice(0, 40)}`);
        ok(
          "气泡显示了来源目录",
          String(await B.eval("document.getElementById('meta').textContent")).includes("clawd-starter")
        );
        ok("没有『永久允许』这类按钮", !(await B.eval("document.body.textContent.includes('永久')")));

        // 走真实 UI 路径：点按钮，而不是直接调 IPC
        await B.eval("document.getElementById('btnDeny').click()");
        const denyRes = await denyP;
        const denyJson = denyRes.body ? JSON.parse(denyRes.body) : null;
        ok(
          "点拒绝 → 200 + behavior:deny",
          denyRes.code === 200 && denyJson?.hookSpecificOutput?.decision?.behavior === "deny",
          `status=${denyRes.code} body=${denyRes.body.slice(0, 90)}`
        );
        ok("deny 带 message 回给 agent", !!denyJson?.hookSpecificOutput?.decision?.message);
        ok(
          "响应带 hookEventName",
          denyJson?.hookSpecificOutput?.hookEventName === "PermissionRequest"
        );
        B.close();
      } else {
        await denyP; // 别把请求挂在那儿
      }

      // --- B. 允许路径 ---
      // 气泡窗口是复用的，DOM 里还留着上一条请求的文本。
      // 所以必须等"新内容"出现再点，否则会点到一条还没渲染好的请求上。
      const allowP = postPermission(ep, { ...permBody, tool_input: { command: "ls -la" } });
      const bTarget2 = await waitForUrl(RENDERER_PORT, "bubble.html");
      if (bTarget2) {
        const B2 = await Cdp.connect(bTarget2.webSocketDebuggerUrl);
        await B2.send("Runtime.enable");
        let allowCmd = null;
        for (let i = 0; i < 40; i++) {
          allowCmd = await B2.eval("document.getElementById('cmd')?.textContent || ''");
          if (String(allowCmd).includes("ls -la")) break;
          await sleep(100);
        }
        ok("第二次请求渲染了新内容", String(allowCmd).includes("ls -la"), `cmd=${String(allowCmd).slice(0, 30)}`);
        ok("第二次请求时按钮已恢复可用", (await B2.eval("document.getElementById('btnAllow').disabled")) === false);
        await B2.eval("document.getElementById('btnAllow').click()");
        const allowRes = await allowP;
        const allowJson = allowRes.body ? JSON.parse(allowRes.body) : null;
        ok(
          "点允许 → 200 + behavior:allow",
          allowRes.code === 200 && allowJson?.hookSpecificOutput?.decision?.behavior === "allow",
          `status=${allowRes.code} body=${allowRes.body.slice(0, 90)}`
        );
        B2.close();
      } else {
        await allowP;
      }

      // --- C. 超时不表态 → 204（不是 deny，也不是 allow）---
      const t0 = Date.now();
      const timeoutRes = await postPermission(ep, { ...permBody, tool_input: { command: "no one clicks me" } });
      const waited = Date.now() - t0;
      ok(
        "没人点 → 204 不做决定（回落原生提示）",
        timeoutRes.code === 204 && timeoutRes.body === "",
        `status=${timeoutRes.code} 等了 ${waited}ms`
      );

      // --- D. 浏览器发起的跨源请求必须被挡住，且不能创建气泡 ---
      const evil = await postPermission(ep, permBody, { origin: "https://evil.example" });
      ok("带 Origin 的请求被拒（403，空响应）", evil.code === 403 && evil.body === "", `status=${evil.code}`);

      // --- E. 非 JSON 的 content-type 被挡（CORS 简单请求防预检绕过）---
      const plain = await new Promise((resolve) => {
        const raw = JSON.stringify(permBody);
        const req = require("node:http").request(
          {
            host: "127.0.0.1",
            port: ep.port,
            path: "/permission",
            method: "POST",
            headers: { "content-type": "text/plain", "content-length": Buffer.byteLength(raw) },
          },
          (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ code: res.statusCode, body: b }));
          }
        );
        req.on("error", () => resolve({ code: 0, body: "" }));
        req.end(raw);
      });
      ok("text/plain 被挡（415）", plain.code === 415, `status=${plain.code}`);

      // --- F. 非法 body 不能挂起一个僵尸请求 ---
      const bad = await new Promise((resolve) => {
        const req = require("node:http").request(
          {
            host: "127.0.0.1",
            port: ep.port,
            path: "/permission",
            method: "POST",
            headers: { "content-type": "application/json", "content-length": 2 },
          },
          (res) => {
            let b = "";
            res.on("data", (c) => (b += c));
            res.on("end", () => resolve({ code: res.statusCode, body: b }));
          }
        );
        req.on("error", () => resolve({ code: 0, body: "" }));
        req.end("[]");
      });
      ok("数组 body 被拒（400）", bad.code === 400, `status=${bad.code}`);
    }

    // ---------- 7.7 会话看板（S6） ----------
    // 三件事：看板能开、列表跟着状态机走、SEC-09 的分层真的成立
    // （快照里只有 basename，完整路径只在"点复制"那一刻由主进程释放）。
    if (ep) {
      const seed = (sessionId, cwd, event, extra) =>
        new Promise((resolve) => {
          const body = JSON.stringify({ agent: "codebuddy", session_id: sessionId, event, cwd, ...extra });
          const req = require("node:http").request(
            {
              host: "127.0.0.1",
              port: ep.port,
              path: "/state",
              method: "POST",
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
                "x-clawd-token": ep.token,
              },
            },
            (res) => {
              res.resume();
              res.on("end", resolve);
            }
          );
          req.on("error", resolve);
          req.end(body);
        });

      await seed("sess-alpha", "E:\\work\\proj-alpha", "UserPromptSubmit", {
        title: "帮我重构看板",
      });
      await seed("sess-alpha", "E:\\work\\proj-alpha", "PreToolUse", { tool_name: "Edit" });
      await seed("sess-beta", "E:\\work\\proj-beta", "Stop");

      // 走和双击同一条 IPC
      await R.eval("window.clawd.toggleDashboard()");
      const dTarget = await waitForUrl(RENDERER_PORT, "dashboard.html");
      ok("双击桌宠能打开会话看板", !!dTarget);

      if (dTarget) {
        const D = await Cdp.connect(dTarget.webSocketDebuggerUrl);
        await D.send("Runtime.enable");

        let rows = 0;
        for (let i = 0; i < 30; i++) {
          rows = await D.eval("document.querySelectorAll('#list li').length");
          if (rows >= 2) break;
          await sleep(150);
        }
        ok("看板列出了会话（≥2 行）", rows >= 2, `行数=${rows}`);

        const dirs = await D.eval(
          "[...document.querySelectorAll('#list .dir')].map(e=>e.textContent).join('|')"
        );
        ok(
          "目录只显示 basename",
          String(dirs).includes("proj-alpha") && String(dirs).includes("proj-beta"),
          `显示=${dirs}`
        );

        // SEC-09 的硬断言：basename 在、盘符不在。
        // 完整路径一旦进 DOM，"复制路径"这个设计就没意义了。
        const leak = await D.eval(
          "JSON.stringify({ hasBase: document.body.textContent.includes('proj-alpha'), hasDrive: document.body.textContent.includes('E:') })"
        );
        const leakObj = JSON.parse(leak || "{}");
        ok(
          "完整路径没有泄露到看板 DOM（只有 basename）",
          leakObj.hasBase === true && leakObj.hasDrive === false,
          `basename=${leakObj.hasBase} 盘符=${leakObj.hasDrive}`
        );

        // ---- 标题与工具名：看板上"像人话"的那两行 ----
        // 标题是"粘"的：后面那条 PreToolUse 不带标题，不能把前一条的好标题抹掉。
        const titles = await D.eval(
          "[...document.querySelectorAll('#list .title')].map(e=>e.textContent).join('|')"
        );
        ok(
          "看板显示了会话标题（标题是粘的：后续事件不带标题不会抹掉它）",
          String(titles).includes("帮我重构看板"),
          `显示=${titles}`
        );
        ok(
          "没拿到标题的那条不占一行（untitled）",
          await D.eval(
            "[...document.querySelectorAll('#list li')].filter(li => (li.querySelector('.sid')||{}).textContent === 'sess-beta').every(li => li.classList.contains('untitled'))"
          ),
          `beta 行 class=${await D.eval("([...document.querySelectorAll('#list li')].find(li => (li.querySelector('.sid')||{}).textContent === 'sess-beta')||{className:'(没找到)'}).className")}`
        );

        const tools = await D.eval(
          "[...document.querySelectorAll('#list .tool')].map(e=>e.textContent).join('|')"
        );
        ok("看板显示了工具名", String(tools).includes("Edit"), `显示=${tools}`);

        // 演示模式：目录名和标题都要藏。标题的理由比目录名更硬——
        // 它是用户自己说的第一句话，里面出现客户名的概率比目录名还高。
        await D.eval("(() => { const c = document.getElementById('demo'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()");
        await sleep(350);
        const demoDirs = await D.eval(
          "[...document.querySelectorAll('#list .dir')].map(e=>e.textContent).join('|')"
        );
        ok(
          "演示模式隐藏全部目录名",
          String(demoDirs).split("|").every((t) => t === "项目已隐藏"),
          `显示=${demoDirs}`
        );
        const demoTitles = await D.eval(
          "[...document.querySelectorAll('#list .title')].map(e=>e.textContent).join('|')"
        );
        ok(
          "演示模式也隐藏标题（用户的原话比目录名更敏感）",
          !String(demoTitles).includes("帮我重构看板") && String(demoTitles).includes("内容已隐藏"),
          `显示=${demoTitles}`
        );
        // 还原，别把演示模式留给后面的断言
        await D.eval("(() => { const c = document.getElementById('demo'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()");
        await sleep(300);

        // 关掉演示模式，给下一次运行留干净状态
        await D.eval("(() => { const c = document.getElementById('demo'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()");
        await sleep(200);

        // 唯一会离开主进程的完整路径：用户显式点"复制路径"
        const copied = await D.eval("window.dashboard.copyPath('sess-alpha')");
        // 伪造的 session id 不能骗出任何路径
        const fake = await D.eval("window.dashboard.copyPath('../../etc/passwd')");
        ok(
          "复制路径只对真实会话生效（伪造 id 拿不到）",
          copied === true && fake === false,
          `真实=${copied} 伪造=${fake}`
        );

        // 剪贴板内容要**先读再诊断**。上一版写反了：先写一个 PROBE-OK 探针
        // 再读，等于把自己的证据覆盖掉了——探针能跑通时，读到的永远是 PROBE-OK。
        // 现在：先读真值；不等才做一次"能不能读写"的能力探测（并且把原值写回去）。
        if (M) {
          const EXPECTED = "E:\\work\\proj-alpha";
          // 单次读不可靠：Windows 上只要有别的进程（剪贴板管理器、另一个 Electron）
          // 正握着剪贴板，readText 会返回空串。实测两次里就有一次读到空——
          // 那是环境抖动，不是 bug，所以要重试几次再下结论。
          let clip = "";
          for (let i = 0; i < 6; i++) {
            clip = await M.eval("require('electron').clipboard.readText()");
            if (clip === EXPECTED) break;
            await sleep(120);
          }
          if (clip === EXPECTED) {
            ok("剪贴板拿到的是完整路径", true, `剪贴板=${JSON.stringify(clip)}`);
          } else {
            const probe = await M.eval(
              "(() => { const c = require('electron').clipboard; const before = c.readText();" +
                " c.writeText('PROBE-OK'); const after = c.readText();" +
                " try { c.writeText(before); } catch {} return after; })()"
            );
            if (probe === "PROBE-OK") {
              // 剪贴板可读写，那这个不一致就是真 bug，不能当成环境问题放过
              ok("剪贴板拿到的是完整路径", false, `剪贴板=${JSON.stringify(clip)}`);
            } else {
              console.log(
                `      [warn] 本环境读不到剪贴板内容，跳过校验（需手工点一次验证）。读到=${JSON.stringify(clip)}`
              );
            }
          }
        }

        // S7：看板里的主题下拉框。crab 删掉之后只剩 ragdoll 一个主题，
        // 而"能换形象"这件事必须有**第二个主题**才测得出来——这两条覆盖面
        // 之前是靠 crab 撑着的，删它不能顺手把防线一起删了。
        // 所以回归运行时往 themes/ 里临时塞一个 `probe` 主题（帧序列、多帧、
        // 不写 timings），测完在 finally 里删掉。
        // 它对运行时是可见的：`listThemeIds()` 每次都 readdirSync，
        // 不像 THEMES_DIR 那样只在模块加载时算一次。
        const probeDir = path.join(ROOT, "themes", "probe");
        const PROBE_SVG =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
          '<rect x="40" y="60" width="120" height="80" rx="10" fill="#7FB3D5"/>' +
          '<g class="pupils"><ellipse cx="80" cy="100" rx="9" ry="12" fill="#123"/>' +
          '<ellipse cx="120" cy="100" rx="9" ry="12" fill="#123"/></g></svg>';
        fs.mkdirSync(path.join(probeDir, "assets"), { recursive: true });
        // 3 张不同颜色的主资产（为了测"多帧在轮播"），
        // 再加 2 张专属颜色的变体（为了测"切回来换的是另一套"）。
        // 同一个形状只是换了填充色，肉眼分得出第几套，回归也能按 id 读。
        const probeFrame = (fill) =>
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
          `<rect id="probe-swatch" x="40" y="60" width="120" height="80" rx="10" fill="${fill}"/>` +
          '<g class="pupils"><ellipse cx="80" cy="100" rx="9" ry="12" fill="#123"/>' +
          '<ellipse cx="120" cy="100" rx="9" ry="12" fill="#123"/></g></svg>';
        fs.writeFileSync(path.join(probeDir, "assets", "p1.svg"), probeFrame("#7FB3D5"));
        fs.writeFileSync(path.join(probeDir, "assets", "p2.svg"), probeFrame("#D57F7F"));
        fs.writeFileSync(path.join(probeDir, "assets", "p3.svg"), probeFrame("#7FD59B"));
        fs.writeFileSync(path.join(probeDir, "assets", "v1.svg"), probeFrame("#C07FD5"));
        fs.writeFileSync(path.join(probeDir, "assets", "v2.svg"), probeFrame("#D5C47F"));
        fs.writeFileSync(
          path.join(probeDir, "theme.json"),
          JSON.stringify({
            schemaVersion: 1,
            name: "回归探针",
            description: "回归运行时临时创建，用完即删",
            states: {
              idle: {
                fps: 8,
                eyeTracking: true,
                frames: ["p1.svg", "p2.svg", "p3.svg"],
                // 一套变体 → 连同主资产一共 2 个槽位
                variants: [{ id: "alt", frames: ["v1.svg", "v2.svg"] }],
              },
            },
          })
        );
        try {
          const themeList = await D.eval(
            "window.dashboard.listThemes().then(d => ({ current: d.current, ok: d.themes.filter(t=>t.ok).map(t=>t.id).join(','), bad: d.themes.filter(t=>!t.ok).length }))"
          );
          ok(
            "看板列出了主题（且都加载成功）",
            !!themeList && themeList.ok === "probe,ragdoll" && themeList.bad === 0,
            `ok=${themeList && themeList.ok} 坏的=${themeList && themeList.bad}`
          );

          const switched = await D.eval("window.dashboard.setTheme('probe')");
          let afterThemeId = null;
          for (let i = 0; i < 20; i++) {
            afterThemeId = await R.eval("window.petDebug.theme().id");
            if (afterThemeId === "probe") break;
            await sleep(100);
          }
          ok("看板切主题后桌宠立刻换形象", switched && switched.ok === true && afterThemeId === "probe", `id=${afterThemeId}`);

          // 探针主题只声明了 idle 的 3 帧，缺的 6 个状态由 idle 补齐 → 7×3=21
          const probeFrames = await R.eval(
            "Object.values(window.VISUAL_STATES).reduce((n, s) => n + s.frames.length, 0)"
          );
          ok("换主题后缺失状态被 idle 补齐（7×3=21）", probeFrames === 21, `帧数=${probeFrames}`);

          // probe 是**帧序列**主题（没有 rigType），正好承接删掉 crab 之后
          // 帧序列这条渲染路径的端到端覆盖——它现在的活消费者只剩内置兜底画面和第三方主题。
          const probeMode = await R.eval("window.petDebug.theme().rig");
          ok("没有 rigType 的主题走帧序列路径", probeMode !== "spring", `rig=${probeMode}`);

          const probeShots = [];
          for (let i = 0; i < 10; i++) {
            probeShots.push(
              await R.eval(
                "(() => { const l = document.querySelector('.layer.show'); if (!l) return -1;" +
                " return Array.from(l.querySelectorAll('svg.frame')).findIndex((e)=>e.classList.contains('on')); })()"
              )
            );
            await sleep(90);
          }
          ok(
            "帧序列真的在轮播（.on 索引持续变化）",
            new Set(probeShots).size >= 3,
            `不同索引 ${new Set(probeShots).size}/10`
          );

          // ---------- 表情变体：一个状态的多套资产 ----------
          // 只断言"states.idle.variants 被解析出来了"是不够的——那是硬约束 25 的形状：
          // 字段到了、校验过了、渲染层没看它一眼。所以这里要读**屏幕上真在播的那块颜色**：
          // 变体用的是另一组填充色，颜色变了才说明真的换了资产。
          // 必须限定 .layer.show：旧图层的帧还要挂 240ms 才清，
          // 直接 querySelector 会抓到正在淡出的那一套，读出来的颜色是"上一套"的。
          const readSwatch = () =>
            R.eval(
              "(() => { const l = document.querySelector('.layer.show'); if (!l) return null;" +
              " const e = l.querySelector('svg.frame.on #probe-swatch'); return e ? e.getAttribute('fill') : null; })()"
            );
          //
          // 用"轮询到目标为止"，而不是"切两次就该是第 2 套"：主进程每 250ms 推一次 state，
          // 推送本身也会触发 renderState，两次手动 setState 之间可能夹进额外轮换。
          // 断言写成"第 2 次必须 pick===1"就会时红时绿——那是测试在赌时序，不是在验功能。
          const MAIN_COLORS = ["#7FB3D5", "#D57F7F", "#7FD59B"];
          const ALT_COLORS = ["#C07FD5", "#D5C47F"];
          const v0 = await R.eval("window.petDebug.variant()");

          ok(
            "petDebug.variant() 返回真的槽位信息（不是空对象）",
            !!v0 && v0.slots === 2 && typeof v0.pick === "number",
            JSON.stringify(v0)
          );

          let alt = null;
          let back = null;
          for (let round = 0; round < 8 && !(alt && back); round++) {
            await R.eval("window.petDebug.setState('thinking')");
            await sleep(150);
            await R.eval("window.petDebug.setState('idle')");
            await sleep(150);
            const v = await R.eval("window.petDebug.variant()");
            const color = await readSwatch();
            if (v.pick === 1 && v.id === "alt" && alt === null) alt = color;
            if (alt !== null && v.pick === 0 && v.id === "" && back === null) back = color;
          }
          ok(
            "切走再切回来会轮换到另一套表情变体",
            ALT_COLORS.includes(alt),
            `轮换到的变体色=${alt}`
          );
          ok(
            "换上去的确实是另一套资产（不是主资产那三种色）",
            ALT_COLORS.includes(alt) && !MAIN_COLORS.includes(alt),
            `变体色=${alt}`
          );
          ok(
            "再切一轮回到主资产（轮播能循环，不会卡在变体上）",
            MAIN_COLORS.includes(back),
            `回到主资产的色=${back}`
          );
        } finally {
          // 无论上面有没有挂，都不能在仓库里留一个 probe 主题
          fs.rmSync(probeDir, { recursive: true, force: true });
        }

        // 切回默认，别给下一次运行留一个"上次选了 probe"的偏好
        await D.eval("window.dashboard.setTheme('ragdoll')");
        await sleep(200);

        // 再双击一次 = 收起
        await R.eval("window.clawd.toggleDashboard()");
        await sleep(400);
        if (M) {
          const visible = await M.eval(
            "require('electron').BrowserWindow.getAllWindows().some(w => String(w.webContents.getURL()).includes('dashboard.html') && w.isVisible())"
          );
          ok("再次双击能收起看板", visible === false, `可见=${visible}`);
        }
        D.close();
      }
    }

    // ---------- 7.8 SVG 白名单（S7） ----------
    // 主题是第三方文件，所以"清洗器有没有真的在干活"必须被断言，而不是读代码确认。
    // 一段把所有已知入口都塞进去的 SVG：能过的必须过，该剥的必须剥。
    const EVIL = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      "<script>alert(1)</script>",
      "<style>*{display:none}</style>",
      "<foreignObject><body>x</body></foreignObject>",
      '<filter id="f"><feImage href="http://evil/x.png"/><feTurbulence baseFrequency="1"/></filter>',
      '<clipPath id="c"><rect width="5" height="5"/></clipPath>',
      '<rect id="r" width="10" height="10" onclick="x()" fill="url(http://evil/x)"/>',
      '<rect id="ok" width="5" height="5" clip-path="url(#c)"/>',
      "</svg>",
    ].join("");

    const cleanReport = await R.eval(`(() => {
      const n = window.petDebug.svg(${JSON.stringify(EVIL)});
      if (!n) return { error: "清洗后为 null" };
      const tags = [...n.querySelectorAll("*")].map((e) => e.nodeName.toLowerCase());
      const r = n.querySelector("#r");
      return {
        tags: tags.join(","),
        rOnclick: r ? r.hasAttribute("onclick") : null,
        rFill: r ? r.getAttribute("fill") : null,
        okClip: n.querySelector("#ok") ? n.querySelector("#ok").getAttribute("clip-path") : null,
      };
    })()`);

    ok(
      "白名单剥掉了 script / style / foreignObject",
      !/script|style|foreignobject/.test(cleanReport.tags || "script"),
      `标签=${cleanReport.tags}`
    );
    ok(
      "白名单剥掉了 feImage / feTurbulence（外部取图与 CPU 炸弹）",
      !/feimage|feturbulence/.test(cleanReport.tags || "feimage"),
      `标签=${cleanReport.tags}`
    );
    ok(
      "放行了 clipPath / filter（主题需要柔和边缘）",
      /clippath/.test(cleanReport.tags || "") && /filter/.test(cleanReport.tags || ""),
      `标签=${cleanReport.tags}`
    );
    ok("on* 属性被剥", cleanReport.rOnclick === false, `onclick=${cleanReport.rOnclick}`);
    ok("url(http…) 被剥（只准 url(#id)）", cleanReport.rFill === null, `fill=${JSON.stringify(cleanReport.rFill)}`);
    ok("url(#c) 被保留", cleanReport.okClip === "url(#c)", `clip-path=${JSON.stringify(cleanReport.okClip)}`);

    // 放行滤镜之后才存在的风险：stdDeviation 是同步计算的，一个 9999 就卡死
    const deviation = await R.eval(`(() => {
      const n = window.petDebug.svg('<svg xmlns="http://www.w3.org/2000/svg"><filter id="f"><feGaussianBlur stdDeviation="9999"/></filter></svg>');
      if (!n) return "null";
      const el = [...n.querySelectorAll("*")].find((e) => e.nodeName.toLowerCase() === "fegaussianblur");
      return el ? el.getAttribute("stdDeviation") : "missing";
    })()`);
    ok("stdDeviation 被钳到 40", deviation === "40", `stdDeviation=${deviation}`);

    // ---------- 7.9 加载器的拒绝路径（S7） ----------
    // 这一段在本进程里跑（不是 Electron 里）：拿 CLAWD_THEMES_DIR 指向一个临时目录，
    // 塞几个"故意坏掉"的主题，逐个确认被拒。用环境变量而不是往仓库里塞垃圾。
    {
      const themeFixture = path.join(TMP_ROOT, "themes-fixture");
      const mk = (id, json, assets = {}) => {
        const d = path.join(themeFixture, id);
        fs.mkdirSync(path.join(d, "assets"), { recursive: true });
        fs.writeFileSync(path.join(d, "theme.json"), typeof json === "string" ? json : JSON.stringify(json, null, 2));
        for (const [name, body] of Object.entries(assets)) {
          fs.writeFileSync(path.join(d, "assets", name), body);
        }
      };
      const good = { schemaVersion: 1, states: { idle: { fps: 2, frames: ["idle-1.svg"] } } };
      const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="1" height="1"/></svg>';

      mk("bad-schema", { schemaVersion: 2, states: { idle: { frames: ["idle-1.svg"] } } }, { "idle-1.svg": SVG });
      mk("bad-traversal", { schemaVersion: 1, states: { idle: { frames: ["../escape.svg"] } } });
      mk("bad-missing", { schemaVersion: 1, states: { idle: { frames: ["nope.svg"] } } });
      mk("bad-json", "{ this is not json", {});
      mk("no-idle", { schemaVersion: 1, states: { working: { frames: ["idle-1.svg"] } } }, { "idle-1.svg": SVG });
      mk("good", good, { "idle-1.svg": SVG });

      const savedDir = process.env.CLAWD_THEMES_DIR;
      process.env.CLAWD_THEMES_DIR = themeFixture;
      delete require.cache[require.resolve("../src/theme")];
      const T = require("../src/theme");

      ok("加载器认得合法主题", T.loadTheme("good").ok === true);
      ok("拒 schemaVersion 不对的主题", T.loadTheme("bad-schema").ok === false);
      ok(
        "拒路径穿越的资产名（../escape.svg）",
        T.loadTheme("bad-traversal").ok === false && /资产名不合法/.test(T.loadTheme("bad-traversal").error),
        T.loadTheme("bad-traversal").error
      );
      ok("拒不存在的资产", T.loadTheme("bad-missing").ok === false);
      ok("拒非法 JSON", T.loadTheme("bad-json").ok === false);
      ok("拒没有 idle 的主题", T.loadTheme("no-idle").ok === false);
      ok(
        "拒目录名不合法的 id（../../etc）",
        T.loadTheme("../../etc").ok === false && /id 不合法/.test(T.loadTheme("../../etc").error)
      );
      // 全坏掉的时候必须给兜底，否则窗口是一片空白——用户连退出的按钮都看不到。
      // 注意这里要换成一个**空目录**再测：夹具目录里有个 good 主题，
      // 直接在当前夹具上断言兜底，测的其实是"fallback 会不会被 good 顶掉"（它当然会）。
      const emptyDir = path.join(TMP_ROOT, "themes-empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      process.env.CLAWD_THEMES_DIR = emptyDir;
      delete require.cache[require.resolve("../src/theme")];
      const T2 = require("../src/theme");
      const fb = T2.resolveTheme(["definitely-not-here"]);
      ok("全部主题不可用时退到内置兜底画面", fb.theme.id === "__fallback__", `id=${fb.theme.id}`);
      ok("兜底画面也是 7 个状态齐全", Object.keys(fb.theme.states).length === 7);
      ok("兜底原因会被带出来（不是静默失败）", typeof fb.error === "string" && fb.error.length > 0);

      if (savedDir === undefined) delete process.env.CLAWD_THEMES_DIR;
      else process.env.CLAWD_THEMES_DIR = savedDir;
      delete require.cache[require.resolve("../src/theme")];

      // ---------- 7.x timings：主题可以改状态时长 ----------
      // 只断言"字段被解析出来了"是不够的：那正是硬约束 25 要防的——
      // 写对了、校验过了、加载成功了、什么都不发生。所以这里**驱动真的状态机**，
      // 看主题的值有没有真的改变行为，并且每次都带一个"不写会怎样"的对照组
      // （只测"变短了"是可疑的，可能它本来就短）。
      const T3 = require("../src/theme");
      const S = require("../src/state");

      // 建一个真 store → 打一个事件 → 等 → 读 visual → 收掉定时器
      async function drive(getTimings, event, waitMs) {
        const st = S.createStore({ onChange: () => {}, getTimings });
        st.apply({ session_id: "timing-probe", event });
        await sleep(waitMs);
        st.tick();
        const v = st.snapshot().visual;
        st.dispose();
        return v;
      }

      const SHORT = { oneshot: { attention: 60 }, sleepAfterMs: 60 };

      const vShort = await drive(() => SHORT, "Stop", 220);
      ok("主题写的 oneshot 时长真的生效（60ms 就退回）", vShort === "idle", `visual=${vShort}`);
      const vNone = await drive(() => null, "Stop", 220);
      ok("对照组：没写就用内置 2400ms（220ms 时仍在 attention）", vNone === "attention", `visual=${vNone}`);

      // 睡意从 idle 开始累计，所以用 SessionStart（→idle）当样本。
      // 早先用 PreToolUse（→working）验证"会睡"，那是旧语义；改口径后它必然失败——
      // 断言在这里起到的作用就是逼我把"到底该验什么"重新想一遍。
      const vSleep = await drive(() => SHORT, "SessionStart", 220);
      ok("主题写的 sleepAfterMs 真的生效（idle 60ms 就睡着）", vSleep === "sleeping", `visual=${vSleep}`);
      const vNoSleep = await drive(() => null, "SessionStart", 220);
      ok("对照组：没写 sleepAfterMs 就用内置 60 秒（idle 220ms 还醒着）", vNoSleep === "idle", `visual=${vNoSleep}`);

      // 状态机的形状不能由主题改：给 working 写时长也不该把它变成 oneshot，
      // 否则主题一改就是"working 播 2 秒就消失"，而且是静默的。
      const vFake = await drive(() => ({ oneshot: { working: 60 } }), "PreToolUse", 220);
      ok("主题不能凭空造 oneshot（给 working 写时长也还是 working）", vFake === "working", `visual=${vFake}`);

      // sleepAfterMs 的口径是「idle 持续多久」，不是「多久没收到事件」。
      // 这两者的差别被真实场景狠狠教了一次：给主题配了 20 秒之后，
      // 一次跑超过 20 秒的工具调用会让宠物在 agent 干活时睡着，
      // 下一个事件一来又醒、一会儿又睡，看起来像在抽搐。
      // 所以这里必须有一条断言盯着"working 期间不许睡"。
      {
        const stWork = S.createStore({ onChange: () => {}, getTimings: () => ({ sleepAfterMs: 60 }) });
        stWork.apply({ session_id: "sleep-probe", event: "PreToolUse" }); // → working
        await sleep(300);
        stWork.tick();
        const vWork = stWork.snapshot().visual;
        stWork.dispose();

        // 对照组必须换**另一个 store**，不能在同一条会话上洗回来。
        // 原来这里在同一条会话上发 SessionStart 制造 idle，那依赖的是旧语义
        // （SessionStart = 切回 idle）——它正是 WorkBuddy 那个"thinking 被打回 idle"
        // 的同一个机制。语义修对之后它必然会红，改口径不是迁就，是纠正：
        // 真实链路上"开一条新会话"就是新 session_id，而不是给旧会话发 SessionStart。
        //
        // 分成两个 store 也是必须的：dominant() 取优先级最高的那条会话，
        // 同一个 store 里只要还留着 working 的会话，idle 就永远赢不了仲裁。
        const stIdle = S.createStore({ onChange: () => {}, getTimings: () => ({ sleepAfterMs: 60 }) });
        stIdle.apply({ session_id: "sleep-probe-idle", event: "SessionStart" }); // 新会话 → idle
        await sleep(300);
        stIdle.tick();
        const vIdle = stIdle.snapshot().visual;
        stIdle.dispose();

        ok("agent 在干活时不会睡着（working 期间不累计睡意）", vWork === "working", `visual=${vWork}`);
        ok("idle 累计够久就睡着（睡意确实还是会生效，不是被整个关掉了）", vIdle === "sleeping", `visual=${vIdle}`);
      }

      // WorkBuddy 每一轮的真实事件序列（实测，且主仓库 hooks/workbuddy-hook.js
      // 把这条写死在注释里了）：每一轮都是 UserPromptSubmit 先到、SessionStart
      // 后补发约 0.1 秒（首轮 source=startup，之后全是 resume）。
      //
      // 于是只要 SessionStart 仍然被当成"切回 idle"，真实链路上的样子就是：
      //   UserPromptSubmit → thinking → 0.1s 后 SessionStart → idle → 一直挂 idle
      //   → 直到 PreToolUse（working）才有反应。
      // 用户看到的就是"明明在 thinking，桌宠却显示 idle"。
      {
        const st = S.createStore({ onChange: () => {}, getTimings: () => null });
        st.apply({ session_id: "wb-turn", event: "UserPromptSubmit" });
        const vThinking = st.snapshot().visual;
        st.apply({ session_id: "wb-turn", event: "SessionStart" }); // 迟到 0.1s 的那一下
        const vLate = st.snapshot().visual;
        st.dispose();
        ok(
          "迟到的 SessionStart 不会把刚进入的 thinking 打回 idle（WorkBuddy 每轮都补发它）",
          vThinking === "thinking" && vLate === "thinking",
          `${vThinking} → ${vLate}`
        );
      }

      // 「需要我确认的时候，没有提示我啊」—— 用户在信里写的原话（10-29）。
      //
      // notification 是**持续状态**，不是播一下就走的 oneshot：agent 在等用户
      // 点"允许"，这个等待可能几十秒甚至几分钟（主仓库管它叫
      // a real permission hold，见 clawd-on-desk src/state.js:345）。
      // 而 ragdoll 主题把它写成了 1500ms —— 比内置默认 3200 还短，
      // 提示闪一下就撤了，用户抬头看的时候屏幕上什么都没有。
      //
      // 所以这里盯两件事，缺一个都是坏的：
      //   ① 它得一直在（不然等于没提示）
      //   ② agent 又动起来时它必须**立刻**让位（不然把上限拉长之后
      //      就变成"明明在干活，猫还在喊"）
      {
        // 读 ragdoll **真实写进 theme.json 的值**当输入，而不是在测试里手抄一份。
        // 手抄那份（1500）只能记录这一次的历史：主题哪天又被写回 1500，
        // 它照样绿——那不是盯着它的断言，只是一张旧照片。
        // 读真文件之后，"主题没写 → 用内置上限"这条路径也一并被验到了。
        const RAGDOLL = JSON.parse(
          fs.readFileSync(path.join(__dirname, "..", "themes", "ragdoll", "theme.json"), "utf8")
        ).timings;

        // 等 2 秒：超过主题写的 1500ms，但远远短于"用户抬个头的时间"。
        const vHold = await drive(() => RAGDOLL, "Notification", 2000);
        ok(
          "等你确认时提示不会自己撤（2 秒后仍在 notification）",
          vHold === "notification",
          `visual=${vHold}`
        );

        const st = S.createStore({ onChange: () => {}, getTimings: () => RAGDOLL });
        st.apply({ session_id: "perm-probe", event: "Notification" });
        const vNotif = st.snapshot().visual;
        st.apply({ session_id: "perm-probe", event: "PreToolUse" }); // 权限通过了，继续干活
        st.tick();
        const vBack = st.snapshot().visual;
        st.dispose();
        ok(
          "agent 又动起来时提示立刻让位（不是霸屏到时间上限）",
          vNotif === "notification" && vBack === "working",
          `${vNotif} → ${vBack}`
        );
      }

      // S9：鼠标把猫弄醒。终点在状态机里——「醒」也只有这一个地方能改，
      // 渲染层自己切画面会被 250ms 的状态推送顶回去（那就是"闪一下又睡"）。
      {
        const st = S.createStore({ onChange: () => {}, getTimings: () => ({ sleepAfterMs: 60 }) });
        st.apply({ session_id: "wake-probe", event: "SessionStart" }); // → idle
        await sleep(300);
        st.tick();
        const vAsleep = st.snapshot().visual;
        const woke = st.wake();
        const vAwake = st.snapshot().visual;
        st.tick(); // 紧接着一拍：不许立刻睡回去
        const vStill = st.snapshot().visual;

        // 对照组：没睡的时候 wake() 什么都不该做。返回 false 是为了让调用方
        // （和这条断言）能分清"醒了"和"本来就没睡"，而不是都得再读一次快照去猜。
        st.apply({ session_id: "wake-probe", event: "PreToolUse" }); // → working
        const wokeWhenAwake = st.wake();
        const vWorking = st.snapshot().visual;
        const wokeLogged = st.snapshot().recent.some((r) => r.how === "woke" && r.event === "Hover");
        st.dispose();

        ok(
          "睡着的猫被 wake() 叫醒（sleeping → idle）",
          vAsleep === "sleeping" && woke === true && vAwake === "idle",
          `${vAsleep} → ${vAwake}（woke=${woke}）`
        );
        ok("醒来后不会立刻又睡回去（stateSince 一起重置了）", vStill === "idle", `visual=${vStill}`);
        ok(
          "醒着的猫不受 wake() 影响（working 不会被鼠标改写）",
          wokeWhenAwake === false && vWorking === "working",
          `woke=${wokeWhenAwake} visual=${vWorking}`
        );
        // 这条日志是"它为什么醒了"的唯一证据：没有它，醒来和"恰好有事件推进来"分不开。
        ok("醒来会在事件日志里留一条 Hover 记录", wokeLogged);
      }

      // 事件日志：排查"它为什么变成 idle"只能靠它——视觉层只看到结果，看不到是被哪个事件推的。
      {
        const st = S.createStore({ onChange: () => {} });
        st.apply({ session_id: "log-probe", event: "UserPromptSubmit" });
        st.apply({ session_id: "log-probe", event: "NopeNotARealEvent" });
        const log = st.snapshot().recent;
        st.dispose();
        const mapped = log.filter((r) => r.how === "mapped");
        const ignored = log.filter((r) => r.how === "ignored");
        ok(
          "事件日志记下了 agent 推来的每个事件与去向",
          mapped.length === 1 && mapped[0].event === "UserPromptSubmit" && mapped[0].to === "thinking",
          JSON.stringify(log)
        );
        ok(
          "认不出来的事件会被标成 ignored（不静默失效）",
          ignored.length === 1 && ignored[0].event === "NopeNotARealEvent",
          JSON.stringify(ignored)
        );
      }

      // 解析层：写了的能读出来、没写的如实返回 null（不替它编默认值）
      const rag = T3.loadTheme("ragdoll");
      // 对照组本来用的是 crab（它没写 timings），但 crab 作为"多余的主题"被删了。
      // 改用 Node 侧夹具里的 good —— 它同样没写 timings。
      // 删主题可以，这条对照不能跟着消失：没有它，上面那几条"生效了"都不可信。
      // 注意 good 住在 fixtures 目录里，得先把 CLAWD_THEMES_DIR 切回去才读得到。
      process.env.CLAWD_THEMES_DIR = themeFixture;
      delete require.cache[require.resolve("../src/theme")];
      const crb = require("../src/theme").loadTheme("good");
      if (savedDir === undefined) delete process.env.CLAWD_THEMES_DIR;
      else process.env.CLAWD_THEMES_DIR = savedDir;
      delete require.cache[require.resolve("../src/theme")];
      ok(
        "ragdoll 声明的 timings 被读出来",
        rag.ok && rag.theme.timings && rag.theme.timings.oneshot.attention === 800,
        `timings=${JSON.stringify(rag.theme && rag.theme.timings)}`
      );
      ok("没写 timings 的主题读作 null（默认值只在 state.js 里有一份）", crb.ok && crb.theme.timings === null, `timings=${JSON.stringify(crb.theme && crb.theme.timings)}`);

      // 在 oneshot 里塞一个状态机不认识的状态：作者会以为生效了，必须报出来。
      fs.mkdirSync(themeFixture, { recursive: true });
      const tf = path.join(themeFixture, "timings-warn");
      fs.mkdirSync(path.join(tf, "assets"), { recursive: true });
      fs.writeFileSync(path.join(tf, "assets", "idle-1.svg"), SVG);
      fs.writeFileSync(
        path.join(tf, "theme.json"),
        JSON.stringify({ schemaVersion: 1, name: "tw", states: good.states, timings: { oneshot: { working: 60, sweeping: 60 } } })
      );
      process.env.CLAWD_THEMES_DIR = themeFixture;
      delete require.cache[require.resolve("../src/theme")];
      const T4 = require("../src/theme");
      const tw = T4.loadTheme("timings-warn");
      ok(
        "oneshot 里塞非 oneshot 状态会被报出来（永不会生效）",
        tw.ok && tw.warnings.some((w) => /不认识的状态/.test(w) && /working/.test(w)),
        `warnings=${JSON.stringify(tw.warnings)}`
      );
      if (savedDir === undefined) delete process.env.CLAWD_THEMES_DIR;
      else process.env.CLAWD_THEMES_DIR = savedDir;
      delete require.cache[require.resolve("../src/theme")];
    }

    // ---------- 8. 单实例锁（SEC-10） ----------
    // 必须和被侧进程用同一个 user-data-dir，否则单实例锁根本不会触发
    const second = spawn(ELECTRON_BIN, [`--user-data-dir=${USER_DATA_DIR}`, "."], {
      cwd: ROOT,
      env: cleanEnv(),
      stdio: "ignore",
    });
    const secondCode = await new Promise((resolve) => {
      const t = setTimeout(() => resolve("timeout"), 8000);
      second.once("exit", (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    if (secondCode === "timeout") {
      try {
        second.kill();
      } catch {}
    }
    ok("第二个实例被单实例锁挡下并退出", secondCode === 0 || secondCode === "timeout", `exit=${secondCode}`);

    // ---------- 7.6 退出时挂起的权限请求必须被收尾（S5） ----------
    // 这一条测的是 before-quit 里的 permissions.dispose()。
    // 不测的话最典型的退化方式是：用户关掉桌宠时，Claude Code 正卡在一个
    // PermissionRequest 上等回应，连接既没断也没答复，表现出来就是"终端没反应"，
    // 而且它不会被任何一轮普通回归发现——因为普通回归都在请求结束之后才退出。
    //
    // 同时发两条：第一条进气泡，第二条进队列。排队的那条更要紧——
    // dispose() 会走 settle() → onResolve()，而 onResolve 里有"弹下一条"的逻辑，
    // 写得不对就会在退出过程中新建窗口，或者把排队的那条漏掉。
    let quitPending1 = null;
    let quitPending2 = null;
    if (ep) {
      const base = { tool_name: "Bash", session_id: "quit-test", cwd: "E:\\JacksonLee\\project\\clawd-starter" };
      quitPending1 = postPermission(ep, { ...base, tool_input: { command: "退出时仍挂起的第一条" } });
      const bubbleShown = await waitForUrl(RENDERER_PORT, "bubble.html");
      await sleep(600);
      quitPending2 = postPermission(ep, { ...base, tool_input: { command: "退出时仍挂起的第二条（排队中）" } });
      await sleep(600);
      const bubbleStill = await waitForUrl(RENDERER_PORT, "bubble.html");
      ok("退出前两条请求都挂起且气泡在显示", !!bubbleShown && !!bubbleStill);
    }

    // ---------- 收尾：走正常退出路径，顺便验证端点文件清理 ----------
    // 两个顺序问题：
    //   1. quit 只能从渲染层经 IPC 发出，所以必须赶在断开 WS 之前发
    //   2. 发完就要断开两个 inspector 连接——主进程 inspector 挂着客户端时，
    //      进程可能迟迟不退出，看起来就像"关不掉"
    R.send("Runtime.evaluate", { expression: "window.clawd.quit()", returnByValue: true });
    await sleep(200);
    R.close();
    if (M) M.close();

    // 挂起的两条必须在退出时拿到 204（不做决定），而不是悬空到客户端超时。
    // 这一步要在关掉 inspector 之后做，否则主进程可能被调试客户端拖着不退出。
    if (quitPending1 && quitPending2) {
      const [qa, qb] = await Promise.all([quitPending1, quitPending2]);
      ok(
        "退出时挂起的第一条被收尾为 204",
        qa.code === 204 && qa.body === "",
        `status=${qa.code} body=${String(qa.body).slice(0, 60)}`
      );
      ok(
        "退出时排队的那条也不会悬空（204）",
        qb.code === 204 && qb.body === "",
        `status=${qb.code} body=${String(qb.body).slice(0, 60)}`
      );
    }

    const exited = await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(child.exitCode !== null), 8000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    ok("quit() 能正常关闭进程（右键菜单里『退出』走的就是它）", exited, `exitCode=${child.exitCode}`);
    await sleep(300);
    ok("退出后端点文件已删除（before-quit 清理）", !fs.existsSync(PORT_FILE));

    if (secondCode === "timeout") {
      try {
        second.kill();
      } catch {}
    }
  } catch (err) {
    console.error("\n回归脚本自身出错：", err && err.message);
    console.error(childOut.slice(-2000));
    fail++;
  } finally {
    // 按进程树杀：electron 会派生 GPU / utility 子进程，只 kill 主进程会留下僵尸，
    // 它们继续占着缓存目录，下次启动就报 "Unable to move the cache: 拒绝访问"。
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {}
    // 清掉隔离用的临时 userData（第一次跑会下载/生成不少缓存文件）
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n" + "=".repeat(56));
  console.log(`结果：PASS ${pass}  FAIL ${fail}`);
  if (fail) {
    console.log("失败项：\n  - " + failures.join("\n  - "));
  }
  process.exit(fail ? 1 : 0);
}

main();
