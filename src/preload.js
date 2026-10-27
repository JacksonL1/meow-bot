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
  quit: () => ipcRenderer.send("app:quit"),
  // S6：双击桌宠开关会话看板
  toggleDashboard: () => ipcRenderer.send("dashboard:toggle"),
  // S7：主题。getTheme 是**拉**（启动时拉一次，绕开"推早了丢失"），
  // onTheme 是**推**（看板里切主题后立刻生效）。
  getTheme: () => ipcRenderer.invoke("theme:get"),
  onTheme: (cb) => ipcRenderer.on("theme", (_e, theme) => cb(theme)),
});
