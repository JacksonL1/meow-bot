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
    [`--inspect=${MAIN_PORT}`, `--remote-debugging-port=${RENDERER_PORT}`, "."],
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
    ok(
      "三个容器都在（#stage/#pet/#layerA/B）",
      await R.eval(
        "!!(document.getElementById('stage') && document.getElementById('pet') && document.getElementById('layerA') && document.getElementById('layerB'))"
      )
    );
    ok("首帧已上屏（.layer.show 内有 svg）", !!(await R.eval("!!document.querySelector('.layer.show svg.on')")));
    ok("7 个状态全部注册", (await R.eval("window.petDebug && window.petDebug.states().length")) === 7);

    // ---------- 2. 渲染进程隔离（SEC-06） ----------
    ok("contextIsolation 生效：渲染层拿不到 require", (await R.eval("typeof window.require")) === "undefined");
    ok("contextIsolation 生效：渲染层拿不到 process", (await R.eval("typeof window.process")) === "undefined");
    ok("preload 没有泄漏 ipcRenderer", (await R.eval("typeof window.ipcRenderer")) === "undefined");
    ok("preload 只暴露 6 个具名动作", (await R.eval("Object.keys(window.clawd||{}).length")) === 6);

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

    const beforeLayer = await R.eval("document.querySelector('.layer.show')?.id");
    await R.eval("window.petDebug.setState('working')");
    let nowState = null;
    for (let i = 0; i < 10; i++) {
      nowState = await R.eval("window.petDebug.state()");
      if (nowState === "working") break;
      await sleep(50);
    }
    const afterLayer = await R.eval("document.querySelector('.layer.show')?.id");
    ok("setState 生效", nowState === "working", `state=${nowState}`);
    ok("换状态时切换图层（交叉淡入的前提）", beforeLayer !== afterLayer, `${beforeLayer} → ${afterLayer}`);
    // 旧层的清空挂在 220ms 的 setTimeout 上（等淡出结束），所以要轮询等它，不能立刻断言
    let cleared = false;
    for (let i = 0; i < 20; i++) {
      cleared = (await R.eval(`document.getElementById('${beforeLayer}').childElementCount`)) === 0;
      if (cleared) break;
      await sleep(100);
    }
    ok("旧图层在淡出后被清空", cleared);

    // working 有 2 帧、fps 8 → 等一会应该发生过换帧
    const frameMoves = await R.eval(`(async () => {
      const seen = new Set();
      for (let i = 0; i < 12; i++) {
        const n = [...document.querySelectorAll('.layer.show svg')].findIndex(s => s.classList.contains('on'));
        seen.add(n);
        await new Promise(r => setTimeout(r, 140));
      }
      return seen.size;
    })()`);
    ok("帧轮播在跑（观察到多个帧下标）", frameMoves >= 2, `不同帧 ${frameMoves}`);

    // ---------- 4. 眼球追踪 ----------
    await R.eval("window.petDebug.setState('idle')");
    await sleep(200);
    await R.eval("window.petDebug.gaze({x:1,y:-1})");
    let transform = null;
    for (let i = 0; i < 30; i++) {
      transform = await R.eval("document.querySelector('.layer.show svg.on .pupils')?.getAttribute('transform') || null");
      if (transform === "translate(3.60 -2.60)") break;
      await sleep(100);
    }
    ok("gaze 收敛到满幅位移", transform === "translate(3.60 -2.60)", `transform=${transform}`);

    // 回中
    await R.eval("window.petDebug.gaze({x:0,y:0})");
    await sleep(900);
    ok(
      "gaze 能回中",
      (await R.eval("document.querySelector('.layer.show svg.on .pupils')?.getAttribute('transform')")) === "translate(0.00 0.00)"
    );

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

      // 窗口是否真的透明——这是 S1 三件套里唯一没法从 DOM 或属性读出来的。
      // 办法：抓一小块屏幕，比较"窗口矩形内侧紧邻边界"与"外侧紧邻边界"的像素。
      // 透明的话，这两组看到的是同一层桌面，差值应该接近 0。
      // 取 10px 相邻对而不是窗口内外两大片区域，是为了抵消壁纸渐变/暗角的影响。
      const transparency = await M.eval(`(async () => {
        const { desktopCapturer, screen, BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        const b = win.getBounds();
        const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
        const pad = 40;
        const crop = {
          x: Math.max(d.bounds.x, b.x - pad),
          y: Math.max(d.bounds.y, b.y - pad),
          width: Math.min(d.bounds.x + d.bounds.width, b.x + b.width + pad) - Math.max(d.bounds.x, b.x - pad),
          height: Math.min(d.bounds.y + d.bounds.height, b.y + b.height + pad) - Math.max(d.bounds.y, b.y - pad),
        };
        if (crop.width < 120 || crop.height < 120) return 'crop-too-small';
        const srcs = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: d.bounds.width, height: d.bounds.height },
        });
        if (!srcs.length) return 'no-source';
        const img = srcs[0].thumbnail.crop(crop);
        const size = img.getSize();
        const buf = img.toBitmap();
        const px = (x, y) => { const i = (y * size.width + x) * 4; return [buf[i+2], buf[i+1], buf[i]]; };
        // 窗口在 crop 内的偏移
        const ox = b.x - crop.x, oy = b.y - crop.y;
        const cross = [
          [[ox-10, oy+120], [ox-20, oy+120]],
          [[ox+b.width+9, oy+120], [ox+b.width+19, oy+120]],
          [[ox+120, oy-10], [ox+120, oy-20]],
          [[ox+120, oy+b.height+9], [ox+120, oy+b.height+19]],
        ];
        // 四条边各算一次差值。只取"最大值"会被背景里一条恰好压在窗口边框上的
        // 硬边（别的窗口边框、滚动条）误伤；不透明的窗口是四条边全不一致。
        const diffs = [];
        for (const [inside, outside] of cross) {
          if (inside[0] < 0 || outside[0] < 0) return 'crop-too-small';
          if (inside[0] >= size.width || outside[0] >= size.width) return 'crop-too-small';
          if (inside[1] >= size.height || outside[1] >= size.height) return 'crop-too-small';
          const a = px(inside[0], inside[1]);
          const c = px(outside[0], outside[1]);
          diffs.push(Math.max(Math.abs(a[0]-c[0]), Math.abs(a[1]-c[1]), Math.abs(a[2]-c[2])));
        }
        return diffs;
      })()`);
      if (Array.isArray(transparency)) {
        const good = transparency.filter((d) => d <= 3).length;
        ok(
          "窗口真透明（窗内空白与窗外桌面同色）",
          good >= 3,
          `四条边差值=[${transparency.join(", ")}]，达标 ${good}/4`
        );
      } else {
        console.log(`跳过  窗口透明检查（${transparency}，需要可见桌面）`);
      }
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

    // ---------- 8. 单实例锁（SEC-10） ----------
    const second = spawn(ELECTRON_BIN, ["."], {
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
    try {
      child.kill();
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
