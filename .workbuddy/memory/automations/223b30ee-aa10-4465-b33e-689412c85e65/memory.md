# 台账每日体检 — 执行记录

## 2026-10-26 16:51（首次运行）
- 运行 `node docs/ledger/scripts/daily-check.js`，退出码 2，结论「有实质变化」。
- 判定为**基线滞后假变化**：`docs/ledger/.last-check.json` 基线记录时间早于 S4 落地（hooks/ 于 16:35 生成），而台账本身已在 16:40 更新完毕。
- 核实：FILE_MAP.md 已含 hooks/clawd-hook.js、hooks/install.js、src/port-file.js、.gitignore（含 NVIDIA Corporation/ 条目）、package.json；PROGRESS.md 时间线已有 2026-10-26 的 S4 条目。脚本未报 FILE_MAP 漏记，audit 仍为 high 1（SEC-08，已记录），无新提交（HEAD 1f79878）。
- 处理：**未修改任何台账内容**，仅脚本自身刷新了 `.last-check.json` 基线。
- 无新安全发现。

## 2026-10-27 16:50
- 运行 daily-check.js，退出码 0，结论「无实质变化」。
- 交叉核实：基线已被刷新到当前 HEAD `7d27f21`（台账文件 mtime 16:31-16:32，晚于最后一次提交），因此 5 个新提交（1f79878..7d27f21：安全加固、权限 bubble、布偶猫形象、会话看板、主题切换）未按"新提交"报出——但时间线里 S5/S6/S7/形象/安全加固条目均已存在。
- audit 由 high 1 → 0（SEC-08 已修，electron 45.0.0），SECURITY.md 安全状态表已标 ✅；无新发现。FILE_MAP 无漏记。
- 处理：未改动任何台账内容，仅脚本刷新 `.last-check.json`。

## 2026-10-28 16:50
- daily-check.js 退出码 0，结论「无实质变化」；HEAD `88a414d`，工作区 6 个未提交（README/verify-electron/main/preload/renderer/state）。
- 交叉核实「基线静默前移」：上次基线 HEAD 已是 88a414d，故 7d27f21..HEAD 的 3 次提交（动作细节、配置项消费者、S8 写信+删 crab）未被报出，但台账已全部覆盖——这 3 次提交本身就带着 docs/ledger 的更新（88a414d 内含 PROGRESS/FILE_MAP/SECURITY 等改动）。
- 未提交改动（+449/-59，含 S9 鼠标叫醒、删 #rig-ruff、眼睑弹簧）在台账工作区副本里同样已入账：PROGRESS 有 S9 条目与安全状态表，SECURITY 有对应新增，时间戳台账 16:45 ≥ 源码 16:36。
- audit 0/0/0 维持；FILE_MAP 无漏记。处理：未改任何文件（脚本自身刷新 .last-check.json）。

## 经验
- 脚本的 dirty 对比是「相对上次基线」，首次/滞后基线下会把已入账的改动重报一次。判断关键：比对源码 mtime 与台账 mtime，台账晚于源码即说明已记录。
- 基线存在**静默前移**风险：若台账在两次体检之间被手工更新并跑过脚本，prev.head 已等于当前 HEAD，之后的新提交就不会被报出。所以每天不能只看「结论」一行，还要用 `git log --since` 与台账 mtime 交叉验证。
- 脚本有个小解析 bug：`git status --porcelain` 的 `slice(3)` 在某些行上会多吃字符（出现 `gitignore`、`cripts/fake-feed.js` 这类截断），不影响结论判断，可择日修。
