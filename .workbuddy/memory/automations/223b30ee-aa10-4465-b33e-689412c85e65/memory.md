# 台账每日体检 — 执行记录

## 2026-10-26 16:51（首次运行）
- 运行 `node docs/ledger/scripts/daily-check.js`，退出码 2，结论「有实质变化」。
- 判定为**基线滞后假变化**：`docs/ledger/.last-check.json` 基线记录时间早于 S4 落地（hooks/ 于 16:35 生成），而台账本身已在 16:40 更新完毕。
- 核实：FILE_MAP.md 已含 hooks/clawd-hook.js、hooks/install.js、src/port-file.js、.gitignore（含 NVIDIA Corporation/ 条目）、package.json；PROGRESS.md 时间线已有 2026-10-26 的 S4 条目。脚本未报 FILE_MAP 漏记，audit 仍为 high 1（SEC-08，已记录），无新提交（HEAD 1f79878）。
- 处理：**未修改任何台账内容**，仅脚本自身刷新了 `.last-check.json` 基线。
- 无新安全发现。

## 经验
- 脚本的 dirty 对比是「相对上次基线」，首次/滞后基线下会把已入账的改动重报一次。判断关键：比对源码 mtime 与台账 mtime，台账晚于源码即说明已记录。
- 脚本有个小解析 bug：`git status --porcelain` 的 `slice(3)` 在某些行上会多吃字符（出现 `gitignore`、`cripts/fake-feed.js` 这类截断），不影响结论判断，可择日修。
