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

## 2026-11-02 09:26
- daily-check.js 退出码 2，报「有实质变化」+1 次提交（`13cda6f 多任务区分`，10-30 17:04），audit 0/0/0。
- 交叉核实：该提交**自带台账更新**（FILE_MAP +11 / PROGRESS +6 / SECURITY +65），S10 时间线两行（三件套 + 淡出死代码修复，191 PASS）已存在；FILE_MAP 表头 22 文件 / 8552 行与实测逐项吻合（4400+605 / 645 / 2902），11 个涉及文件全部在表内 → 无漏记、无需加时间线行。
- 发现两处**可核实的台账缺口**（非编造）：
  1. `PROGRESS.md` 安全状态表**缺 S10 行**——违反台账自己第 3 行「每完成一格同步更新安全状态表」；SECURITY.md 已有「S10 风险评级：落地核对」全节可依。
  2. `PROJECT.md:60` 回归闸门仍写 **195 条断言**，是删信箱前的旧数（时间线记 195 → 146），当前 191（PROGRESS/FILE_MAP 三处一致）。
- 处理：仅改这两处（+1 行 / 改 1 行），未动 src/、scripts/、未 commit。无新 SEC 编号、无新漏洞。

## 2026-11-02 16:50
- daily-check.js 退出码 2，「有实质变化」：HEAD 由 `13cda6f` 推进到 `53353d4`（11 次提交，S10-5 Tauri 迁移 → S10-6 四项 → S10-7 三项），audit 0/0/0，4 个脏文件（图标重绘，执行中已被提交成 `d2e277d`）。
- FILE_MAP 报「漏记」两类：`src-tauri/target/**` 是 cargo 构建物（已在 `.gitignore`，脚本没排除），**不算缺口**；`scripts/diag-events.js` 当时确实缺，但在本次处理期间被并发会话补上（`check-filemap.js` 跑出 [ok]，80 文件 / 49 条）。
- 本次实际只补 3 处**可核实的缺口**：① PROGRESS 时间线补 6 行 2026-11-02 条目（此前表内最新仍是 10-30，S10-5/6/7 只在正文章节里，从未进时间线）；② 安全状态表补 S10-5 / S10-6 / S10-7 三行（含 `SECURITY.md` 已有但表里没有的 P2「安装包无代码签名」）；③ `PROJECT.md` 体积行 37/12756（10:30）→ 实测 41/14328（16:52，逐项自数：4604+621 / 3970+3+33+13 / 645 / 4439）。
- 只改 PROGRESS.md、PROJECT.md，未动 src/、scripts/，未 commit。无新 SEC 编号。
- 踩坑：写进表格的长文本里出现裸 `|`（`{"lock":"event"|"poll"}`）会撑破列数，必须转义成 `\|`；改完用 `awk '{gsub(/\|/,"|")}'` 数竖线可自查。

## 2026-11-04 09:33
- daily-check.js 首次跑退出码 2（「有实质变化」，9 次新提交），**第二次跑因基线已刷新反而报「无实质变化」**——再次印证基线前移，不能只看结论。
- 新提交 9 个中 3 个是台账/记忆提交（c3e3192/7c5538f/7ebd660/f87a028 非台账），实际内容提交：`8a4a9bd` S10-9 删 Electron + 签名、`2c6ec41` README 重写。内容在 PROGRESS §S10-9 正文已有（①–⑤），但**时间线表缺 3 行**。
- FILE_MAP 报「漏记 6521 个文件」全是 `src-tauri/target/**` 构建物（已 gitignore，脚本未排除），非缺口；`check-filemap.js` 跑出 `[ok]`（72 实际 / 41 条）。
- 实修 4 处（均可核实，无新 SEC 编号、无新漏洞）：
  1. PROGRESS 时间线补 3 行（README 重写 / 签名接上 / 删容器）。
  2. PROGRESS 安全状态表补 `S10-9` 行（P2=1：自签名只解决一半，SmartScreen 仍会报）。
  3. SECURITY 开头「SEC-08 未修（待决定）」→「已消除」，并把「cargo audit 未跑」改为「11-03 已补跑 0 漏洞」。
  4. 体积行 34/10361 → **33/10369**（`src-tauri/` 实为 12 个不是 13、`scripts/` 实为 2168 不是 2160），FILE_MAP 与 PROJECT 两处同步，差量改成 −8/−3959。
- 交叉验证小技巧：`41 − 9(删 Electron) + 1(sign-release.js) = 33`，与体积行自洽，可作为文件数正确性的快速校验。

## 2026-11-04 16:50（当天第二次，与 09:33 那轮同一日）
- daily-check 首次跑报「有实质变化」：9 次新提交（09:51–16:19：S10-10 修穿透 / DSH 接入 / 悬空 openStep / 泡泡改版 / thinking 修复 + 4 条 memory），**第二次跑又变成「无实质变化」**——基线前移老问题，结论不能单看。
- 交叉核实：DSH / 泡泡 / 并发双写 / thinking 四条时间线行在各自提交里已写入（提交自带 PROGRESS 更新），**唯一真缺的是 S10-10**（0e3dde5 只加了「已完成」小节，没进时间线）。
- 安全状态表缺 S10-10、S11 两行；SECURITY.md 完全没有 S11 章节。
- 实修 5 处（全部可核实）：
  1. PROGRESS 时间线补 1 行 S10-10（`6d5a0a7` 穿透根因 + 200ms/60ms 双向判定 + 75→80 回归）。
  2. PROGRESS 安全状态表补 S10-10（0/0/0/0）与 S11（P3=1）两行。
  3. SECURITY.md 新增「S11 DSH 接入」节 + **SEC-17（P3）**：DSH 的 title 从投影缓存直读、不经 `TITLE_SECRET_RE`，与 SEC-16「源头过滤」口径冲突；凭据侧清白（dsh.rs 只读 DSH_HOME/USERPROFILE）。
  4. PROJECT.md 体积行 34/11684 → **34/12402**（16:55 实测，+718 按目录拆开可对上）。
  5. FILE_MAP.md 表头 33/10369 → **34/12402**（原表头还是 11-03 快照，连「实测 2026-11-04」都写错了）。
- `check-filemap.js` [ok]（73 实际 / 42 条）；audit 0/0/0；未动 src/、scripts/、未 commit。

## 2026-11-05 16:50
- daily-check 首跑「有实质变化」：2 个内容提交（`04c8084 feat(say)` 桌宠发消息 + 看板重做、`cd33976` 记忆 + 台账），HEAD `cd33976`，工作区 1 个未提交（`.workbuddy/memory/2026-11-05.md`），audit 0/0/0，依赖无变化（tauri 仍 2.12.5）。**第二次跑又变「无实质变化」**——基线前移，老问题，结论以首跑为准。
- FILE_MAP 报「漏记 7191 个文件」全是 `src-tauri/target/**`，非缺口；`check-filemap.js` 跑出 `[ok]`（77 实际 / 46 条）。
- 时间线**无需补**：`04c8084` 本身没带台账，但随后的 `cd33976` 已写入 2026-11-05 S12 整行（含五个坑）。
- 实修 3 个文件（全部可核实）：
  1. `PROGRESS.md` 安全状态表补 **S12 行**（0/0/0/0，无新增 SEC 编号）——表自己的规则「每完成一格同步更新」，此前只到 S11。
  2. `PROJECT.md`：体积行 34/12402（11-04）→ **38/14778**（逐项 `wc -l`，+4 个文件 = `say.rs`/`compose.html`/`compose-renderer.js`/`compose.json`，+2376 行，四目录拆得开）；顺手**修掉该行一个重复单元格**（行尾整段被写了两遍 → 5 列撑成 3 列）；状态 S1–S10 → S1–S12；回归闸门 121 → **124 条（最近 123 PASS + 1 SKIP）**。
  3. `FILE_MAP.md`：表头 37/14730 → **38/14778**（`capabilities` 从 1 个算成 2 个，20 行）；删掉错误的「+3/+2328」旧 delta 段；`compose.json` 9→7 行、`compose.html` 128→132、`compose-renderer.js` 193→232、`say.rs` 578/14 测→662/16 测、`verify-tauri.js` 939/121→1109/124；`bubble.html` 94→192、`bubble-renderer.js` 337→94（**这两格是串位**，不是增长）；并加一段注：行内 `**N 行**` 只是快照，`main.rs`/`dsh.rs`/`state.rs`/`renderer.js`/`tauri-bridge.js`/`index.html` 仍偏小，要真值现数。
- 未动 src/、scripts/，未 commit。**无新安全发现**（SEC-17 仍最大编号）。

## 经验
- 脚本第一次跑会刷新基线，所以**同一天跑第二轮必然报「无实质变化」**——判断一律以第一轮的输出为准，第二轮只当"确认基线已落地"。
- `src-tauri/target/**` 永远会以「FILE_MAP 漏记 6000+ 文件」出现，是构建物（已 gitignore），脚本没排除；`check-filemap.js` 报 `[ok]` 才是 FILE_MAP 的真正结论。
- 脚本的 dirty 对比是「相对上次基线」，首次/滞后基线下会把已入账的改动重报一次。判断关键：比对源码 mtime 与台账 mtime，台账晚于源码即说明已记录。
- 基线存在**静默前移**风险：若台账在两次体检之间被手工更新并跑过脚本，prev.head 已等于当前 HEAD，之后的新提交就不会被报出。所以每天不能只看「结论」一行，还要用 `git log --since` 与台账 mtime 交叉验证。
- 脚本有个小解析 bug：`git status --porcelain` 的 `slice(3)` 在某些行上会多吃字符（出现 `gitignore`、`cripts/fake-feed.js` 这类截断），不影响结论判断，可择日修。
- **最致命的盲区（10-29 确认）**：内容改动检测只覆盖「文件清单」和「dirty 路径集合」，**已脏文件内部的改动永远报不出来**。因此只要工作区长期挂着同一批未提交文件，之后所有编辑都会被判成"无变化"。每天必须补一步：`find . -type f -newermt "<台账 mtime>" -not -path node_modules`，再对命中的源码看 `git diff` 是否已入账。脚本的「结论」一行不能单独作为依据。
- **行数快照必然落后**：开发会话是"边写边记账"，`**N 行**` 往往记的是中途值。今天 `say.rs` 记 578 / 实际 662、`main.rs` 1345 / 1570。校验成本极低：`wc -l <文件>` 一比即知；但**不要逐个去改**（14 处、且表格已声明它只是快照），只维护表头总量 + PROJECT 体积行，其余用一句注说明口径。
- **串位要单独查**：`bubble.html` 记 94（实 192）、`bubble-renderer.js` 记 337（实 94）——两个数像是上下两行写串了，不是代码变了。发现"一个偏小很多、相邻一个偏大很多"时先怀疑串位。
- **表格列数自查**：改表格行后用 `node -e` 数未转义 `|` 的个数，与相邻行比；PROJECT 的「体积」行曾整段重复导致多出一列，肉眼在长行里看不出来。

## 2026-11-06 16:50
- daily-check 首跑退出码 2（「有实质变化」，5 个新提交 / 工作区干净 / HEAD `6402d86` / audit 0-0-0 / 依赖 0），二跑又「无实质变化」——基线前移老问题，以首跑为准。
- 11-06 三次内容提交：`0119af0` 清 10 条编译警告（7 个 rs，净 −22）、`b2b1369` 权限气泡三条静默死路（main.rs +80、新增 `bubble_close`、123→128 断言、硬约束 51）、`6402d86` 端口 23333→27333（+ 修 gaze 假闸门）。三次提交**都没写变更时间线**，`0119af0` 更是台账里零记录。
- FILE_MAP 报「漏记 7465」全是 `src-tauri/target/**` 构建物，`check-filemap.js` 为 [ok]（77 实际 / 46 条），非缺口。
- 实修 3 个文件：① PROGRESS 时间线补 3 行（决策/修复/重构）+ 安全状态表补 S12-1、S12-2 两行（均 0/0/0/0，无新 SEC 编号）；② PROJECT 体积 14778 → **14932**（逐项 wc -l：src 7js 3646 + 4html 1028 + rs 6842 + other 116 + hooks 644 + scripts 2656，文件数仍 38，+154 拆得开：js +51 / rs +35 / scripts +68）、回归闸门 124→**128 断言 + 128 PASS**；③ FILE_MAP 表头同步 14932，并修 `server.rs` 行仍写「固定 23333」的过期事实（改 27333 + 记 `ServerHandle` 已删、start 返回 `()`）、`verify-tauri.js` 行 124→128。
- 未动 src/、scripts/，未 commit。无新安全发现（SEC-17 仍最大编号）。
- 新踩的坑：改 FILE_MAP 单行时把 old_string 只截到「3 条单测。」而 new_string 里复制了整段备注 → 行内正文重复一遍；靠数竖线（该行 6 vs 邻行 5）才发现。**替换整行时要么 old_string 覆盖到行尾，要么 new_string 只写增量**。

## 2026-11-09 09:21
- daily-check 首跑即「无实质变化」（HEAD 仍 `6402d86`，即 11-06 15:38 那次端口提交；周末 11-07/11-08 无提交、无源码改动）。
- 交叉核实：`find src hooks scripts docs -newermt "2026-11-06 17:00"` 只命中 `.last-check.json`（脚本自己刷新）；工作区唯一未提交文件是本自动化 memory.md。audit 0/0/0，依赖仍 0。
- FILE_MAP 漏记 7500+ 全是 `src-tauri/target/**` 构建物（已 gitignore），非缺口。
- 处理：**未修改任何台账文件**，无新安全发现。

## 2026-11-09 16:50（当天第二次）
- daily-check 退出码 0，「无实质变化」；HEAD 仍 `6402d86`，audit 0/0/0，依赖 0。
- 交叉核实：`git log --since 2026-11-06` 仍只有 11-06 的 4 次提交；`find src hooks scripts docs -newermt "2026-11-09 09:30"` 只命中 `.last-check.json`。工作区脏文件为 11-06 已入账的 3 个台账文件 + 本 memory。
- FILE_MAP 漏记 7500+ 仍全为 `src-tauri/target/**` 构建物，非缺口。
- 处理：**未修改任何台账文件**，无新安全发现。
