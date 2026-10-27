"use strict";
// 气泡窗口的上下文桥。和主窗口分开：一个 preload 只服务一个窗口，
// 职责边界清楚了，也就不会把主窗口的动作误开给气泡（反之亦然）。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bubble", {
  onRequest: (cb) => ipcRenderer.on("permission:request", (_e, req) => cb(req)),
  decide: (id, decision) => ipcRenderer.send("permission:decide", { id, decision }),
  setHeight: (h) => ipcRenderer.send("bubble:height", h),
  // 握手：页面脚本跑完、onRequest 已注册之后才通知主进程。
  // 没有这一步，第一个权限请求会在页面还没准备好时被 send 掉，永远收不到。
  ready: () => ipcRenderer.send("bubble:ready"),
});
