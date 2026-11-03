#!/usr/bin/env node
"use strict";
// ============================================================
// 发布物签名（S10-8）
//
// 被谁调用：
//   1. `cargo tauri build` —— tauri.conf.json 的 bundle.windows.signCommand
//      把每个要签的文件路径通过 `%1` 传进来（裸 exe、卸载器、NSIS 安装包）。
//   2. 手动验证：`node scripts/sign-release.js --verify <文件>`
//
// 用哪张证书由环境变量决定（**永远不写进仓库**——私钥入库等于把签名送人）：
//   CLAWD_SIGN_PFX           PFX 文件路径（推荐；商业证书导出或自签名都走这个）
//   CLAWD_SIGN_PFX_PASSWORD  PFX 密码（本地自签名写在 .clawd-signing/ 里，见 README）
//   CLAWD_SIGN_THUMBPRINT    证书指纹（证书已装进当前用户/本机证书库时用这个）
//
// 没配置任何一项时：**响亮地跳过**——打印一行大写警告后退出 0，
// 让没有证书的人照样能打包；但绝不允许"以为签了其实没签"的中间态，
// 所以配置了却签失败必须退出非 0，让打包直接红。
//
// 为什么时间戳服务器是 digicert 的公开 RFC3161 端点：签名没有时间戳的话，
// 证书一过期，签过的 exe 立刻变成"无效签名"——时间戳把有效性锚定在签名时刻。
//
// 为什么这个脚本的日志是 ASCII：它的 stdout 会被 makensis 的管道接走，
// 那一段在多字节代码页下会把中文重编码成乱码（实测行：
// `[sign] 宸茬鍚嶏細nst45DE.tmp`）。签名本身是对的，只是日志没法看，
// 所以对外输出一律英文，注释照旧写中文。
// ============================================================

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SIGN_TOOL_DIRS = [
  "C:/Program Files (x86)/Windows Kits/10/bin",
  "C:/Program Files/Windows Kits/10/bin",
];
const TIMESTAMP_URL = "http://timestamp.digicert.com";
const PRODUCT_NAME = "clawd-starter";

function findSigntool() {
  for (const root of SIGN_TOOL_DIRS) {
    if (!fs.existsSync(root)) continue;
    // 取版本号最大的那个目录（字符串排序对 10.0.x 恰好也成立）
    const versions = fs.readdirSync(root).filter((n) => /^\d+\.\d+\./.test(n)).sort();
    for (let i = versions.length - 1; i >= 0; i--) {
      for (const arch of ["x64", "x86"]) {
        const p = path.join(root, versions[i], arch, "signtool.exe");
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

function signtool(args) {
  const exe = findSigntool();
  if (!exe) {
    console.error("[sign] ERROR: signtool.exe not found. Install the Windows SDK, or put signtool on PATH.");
    process.exit(1);
  }
  const r = spawnSync(exe, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  return { ok: r.status === 0, out };
}

function sign(file) {
  const pfx = process.env.CLAWD_SIGN_PFX;
  const pfxPassword = process.env.CLAWD_SIGN_PFX_PASSWORD;
  const thumbprint = process.env.CLAWD_SIGN_THUMBPRINT;

  if (!pfx && !thumbprint) {
    console.warn(
      "[sign] ⚠️  未配置签名证书（CLAWD_SIGN_PFX / CLAWD_SIGN_THUMBPRINT），" +
        `本次产物不签名：${path.basename(file)}\n` +
        "[sign] ⚠️  未签名的安装包会被 SmartScreen 拦下（「未知发布者」）。" +
        "怎么配证书看 README 的「代码签名」一节。"
    );
    return 0; // 响亮地跳过，不假装签过
  }

  const args = ["sign", "/fd", "sha256", "/d", PRODUCT_NAME, "/tr", TIMESTAMP_URL, "/td", "sha256"];
  if (pfx) {
    if (!fs.existsSync(pfx)) {
      console.error(`[sign] ERROR: CLAWD_SIGN_PFX does not exist: ${pfx}`);
      return 1;
    }
    args.push("/f", pfx);
    if (pfxPassword) args.push("/p", pfxPassword);
  } else {
    args.push("/sha1", thumbprint);
  }
  args.push(file);

  const { ok, out } = signtool(args);
  if (!ok) {
    console.error(`[sign] ERROR: signing failed: ${file}\n${out}`);
    return 1; // 配置了证书却签失败 = 打包必须红，绝不产出"没签成功"的安装包
  }
  console.log(`[sign] signed: ${path.basename(file)}`);
  return 0;
}

function verify(file) {
  const { ok, out } = signtool(["verify", "/pa", "/all", file]);
  // 自签名证书不在受信根里，verify 会报 Untrusted——那也是"签了"的证据。
  const signed = ok || /SignTool Error|Untrusted|No signature found/i.test(out) === false;
  if (/No signature found/i.test(out)) {
    console.log(`[verify] NOT SIGNED: ${file}`);
    return 1;
  }
  console.log(`[verify] ${ok ? "签名有效且受信" : "有签名（verify 报错，多半是自签名不受信，见输出）"}：${file}\n${out.trim()}`);
  return signed ? 0 : 1;
}

const argv = process.argv.slice(2);
if (argv[0] === "--verify") {
  if (!argv[1]) {
    console.error("用法：node scripts/sign-release.js --verify <文件>");
    process.exit(1);
  }
  process.exit(verify(argv[1]));
}
if (!argv[0]) {
  console.error("本脚本由 `cargo tauri build` 的 signCommand 调用（文件路径作第一个参数）。");
  console.error("手动验证签名：node scripts/sign-release.js --verify <文件>");
  process.exit(1);
}
process.exit(sign(argv[0]));
