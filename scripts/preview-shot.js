#!/usr/bin/env node
"use strict";
// 把 preview.html 渲染成一张 PNG，用于设计留档与"改坏了没"的目视对照。
//
// 为什么要单独写一个：桌宠窗口是 240×240 且透明的，直接截它看不出全貌；
// preview.html 是浅底 + 七状态同屏，一张图就能判断形象是否正常。
//
// 用法：
//   node scripts/preview-shot.js                 # 写到 docs/ragdoll-states.png
//   node scripts/preview-shot.js <输出路径>
//
// 依赖零第三方库：Node 内置 WebSocket + Electron 的 CDP。

const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9333;
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "docs", "ragdoll-states.png");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const slot = this.waiting.get(m.id);
      if (!slot) return;
      this.waiting.delete(m.id);
      slot.resolve(m);
    });
    ws.addEventListener("close", () => {
      for (const slot of this.waiting.values()) slot.resolve({ error: { message: "closed" } });
      this.waiting.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    await sleep(120);
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
      }, 15000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// 临时 app 目录：只为把 preview.html 装进一个 BrowserWindow
function makeTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-preview-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "clawd-preview", version: "1.0.0", main: "main.js" })
  );
  fs.writeFileSync(
    path.join(dir, "main.js"),
    `const { app, BrowserWindow } = require("electron");
const path = require("path");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1020, height: 640, show: false, backgroundColor: "#faf9f5" });
  w.loadFile(process.env.CLAWD_PREVIEW_FILE);
});
`
  );
  return dir;
}

(async () => {
  const electronBin = require("electron"); // 纯 Node 下返回可执行文件路径
  const tmpApp = makeTempApp();
  const env = { ...process.env, CLAWD_PREVIEW_FILE: path.join(ROOT, "preview.html") };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, [`--remote-debugging-port=${PORT}`, tmpApp], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  try {
    let target = null;
    for (let i = 0; i < 60; i++) {
      const list = await getJson(PORT, "/json/list");
      const hit = Array.isArray(list)
        ? list.find((t) => t.type === "page" && String(t.url).includes("preview.html"))
        : null;
      if (hit) {
        target = hit;
        break;
      }
      await sleep(300);
    }
    if (!target) throw new Error("15s 内没拿到 preview.html 的调试目标\n" + out.slice(-1200));

    const C = await Cdp.connect(target.webSocketDebuggerUrl);
    await C.send("Runtime.enable");
    await C.send("Page.enable");

    // 等 SVG 真正画出来（preview.html 是脚本生成 DOM，readyState 不够）
    for (let i = 0; i < 50; i++) {
      const r = await C.send("Runtime.evaluate", {
        expression: "document.querySelectorAll('svg').length",
        returnByValue: true,
      });
      if ((r?.result?.result?.value || 0) > 0) break;
      await sleep(200);
    }
    await sleep(700); // 让 CSS 过渡/字体落定

    const shot = await C.send("Page.captureScreenshot", { format: "png" });
    if (!shot?.result?.data) throw new Error("截图失败：" + JSON.stringify(shot).slice(0, 200));

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
    console.log(`[preview-shot] 已写出 ${OUT}`);
    C.close();
  } finally {
    // Windows 上 electron 会派生出 GPU / utility 等子进程，
    // child.kill() 只杀主进程，子进程会逃逸成僵尸并继续占着缓存目录
    // （下次启动报 "Unable to move the cache: 拒绝访问"）。
    // 所以这里按进程树杀。
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {}
    try {
      fs.rmSync(tmpApp, { recursive: true, force: true });
    } catch {}
  }
  process.exit(0);
})().catch((err) => {
  console.error("[preview-shot] 失败：", err.message);
  process.exit(1);
});
