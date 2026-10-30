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

## 2026-10-29 16:50
- daily-check.js 退出码 0，报「无实质变化」；HEAD `ebd5ba3`，工作区 5 个未提交，audit 0/0/0。
- **发现脚本的真实盲区**：`fileHash` 只对文件**路径列表**做 sha1（`files.join("|")`），`dirty` 只比对路径集合的增删。所以**已脏文件内部再次被编辑完全检测不到**。
- 按 mtime 复核（台账 16:38 写入之后）：`src/renderer.js` 16:46 又改了——躯干后新增金色 `RAG` `<text>`，全库 grep 无记录 → 真实漏记。
- 处理：仅在 `PROGRESS.md` 时间线补 1 行（2026-10-29 / 新增），未动其他台账。三次提交（041e39d/22eb78f/ebd5ba3）与 audit 均已入账。
- 无新安全发现。

## 2026-10-30 16:50
- daily-check.js 退出码 2，报「有实质变化」：3 次提交（48a5ca6 提示修复 / bb97a1a 再修 wb 交互 / d768ee2 删信箱）、新增 `src/risk.js`、删除 mailbox/letter 四文件、11 个脏文件。
- 交叉核实后判定**全部已入账**：台账 16:34–16:38 已写 S10 三件套（PROGRESS 时间线 + 安全状态、FILE_MAP 含 risk.js 行、SECURITY 新增 S10 落地核对小节），三次提交本身也各带 docs/ledger 更新。
- 唯一真实漂移：FILE_MAP 表头体积行 8426 行已过期，实测 8552（src js 4400 / html 605 / hooks 645 / scripts 2902）——S10 末尾那批断言（`pickCast` 用例）是在台账快照之后补的，mtime 16:50 也印证了这点。
- 处理：仅改 FILE_MAP 第 3–4 行（行数 + 实测时间 16:52），未加 PROGRESS 行（无新变更类型）、未动 SECURITY、未动源码、未 commit。audit 0/0/0，无新安全发现。
- 经验补充：体积行漂移是「同一批工作还没写完就记账」的必然结果，可作为每天的低成本真值校验——`cat src/*.js src/*.html hooks/*.js scripts/*.js | wc -l` 与表头一比即知台账快照是否落后于代码。

## 经验
- 脚本的 dirty 对比是「相对上次基线」，首次/滞后基线下会把已入账的改动重报一次。判断关键：比对源码 mtime 与台账 mtime，台账晚于源码即说明已记录。
- 基线存在**静默前移**风险：若台账在两次体检之间被手工更新并跑过脚本，prev.head 已等于当前 HEAD，之后的新提交就不会被报出。所以每天不能只看「结论」一行，还要用 `git log --since` 与台账 mtime 交叉验证。
- 脚本有个小解析 bug：`git status --porcelain` 的 `slice(3)` 在某些行上会多吃字符（出现 `gitignore`、`cripts/fake-feed.js` 这类截断），不影响结论判断，可择日修。
- **最致命的盲区（10-29 确认）**：内容改动检测只覆盖「文件清单」和「dirty 路径集合」，**已脏文件内部的改动永远报不出来**。因此只要工作区长期挂着同一批未提交文件，之后所有编辑都会被判成"无变化"。每天必须补一步：`find . -type f -newermt "<台账 mtime>" -not -path node_modules`，再对命中的源码看 `git diff` 是否已入账。脚本的「结论」一行不能单独作为依据。
