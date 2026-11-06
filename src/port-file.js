"use strict";
// ============================================================
// 端点文件的读写（SEC-02 / SEC-10）
//
// 位置：统一放 userData，不再写项目根目录
//   Windows  %APPDATA%\clawd-starter\clawd-starter.port
//   macOS    ~/Library/Application Support/clawd-starter/...
//   Linux    ~/.config/clawd-starter/...
//
// 内容：JSON，含端口与 token
//   { "port": 57541, "token": "64 位十六进制" }
//
// 为什么不用 app.getPath('userData')？因为 fake-feed.js 是纯 Node 进程，
// 拿不到 Electron API。这里用同一套规则算出路径，两边才能对上。
// ============================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_DIR = "clawd-starter";
const FILE_NAME = "clawd-starter.port";

// 默认端口。放在这里而不是 server.js：2026-11-03 删掉 Electron 容器后
// server.js 整份没了，但这个数字还有人要——`hooks/install.js` 装 hook 时
// 要把端点 URL 写进 agent 的配置，用的是它。
// 2026-11-06 从 23333 挪到 27333：23333 与主仓库 clawd-on-desk 相同，
// 且与用户本机 Claude Code 的 ANTHROPIC_BASE_URL 重合（桌宠先启动就占住
// 人家模型网关的端口）。**这台机器上没有任何已装的 HTTP hook 指向旧端口**
// （三条 agent 配置都查过），所以挪是安全的；以后再改这个数之前，
// 必须先重跑 `npm run install:hooks` 把已装 hook 的 URL 一起搬走。
const DEFAULT_PORT = 27333;

function userDataDir() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_DIR);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIR);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, APP_DIR);
}

function portFilePath() {
  // 测试 / 多实例隔离：回归脚本要在「用户自己正开着桌宠」的情况下也能跑。
  // 不能隔离的话，单实例锁和固定端口 27333 都被占用，
  // 表现是"主进程起来了、渲染进程永远不出现"，很容易误判成代码坏了。
  if (process.env.CLAWD_PORT_FILE) return path.resolve(process.env.CLAWD_PORT_FILE);
  return path.join(userDataDir(), FILE_NAME);
}

function writePortFile(file, { port, token }) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // mode 只在类 Unix 生效；Windows 上没有等价语义，靠 ACL 继承
  fs.writeFileSync(file, JSON.stringify({ port, token }), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

function readPortFile(file = portFilePath()) {
  const raw = fs.readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  if (!data || !Number.isInteger(data.port) || typeof data.token !== "string" || data.token.length < 32) {
    throw new Error("端点文件格式不对，删掉它再重启桌宠");
  }
  return data;
}

module.exports = { userDataDir, portFilePath, writePortFile, readPortFile, DEFAULT_PORT };
