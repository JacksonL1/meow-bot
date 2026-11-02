// 诊断：Tauri 页面上到底还剩下哪些"能调后端"的入口？
//
// 为什么留这个文件：`withGlobalTauri` 关掉之后，"渲染层还能不能拿到通用
// invoke 口子"这个问题**不能靠读文档回答**——答案是"能，但只剩一个不可配置的
// 内部对象"。将来升级 Tauri 时这个结论会变，而这个脚本是唯一能一分钟内
// 重新测一遍的东西。用法：node scripts/probe-tauri-surface.js [--release]
//
// 它只读不写：起一份带临时端点文件的实例，用 CDP 读几个全局，然后杀掉。
const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { Cdp, sleep } = require("./cdp");

const ROOT = path.join(__dirname, "..");
const CDP_PORT = 9333;
const RELEASE = process.argv.includes("--release");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-probe-"));
const PORT_FILE = path.join(TMP, "probe.port");
const EXE = path.join(
  ROOT,
  "src-tauri",
  "target",
  RELEASE ? "release" : "debug",
  process.platform === "win32" ? "clawd-starter.exe" : "clawd-starter"
);

const child = spawn(EXE, [], {
  cwd: ROOT,
  env: {
    ...process.env,
    CLAWD_PORT_FILE: PORT_FILE, // 不与用户正在跑的那份抢单实例锁
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
  stdio: "ignore",
});

async function findMainTarget() {
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const hit = list.find(
        (t) => t.type === "page" && !t.url.includes("bubble") && !t.url.includes("dashboard")
      );
      if (hit) return hit;
    } catch {}
  }
  return null;
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`找不到 ${EXE}\n先跑 cargo build（或加 --release 前先 cargo build --release）`);
    process.exit(1);
  }
  const target = await findMainTarget();
  if (!target) throw new Error("主窗口 20s 内没暴露 CDP");
  const R = await Cdp.connect(target.webSocketDebuggerUrl);
  await R.send("Runtime.enable");
  await sleep(500);
  const q = async (expr) => JSON.stringify(await R.eval(expr));

  console.log("宿主标记             :", await q("window.__CLAWD_HOST__"));
  console.log("typeof __TAURI__     :", await q("typeof window.__TAURI__"));
  console.log("typeof __TAURI_INTERNALS__ :", await q("typeof window.__TAURI_INTERNALS__"));
  console.log("internals 自有键     :", await q("window.__TAURI_INTERNALS__ ? Object.keys(window.__TAURI_INTERNALS__) : null"));
  console.log(
    "internals 描述符     :",
    await q(
      "JSON.stringify(Object.getOwnPropertyDescriptor(window,'__TAURI_INTERNALS__'),(k,v)=>typeof v==='function'?'[fn]':v)"
    )
  );
  console.log("可删除吗             :", await q("(()=>{try{return delete window.__TAURI_INTERNALS__}catch(e){return 'throw:'+e.message}})()"));
  console.log("window.clawd 动作数  :", await q("window.clawd ? Object.keys(window.clawd).length : null"));
  console.log("通用 invoke 还在吗   :", await q("typeof (window.__TAURI_INTERNALS__||{}).invoke"));
  console.log(
    "越权调 permission_decide :",
    await q(
      "window.__TAURI_INTERNALS__.invoke('permission_decide',{id:1,decision:'allow'}).then(()=>'ALLOWED').catch(e=>'ERR:'+String(e))"
    )
  );
  R.close();
}

main()
  .catch((e) => console.error("探针失败:", e.message))
  .finally(() => {
    try {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch {}
  });
