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

// S7：可以指定主题。不给就是 ragdoll（默认主题），输出名也跟着主题走，
// 这样加一个主题就多一张对照图，不会互相覆盖。
const ARGV = process.argv.slice(2);
const THEME_FLAG = ARGV.find((a) => a.startsWith("--theme="));
const THEME = THEME_FLAG ? THEME_FLAG.slice("--theme=".length) : "ragdoll";
const OUT_ARG = ARGV.find((a) => !a.startsWith("--"));
const OUT = OUT_ARG ? path.resolve(OUT_ARG) : path.join(ROOT, "docs", `${THEME}-states.png`);

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
const { pathToFileURL } = require("url");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1020, height: 640, show: false, backgroundColor: "#faf9f5" });
  // 用 loadURL 而不是 loadFile，只为了能带 ?theme= 参数
  w.loadURL(pathToFileURL(process.env.CLAWD_PREVIEW_FILE).href + "?theme=" + encodeURIComponent(process.env.CLAWD_PREVIEW_THEME));
});
`
  );
  return dir;
}

(async () => {
  // 先把 themes/ 打成 preview-bundle.js。放在这里而不是让用户记得手动跑：
  // 截图脚本存在的意义就是"改完立刻看"，多一步手动操作就等于长期用过期数据。
  const { build } = require("./build-preview-bundle");
  const bundled = build();
  if (!bundled.ids.includes(THEME)) {
    throw new Error(`没有主题 ${THEME}（现有：${bundled.ids.join(", ") || "无"}）`);
  }

  const electronBin = require("electron"); // 纯 Node 下返回可执行文件路径
  const tmpApp = makeTempApp();
  const env = {
    ...process.env,
    CLAWD_PREVIEW_FILE: path.join(ROOT, "preview.html"),
    CLAWD_PREVIEW_THEME: THEME,
  };
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

    // 隐藏窗口不会自己产生新帧，而 Page.captureScreenshot 要等一帧才返回。
    // 以前页面里每个状态都有逐帧轮播的定时器，一直在制造帧，所以这个前提从没暴露；
    // 改成"1 帧/状态 + 部件动画"之后页面完全静止，截图就会一直等到超时。
    // 所以截图前先手动制造一次重绘，失败再重试。
    const repaint = () =>
      C.send("Runtime.evaluate", {
        expression:
          "requestAnimationFrame(() => { document.body.style.opacity = '0.999'; requestAnimationFrame(() => { document.body.style.opacity = ''; }); })",
      });

    // 默认只截视口（640 高），第二行状态会被切掉一半。
    // 状态对照图是给人看的"七个姿势是否分得开"，缺一行就失去一半用处，
    // 所以先按内容高度把视口撑开再截。宽度不变，栅格不会重排。
    const contentH = await C.send("Runtime.evaluate", {
      expression: "Math.ceil(document.documentElement.scrollHeight)",
      returnByValue: true,
    });
    const fullH = Math.min(Math.max(contentH?.result?.result?.value || 640, 640), 4000);
    await C.send("Emulation.setDeviceMetricsOverride", {
      width: 1020,
      height: fullH,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(400);

    let shot = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await repaint();
      await sleep(220);
      shot = await C.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      if (shot?.result?.data) break;
    }
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
