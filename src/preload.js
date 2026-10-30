"use strict";
// contextIsolation 下 renderer 没有 Node 权限，一切能力都要在这里显式开口。
// 这是 Electron 的安全底线：只暴露具体动作，绝不暴露 ipcRenderer 本身。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clawd", {
  onState: (cb) => ipcRenderer.on("state", (_e, snapshot) => cb(snapshot)),
  onGaze: (cb) => ipcRenderer.on("gaze", (_e, gaze) => cb(gaze)),
  dragStart: () => ipcRenderer.send("drag:start"),
  dragEnd: () => ipcRenderer.send("drag:end"),
  setIgnoreMouse: (ignore) => ipcRenderer.send("mouse:ignore", ignore),
  // S9：鼠标停到猫身上时把它弄醒。渲染层只能"请求"，改状态的是主进程的状态机——
  // 这里刻意不做成"直接改画面"，否则会被下一个 250ms 的状态推送顶回去。
  wake: () => ipcRenderer.send("pet:hover"),
  quit: () => ipcRenderer.send("app:quit"),
  // S8：双击桌宠 = 写封信。右键 = 小菜单（写信 / 看板 / 退出）。
  // 看板原来是双击的入口，现在挪进右键菜单 —— 桌宠没有标题栏，
  // 右键菜单是唯一能"把功能都摆出来"的地方。
  // kind 可选："letter"（默认，双击走这个）/ "report"（预填现场 + 留本地副本）。
  // 它来自渲染层，可被 F12 改，但全部效力只是"预填什么、留不留副本"，
  // 不是权限，所以主进程只做一次字符串比对，不做额外校验。
  // 带上这个参数还有一个纯工程上的理由：原生右键菜单在回归里**不能真弹**
  // （会阻塞主进程），所以「报告问题」这条链路只有靠着它才能被真验一次。
  openLetter: (kind) => ipcRenderer.send("letter:open", kind),
  petMenu: () => ipcRenderer.send("pet:menu"),
  // 带上 { kind }：报告问题的回执文案不一样（它本地也留了一份）。
  onLetterSent: (cb) => ipcRenderer.on("letter:sent", (_e, data) => cb(data)),
  toggleDashboard: () => ipcRenderer.send("dashboard:toggle"),
  // S7：主题。getTheme 是**拉**（启动时拉一次，绕开"推早了丢失"），
  // onTheme 是**推**（看板里切主题后立刻生效）。
  getTheme: () => ipcRenderer.invoke("theme:get"),
  onTheme: (cb) => ipcRenderer.on("theme", (_e, theme) => cb(theme)),
});
