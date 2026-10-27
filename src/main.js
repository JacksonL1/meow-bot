"use strict";
// ============================================================
// S1 + S5  Electron 主进程（原项目对应 src/main.js + src/pet-window-runtime.js）
//
// 一个"桌宠窗口"在 Windows 上需要同时满足：
//   transparent  背景透明（必须同时给 backgroundColor: '#00000000'）
//   frame:false  无边框，否则系统会画一条标题栏
//   hasShadow:false  否则透明区域会出现阴影方块
//   skipTaskbar  不在任务栏里占位
//   alwaysOnTop  + level 'screen-saver'（Windows 上 level 参数才真正生效）
//
// 两个平台级的坑：
//   1. 透明窗口默认会"挡住"下面所有的鼠标点击 → 要用 setIgnoreMouseEvents 动态开关
//   2. -webkit-app-region: drag 会让该区域收不到 mousemove → 自己实现拖拽
// ============================================================

const { app, BrowserWindow, ipcMain, screen, powerMonitor, clipboard } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("./server");
const { createStore } = require("./state");
const { createPermissionCenter } = require("./permission");
const { portFilePath } = require("./port-file");

// SEC-10：单实例锁。第二个实例直接退出，避免两个进程抢同一个端点文件。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const WIN_W = 240;
const WIN_H = 240;
const BUBBLE_W = 360;

let win = null;
let drag = null; // { cursorX, cursorY, winX, winY, timer }
let lastGaze = { x: 0, y: 0 };

// ---- S6：会话看板 ----
// 和气泡一样懒创建，但语义完全不同：气泡是"要你立刻做决定"，看板是"你自己想看"。
// 所以它不置顶、不抢焦点、关掉就是关掉（不记忆位置也无所谓，Windows 会记住）。
let dashboard = null;

// ---- S5：权限气泡 ----
let bubble = null; // 懒创建：真有人来请求时才建窗口
const bubbleQueue = []; // 一次只显示一个，后来的排队
let bubbleCurrent = null; // 当前显示中的请求 id
// 页面加载完成前不能投消息，否则第一个权限请求会被静默丢掉
// （表现：气泡空白、点了没反应、最后超时回落）。用渲染层的 handshake 确认。
let bubbleReady = false;
let bubblePendingEntry = null;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: area.x + area.width - WIN_W - 40,
    y: area.y + area.height - WIN_H - 40,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // SEC-06：把安全基线写成显式配置，不依赖 Electron 的默认值。
      // 默认值会随版本变，而这三项一旦被无声削弱，隔离就没了。
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false,
    },
  });

  // Windows 上普通 alwaysOnTop 会被全屏应用压掉，'screen-saver' 层级最稳
  win.setAlwaysOnTop(true, "screen-saver");

  // 先全体穿透，renderer 检测到鼠标压在宠物身上再关掉穿透
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    win = null;
  });
  // 桌宠被拖动时，气泡跟着走
  win.on("move", positionBubble);
}

function broadcast(snapshot) {
  if (win && !win.isDestroyed()) win.webContents.send("state", snapshot);
}

// ------------------------------------------------------------
// S5：权限气泡窗口
// ------------------------------------------------------------

function ensureBubble() {
  if (bubble && !bubble.isDestroyed()) return bubble;

  bubble = new BrowserWindow({
    width: BUBBLE_W,
    height: 140, // 真高度由渲染层量完回传（bubble:height）
    show: false,
    frame: false,
    transparent: true, // 圆角是卡片自己画的，窗口背景必须透明才看得出圆角
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "bubble-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.loadFile(path.join(__dirname, "bubble.html"));
  bubble.on("closed", () => {
    bubble = null;
    bubbleReady = false; // 下次再建窗口要重新握手
    bubblePendingEntry = null;
  });
  return bubble;
}

// 气泡贴在桌宠上方；上方放不下就改下方；横向夹在工作区内
function positionBubble() {
  if (!bubble || bubble.isDestroyed() || !win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const [px, py] = win.getPosition();
  const [bw, bh] = bubble.getSize();
  let x = px + WIN_W / 2 - bw / 2;
  let y = py - bh - 12;
  if (y < area.y) y = py + WIN_H + 12;
  bubble.setPosition(Math.round(clamp(x, area.x + 8, area.x + area.width - bw - 8)), Math.round(y));
}

// 真正投递并展示。只有页面 ready 之后才能走到这里。
function presentBubble(entry) {
  if (!bubble || bubble.isDestroyed()) return;
  bubble.webContents.send("permission:request", {
    id: entry.id,
    toolName: entry.toolName,
    command: entry.command,
    cwd: entry.cwd,
    sessionId: entry.sessionId,
    queued: bubbleQueue.length,
  });
  positionBubble();
  bubble.show();
  bubble.focus();
}

function showBubble(entry) {
  ensureBubble();
  bubbleCurrent = entry.id;
  // 页面还没 ready 就先存着，等 bubble:ready 再投。
  // 这一段是踩过坑才加的：直接 send 的话消息会丢，气泡会一直空白到超时。
  if (bubbleReady) presentBubble(entry);
  else bubblePendingEntry = entry;
}

function onBubbleReady() {
  bubbleReady = true;
  const entry = bubblePendingEntry;
  bubblePendingEntry = null;
  // 只有在等待期间这个请求还没被 resolve 掉才需要展示
  if (entry && bubbleCurrent === entry.id) presentBubble(entry);
}

// ------------------------------------------------------------
// S6：会话看板窗口
// ------------------------------------------------------------

function ensureDashboard() {
  if (dashboard && !dashboard.isDestroyed()) return dashboard;

  dashboard = new BrowserWindow({
    width: 420,
    height: 460,
    minWidth: 340,
    minHeight: 260,
    show: false,
    // 它是个"正常窗口"：有边框、不置顶、不透明。
    // 和桌宠/气泡刻意不同——那两个是"突然出现在你屏幕上"，这个是你主动要看。
    frame: true,
    transparent: false,
    backgroundColor: "#faf9f5",
    alwaysOnTop: false,
    title: "Clawd · 会话",
    webPreferences: {
      preload: path.join(__dirname, "dashboard-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  dashboard.loadFile(path.join(__dirname, "dashboard.html"));
  dashboard.on("closed", () => {
    dashboard = null;
  });
  return dashboard;
}

// 双击桌宠 = 开/关。做成 toggle 而不是"只开"，
// 是因为桌宠没有任务栏入口，用户关掉看板后很难再找回来。
function toggleDashboard() {
  const d = ensureDashboard();
  if (d.isVisible()) {
    d.hide();
    return;
  }

  // 贴着桌宠放，省得用户去任务栏找窗口
  if (win && !win.isDestroyed()) {
    const area = screen.getPrimaryDisplay().workArea;
    const [px, py] = win.getPosition();
    const [dw, dh] = d.getSize();
    let x = px + WIN_W / 2 - dw / 2;
    let y = py - dh - 12;
    if (y < area.y) y = py + WIN_H + 12;
    d.setPosition(
      Math.round(clamp(x, area.x + 8, area.x + area.width - dw - 8)),
      Math.round(clamp(y, area.y + 8, area.y + area.height - dh - 8))
    );
  }
  d.show();
  d.focus();
}

app.whenReady().then(() => {
  const store = createStore({ onChange: broadcast });

  // ---- S5：权限裁决台 ----
  // onRequest 只管"显示"；回写全部收敛在 permission.js 的 settle() 里，
  // 保证任何结局都恰好响应一次，不会漏也不会重。
  const permissions = createPermissionCenter({
    onRequest(entry) {
      if (bubbleCurrent === null) showBubble(entry);
      else bubbleQueue.push(entry.id); // 一次只弹一个，避免气泡叠气泡
    },
    onResolve() {
      bubbleCurrent = null;
      if (bubble && !bubble.isDestroyed()) bubble.hide();
      const nextId = bubbleQueue.shift();
      if (nextId !== undefined) {
        const next = permissions.get(nextId);
        if (next) showBubble(next);
      }
    },
  });

  // SEC-02 / SEC-10：端点统一写 userData，内容是 { port, token }，权限 0600。
  // 不再写项目根目录——那里可能被同步盘带走，也可能被别的项目误读。
  const portFile = portFilePath();
  const token = crypto.randomBytes(32).toString("hex");
  const server = startServer({ store, portFile, token, permissions });

  createWindow();

  // ---- 拖拽：不用 app-region，改成主进程轮询全局光标 ----
  // 为什么必须轮询？窗口跟着光标移动后，光标在窗口内的相对位置不变，
  // renderer 就再也收不到 mousemove 了。只有 screen.getCursorScreenPoint()
  // 才能拿到"和窗口无关"的坐标。
  ipcMain.on("drag:start", () => {
    if (!win || drag) return;
    const cursor = screen.getCursorScreenPoint();
    const [winX, winY] = win.getPosition();
    drag = {
      cursorX: cursor.x,
      cursorY: cursor.y,
      winX,
      winY,
      timer: setInterval(() => {
        if (!win || win.isDestroyed()) return;
        const p = screen.getCursorScreenPoint();
        win.setPosition(drag.winX + (p.x - drag.cursorX), drag.winY + (p.y - drag.cursorY));
      }, 16),
    };
  });

  ipcMain.on("drag:end", () => {
    if (drag && drag.timer) clearInterval(drag.timer);
    drag = null;
  });

  // ---- 点击穿透开关 ----
  ipcMain.on("mouse:ignore", (_e, ignore) => {
    if (!win || win.isDestroyed()) return;
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  // ---- S5：气泡的两个按钮与高度回传 ----
  ipcMain.on("permission:decide", (_e, msg) => {
    // 参数来自渲染进程，但即使被伪造也只能影响"已经挂起着的真实请求"，
    // 不会凭空造出一个决定——决定永远对应一个真实存在的 HTTP 响应
    if (!msg || typeof msg.id !== "number") return;
    permissions.decide(msg.id, msg.decision);
  });

  // 气泡页面加载完的握手：ready 之前不投消息，否则第一个权限请求会丢
  ipcMain.on("bubble:ready", onBubbleReady);

  ipcMain.on("bubble:height", (_e, h) => {
    if (!bubble || bubble.isDestroyed()) return;
    bubble.setSize(BUBBLE_W, clamp(Math.round(Number(h) || 0), 80, 460));
    positionBubble();
  });

  // ---- 眼球追踪：主进程读全局光标，归一化后推给渲染层 ----
  // 为什么不能在渲染层自己算？窗口只有 240×240，光标绝大多数时间在窗口外面，
  // renderer 根本收不到 mousemove。只有 screen.getCursorScreenPoint() 看得到全局位置。
  const gazeTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const nx = clamp((p.x - (b.x + b.width / 2)) / 260, -1, 1);
    const ny = clamp((p.y - (b.y + b.height / 2)) / 260, -1, 1);
    // 变化太小就不发，省 IPC 也省电
    if (Math.abs(nx - lastGaze.x) < 0.02 && Math.abs(ny - lastGaze.y) < 0.02) return;
    lastGaze = { x: nx, y: ny };
    win.webContents.send("gaze", lastGaze);
  }, 100);

  ipcMain.on("app:quit", () => app.quit());

  // ---- S6：看板 ----
  ipcMain.on("dashboard:toggle", toggleDashboard);

  // 看板每秒自己来要一次快照。推送也能做，但 idleMs 本来就要随时间变，
  // 轮询一个本地 IPC 比维护"何时该推"简单得多。
  ipcMain.handle("dashboard:snapshot", () => store.snapshot());

  // 唯一会离开主进程的完整路径：用户对某一条显式点了"复制路径"。
  // id 是渲染层传来的，但 store 只按 Map 精确取，取不到就返回 false，
  // 不存在"拼一个 id 骗出别的会话路径"的路径。
  ipcMain.handle("dashboard:copy-path", (_e, id) => {
    if (typeof id !== "string") return false;
    const full = store.fullCwd(id);
    if (!full) return false;
    clipboard.writeText(full);
    return true;
  });

  // SEC-07：锁屏 / 休眠时先把窗口收起来。
  // 'screen-saver' 是最高常规层级，不收起来会浮在锁屏界面之上——
  // S5 之后气泡里会显示"正在执行什么命令"，那就成了别人能看见的信息泄露。
  const hideAll = () => {
    if (win && !win.isDestroyed()) win.hide();
    if (bubble && !bubble.isDestroyed()) bubble.hide();
    // 看板会列出每个会话的项目目录名，锁屏时留在屏幕上就是信息泄露
    if (dashboard && !dashboard.isDestroyed()) dashboard.hide();
  };
  const showAll = () => {
    if (win && !win.isDestroyed()) win.showInactive();
    if (bubbleCurrent !== null && bubble && !bubble.isDestroyed()) bubble.showInactive();
  };
  powerMonitor.on("lock-screen", hideAll);
  powerMonitor.on("unlock-screen", showAll);
  powerMonitor.on("suspend", hideAll);
  powerMonitor.on("resume", showAll);

  // 首帧推送：避免桌宠启动后一直呆在初识状态
  setTimeout(() => broadcast(store.snapshot()), 300);

  app.on("before-quit", () => {
    clearInterval(gazeTimer);
    store.dispose();
    // 退出时把所有挂着的权限请求以 204 结束，否则对端的 HTTP 连接会一直悬着。
    // 交还给 Claude Code 自己的原生提示，比让它卡死强。
    permissions.dispose();
    server.close();
    // 正常退出时删掉端点文件：否则 hook 会拿着旧端口去连，连不上再静默退出。
    // 崩溃时删不掉也没关系，hook 对 ECONNREFUSED 同样是静默的。
    try {
      fs.unlinkSync(portFile);
    } catch {}
  });
});

// 桌宠是常驻单例，关掉所有窗口就退出（macOS 也一样，否则 dock 图标会赖着）
app.on("window-all-closed", () => app.quit());
