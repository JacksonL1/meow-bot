"use strict";
// ============================================================
// S2-2  本地 HTTP 接收器（原项目对应 src/server.js + src/server-route-state.js）
//
// 为什么用 HTTP 而不是文件监听 / 管道？
//   因为 hook 是独立的短命进程，它需要一种"对方没开就立刻失败"的通信方式。
//   端点写在文件里 → hook 读文件 → POST 一发即走，桌宠没开就静默退出。
//
// 两个端点，两道不同的门：
//   /state       观察用，四道锁（Host / Origin / Token / Content-Type）
//   /permission  裁决用，三道锁（Host / Origin / Content-Type）——**没有 Token**
//
// 为什么 /permission 不能有 token？因为它的调用方是 Claude Code 自己
// （settings.json 里配 {type:"http", url:"http://127.0.0.1:<port>/permission"}），
// Claude Code 不知道我们的 token，也带不上。这是 HTTP hook 架构的固有属性，
// 只能靠"拒绝浏览器发起的请求"来收敛；详见 SECURITY.md 的 S5 小节。
//
// 端口为什么改成固定？同理：HTTP hook 的 url 写在 settings.json 里，是静态的。
// 端口每次启动都变的话，上次装好的 hook 就指向了一个死端口。
// ============================================================

const http = require("node:http");
const crypto = require("node:crypto");
const { writePortFile } = require("./port-file");

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_PORT = 23333; // 与主仓库一致

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

// 裁决端点被拒时不回任何内容：不给对方反馈"你差在哪一步"
function sendRejected(res, code) {
  res.writeHead(code, { "content-length": 0 });
  res.end();
}

// 定长比较，避免通过响应时间猜 token
function safeEqual(got, expected) {
  const a = Buffer.from(String(got), "utf8");
  if (a.length !== expected.length) return false;
  return crypto.timingSafeEqual(a, expected);
}

/**
 * @param {{ store: ReturnType<import('./state').createStore>,
 *           portFile: string, token: string,
 *           permissions?: ReturnType<import('./permission').createPermissionCenter>,
 *           port?: number }} opts
 */
function startServer({ store, portFile, token, permissions, port = DEFAULT_PORT }) {
  if (typeof token !== "string" || token.length < 32) {
    throw new Error("startServer 需要一个至少 32 字符的随机 token");
  }
  const expected = Buffer.from(token, "utf8");

  const server = http.createServer(async (req, res) => {
    const addr = server.address();
    const actualPort = addr && typeof addr === "object" ? addr.port : 0;

    // ---- 1. Host：必须是本机回环 + 本进程端口 ----
    // DNS rebinding 就是靠"域名解析到 127.0.0.1"来绕同源策略的，这道锁专治它
    if (req.headers.host !== `127.0.0.1:${actualPort}`) {
      return sendRejected(res, 403);
    }

    // ---- 2. Origin：浏览器发起的跨源请求一律拒绝 ----
    // "null" 是 file:// 页面与沙箱 iframe 的 Origin，放行它由 token 兜底。
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null") {
      return sendRejected(res, 403);
    }

    // ---- 3. Content-Type：挡住不需要预检的简单请求 ----
    // text/plain 属于 CORS 简单请求，浏览器不发预检，请求会真的打到服务端。
    const isPost = req.method === "POST";
    if (isPost && !String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return sendRejected(res, 415);
    }

    const url = new URL(req.url, "http://127.0.0.1");

    // ---- /permission：裁决端点，没有 token 可校，三道边界已过完 ----
    if (isPost && url.pathname === "/permission") {
      // 没有权限中心（未启用气泡）→ 不做决定，让请求以 404 结束由对端回落
      if (!permissions) return sendRejected(res, 404);
      try {
        const payload = await readJsonBody(req);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return sendRejected(res, 400);
        }
        // 挂起响应；回写由 permission.js 在用户点击 / 超时时完成
        permissions.create(res, payload);
        return;
      } catch {
        return sendRejected(res, 400);
      }
    }

    // ---- 4. Token：只有 /state 与 /health 需要 ----
    if (!safeEqual(req.headers["x-clawd-token"] || "", expected)) {
      return sendJson(res, 401, { error: "bad token" });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/state") {
      return sendJson(res, 200, store.snapshot());
    }

    if (isPost && url.pathname === "/state") {
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

  // 端口占用时不要静默漂移：HTTP hook 的 url 是写死的，一漂移就失效。
  // 先试固定端口，失败才退回随机，并且明确报警。
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(
        `[clawd] 端口 ${port} 被占用，改用随机端口——已装的 PermissionRequest HTTP hook 会失效，需要重跑 npm run install:hooks`
      );
      server.listen(0, "127.0.0.1");
      return;
    }
    console.error("[clawd] server error:", err);
  });

  server.listen(port, "127.0.0.1", () => {
    const { port: actual } = server.address();
    writePortFile(portFile, { port: actual, token });
    console.log(`[clawd] state      POST http://127.0.0.1:${actual}/state`);
    console.log(`[clawd] permission POST http://127.0.0.1:${actual}/permission`);
    console.log(`[clawd] 端点已写入 ${portFile}（含 token，权限 0600）`);
    if (actual !== DEFAULT_PORT) {
      console.warn(`[clawd] 注意：不是默认端口 ${DEFAULT_PORT}，已装的 HTTP hook 需要更新`);
    }
  });

  return server;
}

module.exports = { startServer, safeEqual, DEFAULT_PORT };
