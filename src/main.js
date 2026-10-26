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

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const { startServer } = require("./server");
const { createStore } = require("./state");

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

  // 端口文件：打包后写 userData，开发时写项目根目录（方便 fake-feed 找到）
  const portFile = app.isPackaged
    ? path.join(app.getPath("userData"), "clawd-starter.port")
    : path.join(app.getAppPath(), ".clawd-port");
  const server = startServer({ store, portFile });

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

  // 首帧推送：避免桌宠启动后一直呆在初识状态
  setTimeout(() => broadcast(store.snapshot()), 300);

  app.on("before-quit", () => {
    clearInterval(gazeTimer);
    store.dispose();
    server.close();
  });
});

// 桌宠是常驻单例，关掉所有窗口就退出（macOS 也一样，否则 dock 图标会赖着）
app.on("window-all-closed", () => app.quit());
