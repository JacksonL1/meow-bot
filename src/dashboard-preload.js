"use strict";
// ============================================================
// S6  会话看板的 preload
//
// 只暴露两个动作，和主窗口同一个原则：
//   不暴露 ipcRenderer 本身，只给"具体能做的事"。
//
// 注意这里没有"取完整 cwd"的接口。完整路径永远留在主进程，
// 只有用户点了某一行的"复制路径"才会由主进程塞进剪贴板
// （见 SEC-09 的分层：快照只出 basename，完整路径按需、单条释放）。
// ============================================================

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dashboard", {
  getSnapshot: () => ipcRenderer.invoke("dashboard:snapshot"),
  copyPath: (sessionId) => ipcRenderer.invoke("dashboard:copy-path", sessionId),
});
