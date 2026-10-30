#!/usr/bin/env node
"use strict";
// ============================================================
// S4-1  agent hook 适配器（claude / codebuddy / workbuddy 共用）
//
// 它的一生只有几毫秒，只走一个方向：
//   读 stdin JSON → 挑出字段 → POST 给桌宠 → 退出 0
//
// 曾经它还走另一个方向（送信：把信箱里的信写进 stdout，让宿主当上下文收下）。
// 信箱整套 2026-10-30 砍掉了，理由写在 DEVLOG 里：它解决的是一个不存在的问题
// ——用户想让 agent 知道什么，直接在对话里说是一跳直达，经桌宠转交是三跳，
// 还多出一个会丢信的环节。**hook 从此不再往 stdout 写一个字节**，
// 这让下面那条铁律变得更干净：stdout 不再是协议，也不再有"例外"。
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

// Notification 里有一部分是 WorkBuddy 自己的生命周期闲聊，不是"在等你"。
// 这两个值抄自主仓库 `hooks/workbuddy-hook.js:30` 的实测注释：
//   idle_prompt  —— "再发一条消息吧"的提醒（Stop 之后约 60 秒）
//   auth_success —— 登录成功的 toast（每一轮开头都发一次）
// 必须在**源头**滤掉而不是交给状态机：notification 是"真的在等你"的长状态
// （内置上限 10 分钟，见 state.js），让一条 idle_prompt 挂上来，
// 桌宠就会凭空提示好几分钟。
//
// 白名单式的：只丢明确列出的这两种，没见过的 notification_type 照常放行
// ——反过来的写法（只放行认识的）会把真提示也一起挡掉，而那种 bug
// 从日志上完全看不出来。
const IGNORED_NOTIFICATION_TYPES = new Set(["idle_prompt", "auth_success"]);

// ---- 会话标题：看板上唯一"像人话"的那一行 ----
//
// 两个来源，按质量排序（抄自主仓库 hooks/workbuddy-hook.js:135-160）：
//   ① payload.session_title  —— WorkBuddy 的 /rename，用户自己起的名，最准
//   ② UserPromptSubmit 时 prompt 的**第一行非空文字** —— 没有改名时的兜底
// 刻意**不**回退到 cwd / session_id：服务端对标题是"粘"的（后来的事件大多
// 不带标题，用一个低质量值去覆盖好标题，比没有标题更糟）。
//
// 上限 60 是主仓库的实测值：再长就看板上就开始挤掉目录名了。
const TITLE_MAX = 60;

// 密钥不能进标题。用户 prompt 的第一行有可能**正好就是**一段密钥
// （"帮我把这个 token 配进去 sk-xxxx"），而看板是会**上屏幕**的。
// 命中就**整个标题都不要**，不是"洗掉再显示"——洗到一半的密钥仍然是密钥，
// 而少一行标题只是少一行字。正则同样抄自主仓库。
const TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function clipTitle(s) {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;
}

// 返回 undefined = 这一轮没有值得显示的标题（调用方就不会带上这个字段）
function deriveTitle(event, payload) {
  const named = typeof payload.session_title === "string" ? payload.session_title.trim() : "";
  if (named) return clipTitle(named);
  if (event === "UserPromptSubmit" && typeof payload.prompt === "string") {
    for (const line of payload.prompt.split(/\r?\n/)) {
      const c = line.trim();
      if (!c) continue; // 跳过开头的空行，第一句话才是标题
      if (TITLE_SECRET_RE.test(c)) return undefined;
      return clipTitle(c);
    }
  }
  return undefined;
}

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
  // 1) 读 stdin（带硬超时），排在探端口之前。
  //    这个顺序最初是为送信定的（信不依赖桌宠在跑），送信砍掉之后它其实
  //    变成了一个待议项：单看"收"这一路，先探端口能省掉一次 stdin 读取。
  //    但先读也有它的道理——宿主是先把 payload 写进管道再等我们退出的，
  //    我们抢在它写完之前 exit(0)，写的一端就可能拿到 EPIPE。
  //    在有人实测过宿主对 EPIPE 的反应之前，不动这个顺序。
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


  // 2) 再探端口：桌宠没开就到此为止，不重试、不打印、退 0
  let endpoint;
  try {
    endpoint = readPortFile();
  } catch {
    return;
  }

  // 缺 session_id 的事件**不报**，绝不给它合成一个占位 id。
  //
  // 原来写的是 `field(payload.session_id) || "unknown"`，后果有两层，第二层才要命：
  //   ① 多条真实会话的事件被塞进同一条叫 "unknown" 的会话，Dashboard 上只剩一个幽灵；
  //   ② 它们的事件互相覆盖——A 正在 thinking，B 结束了发一个 Stop →
  //      attention 播完 800ms 回 idle，**A 的画面就变成 idle**。
  //      这正是用户报的"thinking 时显示 idle"的第二个可能来源。
  // 主仓库 hooks/workbuddy-hook.js 这条是带着 bug 编号的（#618 / #648）：
  // 合成 id 会造出一个"后面的事件既更新不了、也清除不掉"的幻影会话。
  // 会话不见了还有 MAX_SESSIONS 的淘汰兜底，状态互相污染没有兜底。
  //
  // 警告走 stderr：**这个文件绝不往 stdout 写一个字节**（信箱砍掉之后，stdout
  // 不再是协议通道，连"例外"都没有了；但 stderr 才是该用来抱怨的地方，这个习惯保留）。
  // trim 过后再判空：`"   "` 是 truthy 字符串，不 trim 就会被当成有效会话号，
  // 于是几条来自不同会话的事件照样会合并到同一条 `"   "` 会话里。
  const rawSid = field(payload.session_id);
  const sid = rawSid ? rawSid.trim() : undefined;
  if (!sid) {
    console.error(`[clawd-hook] 事件 ${event} 没带 session_id，已丢弃（不合成占位会话）`);
    return;
  }

  // Notification 里有一部分是 WorkBuddy 自己的生命周期闲聊，不是"在等你"。
  // 这两个值是主仓库 hooks/workbuddy-hook.js:30 实测列出来的：
  //   idle_prompt —— "再发一条消息吧"的提醒（Stop 之后约 60 秒）
  //   auth_success —— 登录成功的 toast（每一轮开头都发一次）
  // 必须在**源头**滤掉而不是交给状态机：notification 是"真的在等你"的长状态，
  // 让一条 idle_prompt 挂上来，桌宠就会凭空提示好几分钟（见 state.js 那条注释）。
  if (event === "Notification") {
    const ntype = field(payload.notification_type);
    if (ntype && IGNORED_NOTIFICATION_TYPES.has(ntype)) return;
  }

  // 3) 只取需要的字段，其余一律丢弃（不落盘、不打日志）
  //
  // 标题在这里算完再走：prompt 是用户原文，它**不离开这个进程**——
  // 我们只把"第一行"这一条派生结果发出去。真要把 prompt 整段 POST 给桌宠，
  // 就等于给本机 HTTP 那条链路上多挂一份用户原文。
  const title = deriveTitle(event, payload);
  const body = JSON.stringify({
    agent: "claude-code",
    session_id: sid,
    event,
    cwd: field(payload.cwd, MAX_CWD),
    tool_name: field(payload.tool_name),
    ...(title ? { title } : {}),
  });

  await post(endpoint, body);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
