#!/usr/bin/env node
"use strict";
// ============================================================
// S4-1  agent hook 适配器（claude / codebuddy / workbuddy 共用）
//
// 它的一生只有几毫秒，但走**两个方向**：
//   收：读 stdin JSON → 挑出 3 个字段 → POST 给桌宠 → 退出 0
//   送：UserPromptSubmit 时把信箱里的信写进 stdout → 宿主当上下文收下
//
// 三条铁律（来自 SECURITY.md 的 S4 预判）：
//   1. 绝不阻塞 agent —— stdin 2s 硬超时，POST 1.5s 超时，到点就走
//   2. 绝不打日志 —— stdin 里有用户 prompt、文件路径、工具参数
//      （例外：UserPromptSubmit 的信件 JSON 是**协议输出**，不是日志）
//   3. 绝不抛异常 —— 任何失败都 process.exit(0)，安静得像没装过
//
// 用法（由 install.js 写进 ~/.claude/settings.json）：
//   node clawd-hook.js PreToolUse
// 事件名优先取 stdin 里的 hook_event_name，命令行参数只是兜底。
// ============================================================

const { readPortFile } = require("../src/port-file");
const mailbox = require("../src/mailbox");

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

// ---- S8：送信 ----
// 只在 UserPromptSubmit 上做，因为**只有这个事件的 stdout 会被加进上下文**
// （官方文档：退出码 0 时 stdout 一般只显示给用户，但 UserPromptSubmit 和
// SessionStart 是例外——stdout 会进上下文）。
//
// 三条必须守住的边界：
//   1. 没有信时**一个字节都不输出**。UserPromptSubmit 的 stdout 会被塞进
//      用户的消息里，多打一个换行都是在污染每一次对话。
//   2. 输出必须是合法 JSON。半截 JSON 宿主解析不了，等于信没寄出去。
//   3. 送信**不依赖桌宠是否在跑**。信是桌宠写的，但寄的时候桌宠可能已经关了；
//      这个函数在 readPortFile() 之前调用，就是为此。
async function deliverLetters(event) {
  if (event !== "UserPromptSubmit") return;

  let result;
  try {
    result = mailbox.take();
  } catch {
    return; // 信箱目录不可读之类，当作没信
  }
  if (!result || !Array.isArray(result.letters) || result.letters.length === 0) return;

  let text;
  try {
    text = mailbox.format(result.letters);
  } catch {
    return;
  }
  if (!text) return;

  const payload = JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });

  // 等一下写完再走：process.exit() 在管道上会截断还没 flush 的输出，
  // 而截断的 JSON 在宿主那边就是"没有输出"——信白寄了，而且没有任何报错。
  await new Promise((resolve) => {
    process.stdout.write(payload + "\n", () => resolve());
  });
}

async function main() {
  // 1) 读 stdin（带硬超时）。这一步不能因为"桌宠没开"而跳过：
  //    以前是先探端口再读 stdin，理由是省一次等待；但那样一来
  //    桌宠关着的时候就永远寄不了信了。
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

  // 2) 先送信。失败也不抛 —— 信送不出去不能连累 agent 的正常流程。
  await deliverLetters(event);

  // 3) 再报事件：桌宠没开就到此为止，不重试、不打印、退 0
  let endpoint;
  try {
    endpoint = readPortFile();
  } catch {
    return;
  }

  // 4) 只取需要的字段，其余一律丢弃（不落盘、不打日志）
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
