#!/usr/bin/env node
"use strict";
// ============================================================
// S4-2  把 hook 装进 agent 的 settings.json
//
// 这是整个项目里唯一会改用户全局配置的地方，所以四条规矩：
//   1. 先备份：settings.json.clawd-backup-<时间戳>
//   2. 原子写：同目录临时文件 + rename，不留半截 JSON
//   3. 认出自己：只动带 clawd 标记的条目，别人的一个字节都不碰
//   4. 幂等：重复执行不会产生重复 entry
//
// 用法：
//   node hooks/install.js                     # 默认 Claude Code
//   node hooks/install.js --agent workbuddy   # 换目标
//   node hooks/install.js --uninstall         # 卸载
//   node hooks/install.js --dry-run           # 只看结果，不写盘
//   node hooks/install.js --file <path>       # 换一个 settings 文件（测试用）
//
// ---- 为什么要有 AGENTS 表 ----
// 三家（Claude Code / CodeBuddy / WorkBuddy）的 hook **格式**是兼容的
// （都是 { matcher, hooks: [{type, command|url}] }），但契约有三处实质差异，
// 照抄 Claude 那一套会装出"看起来装好了、其实永远不触发"或者"重复触发"的结果：
//
//   1. 事件名不同：Claude 有 PostToolUseFailure，另两家没有；
//      另两家有 PreCompact，Claude 这一版没装。
//   2. matcher 取值不同：Claude 这边我们写 "*"，另两家主仓库一律写 ""。
//   3. 权限能力不同：CodeBuddy 真的会 POST /permission；
//      WorkBuddy 在原生沙箱 + GUI 里自己处理权限，**永不调用外部端点**
//      （主仓库 workbuddy-install.js 里甚至专门写代码去清理早期版本装下的死 URL）。
//      所以给 WorkBuddy 装 PermissionRequest 是纯粹的垃圾配置。
// ============================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readPortFile } = require("../src/port-file");
const { DEFAULT_PORT } = require("../src/server");

// command hook 的标记：只认命令里含这段的条目
const MARKER = "clawd-hook.js";
const HOOK_PATH = path.join(__dirname, "clawd-hook.js");
// HTTP hook 的标记放在 url 的 query 里：query 不影响服务端路由（只认 pathname），
// 但让我们在卸载时能一眼认出"这条是我们的"。
// 主仓库用的是 hook 的 name 字段（clawd-on-desk.permission.v1），两边互不干扰。
const HTTP_MARKER = "via=clawd-starter";

// S5：权限走 HTTP hook，由 agent 直接 POST 桌宠，响应体就是决定。
// 这是**阻塞式**的：不能加 async（加了就等于永远不给决定）。
// timeout 是 agent 侧的上限（秒）；我们 120s 没等到点击就回 204 让它回落原生提示。
const HTTP_EVENT = "PermissionRequest";
const HTTP_TIMEOUT_SEC = 600;

const AGENTS = {
  claude: {
    label: "Claude Code",
    configPath: path.join(os.homedir(), ".claude", "settings.json"),
    // 观察型事件（不含 PermissionRequest——那个走 HTTP，单独处理）
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
      "SessionEnd",
      "Notification",
    ],
    matcher: "*",
    // async: true 意味着"发出去就不管了"。Claude Code 支持这个字段，
    // 不加的话每次工具调用都要等 hook 退出，而 Windows 上 node 冷启动就 ~200ms。
    asyncHooks: true,
    permission: "http", // 支持 PermissionRequest HTTP hook
  },
  codebuddy: {
    label: "CodeBuddy",
    configPath: path.join(os.homedir(), ".codebuddy", "settings.json"),
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionEnd",
      "Notification",
      "PreCompact",
    ],
    matcher: "",
    // CodeBuddy 的官方安装器从不写 async，官方文档也没承诺这个字段。
    // 不写 = 走默认（阻塞）。代价是每个事件白等一次 node 冷启动，
    // 但写一个不被识别的字段风险更大，先按保守的来。
    asyncHooks: false,
    permission: "http",
  },
  workbuddy: {
    label: "WorkBuddy",
    configPath: path.join(os.homedir(), ".workbuddy", "settings.json"),
    events: [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionEnd",
      "Notification",
      "PreCompact",
    ],
    matcher: "",
    asyncHooks: false,
    // 桌面版 WorkBuddy 在原生沙箱 + GUI 里处理权限，永不调用外部端点。
    // 装一个指向我们 /permission 的 hook 只会变成一条死配置。
    permission: "none",
  },
};

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const dryRun = args.includes("--dry-run");

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function resolveAgent() {
  const name = argValue("--agent") || "claude";
  const agent = AGENTS[name];
  if (!agent) {
    throw new Error(`未知 agent：${name}（可选：${Object.keys(AGENTS).join(" / ")}）`);
  }
  return { name, ...agent };
}

// agent 与目标文件都在 main() 里解析：解析会抛（--agent 打错、路径不合法），
// 放在模块顶层 throw 会绕过下面的 try/catch，用户看到的是一段裸栈而不是"[clawd] 失败：…"。
let agent = null;
let settingsFile = null;

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

// 观察型 hook：只是"看一眼"，不 block 工具、不改 tool_input、不给裁决。
function ourGroup(ev, a) {
  const hook = { type: "command", command: ourCommand(ev) };
  if (a.asyncHooks) {
    hook.async = true;
    // timeout 是宿主侧兜底：异步 hook 正常 240ms 内退出，5s 是防呆不是预期。
    hook.timeout = 5;
  }
  return { matcher: a.matcher, hooks: [hook] };
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

function applyChanges(data, a) {
  const next = { ...data };
  const hooks = { ...(next.hooks || {}) };

  for (const ev of a.events) {
    const cleaned = stripOurs(hooks[ev]);
    if (uninstall) {
      if (cleaned.length > 0) hooks[ev] = cleaned;
      else delete hooks[ev];
    } else {
      hooks[ev] = [...cleaned, ourGroup(ev, a)];
    }
  }

  // 权限事件单独处理：
  //   permission === "http" → 装 url
  //   permission === "none" → 不装；但卸载时仍要清掉我们自己留下的残条
  if (a.permission === "http" || uninstall) {
    const cleanedHttp = stripOurs(hooks[HTTP_EVENT]);
    if (uninstall || a.permission === "none") {
      if (cleanedHttp.length > 0) hooks[HTTP_EVENT] = cleanedHttp;
      else delete hooks[HTTP_EVENT];
    } else {
      hooks[HTTP_EVENT] = [...cleanedHttp, ourHttpGroup(permissionPort())];
    }
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
  agent = resolveAgent();
  settingsFile = argValue("--file") ? path.resolve(argValue("--file")) : agent.configPath;

  const { existed, data } = readSettings();

  if (data.disableAllHooks === true) {
    console.warn(`[clawd] 注意：settings.json 里有 disableAllHooks: true，${agent.label} 会忽略所有 hook`);
  }

  const next = applyChanges(data, agent);
  const before = JSON.stringify(data);
  const after = JSON.stringify(next);

  if (before === after) {
    console.log(`[clawd] 无变化（${uninstall ? "已经卸载干净" : "已经装好了"}）：${settingsFile}`);
    return;
  }

  if (dryRun) {
    console.log(`[clawd] ${agent.label} --dry-run，以下是将写入 ${settingsFile} 的内容：\n`);
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (existed) {
    const dest = backup(settingsFile);
    console.log(`[clawd] 已备份 → ${dest}`);
  }
  writeAtomic(settingsFile, next);

  const permNote =
    agent.permission === "http"
      ? `+ 1 个阻塞式 HTTP hook`
      : `（${agent.label} 原生处理权限，不装权限 hook）`;
  console.log(
    uninstall
      ? `[clawd] 已从 ${settingsFile} 移除本项目的 hook（${agent.label}，其他配置原样保留）`
      : `[clawd] 已写入 ${settingsFile}（${agent.label}）：${agent.events.length} 个观察型 command hook ${permNote}`
  );
  if (!uninstall && agent.permission === "http") {
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
