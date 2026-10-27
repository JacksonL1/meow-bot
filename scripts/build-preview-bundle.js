#!/usr/bin/env node
"use strict";
// ============================================================
// 把 themes/ 打包成 preview.html 能直接吃的一个 JS（preview-bundle.js）
//
// 为什么需要它：preview.html 是**浏览器直接打开**的静态页（file://），
// 读不到 themes/ 下的文件——file:// 下 fetch 会被同源策略拦掉。
// 所以要么起个本地服务，要么把数据打成一个 <script>。后者更简单。
//
// 这个包**只给预览用**。桌宠运行时走的是 IPC（主进程读文件 → preload → 渲染层），
// 不经过它。所以包过期只会让预览图落后，不会影响实际形象。
//
//   node scripts/build-preview-bundle.js           # 写 preview-bundle.js
//   require("./build-preview-bundle").build()      # 供 preview-shot.js 调用
// ============================================================

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "preview-bundle.js");

function build() {
  const themes = require(path.join(ROOT, "src/theme.js"));
  const ids = themes.listThemeIds();
  if (!ids.length) throw new Error("themes/ 下一个主题都没有");

  const bundle = {};
  const failed = [];
  for (const id of ids) {
    const r = themes.loadTheme(id);
    if (!r.ok) {
      failed.push(`${id}: ${r.error}`);
      continue;
    }
    bundle[id] = { name: r.theme.name, description: r.theme.description, states: r.theme.states };
  }

  const js =
    "// 由 scripts/build-preview-bundle.js 生成，不要手改。\n" +
    "// 只给 preview.html 用；桌宠运行时不读它。\n" +
    "window.CLAWD_THEMES = " +
    JSON.stringify(bundle) +
    ";\n";
  fs.writeFileSync(OUT, js, "utf8");

  return { ids: Object.keys(bundle), failed, bytes: Buffer.byteLength(js) };
}

if (require.main === module) {
  const r = build();
  console.log(`[ok] preview-bundle.js：${r.ids.length} 个主题（${r.ids.join(", ")}），${r.bytes} 字节`);
  if (r.failed.length) {
    console.error("[!] 有主题加载失败，已跳过：\n  " + r.failed.join("\n  "));
    process.exitCode = 1;
  }
}

module.exports = { build, OUT };
