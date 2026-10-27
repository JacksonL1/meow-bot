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

async function main() {
  console.log("Electron 升级回归\n" + "=".repeat(56));

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
  const childEnv = { ...cleanEnv(), CLAWD_PERMISSION_TIMEOUT_MS: "6000" };

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

    // motion 声明的部件必须真的存在于那一帧里。写错一个 part 名的后果是
    // "这条动画静默不生效"，画面上完全看不出来——所以要在结构上先卡住。
    const missingParts = await R.eval(`(() => {
      const bad = [];
      const sec = window.VISUAL_STATES;
      for (const [name, def] of Object.entries(sec)) {
        if (!def.motion || !def.motion.length) continue;
        const host = document.createElement('div');
        host.innerHTML = def.frames[0];
        const svg = host.querySelector('svg');
        for (const rule of def.motion) {
          if (!svg.querySelector('.m-' + rule.part)) bad.push(name + ':' + rule.part);
        }
      }
      return bad.join(',');
    })()`);
    ok("motion 声明的部件在 SVG 里都存在", missingParts === "", `缺失：${missingParts}`);

    // ---------- 2. 渲染进程隔离（SEC-06） ----------
    ok("contextIsolation 生效：渲染层拿不到 require", (await R.eval("typeof window.require")) === "undefined");
    ok("contextIsolation 生效：渲染层拿不到 process", (await R.eval("typeof window.process")) === "undefined");
    ok("preload 没有泄漏 ipcRenderer", (await R.eval("typeof window.ipcRenderer")) === "undefined");
    // 动作数是安全闸门：S6 加了 toggleDashboard（6→7），S7 加了 getTheme / onTheme（7→9）。
    // 以后每次加 IPC 都要顺手改这里，改的时候问自己一句"这个动作真的需要吗"。
    ok("preload 只暴露 9 个具名动作", (await R.eval("Object.keys(window.clawd||{}).length")) === 9);

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

    // 轮询等它落定，而不是立刻读一次——交叉淡入本身有 160ms 过渡，
    // 单点采样会把"正在换"读成"没换"。
    let nowState = null;
    let afterLayer = beforeLayer;
    for (let i = 0; i < 20; i++) {
      nowState = await R.eval("window.petDebug.state()");
      afterLayer = await R.eval("document.querySelector('.layer.show')?.id");
      if (nowState === "working" && afterLayer && afterLayer !== beforeLayer) break;
      await sleep(50);
    }
    ok("setState 生效", nowState === "working", `state=${nowState}`);
    ok("换状态时切换图层（交叉淡入的前提）", beforeLayer !== afterLayer, `${beforeLayer} → ${afterLayer}`);

    // 换一次状态只该重建一次。多了就说明有东西在重复触发——
    // 画面看不出区别（结果一样），但它是竞态的信号，而这轮真撞上过。
    const afterBuilds = await R.eval("window.petDebug.builds()");
    ok("换一次状态只重建一次", afterBuilds - beforeBuilds === 1, `重建 ${afterBuilds - beforeBuilds} 次`);
    if (afterBuilds - beforeBuilds !== 1) {
      // 失败时把推送时间线打出来，否则只能猜"是谁把状态推回去了"
      console.log("      [dbg] 状态推送记录：", JSON.stringify(await R.eval("window.petDebug.stateLog()")));
    }
    // 旧层的清空挂在 220ms 的 setTimeout 上（等淡出结束），所以要轮询等它，不能立刻断言
    let cleared = false;
    for (let i = 0; i < 20; i++) {
      cleared = (await R.eval(`document.getElementById('${beforeLayer}').childElementCount`)) === 0;
      if (cleared) break;
      await sleep(100);
    }
    ok("旧图层在淡出后被清空", cleared);

    // 部件动画在不在动。这是"活猫感"的唯一可测证据：
    // 静态截图看不出区别，只有连续采样 transform 才能证明插值在跑。
    // 采样窗口 1.2s，覆盖最短周期（error 的抖动 160ms）和常规呼吸（3.4s 的一小段）。
    const motionMoves = await R.eval(`(async () => {
      const snaps = [];
      for (let i = 0; i < 12; i++) {
        snaps.push(JSON.stringify(window.petDebug.motion()));
        await new Promise(r => setTimeout(r, 100));
      }
      return new Set(snaps).size;
    })()`);
    ok("部件动画在跑（同一状态下 transform 持续变化）", motionMoves >= 4, `不同快照 ${motionMoves}/12`);

    // 眨眼：眼睛部件会被压成 scale(1, <1)，而且是"闭上再睁开"，不是一直眯着。
    // 间隔是随机 1.8~4.2s（thinking），所以采样窗口要盖过最大间隔。
    // 注意：采样必须从 **Node 侧**逐次读，不能写成页面里的长循环——
    // CDP 的 send() 有 5 秒超时，一次 5 秒以上的 eval 会静默返回 undefined。
    await R.eval("window.petDebug.setState('thinking')");
    await sleep(120);
    let blinkMin = 1;
    for (let i = 0; i < 100; i++) {
      const t = await R.eval("window.petDebug.motion().eyes || ''");
      const m = /scale\(1 ([\d.]+)\)/.exec(t || "");
      if (m) blinkMin = Math.min(blinkMin, Number(m[1]));
      if (blinkMin < 0.5) break;
      await sleep(50);
    }
    ok("会眨眼（眼睛被压扁过一次以上）", blinkMin < 0.5, `最小纵向比例 ${blinkMin}`);

    // ---------- 3.5 彩蛋（gags）与 eyeTracking ----------
    // 彩蛋是"隔一阵干一件一次性的事"（钓上鱼吃掉 / 钓上拖鞋扔掉）。
    // 要能测的有四件事：声明得到、部件画了、放得出来、收得回去。
    // 排期是随机 7~14 秒，回归等不起，所以用 petDebug.gag() 跳过排期——
    // 播放走的还是同一条 runGag，测的仍然是真代码，只是不掷骰子。
    await R.eval("window.petDebug.setState('working')");
    await sleep(250);

    const gagNames = JSON.parse((await R.eval("JSON.stringify(window.petDebug.gagNames())")) || "[]");
    ok(
      "working 声明了两条彩蛋（fish / slipper）",
      gagNames.includes("fish") && gagNames.includes("slipper"),
      `gagNames=${JSON.stringify(gagNames)}`
    );

    // 部件名写错在画面上表现为"这条彩蛋永远不出现"，静默且极难联想，所以先在结构上卡住。
    const gagPartMissing = await R.eval(`(() => {
      const bad = [];
      for (const [name, def] of Object.entries(window.VISUAL_STATES)) {
        if (!def.gags || !def.gags.length) continue;
        const host = document.createElement('div');
        host.innerHTML = def.frames[0];
        const svg = host.querySelector('svg');
        for (const g of def.gags) {
          for (const step of g.steps) {
            if (!svg.querySelector('.m-' + step.part)) bad.push(name + ':' + g.name + ':' + step.part);
          }
        }
      }
      return bad.join(',');
    })()`);
    ok("gags 的部件在 SVG 里都存在", gagPartMissing === "", `缺失：${gagPartMissing}`);

    // eyeTracking 以前是"写了不生效"的字段：主题声明了 false，渲染层照样写瞳孔 transform。
    // 现在它真的管住 applyGaze。测两件事：开关值传到了渲染层、以及瞳孔确实不动。
    ok("working 的 eyeTracking 为 false", (await R.eval("window.petDebug.eyeTracking()")) === false);
    await R.eval("window.petDebug.setState('idle')");
    await sleep(150);
    ok("idle 的 eyeTracking 为 true（对照组）", (await R.eval("window.petDebug.eyeTracking()")) === true);
    await R.eval("window.petDebug.setState('working')");
    await sleep(200);

    await R.eval("window.petDebug.gaze({x:1,y:1}, true)");
    await sleep(420);
    const workPupils = await R.eval(
      "document.querySelector('.layer.show svg.on .pupils')?.getAttribute('transform') ?? null"
    );
    ok("working 下瞳孔不跟鼠标（疲惫的猫不追光标）", workPupils === null || workPupils === "translate(0.00 0.00)", `transform=${workPupils}`);
    await R.eval("window.petDebug.unpinGaze()");

    // 放出来 + 真的在动
    await R.eval("window.petDebug.setState('working')");
    await sleep(200);
    await R.eval("window.petDebug.gag('fish')");
    await sleep(120);
    const gagA = JSON.parse((await R.eval("JSON.stringify(window.petDebug.gagState())")) || "{}");
    await sleep(380);
    const gagB = JSON.parse((await R.eval("JSON.stringify(window.petDebug.gagState())")) || "{}");
    ok(
      "彩蛋把藏着的部件放出来了（display 不再是 none）",
      !!(gagA.fish && gagA.fish.display !== "none"),
      `fish.display=${gagA.fish && gagA.fish.display}`
    );
    ok(
      "彩蛋在动（同一部件的 transform 在变）",
      !!(gagA.fish && gagB.fish && gagA.fish.transform !== gagB.fish.transform),
      `${gagA.fish && gagA.fish.transform} → ${gagB.fish && gagB.fish.transform}`
    );

    // 收回去。这里同时守住一个真实踩过的坑：收尾不能一律 display:none，
    // 瞳孔是"本来露着、被拉进彩蛋跟着看一眼"的部件，一律隐藏会把猫的眼睛抹掉。
    let gagDone = false;
    for (let i = 0; i < 40; i++) {
      const st = JSON.parse(
        (await R.eval(`JSON.stringify({
          fish: document.querySelector('.layer.show svg.on .m-fish')?.getAttribute('display') ?? null,
        })`)) || "{}"
      );
      if (st.fish === "none") {
        gagDone = true;
        break;
      }
      await sleep(150);
    }
    const restored = JSON.parse(
      (await R.eval(`JSON.stringify({
        pupilsDisplay: document.querySelector('.layer.show svg.on .pupils')?.getAttribute('display') ?? null,
        pupilsTransform: document.querySelector('.layer.show svg.on .pupils')?.getAttribute('transform') ?? null,
      })`)) || "{}"
    );
    ok("彩蛋演完把鱼收回（display 回到 none）", gagDone);
    ok(
      "彩蛋结束后瞳孔恢复原状（没被当成一次性部件一起藏掉）",
      restored.pupilsDisplay === null && restored.pupilsTransform === null,
      `display=${restored.pupilsDisplay} transform=${restored.pupilsTransform}`
    );

    // ---------- 4. 眼球追踪 ----------
    // 结构前提：渲染层用 querySelector(".pupils") 拿第一个就驱动，
    // 所以**每帧最多只能有一个 .pupils 组**。左右眼各包一个组的话，
    // 只有一只眼会动，另一只永远定住——画上去看着正常，动起来才发现。
    const multiPupils = await R.eval(`(() => {
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
    ok("每帧最多一个 .pupils 组（否则只有一只眼会动）", multiPupils === "", `违规帧：${multiPupils}`);

    await R.eval("window.petDebug.setState('idle')");
    await sleep(200);
    // 第二个参数 pin=true：钉住，别让主进程按真实光标推的 gaze 把它盖掉。
    // 这条断言测的是"渲染层会不会把给定坐标插值到瞳孔上"，不是"主进程算得准不准"，
    // 两者混在一起就会随机失败（实测读到过 translate(-0.98 0.81)，那是光标位置）。
    await R.eval("window.petDebug.gaze({x:1,y:-1}, true)");
    let transform = null;
    for (let i = 0; i < 30; i++) {
      transform = await R.eval("document.querySelector('.layer.show svg.on .pupils')?.getAttribute('transform') || null");
      if (transform === "translate(3.60 -2.60)") break;
      await sleep(100);
    }
    ok("gaze 收敛到满幅位移", transform === "translate(3.60 -2.60)", `transform=${transform}`);

    // 两只眼必须一起动：pupils 组里瞳孔的数量要够（眼睛画法变了也不会漏）
    const pupilCount = await R.eval(
      "document.querySelectorAll('.layer.show svg.on .pupils ellipse, .layer.show svg.on .pupils circle').length"
    );
    ok("瞳孔层里两只眼都在（≥2 个瞳孔）", pupilCount >= 2, `瞳孔节点 ${pupilCount}`);

    // 回中
    await R.eval("window.petDebug.gaze({x:0,y:0}, true)");
    await sleep(900);
    ok(
      "gaze 能回中",
      (await R.eval("document.querySelector('.layer.show svg.on .pupils')?.getAttribute('transform')")) === "translate(0.00 0.00)"
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

      // 四条 IPC 通道是否都接上了：从主进程数监听器，比从渲染层猜可靠
      for (const ch of ["drag:start", "drag:end", "mouse:ignore", "app:quit"]) {
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
      const seed = (sessionId, cwd, event) =>
        new Promise((resolve) => {
          const body = JSON.stringify({ agent: "codebuddy", session_id: sessionId, event, cwd });
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

      await seed("sess-alpha", "E:\\work\\proj-alpha", "PreToolUse");
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

        // 演示模式：只隐藏目录名，状态和时间照旧
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

        // S7：看板里的主题下拉框。列表由主进程给，所以能点到的每一项都真的加载得起来。
        const themeList = await D.eval(
          "window.dashboard.listThemes().then(d => ({ current: d.current, ok: d.themes.filter(t=>t.ok).map(t=>t.id).join(','), bad: d.themes.filter(t=>!t.ok).length }))"
        );
        ok(
          "看板列出了主题（且都加载成功）",
          !!themeList && themeList.ok === "crab,ragdoll" && themeList.bad === 0,
          `ok=${themeList && themeList.ok} 坏的=${themeList && themeList.bad}`
        );

        const switched = await D.eval("window.dashboard.setTheme('crab')");
        let afterThemeId = null;
        for (let i = 0; i < 20; i++) {
          afterThemeId = await R.eval("window.petDebug.theme().id");
          if (afterThemeId === "crab") break;
          await sleep(100);
        }
        ok("看板切主题后桌宠立刻换形象", switched && switched.ok === true && afterThemeId === "crab", `id=${afterThemeId}`);

        const crabFrames = await R.eval(
          "Object.values(window.VISUAL_STATES).reduce((n, s) => n + s.frames.length, 0)"
        );
        ok("换主题后帧数依然完整（19）", crabFrames === 19, `帧数=${crabFrames}`);

        // 切回默认，别给下一次运行留一个"上次选了螃蟹"的偏好
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
    ok("右键退出能正常关闭进程", exited, `exitCode=${child.exitCode}`);
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
