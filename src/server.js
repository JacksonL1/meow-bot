"use strict";
// ============================================================
// S2-2  本地 HTTP 接收器（原项目对应 src/server.js + src/server-route-state.js）
//
// 为什么用 HTTP 而不是文件监听 / 管道？
//   因为 hook 是独立的短命进程，它需要一种"对方没开就立刻失败"的通信方式。
//   端点写在文件里 → hook 读文件 → POST 一发即走，桌宠没开就静默退出。
//
// 安全（SEC-01 / SEC-02）——四道锁，按顺序：
//   1. Host      必须是 127.0.0.1:<本进程端口>，挡 DNS rebinding
//   2. Origin    存在且不是 "null" 一律拒绝，挡普通网页
//   3. Token     x-clawd-token 与启动时随机生成的值定时安全比对，挡同机其他进程
//   4. Content-Type  POST 必须是 application/json，挡 text/plain 的 CORS 简单请求
//
// 注意第 4 条不是"洁癖"：text/plain 属于 CORS 简单请求，浏览器不发预检，
// 请求会真的打到服务端——响应被拦下也没用，副作用已经发生了。
// ============================================================

const http = require("node:http");
const crypto = require("node:crypto");
const { writePortFile } = require("./port-file");

const MAX_BODY_BYTES = 256 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// 定长比较，避免通过响应时间猜 token
function safeEqual(got, expected) {
  const a = Buffer.from(String(got), "utf8");
  if (a.length !== expected.length) return false;
  return crypto.timingSafeEqual(a, expected);
}

/**
 * @param {{ store: ReturnType<import('./state').createStore>, portFile: string, token: string }} opts
 */
function startServer({ store, portFile, token }) {
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("startServer 需要一个至少 32 字符的随机 token");
  }
  const expected = Buffer.from(token, "utf8");

  const server = http.createServer(async (req, res) => {
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;

    // ---- 1. Host：必须是本机回环 + 本进程端口 ----
    if (req.headers.host !== `127.0.0.1:${port}`) {
      return sendJson(res, 403, { error: "bad host" });
    }

    // ---- 2. Origin：浏览器发起的跨源请求一律拒绝 ----
    // "null" 是 file:// 页面与沙箱 iframe 的 Origin，放行它由 token 兜底。
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") {
      return sendJson(res, 403, { error: "cross-origin blocked" });
    }

    // ---- 3. Token：本机进程也可能不怀好意 ----
    if (!safeEqual(req.headers["x-clawd-token"] || "", expected)) {
      return sendJson(res, 401, { error: "bad token" });
    }

    // ---- 4. Content-Type：挡住不需要预检的简单请求 ----
    if (req.method === "POST") {
      const ct = String(req.headers["content-type"] || "").toLowerCase();
      if (!ct.startsWith("application/json")) {
        return sendJson(res, 415, { error: "content-type must be application/json" });
      }
    }

    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/state") {
      return sendJson(res, 200, store.snapshot());
    }

    if (req.method === "POST" && url.pathname === "/state") {
      try {
        const payload = await readJsonBody(req);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return sendJson(res, 400, { error: "body must be an object" });
        }
        const snap = store.apply(payload);
        // 回包把"当前该显示什么"告诉 hook，方便它自己决定是否继续阻塞
        return sendJson(res, 200, { ok: true, visual: snap.visual });
      } catch (err) {
        return sendJson(res, 400, { error: String(err.message || err) });
      }
    }

    return sendJson(res, 404, { error: "not found" });
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    writePortFile(portFile, { port, token });
    console.log(`[clawd] POST http://127.0.0.1:${port}/state`);
    console.log(`[clawd] 端点已写入 ${portFile}（含 token，权限 0600）`);
  });

  server.on("error", (err) => console.error("[clawd] server error:", err));

  return server;
}

module.exports = { startServer, safeEqual };
