"use strict";
// ============================================================
// S2-2  本地 HTTP 接收器（原项目对应 src/server.js + src/server-route-state.js）
//
// 为什么用 HTTP 而不是文件监听 / 管道？
//   因为 hook 是独立的短命进程，它需要一种"对方没开就立刻失败"的通信方式。
//   端口写在文件里 → hook 读文件 → POST 一发即走，桌宠没开就静默退出。
//
// 学习要点：
//   - listen(0) 让系统分配随机端口（避免固定端口冲突，也少一个被探测的面）
//   - 只绑 127.0.0.1，绝不绑 0.0.0.0
//   - 请求体必须有上限（这里是 256 KB），否则一个恶意请求就能撑爆内存
// ============================================================

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

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

/**
 * @param {{ store: ReturnType<import('./state').createStore>, portFile: string }} opts
 */
function startServer({ store, portFile }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, pid: process.pid });
    }

    if (req.method === "GET" && url.pathname === "/state") {
      return sendJson(res, 200, store.snapshot());
    }

    if (req.method === "POST" && url.pathname === "/state") {
      try {
        const payload = await readJsonBody(req);
        if (!payload || typeof payload !== "object") {
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
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, String(port), "utf8");
    console.log(`[clawd] POST http://127.0.0.1:${port}/state`);
    console.log(`[clawd] port 已写入 ${portFile}`);
  });

  server.on("error", (err) => console.error("[clawd] server error:", err));

  return server;
}

module.exports = { startServer };
