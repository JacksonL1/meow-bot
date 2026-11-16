#!/usr/bin/env node
"use strict";
// ============================================================
// 把 DSH approval/request 应答者装进 headless profile。
//
// 与普通 hook 安装器一样守四条边界：先备份、原子写、只认自己的标记、重复执行无变化。
// cordis.patch.yml 是 YAML，但这里不引入 YAML 依赖，也不重写整份文件：只维护带
// marker 的那一个 insert 段，用户自己的模型、供应商与凭据配置逐字保留。
//
// 用法：
//   node hooks/install-dsh-approval.js
//   node hooks/install-dsh-approval.js --dry-run
//   node hooks/install-dsh-approval.js --uninstall
//   node hooks/install-dsh-approval.js --profile-dir <目录>   # 测试隔离
// ============================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_FILE = "clawd-approval-bridge.mjs";
const PLUGIN_SOURCE = path.join(__dirname, "dsh-approval-bridge.mjs");
const BEGIN = "# >>> clawd-starter dsh approval bridge >>>";
const END = "# <<< clawd-starter dsh approval bridge <<<";
const BLOCK = `${BEGIN}\n- insert:\n    - id: clawd-approval-bridge\n      name: "./${PLUGIN_FILE}"\n${END}\n`;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const uninstall = args.includes("--uninstall");

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function profileDir() {
  const explicit = argValue("--profile-dir");
  if (explicit) return path.resolve(explicit);
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "profiles", "headless");
}

// 只剥两类东西：我们带 marker 的正式段，以及 2026-11-16 实验留下的精确三段式。
// 不做“看到 insert 就删”的粗暴文本替换——同文件里可能有用户自己的其他插件。
function withoutOurBlock(raw) {
  const marked = new RegExp(
    `^[ \\t]*${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?\\n[\\s\\S]*?^[ \\t]*${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*(?:\\r?\\n|$)`,
    "gm"
  );
  const legacy = /^[ \t]*-[ \t]+insert:[ \t]*\r?\n[ \t]*-[ \t]+id:[ \t]*clawd-approval-bridge[ \t]*\r?\n[ \t]*name:[ \t]*["']?\.\/clawd-approval-bridge\.mjs["']?[ \t]*(?:\r?\n|$)/gm;
  return raw.replace(marked, "").replace(legacy, "").replace(/(?:\r?\n){3,}/g, "\n\n").trimEnd();
}

function desiredPatch(raw) {
  const base = withoutOurBlock(raw);
  if (uninstall) return base ? base + "\n" : "";
  return (base ? base + "\n\n" : "") + BLOCK;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backup(file, backups) {
  if (!fs.existsSync(file)) return;
  const dest = `${file}.clawd-backup-${stamp()}`;
  fs.copyFileSync(file, dest);
  backups.push(dest);
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.clawd-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function main() {
  const dir = profileDir();
  const patchFile = path.join(dir, "cordis.patch.yml");
  const pluginFile = path.join(dir, PLUGIN_FILE);
  const oldPatch = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "";
  const newPatch = desiredPatch(oldPatch);
  const source = fs.readFileSync(PLUGIN_SOURCE, "utf8");
  const oldPlugin = fs.existsSync(pluginFile) ? fs.readFileSync(pluginFile, "utf8") : null;
  const patchChanged = newPatch !== oldPatch;
  const pluginChanged = uninstall ? oldPlugin !== null : oldPlugin !== source;

  if (!patchChanged && !pluginChanged) {
    console.log(`[clawd] 无变化（${uninstall ? "DSH 审批桥已卸载" : "DSH 审批桥已装好"}）：${dir}`);
    return;
  }
  if (dryRun) {
    console.log(`[clawd] --dry-run：没有写入任何文件`);
    console.log(`[clawd] ${patchChanged ? "将更新" : "不改动"} ${patchFile}`);
    console.log(`[clawd] ${pluginChanged ? (uninstall ? "将备份并移除" : "将安装") : "不改动"} ${pluginFile}`);
    return;
  }

  fs.mkdirSync(dir, { recursive: true });
  const backups = [];
  if (patchChanged) backup(patchFile, backups);
  if (pluginChanged) backup(pluginFile, backups);

  if (patchChanged) writeAtomic(patchFile, newPatch);
  if (pluginChanged) {
    if (uninstall) fs.unlinkSync(pluginFile);
    else writeAtomic(pluginFile, source);
  }

  for (const file of backups) console.log(`[clawd] 已备份 → ${file}`);
  console.log(
    uninstall
      ? `[clawd] 已移除 DSH 审批桥；其他 profile 配置原样保留：${dir}`
      : `[clawd] DSH 审批桥已接入 headless profile：${dir}`
  );
}

try {
  main();
} catch (err) {
  console.error(`[clawd] DSH 审批桥安装失败：${err.message}`);
  process.exit(1);
}
