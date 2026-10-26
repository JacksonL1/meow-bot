"use strict";
// ============================================================
// 假数据源 —— 你在 S4 接真 hook 之前，全靠它活着
//
// 用法：
//   node scripts/fake-feed.js              # 走一遍完整剧本
//   node scripts/fake-feed.js Stop         # 只发一个事件
//   node scripts/fake-feed.js --hold working 10   # 保持 working 10 秒
//
// 原项目不用这么麻烦，它自带 bash test-demo.sh / test-oneshot-gate.sh。
// ============================================================

// 端点与 token 都从 userData 的端点文件读（SEC-02）。
// 读不到说明桌宠没开——这里直接退出，行为与真 hook 保持一致。
const { readPortFile } = require("../src/port-file");

const STATE_EVENT = {
  idle: "SessionStart",
  thinking: "UserPromptSubmit",
  working: "PreToolUse",
  error: "PostToolUseFailure",
  attention: "Stop",
  notification: "PermissionRequest",
};

function readEndpoint() {
  try {
    return readPortFile();
  } catch (err) {
    console.error(`读不到端点文件：${err.message}`);
    console.error("先把桌宠跑起来：npm start");
    process.exit(1);
  }
}

async function post(port, token, event, extra = {}) {
  const body = {
    agent: "fake",
    session_id: extra.session_id || "demo-session",
    event,
    cwd: process.cwd(),
    tool_name: extra.tool_name,
  };
  const res = await fetch(`http://127.0.0.1:${port}/state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawd-token": token,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(`  ${event.padEnd(18)} → HTTP ${res.status} ${data.error || ""}`);
    return;
  }
  console.log(`  ${event.padEnd(18)} → visual: ${data.visual}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { port, token } = readEndpoint();
  const arg = process.argv[2];

  // 形态一：--hold <state> <seconds>
  if (arg === "--hold") {
    const state = process.argv[3] || "working";
    const seconds = Number(process.argv[4] || 10);
    const event = STATE_EVENT[state];
    if (!event) {
      console.error(`未知状态：${state}，可选：${Object.keys(STATE_EVENT).join(" / ")}`);
      process.exit(1);
    }
    console.log(`保持 ${state} 共 ${seconds}s（每 2s 重发一次 ${event}）`);
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      await post(port, token, event);
      await sleep(2000);
    }
    return;
  }

  // 形态二：单个事件
  if (arg) {
    await post(port, token, arg);
    return;
  }

  // 形态三：完整剧本
  const script = [
    ["UserPromptSubmit", 0, "用户敲了一条 prompt"],
    ["PreToolUse", 1500, "开始调工具 → 打字"],
    ["PostToolUse", 1500, "工具返回，继续干活"],
    ["PostToolUseFailure", 1500, "工具失败 → 红色感叹号（oneshot）"],
    ["UserPromptSubmit", 3200, "重试一轮"],
    ["PreToolUse", 1200, "又忙起来了"],
    ["Stop", 2500, "这一轮结束 → 开心（oneshot）"],
    ["SessionEnd", 3500, "会话结束，桌宠回 idle"],
  ];

  console.log(`剧本模式，目标端口 ${port}\n`);
  for (const [event, delay, note] of script) {
    await sleep(delay);
    console.log(`· ${note}`);
    await post(port, token, event);
  }
  console.log("\n剧本结束。等 25 秒它会开始发呆，60 秒会睡着。");
}

main().catch((err) => {
  console.error("失败了：", err.message);
  process.exit(1);
});
