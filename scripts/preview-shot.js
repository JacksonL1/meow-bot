#!/usr/bin/env node
"use strict";
// 把 preview.html 渲染成一张 PNG，用于设计留档与"改坏了没"的目视对照。
//
// 为什么要单独写一个：桌宠窗口是 240×240 且透明的，直接截它看不出全貌；
// preview.html 是浅底 + 七状态同屏，一张图就能判断形象是否正常。
//
// 用法：
//   node scripts/preview-shot.js                 # 写到 docs/<theme>-states.png
//   node scripts/preview-shot.js <输出路径>
//   node scripts/preview-shot.js --theme=_template
//
// 依赖零第三方库：Node 内置 WebSocket + 宿主 WebView2 的 CDP。
//
// ---- 2026-11-03：宿主从 Electron 换成 Tauri ----
// 原来这里起一个临时 Electron app 装一个 BrowserWindow 来跑 preview.html。
// Electron 容器删掉之后换成 Tauri 的 release 二进制：它启动后本来就有一个窗口
// 在跑 index.html，我们连上 CDP 之后用 `Page.navigate` 把这个窗口**导航到**
// preview.html。渲染内核还是同一个 Chromium（WebView2），所以下面那些
// "等 SVG 画出来 / 撑开视口 / 强制重绘再截"的判据一条都不用改。
//
// 唯一的前提：**必须先 `npm run build`**（README 里也写了）。截图脚本不去
// 编译 Rust —— 那会让"改完立刻看"变成"改完等两分钟"。

const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const PORT = 9333;
const EXE = path.join(ROOT, "src-tauri", "target", "release", "clawd-starter.exe");

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

(async () => {
  // 先把 themes/ 打成 preview-bundle.js。放在这里而不是让用户记得手动跑：
  // 截图脚本存在的意义就是"改完立刻看"，多一步手动操作就等于长期用过期数据。
  const { build } = require("./build-preview-bundle");
  const bundled = build();
  if (!bundled.ids.includes(THEME)) {
    throw new Error(`没有主题 ${THEME}（现有：${bundled.ids.join(", ") || "无"}）`);
  }

  if (!fs.existsSync(EXE)) {
    throw new Error(`找不到 ${EXE}\n先跑 npm run build（截图脚本不去编译 Rust）`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-preview-"));
  const portFile = path.join(tmp, "clawd-starter.port");
  const child = spawn(EXE, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      CLAWD_PORT_FILE: portFile, // 不碰用户正在用的那份端点文件
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  try {
    let target = null;
    for (let i = 0; i < 80; i++) {
      const list = await getJson(PORT, "/json/list");
      const hit = Array.isArray(list) ? list.find((t) => t.type === "page") : null;
      if (hit) {
        target = hit;
        break;
      }
      await sleep(300);
    }
    if (!target) throw new Error("拿不到宿主的调试目标\n" + out.slice(-1200));

    const C = await Cdp.connect(target.webSocketDebuggerUrl);
    await C.send("Runtime.enable");
    await C.send("Page.enable");

    // 把宿主窗口导航到 preview.html。用 loadURL 而不是 loadFile 的老理由仍然成立：
    // 只有 URL 才能带 ?theme= 参数。
    const url =
      pathToFileURL(path.join(ROOT, "preview.html")).href + "?theme=" + encodeURIComponent(THEME);
    const nav = await C.send("Page.navigate", { url });
    if (nav?.error) throw new Error("导航失败：" + JSON.stringify(nav.error));

    // 等 SVG 真正画出来（preview.html 是脚本生成 DOM，readyState 不够）
    let svgs = 0;
    for (let i = 0; i < 60; i++) {
      const r = await C.send("Runtime.evaluate", {
        expression: "document.querySelectorAll('svg').length",
        returnByValue: true,
      });
      svgs = r?.result?.result?.value || 0;
      if (svgs > 0) break;
      await sleep(200);
    }
    if (svgs === 0) throw new Error("preview.html 里一个 svg 都没画出来");
    await sleep(700); // 让 CSS 过渡/字体落定

    // 窗口不会自己产生新帧，而 Page.captureScreenshot 要等一帧才返回。
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
    // Windows 上 WebView2 会派生 GPU / renderer 等子进程，
    // child.kill() 只杀主进程，子进程会逃逸成僵尸并继续占着缓存目录。
    // 所以这里按进程树杀。
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGKILL");
      }
    } catch {}
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
  process.exit(0);
})().catch((err) => {
  console.error("[preview-shot] 失败：", err.message);
  process.exit(1);
});
