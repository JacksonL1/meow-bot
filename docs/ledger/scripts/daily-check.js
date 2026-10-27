#!/usr/bin/env node
"use strict";
// 台账每日体检：对比「上次检查」与「现在」，只报告实质变化。
// 无变化时明确输出「无需更新」，避免 AI 为凑记录而编造内容。
//
// 用法： node docs/ledger/scripts/daily-check.js

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../../..");
const LEDGER = path.resolve(__dirname, "..");
const STATE_FILE = path.join(LEDGER, ".last-check.json");
const MAP_FILE = path.join(LEDGER, "FILE_MAP.md");

const SKIP_DIRS = new Set(["node_modules", ".git", ".idea", "dist", "docs"]);

function tryRun(cmd, args, timeout = 60000, useShell = false) {
  try {
    return execFileSync(cmd, args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout,
      shell: useShell,
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd(); // 只能裁右边！见下方 status 解析处的注释
  } catch (e) {
    // npm audit 有漏洞时退出码非 0，但 stdout 里仍有完整 JSON，不能丢
    const out = e && e.stdout ? String(e.stdout).trimEnd() : "";
    return out || null;
  }
}

// Windows 上 npm 是 .cmd 垫片，直接 spawn 会 ENOENT，必须走 shell
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === ".DS_Store" || e.name === "Thumbs.db") continue;
    if (e.name.startsWith(".") && e.name !== ".gitignore" && e.name !== ".clawd-port") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, acc);
    } else {
      acc.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  return acc;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const prev = loadState();
  const firstRun = !prev;
  const now = new Date();
  const changes = [];
  const issues = [];
  const notes = [];

  // ---- 1. git ----
  const head = tryRun("git", ["rev-parse", "HEAD"]);
  const branch = tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  let newCommits = [];
  if (head) {
    if (!prev) {
      newCommits = (tryRun("git", ["log", "--oneline", "-5", "--format=%ad %s", "--date=short"]) || "").split("\n").filter(Boolean);
      notes.push(`首次检查，记录基线 HEAD ${head.slice(0, 7)}`);
    } else if (prev.head !== head) {
      const range = prev.head ? `${prev.head}..HEAD` : "-10";
      newCommits = (tryRun("git", ["log", "--oneline", "--format=%ad %s", "--date=short", range]) || "").split("\n").filter(Boolean);
      if (newCommits.length) changes.push(`git 新增 ${newCommits.length} 次提交`);
    }
  } else {
    notes.push("git 不可用或不是仓库");
  }

  // ---- 2. 工作区（排除台账自身，否则每天都会被自己弄脏）----
  //
  // 这里踩过一个很难看的坑：porcelain 每行是「两个状态位 + 一个空格 + 路径」，
  // 而第一行以空格开头（未暂存的修改是 ` M file`）。如果对整段输出做 trim()，
  // 首行开头的空格会被吃掉，`M file` 再 slice(3) 就把文件名的第一个字母也切走了——
  // 实测出现过 `README.md` 变成 `EADME.md` 被写进基线。
  // 所以 tryRun 只允许 trimEnd()，这里再兜一层：第 3 个字符不是空格时退回正则。
  const porcelainPath = (l) =>
    (l[2] === " " ? l.slice(3) : l.replace(/^.{1,2}\s+/, "")).trim().replace(/^"|"$/g, "");

  const statusRaw = tryRun("git", ["status", "--porcelain"]) || "";
  const dirty = statusRaw
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim())
    .filter((l) => {
      const p = porcelainPath(l);
      return !p.startsWith("docs/");
    });
  // 工作区「现状」不等于「变化」：只有相对上次基线增减时才计入
  const dirtyPaths = dirty.map(porcelainPath);
  if (!firstRun) {
    const prevDirty = new Set(prev.dirtyPaths || []);
    const added = dirtyPaths.filter((p) => !prevDirty.has(p));
    const resolved = [...prevDirty].filter((p) => !dirtyPaths.includes(p));
    if (added.length) changes.push(`新增未提交：${added.join(", ")}`);
    if (resolved.length) changes.push(`已提交或撤销：${resolved.join(", ")}`);
  }

  // ---- 3. 文件清单（含与 FILE_MAP 的差异）----
  const files = walk(ROOT).sort();
  const fileHash = crypto.createHash("sha1").update(files.join("|")).digest("hex").slice(0, 12);
  if (prev && prev.fileHash !== fileHash) {
    const prevSet = new Set(prev.files || []);
    const curSet = new Set(files);
    const added = files.filter((f) => !prevSet.has(f));
    const removed = (prev.files || []).filter((f) => !curSet.has(f));
    if (added.length) changes.push(`新增文件 ${added.length} 个：${added.join(", ")}`);
    if (removed.length) changes.push(`删除文件 ${removed.length} 个：${removed.join(", ")}`);
  }

  // 台账漏记检查
  let mapMissing = [];
  if (fs.existsSync(MAP_FILE)) {
    const md = fs.readFileSync(MAP_FILE, "utf8");
    const recorded = new Set();
    for (const m of md.matchAll(/\|\s*`([^`]+)`\s*\|/g)) {
      const p = m[1];
      if (p.endsWith("*") || p.endsWith("/")) continue;
      recorded.add(p);
    }
    mapMissing = files.filter((f) => !recorded.has(f));
    if (mapMissing.length) issues.push(`FILE_MAP 漏记 ${mapMissing.length} 个文件`);
  }

  // ---- 4. 依赖与漏洞 ----
  let pkgHash = null;
  let deps = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    pkgHash = crypto.createHash("sha1").update(JSON.stringify(deps)).digest("hex").slice(0, 12);
  } catch {
    notes.push("package.json 读取失败");
  }
  if (prev && pkgHash && prev.pkgHash && prev.pkgHash !== pkgHash) {
    changes.push("package.json 依赖声明有变化");
  }

  let auditCounts = null;
  const auditRaw = tryRun(NPM, ["audit", "--json"], 120000, true);
  if (auditRaw) {
    try {
      const parsed = JSON.parse(auditRaw);
      auditCounts = parsed?.metadata?.vulnerabilities || null;
    } catch {
      notes.push("npm audit 输出解析失败");
    }
  } else {
    notes.push("npm audit 未执行（可能离线或非 npm 项目）");
  }
  if (auditCounts && prev && prev.audit) {
    const before = prev.audit;
    const worse =
      (auditCounts.high || 0) > (before.high || 0) || (auditCounts.critical || 0) > (before.critical || 0);
    const better =
      (auditCounts.high || 0) < (before.high || 0) || (auditCounts.critical || 0) < (before.critical || 0);
    if (worse) changes.push(`npm audit 恶化：high ${before.high || 0}→${auditCounts.high || 0}，critical ${before.critical || 0}→${auditCounts.critical || 0}`);
    if (better) changes.push(`npm audit 改善：high ${before.high || 0}→${auditCounts.high || 0}`);
  }

  // ---- 输出 ----
  const pad = (s) => String(s).padEnd(12, " ");
  console.log(`[clawd-starter 台账体检] ${now.toLocaleString("zh-CN", { hour12: false })}`);
  console.log(`项目根：${ROOT}`);
  console.log("");
  console.log(`${pad("git")}${head ? `${branch} @ ${head.slice(0, 7)}` : "不可用"}`);
  console.log(`${pad("工作区")}${dirty.length ? `${dirty.length} 个未提交文件` : "干净"}`);
  console.log(`${pad("文件数")}${files.length}`);
  console.log(`${pad("依赖")}${Object.keys(deps).length} 个（${Object.entries(deps).map(([k, v]) => `${k}${v}`).join(", ") || "无"}）`);
  if (auditCounts) {
    console.log(`${pad("audit")}critical ${auditCounts.critical || 0} / high ${auditCounts.high || 0} / moderate ${auditCounts.moderate || 0}`);
  }

  if (newCommits.length && !firstRun) {
    console.log("\n新提交：");
    newCommits.forEach((c) => console.log(`  ${c}`));
  }
  if (dirty.length && !firstRun) {
    console.log("\n未提交文件：");
    dirty.slice(0, 15).forEach((l) => console.log(`  ${l.trim()}`));
    if (dirty.length > 15) console.log(`  ... 另有 ${dirty.length - 15} 个`);
  }
  if (mapMissing.length && !firstRun) {
    console.log("\nFILE_MAP 漏记：");
    mapMissing.forEach((f) => console.log(`  ${f}`));
  }
  if (notes.length) {
    console.log("\n备注：");
    notes.forEach((n) => console.log(`  ${n}`));
  }

  console.log("");
  if (issues.length) {
    console.log("台账待补：");
    issues.forEach((c) => console.log(`  - ${c}`));
    console.log("");
  }

  if (firstRun) {
    console.log("结论：基线已建立。以上为当前状态，不算「变化」；如有「台账待补」项请补记。");
  } else if (changes.length) {
    console.log("结论：有实质变化，需要更新台账");
    changes.forEach((c) => console.log(`  - ${c}`));
  } else {
    console.log("结论：无实质变化，无需更新台账（不要为此编造记录）");
  }

  // ---- 写状态 ----
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        checkedAt: now.toISOString(),
        head,
        branch,
        dirtyPaths,
        fileHash,
        files,
        pkgHash,
        deps,
        audit: auditCounts,
      },
      null,
      2
    ),
    "utf8"
  );

  process.exitCode = changes.length || issues.length ? 2 : 0;
}

main();
