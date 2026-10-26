"use strict";
// ============================================================
// S1  Electron 主进程（原项目对应 src/main.js + src/pet-window-runtime.js）
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

const { app, BrowserWindow, ipcMain, screen, powerMonitor } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("./server");
const { createStore } = require("./state");
const { portFilePath } = require("./port-file");

// SEC-10：单实例锁。第二个实例直接退出，避免两个进程抢同一个端点文件。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const WIN_W = 240;
const WIN_H = 240;

let win = null;
let drag = null; // { cursorX, cursorY, winX, winY, timer }
let lastGaze = { x: 0, y: 0 };

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
}

function broadcast(snapshot) {
  if (win && !win.isDestroyed()) win.webContents.send("state", snapshot);
}

app.whenReady().then(() => {
  const store = createStore({ onChange: broadcast });

  // SEC-02 / SEC-10：端点统一写 userData，内容是 { port, token }，权限 0600。
  // 不再写项目根目录——那里可能被同步盘带走，也可能被别的项目误读。
  const portFile = portFilePath();
  const token = crypto.randomBytes(32).toString("hex");
  const server = startServer({ store, portFile, token });

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

  // SEC-07：锁屏 / 休眠时先把窗口收起来。
  // 'screen-saver' 是最高常规层级，不收起来会浮在锁屏界面之上——
  // 等 S5 气泡显示"正在执行什么命令"时，这就成了别人能看见的信息泄露。
  powerMonitor.on("lock-screen", () => {
    if (win && !win.isDestroyed()) win.hide();
  });
  powerMonitor.on("unlock-screen", () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });
  powerMonitor.on("suspend", () => {
    if (win && !win.isDestroyed()) win.hide();
  });
  powerMonitor.on("resume", () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });

  // 首帧推送：避免桌宠启动后一直呆在初识状态
  setTimeout(() => broadcast(store.snapshot()), 300);

  app.on("before-quit", () => {
    clearInterval(gazeTimer);
    store.dispose();
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
