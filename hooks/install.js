#!/usr/bin/env node
"use strict";
// ============================================================
// S4-2  把 hook 装进 ~/.claude/settings.json
//
// 这是整个项目里唯一会改用户全局配置的地方，所以四条规矩：
//   1. 先备份：settings.json.clawd-backup-<时间戳>
//   2. 原子写：同目录临时文件 + rename，不留半截 JSON
//   3. 认出自己：只动命令里含 "clawd-hook.js" 的条目，别人的一个字节都不碰
//   4. 幂等：重复执行不会产生重复 entry
//
// 用法：
//   node hooks/install.js                 # 安装
//   node hooks/install.js --uninstall     # 卸载
//   node hooks/install.js --dry-run       # 只看结果，不写盘
//   node hooks/install.js --file <path>   # 换一个 settings 文件（测试用）
// ============================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readPortFile } = require("../src/port-file");
const { DEFAULT_PORT } = require("../src/server");

const MARKER = "clawd-hook.js";
const HOOK_PATH = path.join(__dirname, "clawd-hook.js");
// HTTP hook 的标记放在 url 的 query 里：query 不影响服务端路由（只认 pathname），
// 但让我们在卸载时能一眼认出"这条是我们的"。
const HTTP_MARKER = "via=clawd-starter";

// 只装 S4 用到的事件（观察型，全部 async）。
// PermissionRequest 走 HTTP hook，不在这个列表里——见下面的 HTTP_EVENT。
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SessionEnd",
  "Notification",
];

// S5：权限走 HTTP hook，由 Claude Code 直接 POST 桌宠，响应体就是决定。
// 这是**阻塞式**的：不能加 async（加了就等于永远不给决定）。
// timeout 是 Claude Code 侧的上限（秒）；桌宠自己 120s 没等到点击就回 204 让它回落原生提示。
const HTTP_EVENT = "PermissionRequest";
const HTTP_TIMEOUT_SEC = 600;

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const dryRun = args.includes("--dry-run");
const fileArgIndex = args.indexOf("--file");
const settingsFile =
  fileArgIndex >= 0 && args[fileArgIndex + 1]
    ? path.resolve(args[fileArgIndex + 1])
    : path.join(os.homedir(), ".claude", "settings.json");

function isOurs(hook) {
  if (!hook || typeof hook !== "object") return false;
  if (typeof hook.command === "string" && hook.command.includes(MARKER)) return true;
  return hook.type === "http" && typeof hook.url === "string" && hook.url.includes(HTTP_MARKER);
}

// 桌宠没开就读不到端点文件，退回默认端口——装了也没用，但至少 url 是合法的，
// 等桌宠起来后重跑一次 install 就会指向真端口。
function permissionPort() {
  try {
    return readPortFile().port;
  } catch {
    return DEFAULT_PORT;
  }
}

// 从某个事件的 entry 数组里摘掉我们自己的 hook；顺手丢掉被摘空的组
function stripOurs(groups) {
  if (!Array.isArray(groups)) return [];
  const kept = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") {
      kept.push(group);
      continue;
    }
    const inner = Array.isArray(group.hooks) ? group.hooks.filter((h) => !isOurs(h)) : [];
    if (inner.length === 0) continue; // 整组都是我们的 → 整组不要
    kept.push({ ...group, hooks: inner });
  }
  return kept;
}

function ourCommand(event) {
  // 路径可能带空格，一律加引号；node 用绝对路径避免 PATH 差异
  return `node "${HOOK_PATH}" ${event}`;
}

// async: true —— S4 的全部事件都只是"看一眼"，不参与决策：
// 不 block 工具、不改 tool_input、不给 permissionDecision。
// 不加这个字段的话，Claude Code 会等 hook 退出才继续，
// 而 Windows 上 node 进程冷启动就要 ~200ms，等于每次工具调用都白扔 200ms。
// （对照主仓库 docs/project/agent-runtime-architecture.md:772：
//   PermissionRequest 用阻塞式 HTTP hook，因为要返回裁决；其他事件一律非阻塞。）
// timeout 是宿主侧的兜底：异步 hook 正常情况下 240ms 内退出，5s 是防呆不是预期。
function ourGroup(event) {
  return {
    matcher: "*",
    hooks: [{ type: "command", command: ourCommand(event), async: true, timeout: 5 }],
  };
}

function ourHttpGroup(port) {
  return {
    matcher: "",
    hooks: [
      {
        type: "http",
        url: `http://127.0.0.1:${port}/permission?${HTTP_MARKER}`,
        // 注意：这里**故意不写 async**。async hook 发出去就不管了，
        // 而权限请求要的就是"等回答"，加了 async 等于永远不给决定。
        timeout: HTTP_TIMEOUT_SEC,
      },
    ],
  };
}

function readSettings() {
  if (!fs.existsSync(settingsFile)) {
    return { existed: false, data: {} };
  }
  const raw = fs.readFileSync(settingsFile, "utf8");
  const data = JSON.parse(raw); // 解析失败直接抛，绝不覆盖一个我们看不懂的文件
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("settings.json 顶层不是对象，停止操作");
  }
  if (data.hooks !== undefined && (typeof data.hooks !== "object" || Array.isArray(data.hooks))) {
    throw new Error("settings.json 的 hooks 字段不是对象，停止操作");
  }
  return { existed: true, data };
}

function applyChanges(data) {
  const next = { ...data };
  const hooks = { ...(next.hooks || {}) };

  for (const event of EVENTS) {
    const cleaned = stripOurs(hooks[event]);
    if (uninstall) {
      if (cleaned.length > 0) hooks[event] = cleaned;
      else delete hooks[event];
    } else {
      hooks[event] = [...cleaned, ourGroup(event)];
    }
  }

  // S5：PermissionRequest 是 HTTP-only 事件，装的是 url 不是命令。
  // 顺带把这一组里残留的 command hook 也清掉（老版本可能装过）。
  const cleanedHttp = stripOurs(hooks[HTTP_EVENT]);
  if (uninstall) {
    if (cleanedHttp.length > 0) hooks[HTTP_EVENT] = cleanedHttp;
    else delete hooks[HTTP_EVENT];
  } else {
    hooks[HTTP_EVENT] = [...cleanedHttp, ourHttpGroup(permissionPort())];
  }

  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  return next;
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.clawd-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.clawd-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file); // 同分区 rename 是原子的，不会留下半个文件
}

function main() {
  const { existed, data } = readSettings();

  if (data.disableAllHooks === true) {
    console.warn("[clawd] 注意：settings.json 里有 disableAllHooks: true，Claude Code 会忽略所有 hook");
  }

  const next = applyChanges(data);
  const before = JSON.stringify(data);
  const after = JSON.stringify(next);

  if (before === after) {
    console.log(`[clawd] 无变化（${uninstall ? "已经卸载干净" : "已经装好了"}）：${settingsFile}`);
    return;
  }

  if (dryRun) {
    console.log(`[clawd] --dry-run，以下是将写入 ${settingsFile} 的内容：\n`);
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (existed) {
    const dest = backup(settingsFile);
    console.log(`[clawd] 已备份 → ${dest}`);
  }
  writeAtomic(settingsFile, next);

  console.log(
    uninstall
      ? `[clawd] 已从 ${settingsFile} 移除本项目的 hook（其他配置原样保留）`
      : `[clawd] 已写入 ${settingsFile}：${EVENTS.length} 个观察型 command hook + 1 个阻塞式 HTTP hook`
  );
  if (!uninstall) {
    console.log(`[clawd] command hook：${HOOK_PATH}`);
    console.log(`[clawd] 权限 HTTP hook：http://127.0.0.1:${permissionPort()}/permission（阻塞，${HTTP_TIMEOUT_SEC}s）`);
    console.log(`[clawd] 注意：端口变了要重跑一次 install，否则权限请求会打到死端口`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[clawd] 失败：${err.message}`);
  console.error("[clawd] 未修改任何文件。");
  process.exit(1);
}
