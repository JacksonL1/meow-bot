#!/usr/bin/env node
"use strict";
// 台账巡检：找出「代码里有、但 FILE_MAP 没记」和「台账记了、但文件已不存在」的条目。
// 只报告，不改文件。用法： node docs/ledger/scripts/check-filemap.js

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const MAP_FILE = path.join(ROOT, "docs/ledger/FILE_MAP.md");
const SKIP_DIRS = new Set(["node_modules", ".git", ".idea", "dist", "docs"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".clawd-port" && entry.name !== ".gitignore") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, acc);
    } else if (!SKIP_FILES.has(entry.name)) {
      acc.push(path.relative(ROOT, full).split(path.sep).join("/"));
    }
  }
  return acc;
}

function main() {
  if (!fs.existsSync(MAP_FILE)) {
    console.error(`找不到 ${MAP_FILE}`);
    process.exit(1);
  }
  const md = fs.readFileSync(MAP_FILE, "utf8");
  const recorded = new Set();
  const prefixes = []; // 形如 `themes/**`：整目录登记，不逐帧列
  for (const m of md.matchAll(/\|\s*`([^`]+)`\s*\|/g)) {
    const p = m[1];
    if (p.endsWith("/**")) {
      prefixes.push(p.slice(0, -2)); // 保留结尾的 "/"
      continue;
    }
    if (p.endsWith("*") || p.endsWith("/")) continue; // 通配/目录条目不参与比对
    recorded.add(p);
  }

  const actual = walk(ROOT);

  // 主题资产有几十个 SVG 帧，逐帧登记只会让台账变成文件列表。
  // 所以允许 `themes/**` 这种整目录条目覆盖它下面的所有文件。
  const covered = (f) => recorded.has(f) || prefixes.some((pre) => f.startsWith(pre));
  const missing = actual.filter((f) => !covered(f));
  // 存在性必须直接问文件系统，不能拿 walk 的结果反查：
  // docs/ 在 SKIP_DIRS 里（台账本身不参与"是否漏记"的比对），
  // 但它下面的资产（比如 docs/ragdoll-states.png）是应该能被台账引用的。
  // 用 actual 判断会让这类条目永远被误报成"已不存在"。
  const stale = [...recorded].filter((f) => !fs.existsSync(path.join(ROOT, f)));

  console.log(`项目根：${ROOT}`);
  console.log(`实际文件 ${actual.length} 个，台账记录 ${recorded.size} 条\n`);

  if (missing.length) {
    console.log(`[!] 有 ${missing.length} 个文件没进台账：`);
    missing.forEach((f) => console.log(`    ${f}`));
    console.log("");
  }
  if (stale.length) {
    console.log(`[!] 台账里有 ${stale.length} 条已不存在（删了或改名了）：`);
    stale.forEach((f) => console.log(`    ${f}`));
    console.log("");
  }
  if (!missing.length && !stale.length) {
    console.log("[ok] 台账与文件系统一致。");
  }
}

main();
