"use strict";
// 信纸窗口的上下文桥。和气泡一样：一个 preload 只服务一个窗口。
// 这里刻意**没有**暴露"读文件""跑命令"之类的能力 ——
// 信纸能做的只有三件事：收下用户打的字、寄出、取消。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("letter", {
  // 每次打开窗口由主进程发一次：渲染层据此清空上一次的草稿并把光标放进去。
  // 为什么不用 window 的 focus 事件代替？因为用户点了别的窗口再点回来也会触发 focus，
  // 那会把写到一半的草稿清掉 —— 这是最不能忍的一种 bug。
  // 带上 { maxChars }：字数上限的真值只有一份，在 mailbox.js 里。
  // 渲染层不许自己写一个 4000 —— 两处数字一旦分叉，就会出现"面板说还能写、
  // 寄出却被拒"这种自相矛盾的提示。
  onOpen: (cb) => ipcRenderer.on("letter:open", (_e, data) => cb(data)),
  // 返回 { ok, error }：失败原因（太长 / 信箱满）要显示在信纸上，不能静默丢掉
  send: (text) => ipcRenderer.invoke("letter:send", text),
  cancel: () => ipcRenderer.send("letter:cancel"),
});
