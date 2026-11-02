"use strict";
// ============================================================
// 极简 CDP 客户端
//
// 只做一件事：发 Runtime.evaluate 拿返回值。
// 两个回归脚本（verify-electron.js / verify-tauri.js）共用它——
// **共用是有意的**：两边跑的是同一套判据，如果连"怎么把表达式丢进页面"
// 都不一样，那两边的绿色就没有可比性了。
//
// 为什么不用 puppeteer/playwright：这两个脚本的全部价值在于"不依赖任何
// 测试框架，只用 Node 内置能力"。Node 22 自带 WebSocket，够用。
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      // 没有 id 的是事件（Runtime.exceptionThrown / Log.entryAdded …）。
      // 收集它们是为了断言"页面没抛过异常"——只看最终 DOM 是不够的：
      // 一个被 try/catch 吞掉的错误照样能让画面看起来是对的。
      if (msg.method) {
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params);
        return;
      }
      const slot = this.waiting.get(msg.id);
      if (!slot) return;
      this.waiting.delete(msg.id);
      slot.resolve(msg);
    });
    ws.addEventListener("close", () => {
      for (const slot of this.waiting.values()) slot.resolve({ error: { message: "socket closed" } });
      this.waiting.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
    });
    await sleep(100);
    return new Cdp(ws);
  }

  send(method, params = {}) {    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, { resolve });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          resolve({ error: { message: "timeout" } });
        }
      }, 5000);
    });
  }

  // 订阅 CDP 事件（Runtime.exceptionThrown 等）。没有这个的话，
  // "页面抛了异常"这件事在只看 DOM 的断言里是完全看不见的。
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  // 返回 JS 表达式的值；异常返回 undefined
  // includeCommandLineAPI 是为主进程准备的：Node inspector 的全局里没有 require
  // （require 是模块作用域的），打开这个开关才会注入一个 console 风格的 require。
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      includeCommandLineAPI: true,
    });
    if (r.error) return undefined;
    const res = r.result || {};
    if (res.exceptionDetails) {
      console.log("      [eval 异常] " + expression.slice(0, 60) + " → " + (res.exceptionDetails.text || ""));
      return undefined;
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

module.exports = { Cdp, sleep };
