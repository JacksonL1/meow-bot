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

const { app, BrowserWindow, ipcMain, screen, powerMonitor, clipboard, Menu } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { startServer } = require("./server");
const { createStore } = require("./state");
const { createPermissionCenter } = require("./permission");
const { portFilePath } = require("./port-file");
const themes = require("./theme");
const mailbox = require("./mailbox");

// SEC-10：单实例锁。第二个实例直接退出，避免两个进程抢同一个端点文件。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const WIN_W = 240;
const WIN_H = 240;
const BUBBLE_W = 360;
const LETTER_W = 360;
const LETTER_H = 250;

let win = null;
let drag = null; // { cursorX, cursorY, winX, winY, timer }
let lastGaze = { x: 0, y: 0 };

// ---- S6：会话看板 ----
// 和气泡一样懒创建，但语义完全不同：气泡是"要你立刻做决定"，看板是"你自己想看"。
// 所以它不置顶、不抢焦点、关掉就是关掉（不记忆位置也无所谓，Windows 会记住）。
let dashboard = null;

// ---- S7：主题 ----
// 加载完成后的主题对象（含全部帧）。渲染层启动时来"拉"一次，切换时再"推"。
// 不在这里做任何 SVG 清洗：清洗需要 DOM，主进程没有。
let currentTheme = null;

const DEFAULT_THEME_ID = "ragdoll";

function pickThemeCandidates() {
  // 优先级：环境变量（回归用）→ 命令行 → 上次选的 → 内置默认。
  // 最后那个不能省：没有它，resolveTheme 会按字母序取第一个可用的主题，
  // 于是"默认主题"变成了"名字最小的主题"——加一个 aaa 主题就把默认换了。
  const out = [];
  if (process.env.CLAWD_THEME) out.push(process.env.CLAWD_THEME);
  const flag = process.argv.find((a) => a.startsWith("--theme="));
  if (flag) out.push(flag.slice("--theme=".length));
  const pref = themes.readPreference();
  if (pref) out.push(pref);
  out.push(DEFAULT_THEME_ID);
  return out;
}

function pushTheme() {
  if (!currentTheme) return;
  if (win && !win.isDestroyed()) win.webContents.send("theme", currentTheme);
  // 看板只需要 id 与名字，几百 KB 的帧数据没必要再送一份
  if (dashboard && !dashboard.isDestroyed()) {
    dashboard.webContents.send("theme", { id: currentTheme.id, name: currentTheme.name });
  }
}

function applyTheme(id, { remember = true } = {}) {
  const r = themes.loadTheme(id);
  if (!r.ok) return { ok: false, error: r.error };
  currentTheme = r.theme;
  if (remember) themes.writePreference(id);
  pushTheme();
  return { ok: true, id, name: r.theme.name };
}

// ---- S5：权限气泡 ----
let bubble = null; // 懒创建：真有人来请求时才建窗口
const bubbleQueue = []; // 一次只显示一个，后来的排队
let bubbleCurrent = null; // 当前显示中的请求 id
// 页面加载完成前不能投消息，否则第一个权限请求会被静默丢掉
// （表现：气泡空白、点了没反应、最后超时回落）。用渲染层的 handshake 确认。
let bubbleReady = false;
let bubblePendingEntry = null;

// ---- S8：信纸 ----
// 和气泡一样懒创建。区别在于：气泡是"agent 要你立刻做决定"，信纸是"你自己想说句话"。
// 所以信纸要抢焦点（你要打字），但不阻塞任何东西 —— 关掉窗口信就没了，不写盘。
let letterWin = null;
let letterReady = false;
// 页面 ready 之前来的打开请求先存着，等 letter:ready 再补发。
// 和气泡同一个坑：loadFile 是异步的，先 send 的话第一条消息会丢，
// 表现是"双击了没反应，再双击一次才行"。
let letterPendingOpen = false;

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
  // 桌宠是无边框 + 不进任务栏的窗口，用户没法从菜单里开 DevTools，
  // 而没有 DevTools 就打不开 petDebug（"它为什么变成 idle"唯一的现场窗口）。
  // 所以给一个显式开关：npm run start:debug
  // 两种写法都认：命令行 --devtools，或环境变量（npm script 跨平台更稳）
  if (process.argv.includes("--devtools") || process.env.CLAWD_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
  win.on("closed", () => {
    win = null;
  });
  // 桌宠被拖动时，气泡跟着走
  win.on("move", positionBubble);
}

// 记住"推过没有"，给下面 300ms 的首帧保险用。
// 不记的话启动时会连推两次同样的 idle：tick 的第一个 250ms 周期已经把
// lastVisual 从 null 变成 idle 并 emit 过一次，300ms 的保险再推一遍是多余的。
let pushedAnyState = false;

function broadcast(snapshot) {
  if (!win || win.isDestroyed()) return;
  pushedAnyState = true;
  win.webContents.send("state", snapshot);
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

// ------------------------------------------------------------
// S8：信纸窗口
// ------------------------------------------------------------

function ensureLetter() {
  if (letterWin && !letterWin.isDestroyed()) return letterWin;

  letterWin = new BrowserWindow({
    width: LETTER_W,
    height: LETTER_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // 和气泡一样置顶：信纸是从桌宠那儿"长出来"的，
    // 藏在一堆窗口后面会让人以为双击没反应。
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "letter-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  letterWin.setAlwaysOnTop(true, "screen-saver");
  letterWin.loadFile(path.join(__dirname, "letter.html"));
  // 用 did-finish-load 当"可以投递了"的信号，而不是让页面反手发一个 ready 握手。
  // 区别在哪：握手的可靠性取决于页面脚本有没有跑到那一行，而信纸是用户点出来的，
  // 页面一旦加载失败（脚本抛异常），握手就永远不来，表现是"双击毫无反应" ——
  // 一个完全静默的失败。did-finish-load 是宿主管的，页面再烂也会触发。
  letterWin.webContents.on("did-finish-load", () => {
    letterReady = true;
    if (letterPendingOpen) {
      letterPendingOpen = false;
      presentLetter();
    }
  });
  letterWin.on("closed", () => {
    letterWin = null;
    letterReady = false;
    letterPendingOpen = false;
  });
  return letterWin;
}

function positionLetter() {
  if (!letterWin || letterWin.isDestroyed() || !win || win.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const [px, py] = win.getPosition();
  let x = px + WIN_W / 2 - LETTER_W / 2;
  let y = py - LETTER_H - 12;
  if (y < area.y) y = py + WIN_H + 12;
  letterWin.setPosition(
    Math.round(clamp(x, area.x + 8, area.x + area.width - LETTER_W - 8)),
    Math.round(y)
  );
}

function presentLetter() {
  if (!letterWin || letterWin.isDestroyed()) return;
  letterWin.webContents.send("letter:open", { maxChars: mailbox.MAX_LETTER_CHARS });
  positionLetter();
  letterWin.show();
  letterWin.focus();
}

function openLetter() {
  ensureLetter();
  if (letterReady) {
    letterPendingOpen = false;
    presentLetter();
    return;
  }
  // 页面还在加载：先把"要打开"记下来，等 did-finish-load 补发。
  // 直接 send 的话第一条消息会丢，表现是"第一次双击没反应，第二次才行"。
  letterPendingOpen = true;
}

// 寄信成功之后告诉桌宠"信寄出去了"。
// 为什么不让渲染层自己设状态：状态机在主进程手里，渲染层擅自改成 notification
// 会在下一个 250ms 的 tick 里被真实状态顶掉，看起来就像"闪了一下又没了"。
function flashLetterSent() {
  if (win && !win.isDestroyed()) win.webContents.send("letter:sent");
}

app.whenReady().then(() => {
  // 状态时长来自**当前主题**，但此刻主题还没解析（下面第 331 行才定）。
  // 所以传的是 getter 而不是值：store 每次判断时长都重新问一次，
  // 换主题后新时长立刻生效，不用重建 store。
  const store = createStore({
    onChange: broadcast,
    getTimings: () => (currentTheme && currentTheme.timings) || null,
  });

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

  // S7：先定主题再建窗口。顺序很重要——渲染层一加载就会 invoke("theme:get")，
  // 那时 currentTheme 必须已经有值，否则第一帧是空白，用户看到的是一个"没画东西"的窗口。
  const resolved = themes.resolveTheme(pickThemeCandidates());
  currentTheme = resolved.theme;
  if (resolved.error) {
    // 不崩、不弹窗：主题坏了就用兜底，把原因留在控制台
    console.warn("[theme] 有主题没加载成功：", resolved.error);
  }

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

  // ---- 鼠标停到它身上 → 把它弄醒（S9）----
  // 这条通道以前是空的：睡着是状态机按空闲时长推出来的，渲染层只能看着。
  // 现在渲染层在「真的命中猫」且「当前确实是 sleeping」时才发，
  // 且自带 500ms 上限，所以这里不必再限流。
  // 真正改状态的是 store.wake()——不是渲染层，原因见那里的注释。
  ipcMain.on("pet:hover", () => store.wake());

  // ---- S8：右键小菜单 ----
  // 以前右键 = 直接退出。那是个很糟的设计：桌宠没有标题栏，
  // 想找"怎么关掉它"的时候，唯一能试的就是右键，而它**没有确认**就退了。
  // 现在右键给一个菜单，退出只是其中一项。
  ipcMain.on("pet:menu", () => {
    if (!win || win.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: "写封信…", click: openLetter },
      { label: "会话看板", click: toggleDashboard },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]).popup({ window: win });
  });

  // ---- S8：信纸 ----
  ipcMain.on("letter:open", openLetter);
  ipcMain.on("letter:cancel", () => {
    if (letterWin && !letterWin.isDestroyed()) letterWin.hide();
  });

  // 寄信是**唯一**会把用户写的东西落盘的动作，所以校验全部在这里做：
  // 渲染层传来的只是一段文字，能存不能存由 mailbox.put 说了算。
  ipcMain.handle("letter:send", (_e, text) => {
    if (typeof text !== "string") return { ok: false, error: "信的内容必须是文字" };
    const r = mailbox.put(text);
    if (!r.ok) return r; // 失败原因原样回给信纸，让用户知道是太长还是信箱满
    if (letterWin && !letterWin.isDestroyed()) letterWin.hide();
    flashLetterSent();
    // 顺手清一下已投递的历史（7 天），失败无所谓
    try {
      mailbox.prune();
    } catch {}
    return { ok: true, id: r.id };
  });

  // 看板想知道"信箱里还有几封没寄出去"，只读不取
  ipcMain.handle("mailbox:pending", () => mailbox.listPending().length);

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

  // ---- S7：主题 ----
  // 渲染层启动时拉一次（避免"推早了被丢"），切换时走 theme:set 再推回去。
  ipcMain.handle("theme:get", () => currentTheme);

  ipcMain.handle("theme:list", () => ({
    current: currentTheme ? currentTheme.id : null,
    themes: themes.listThemes(),
  }));

  // id 来自渲染层，但 loadTheme 只认 readdir 出来的真实目录名，
  // 拼不出越权路径；路径合法性与资产白名单也在 theme.js 里统一把关。
  ipcMain.handle("theme:set", (_e, id) => applyTheme(id));

  // SEC-07：锁屏 / 休眠时先把窗口收起来。
  // 'screen-saver' 是最高常规层级，不收起来会浮在锁屏界面之上——
  // S5 之后气泡里会显示"正在执行什么命令"，那就成了别人能看见的信息泄露。
  const hideAll = () => {
    if (win && !win.isDestroyed()) win.hide();
    if (bubble && !bubble.isDestroyed()) bubble.hide();
    // 看板会列出每个会话的项目目录名，锁屏时留在屏幕上就是信息泄露
    if (dashboard && !dashboard.isDestroyed()) dashboard.hide();
    // 信纸上是用户自己写的字，可能比目录名更私密，锁屏必须一起收
    if (letterWin && !letterWin.isDestroyed()) letterWin.hide();
  };
  const showAll = () => {
    if (win && !win.isDestroyed()) win.showInactive();
    if (bubbleCurrent !== null && bubble && !bubble.isDestroyed()) bubble.showInactive();
  };
  powerMonitor.on("lock-screen", hideAll);
  powerMonitor.on("unlock-screen", showAll);
  powerMonitor.on("suspend", hideAll);
  powerMonitor.on("resume", showAll);

  // 首帧推送：避免桌宠启动后一直呆在初识状态。
  // 但如果 tick 已经推过一次（大多数情况都是），这一次就是重复的——
  // 重复推送本身无害，可它会让"启动期间的画面"变成两次重建，
  // 联动调试时非常难理解（表现为"状态莫名弹回 idle"）。
  setTimeout(() => {
    if (!pushedAnyState) broadcast(store.snapshot());
  }, 300);

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
