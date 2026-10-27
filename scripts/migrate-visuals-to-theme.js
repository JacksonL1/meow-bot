#!/usr/bin/env node
"use strict";
// ============================================================
// 一次性迁移脚本：把写死的 src/visuals.js 拆成 themes/<id>/ 主题包
//
//   node scripts/migrate-visuals-to-theme.js ragdoll  src/visuals.js
//   node scripts/migrate-visuals-to-theme.js crab     <(git show 85c094a:src/visuals.js)
//
// 为什么要它：19 帧 SVG 是函数拼出来的字符串，手抄一遍必然出错（少一个颜色、
// 多一个空格），而且抄完没人能证明"和原来一样"。用脚本拆，拆完能用回归比对。
//
// **不要在日常流程里跑它**——它会覆盖 themes/<id>/ 下的手改内容。
// 保留这个文件是为了说明 themes/ 是怎么来的，以及将来换形象时还能这么干。
// ============================================================

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const THEMES_DIR = path.join(ROOT, "themes");

const [, , themeId, sourceArg] = process.argv;
if (!themeId || !sourceArg) {
  console.error("用法： node scripts/migrate-visuals-to-theme.js <theme-id> <visuals.js 路径>");
  process.exit(1);
}

const META = {
  ragdoll: {
    name: "布偶猫",
    author: "clawd-starter",
    version: "1.0.0",
    description: "四肢趴伏的布偶猫：奶油白长毛 + 深棕重点色 + 蓝宝石竖瞳。",
  },
  crab: {
    name: "螃蟹",
    author: "clawd-starter",
    version: "1.0.0",
    description: "原版小螃蟹。拿来证明主题系统真的能换形象，而不只是换配置。",
  },
};

function loadVisualStates(source) {
  // visuals.js 的出口就一句 window.VISUAL_STATES = ...，
  // 给它一个假 window 就能在 Node 里跑，不需要 DOM。
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "visuals.js" });
  const states = sandbox.window.VISUAL_STATES;
  if (!states || typeof states !== "object") throw new Error("visuals.js 没有导出 window.VISUAL_STATES");
  return states;
}

function main() {
  const source = fs.readFileSync(path.resolve(sourceArg), "utf8");
  const states = loadVisualStates(source);

  const dir = path.join(THEMES_DIR, themeId);
  const assets = path.join(dir, "assets");
  fs.rmSync(assets, { recursive: true, force: true });
  fs.mkdirSync(assets, { recursive: true });

  const manifest = {
    schemaVersion: 1,
    ...(META[themeId] || { name: themeId, author: "", version: "1.0.0", description: "" }),
    _comment:
      "由 scripts/migrate-visuals-to-theme.js 生成。states 里每个状态可含多帧，按 fps 轮播。" +
      "资产只支持 SVG，每帧内必须自带 viewBox（约定 0 0 200 200）。",
    states: {},
  };

  let files = 0;
  for (const [state, def] of Object.entries(states)) {
    const names = [];
    def.frames.forEach((markup, i) => {
      const name = `${state}-${i + 1}.svg`;
      fs.writeFileSync(path.join(assets, name), String(markup).trim() + "\n", "utf8");
      names.push(name);
      files += 1;
    });
    manifest.states[state] = {
      fps: def.fps,
      eyeTracking: def.eyeTracking === true,
      frames: names,
    };
  }

  fs.writeFileSync(path.join(dir, "theme.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(`[ok] themes/${themeId}/：${Object.keys(states).length} 个状态，${files} 个 SVG 文件`);
}

main();
