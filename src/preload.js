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
  // S8：双击桌宠 = 写封信。右键 = 小菜单（写信 / 看板 / 退出）。
  // 看板原来是双击的入口，现在挪进右键菜单 —— 桌宠没有标题栏，
  // 右键菜单是唯一能"把功能都摆出来"的地方。
  openLetter: () => ipcRenderer.send("letter:open"),
  petMenu: () => ipcRenderer.send("pet:menu"),
  onLetterSent: (cb) => ipcRenderer.on("letter:sent", () => cb()),
  toggleDashboard: () => ipcRenderer.send("dashboard:toggle"),
  // S7：主题。getTheme 是**拉**（启动时拉一次，绕开"推早了丢失"），
  // onTheme 是**推**（看板里切主题后立刻生效）。
  getTheme: () => ipcRenderer.invoke("theme:get"),
  onTheme: (cb) => ipcRenderer.on("theme", (_e, theme) => cb(theme)),
});
