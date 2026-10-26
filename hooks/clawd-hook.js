#!/usr/bin/env node
"use strict";
// ============================================================
// S4-1  Claude Code hook 适配器（原项目对应 hooks/clawd-hook.js）
//
// 它的一生只有几毫秒：
//   读 stdin JSON → 挑出 3 个字段 → POST 给桌宠 → 退出 0
//
// 三条铁律（来自 SECURITY.md 的 S4 预判）：
//   1. 绝不阻塞 agent —— stdin 2s 硬超时，POST 1.5s 超时，到点就走
//   2. 绝不打日志 —— stdin 里有用户 prompt、文件路径、工具参数
//   3. 绝不抛异常 —— 任何失败都 process.exit(0)，安静得像没装过
//
// 用法（由 install.js 写进 ~/.claude/settings.json）：
//   node clawd-hook.js PreToolUse
// 事件名优先取 stdin 里的 hook_event_name，命令行参数只是兜底。
// ============================================================

const { readPortFile } = require("../src/port-file");

const STDIN_TIMEOUT_MS = 2000;
const POST_TIMEOUT_MS = 1500;
const MAX_STDIN_BYTES = 1024 * 1024; // 1MB，正常的 hook payload 远小于这个
const MAX_FIELD = 64;
const MAX_CWD = 1024;

// 只做长度截断和类型收敛，不做语义判断——语义归状态机
function field(v, max = MAX_FIELD) {
  return typeof v === "string" && v ? v.slice(0, max) : undefined;
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks = [];

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) return done(null); // 超限当作读不到，别把内存吃了
      chunks.push(chunk);
    });
    process.stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => done(null));
  });
}

function post(endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  return fetch(`http://127.0.0.1:${endpoint.port}/state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawd-token": endpoint.token,
    },
    body,
    signal: controller.signal,
  })
    .catch(() => null) // 桌宠中途关了、端口没响应，都算正常情况
    .finally(() => clearTimeout(timer));
}

async function main() {
  // 1) 桌宠没开就到此为止：不重试、不打印、退 0
  let endpoint;
  try {
    endpoint = readPortFile();
  } catch {
    return;
  }

  // 2) 读 stdin（带硬超时）
  const raw = await readStdin(STDIN_TIMEOUT_MS);
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {}; // 解析失败按空对象继续，事件名退回 argv
    }
  }
  if (!payload || typeof payload !== "object") payload = {};

  const event = field(payload.hook_event_name) || field(process.argv[2]);
  if (!event) return;

  // 3) 只取需要的字段，其余一律丢弃（不落盘、不打日志）
  const body = JSON.stringify({
    agent: "claude-code",
    session_id: field(payload.session_id) || "unknown",
    event,
    cwd: field(payload.cwd, MAX_CWD),
    tool_name: field(payload.tool_name),
  });

  await post(endpoint, body);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
