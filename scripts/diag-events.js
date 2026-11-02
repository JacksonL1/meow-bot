#!/usr/bin/env node
"use strict";
// ============================================================
// 状态诊断（S10-7）
//
// 它回答"它为什么是 idle"——本项目最难查的一类问题，因为**没有任何报错**：
// hook POST 成功、服务回 200、页面安静。只看画面永远看不出来，
// 必须把状态机自己记的账读出来。
//
// 数据源是 `GET /state`（带 token）里的 `recent` 数组，每条：
//   { t, event, sid, from, to, how }
//
// `how` 就是答案：
//   mapped        —— 事件认得，状态真的改了
//   same          —— 事件认得，但目标状态跟当前一样（不算 bug）
//   ignored       —— **事件名不认得**，什么都没改 ← 掉 idle 的头号嫌疑
//   preserved     —— SessionStart 撞上已有会话，原状态被保住了（S10-6③ 修的就是这个）
//   session-end   —— 会话被删了（没有会话时仲裁结果就是 idle，这是对的）
//   woke          —— 鼠标把它弄醒了
//
// 用法：
//   node scripts/diag-events.js                      # 读本机正在跑的那份
//   node scripts/diag-events.js --port-file <path>   # 读指定端点文件（回归隔离用）
//   node scripts/diag-events.js --replay             # 起临时实例，回放一轮事件序列
// ============================================================

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Cdp, sleep } = require("./cdp");

const ROOT = path.join(__dirname, "..");
const CDP_PORT = 9335;

function realEndpointFile() {
  return require(path.join(ROOT, "src", "port-file.js")).portFilePath();
}

function httpJson(opts, body) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const headers = Object.assign(
      { Host: `127.0.0.1:${opts.port}`, Origin: "null" },
      data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      opts.token ? { "X-Clawd-Token": opts.token } : {}
    );
    const req = http.request(
      { host: "127.0.0.1", port: opts.port, path: opts.path, method: opts.method || "GET", headers, timeout: opts.timeout || 3000 },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ code: res.statusCode, body: b }));
      }
    );
    req.on("error", (e) => resolve({ code: 0, body: String(e) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ code: 0, body: "timeout" });
    });
    if (data) req.write(data);
    req.end();
  });
}

function waitTargets(port, type, ms = 15000) {
  const deadline = Date.now() + ms;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const b = await new Promise((resolve, reject) => {
          const r = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 800 }, (res) => {
            let s = "";
            res.on("data", (d) => (s += d));
            res.on("end", () => resolve(s));
          });
          r.on("error", reject);
          r.on("timeout", () => {
            r.destroy();
            reject(new Error("timeout"));
          });
        });
        const j = JSON.parse(b);
        const hit = type ? j.filter((t) => t.type === type) : j;
        if (hit.length) return hit;
      } catch {}
      await sleep(300);
    }
    return null;
  })();
}

// 一轮真实会话大概长这样。顺序**照抄现场观察到的**：
//   SessionStart（新会话）→ UserPromptSubmit（thinking）→ SessionStart（约 0.1s 后补发）
//   → PreToolUse（working）→ PostToolUse → PreCompact（压缩上下文）→ SessionStart(source=compact)
//   → UserPromptSubmit → Stop（attention）→ SessionEnd
//
// 每条都带 `expect`：期望的 visual。用显式期望值而不是"是不是 idle"这种启发式——
// 新会话的 SessionStart 本来就该是 idle，用启发式会把它误判成 bug，
// 而误报过一次之后，这个脚本的警报就再也没人信了。
//
// 第 3 和第 7 条是**问题 1 的回归点**，两个症状同一个根因：
//   thinking 时补发的 SessionStart、压缩后补发的 SessionStart，
//   都在"一条已经存在的会话"上。按普通映射处理 = 把 thinking/working 清成 idle。
function roundEvents(sid) {
  return [
    { send: { event: "SessionStart", session_id: sid, cwd: "E:/JacksonLee/project/clawd-starter" }, expect: "idle" },
    { send: { event: "UserPromptSubmit", session_id: sid, title: "改登录页", keyword: "登录" }, expect: "thinking" },
    { send: { event: "SessionStart", session_id: sid, cwd: "E:/JacksonLee/project/clawd-starter" }, expect: "thinking" },
    { send: { event: "PreToolUse", session_id: sid, tool_name: "Edit" }, expect: "working" },
    { send: { event: "PostToolUse", session_id: sid, tool_name: "Edit" }, expect: "working" },
    { send: { event: "PreCompact", session_id: sid }, expect: "working" },
    { send: { event: "SessionStart", session_id: sid, source: "compact", cwd: "E:/JacksonLee/project/clawd-starter" }, expect: "working" },
    { send: { event: "UserPromptSubmit", session_id: sid, title: "改登录页" }, expect: "thinking" },
    { send: { event: "Stop", session_id: sid }, expect: "attention" },
    { send: { event: "SessionEnd", session_id: sid }, expect: "idle" },
  ];
}

async function dump() {
  const pfIdx = process.argv.indexOf("--port-file");
  const portFile = pfIdx > 0 ? process.argv[pfIdx + 1] : realEndpointFile();
  if (!fs.existsSync(portFile)) {
    console.error("端点文件不存在：" + portFile);
    console.error("桌宠没在跑。先启动桌宠，再跑这个脚本。");
    process.exit(1);
  }
  const ep = JSON.parse(fs.readFileSync(portFile, "utf8"));
  const r = await httpJson({ port: ep.port, path: "/state", token: ep.token });
  if (r.code === 0) {
    // 端点文件还在、端口没人听 —— 上一轮没清干净（崩溃 / taskkill /F）。
    // 这跟"桌宠没启动"是两回事，报错说清楚，否则用户会反复重启也修不好。
    console.error(`端点文件还在（port=${ep.port}），但没有进程在监听：${r.body}`);
    console.error("这是上一次没收尾留下的。删掉它就等于清零：");
    console.error("  " + portFile);
    process.exit(1);
  }
  if (r.code !== 200) {
    console.error("读 /state 失败：code=" + r.code + " body=" + r.body);
    process.exit(1);
  }
  const snap = JSON.parse(r.body);

  console.log("\n== 当前该显示什么 ==");
  console.log("  visual: " + (snap.visual || "(none)"));
  console.log("\n== 会话 ==");
  if (!snap.sessions.length) console.log("  （没有会话）");
  for (const s of snap.sessions) {
    console.log(`  ${s.id}  state=${s.state}  idle=${Math.round(s.idleMs / 1000)}s  title=${s.title || "-"}  tool=${s.tool || "-"}  keyword=${s.keyword || "-"}`);
  }

  const tIdx = process.argv.indexOf("--tail");
  const tail = tIdx > 0 ? Number(process.argv[tIdx + 1] || 20) : 20;
  const rows = (snap.recent || []).slice(-tail);
  console.log(`\n== 最近 ${tail} 条事件 ==`);
  if (!rows.length) console.log("  （还没有事件。hook 装了吗？先跑 npm run preview:hooks）");
  for (const e of rows) {
    const t = e.t ? new Date(e.t).toLocaleTimeString() : "-";
    console.log(`  ${t}  ${String(e.event).padEnd(20)} ${e.sid}  ${e.from} -> ${e.to}  [${e.how}]`);
  }

  const uniqIgnored = [...new Set(rows.filter((e) => e.how === "ignored").map((e) => e.event))];
  console.log("\n== 结论 ==");
  if (uniqIgnored.length) {
    console.log(`  有 ${uniqIgnored.length} 种事件名没被认出来：${uniqIgnored.join(", ")}`);
    console.log("  这就是掉 idle 最可能的原因：这些事件什么都没改，");
    console.log("  状态就停在上一轮结束时的 idle。把它补进 EVENT_STATE 即可。");
  } else {
    console.log("  这批事件里没有未知事件名。若它仍然掉 idle，");
    console.log("  看上面表格里哪一条把状态改成了 idle（from -> to 那一列）。");
  }
}

// ---- 回放：起一份临时实例，喂一轮真实事件序列 ----
// 这个方法存在的理由：真锁屏 / 真压缩上下文没法在回归里制造，
// 但**事件序列是可以照抄的** —— 把现场看到的顺序喂一遍，就能看出哪一步掉 idle。
async function replay() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-diag-"));
  const portFile = path.join(tmp, "clawd-starter.port");
  const exe = path.join(ROOT, "src-tauri", "target", "release", "clawd-starter.exe");
  const child = spawn(exe, [], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      CLAWD_PORT_FILE: portFile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let ep = null;
  for (let i = 0; i < 60 && !ep; i++) {
    await sleep(250);
    try { ep = JSON.parse(fs.readFileSync(portFile, "utf8")); } catch {}
  }
  if (!ep) { console.error("临时实例没起来"); child.kill(); process.exit(1); }

  const list = await waitTargets(CDP_PORT, "page");
  if (!list || !list.length) { console.error("连不上临时实例的 CDP"); child.kill(); process.exit(1); }
  const R = await Cdp.connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await R.send("Runtime.enable");

  // 等页面把 petDebug 挂上再开始。不等的话第一条一定读到 null，
  // 那不是 "掉了"，是"还没醒"——混在一起看会把脚本自己的时序当成 bug。
  for (let i = 0; i < 40; i++) {
    const ok = await R.eval("typeof window.petDebug === 'object' && !!window.petDebug");
    if (ok) break;
    await sleep(250);
  }

  console.log("\n== 回放一轮真实事件序列 ==");
  console.log("   事件                  期望      服务端    画面      判定");
  let bad = 0;
  for (const step of roundEvents("diag-1")) {
    const ev = step.send;
    await httpJson({ port: ep.port, path: "/state", method: "POST", token: ep.token }, ev);
    await sleep(150);
    // 两边都读：服务端 = 状态机的仲裁结果，画面 = 渲染层真的切过去了没。
    // 只读一边的话，分不清是"状态机算错"还是"算对了但没送到屏幕上"。
    const st = await httpJson({ port: ep.port, path: "/state", token: ep.token });
    const snap = st.code === 200 ? JSON.parse(st.body) : { visual: "?" };
    const visual = await R.eval("window.petDebug ? window.petDebug.state() : null");
    const ok = snap.visual === step.expect && visual === step.expect;
    if (!ok) bad++;
    let verdict = ok ? "" : `<-- 期望 ${step.expect}`;
    if (!ok && snap.visual !== visual) verdict += `，且层间不一致（服务端 ${snap.visual} / 画面 ${visual}）`;
    console.log(
      `  ${ev.event.padEnd(20)} ${String(step.expect).padEnd(9)} ${String(snap.visual).padEnd(9)} ${String(visual).padEnd(9)} ${verdict}`
    );
  }
  console.log(bad ? `\n  ${bad} 步不符合期望` : "\n  全部符合期望（含 thinking 保住、压缩后不回 idle）");
  R.close();
  try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(bad ? 1 : 0);
}

const mode = process.argv.includes("--replay") ? replay : dump;
mode().catch((e) => {
  console.error("脚本自身出错：", e && e.stack);
  process.exit(1);
});
