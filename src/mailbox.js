"use strict";
// ============================================================
// S8  信箱：把「跟桌宠说的话」原样转交给 agent
//
// 这个模块存在的唯一理由：**猫不回答任何问题，只做搬运工。**
// 所以这里没有任何"生成""回复""理解"的代码，只有 存 → 取 → 交。
//
// ---- 为什么走文件，而不是直接调 CLI ----
// 试过了：CLI 能用（--version 2.165.0），但
//   1. 它要自己登录一次，桌面端的登录态它读不到（凭证在 Electron 的加密存储里）；
//   2. 就算登录了，`-p` 也只是开一个新会话 —— 进不了你正在看的那个。
// 而 hook 这条通道本来就是双向的：官方文档明写「UserPromptSubmit 和 SessionStart
// 的 stdout 会添加到上下文中」。所以信走 hook 送进去，零依赖、零登录、零端口。
//
// ---- 目录布局 ----
//   <userData>/mailbox/pending/<id>.json   { id, createdAt, text }
//   <userData>/mailbox/sent/<id>.json      投递后挪过来，留一份供排查
//
// 为什么不直接删？"我明明写了信，agent 说没收到"是这类功能最容易出现的争执，
// 留一份已投递的记录，排查时不用猜。
// ============================================================

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("./port-file");

// 一封信最多 4000 字。不是技术限制，是**上下文预算**：
// 这封信会被塞进用户下一条消息里，写成长篇小说会把用户的正文挤掉。
const MAX_LETTER_CHARS = 4000;
// 最多 5 封待投递。堆到几十封说明用户以为"发了没人管"，
// 与其让它无限堆积，不如在第 6 封时明确告诉他信箱满了。
const MAX_PENDING = 5;
// 24 小时没被取走的信自动作废。隔三天突然冒出一封旧信，
// 会让 agent 对着过期内容干活，比丢信更糟。
const TTL_MS = 24 * 60 * 60 * 1000;
// 单封文件读取上限：正常不超过 MAX_LETTER_CHARS 的几倍，
// 超过说明这个文件不是我们写的（被人塞了东西），当坏信丢掉。
const MAX_FILE_BYTES = 64 * 1024;

// ---- 报告问题：现场诊断包 ----
//
// 为什么要有它：用户第一次报 bug 是**写信**说的（「需要我确认的时候，没有提示我啊」）。
// 他走的是"跟猫说话"那条路，因为桌宠身上当时没有一个更像"反馈"的地方——
// 于是他得自己动手描述现场，而状态机手里其实握着现场（刚发生过哪些事件）。
//
// 改这个函数之前先读这三条边界，它们各对应一次真实的踩坑：
//   1. **诊断里绝不出现任何路径**。会话的 cwd 无论完整还是 basename 都不放：
//      这段文本有两处归宿——agent 的上下文，和用户磁盘上的副本，
//      哪一处都不该出现项目目录名。只放状态与事件序列
//      （event / from / to / how / 会话号前 8 位）。
//   2. **它只是草稿，不是证据**。诊断是**填进信纸里的普通文字**，
//      用户可以删、可以改、可以全删掉只留一句自己的话。
//      猫仍然是邮差，不代笔，更不会替用户决定"该报什么"。
//   3. **长度有硬上限**。它会跟着信一起被塞进用户下一条消息的上下文里，
//      写长了会把用户真正想说的话挤掉（MAX_LETTER_CHARS 那条注释讲的就是这个预算）。
const MAX_DIAGNOSTICS_CHARS = 1200;
const MAX_DIAGNOSTIC_EVENTS = 12;

function mailboxDir() {
  // 回归要能在用户正开着桌宠时跑，所以目录必须可隔离，
  // 和 port-file 的 CLAWD_PORT_FILE 是同一套思路。
  if (process.env.CLAWD_MAILBOX_DIR) return path.resolve(process.env.CLAWD_MAILBOX_DIR);
  return path.join(userDataDir(), "mailbox");
}

function pendingDir() {
  return path.join(mailboxDir(), "pending");
}

function sentDir() {
  return path.join(mailboxDir(), "sent");
}

// 报告问题的本地副本。它和 sent/ 的区别：sent/ 是"投递过"的记录，
// reported/ 是"提交过"的记录——后者不参与投递，只当回执用。
function reportedDir() {
  return path.join(mailboxDir(), "reported");
}

// 只接受我们自己生成的 id。readdir 出来的名字要经过这一关才拼路径 ——
// 否则一个叫 `../../x.json` 的文件名就能让删除操作跑到信箱外面去。
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function readLetter(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data.id !== "string" || !ID_RE.test(data.id)) return null;
    if (typeof data.text !== "string" || !data.text) return null;
    const createdAt = Number(data.createdAt);
    if (!Number.isFinite(createdAt)) return null;
    return { id: data.id, createdAt, text: data.text };
  } catch {
    return null; // 坏文件不抛，当它不存在
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file); // 同分区 rename 是原子的：取信的一方永远读不到半截 JSON
}

// 待投递的信，按写入时间从旧到新。
// 顺序很重要：先写的先寄出，否则同一轮的几封信会乱序。
function listPending() {
  let names;
  try {
    names = fs.readdirSync(pendingDir());
  } catch {
    return []; // 目录还不存在 = 一封信都没有
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const letter = readLetter(path.join(pendingDir(), name));
    if (letter) out.push(letter);
  }
  out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return out;
}

function put(text) {
  if (typeof text !== "string") return { ok: false, error: "信的内容必须是文字" };
  // 只裁首尾空白，中间的换行和缩进一律保留 —— 那是用户写的格式
  const body = text.replace(/^\s+|\s+$/g, "");
  if (!body) return { ok: false, error: "信是空的" };
  if (body.length > MAX_LETTER_CHARS) {
    return { ok: false, error: `信太长了（${body.length} 字，上限 ${MAX_LETTER_CHARS} 字）` };
  }

  const existing = listPending();
  if (existing.length >= MAX_PENDING) {
    return { ok: false, error: `信箱里还有 ${existing.length} 封没寄出去，等寄完再写吧` };
  }

  // createdAt 必须**严格递增**，不能只取 Date.now()。
  // 为什么：两封信完全可能落在同一毫秒里（手快、脚本、回归），
  // 那时排序只能拿 id 当兜底，而 id 是 UUID —— 于是"先写的先寄出"
  // 变成了随机顺序。这个 bug 只有在同毫秒写入时才出现，
  // 平时手写根本碰不到，但它是真的错了。
  // 做法：比现有最晚的一封至少晚 1ms。代价是时间戳可能超前几毫秒，
  // 对 24h 的过期判断毫无影响。
  let createdAt = Date.now();
  if (existing.length > 0) {
    const latest = existing[existing.length - 1].createdAt;
    if (createdAt <= latest) createdAt = latest + 1;
  }

  const id = crypto.randomUUID();
  const letter = { id, createdAt, text: body };
  try {
    writeAtomic(path.join(pendingDir(), `${id}.json`), letter);
  } catch (err) {
    return { ok: false, error: `写信封失败：${err.message}` };
  }
  return { ok: true, id, createdAt };
}

// 取走全部待投递的信。这是**破坏性**的：调用后这些信不会再被取第二次。
// 过期的信直接丢掉，不返回 —— 它们不该出现在 agent 的上下文里。
function take(now = Date.now()) {
  const dir = pendingDir();
  const letters = [];
  let expired = 0;

  for (const letter of listPending()) {
    const src = path.join(dir, `${letter.id}.json`);
    if (now - letter.createdAt > TTL_MS) {
      expired++;
      try {
        fs.unlinkSync(src);
      } catch {}
      continue;
    }
    // 先挪到 sent 再算投递成功：挪失败就当没取到，
    // 宁可下一轮再寄一次，也不能出现"取走了但没寄出去"的黑洞。
    try {
      fs.mkdirSync(sentDir(), { recursive: true });
      fs.renameSync(src, path.join(sentDir(), `${letter.id}.json`));
      letters.push(letter);
    } catch {}
  }

  return { letters, expired };
}

function prune(now = Date.now()) {
  // 已投递的留 7 天。够排查一次"我明明写了"，又不至于把信箱变成垃圾场。
  // reported/ 用同一套规则——它也是磁盘上会一直堆下去的东西，
  // 不清理的话"我三个月前报过一个问题"会一直占着用户的 AppData。
  const keepMs = 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const dir of [sentDir(), reportedDir()]) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // 目录还不存在（从没投过 / 从没报过），正常
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > keepMs) {
          fs.unlinkSync(file);
          removed++;
        }
      } catch {}
    }
  }
  return removed;
}

// 把"此刻桌宠看见了什么"写成一段人能读、agent 也能读的草稿。
//
// 入参是 `store.snapshot()` 的形状（visual / sessions / recent）。
// **注意 sessions 里的 cwd 一个字都不取** —— 见上面诊断包注释的第 1 条。
// 防御式地读每一个字段：快照可能来自旧版本、可能被改过，
// 这里抛一次异常就是"点报告问题没反应"，一个纯静默的失败。
function buildDiagnostics(snapshot, meta = {}) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const m = meta && typeof meta === "object" ? meta : {};

  const when = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())} ${p2(
    when.getHours()
  )}:${p2(when.getMinutes())}`;

  const lines = [`【桌宠现场 · ${stamp}】`];

  const env = [m.version, m.platform, m.arch, m.theme].filter(
    (v) => typeof v === "string" && v.trim()
  );
  if (env.length > 0) lines.push(`环境：${env.join(" · ")}`);

  // 此刻画面 + 会话分布。只数状态，不报 id、不报目录。
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  const counts = new Map();
  for (const s of sessions) {
    const key = s && typeof s.state === "string" ? s.state : "?";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const spread = [...counts.entries()].map(([k, v]) => `${k} ×${v}`).join(" / ");
  lines.push(
    `此刻画面：${typeof snap.visual === "string" ? snap.visual : "?"}` +
      (sessions.length > 0 ? `；会话 ${sessions.length} 条（${spread}）` : "；没有会话")
  );

  // 最近事件。它是"为什么现在长这样"的唯一证据——
  // 视觉层只知道自己是什么状态，不知道是被哪个事件推过去的。
  const recent = Array.isArray(snap.recent) ? snap.recent : [];
  if (recent.length > 0) {
    lines.push("最近事件（由旧到新）：");
    for (const r of recent.slice(-MAX_DIAGNOSTIC_EVENTS)) {
      if (!r || typeof r !== "object") continue;
      const t = new Date(Number(r.t) || 0);
      const clock = Number.isFinite(Number(r.t)) && Number(r.t) > 0
        ? `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`
        : "--:--:--";
      const hop = r.from === r.to ? `${r.to}` : `${r.from} → ${r.to}`;
      lines.push(
        `  ${clock}  ${r.event}  [${String(r.sid || "-").slice(0, 8)}]  ${hop}  (${r.how})`
      );
    }
  } else {
    lines.push("最近事件：（还没有收到任何 agent 事件）");
  }

  lines.push("");
  lines.push("我想说的是：");

  const text = lines.join("\n");
  // 从尾部裁：上面那些行是现场，最后一行是留给用户的引导，
  // 反过来裁会把"我想说的是"这句砍掉，用户就不知道该往哪儿写。
  return text.length > MAX_DIAGNOSTICS_CHARS
    ? `…（前面省略）\n${text.slice(-MAX_DIAGNOSTICS_CHARS)}`
    : text;
}

// 报告问题的信，除了照常进 pending 等投递，**额外在 reported/ 留一份**。
//
// 这不是第二个投递口——它不参与 take()，永远不会被挪走，
// 所以不会有"取走了没寄出去"的黑洞（那个坑见 DEVLOG 2026-10-30）。
// 它的唯一作用是**回执**：hook 是 fire-and-forget，宿主从不回执，
// 所以"有没有送到"我们确认不了；但"我提交过了"必须查得到。
// 用户问「我写的信，没了?」的时候，至少有一个地方能翻。
function saveReport(text, now = Date.now()) {
  if (typeof text !== "string") return { ok: false, error: "内容必须是文字" };
  const body = text.replace(/^\s+|\s+$/g, "");
  if (!body) return { ok: false, error: "内容是空的" };
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(reportedDir(), { recursive: true });
    writeAtomic(path.join(reportedDir(), `${id}.json`), { id, createdAt: now, text: body });
  } catch (err) {
    return { ok: false, error: `留副本失败：${err.message}` };
  }
  return { ok: true, id, createdAt: now };
}

function listReports() {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(reportedDir());
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const letter = readLetter(path.join(reportedDir(), name));
    if (letter) out.push(letter);
  }
  out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return out;
}

// 把信包装成一段**边界清楚**的文本交给 agent。
// 为什么要包边界：这封信会拼在用户真实输入的前面/后面，
// 没有任何标记的话，模型分不清哪句是用户此刻说的话、哪句是之前写的信。
// 这里只声明来源（谁写的、什么时候写的），**不写任何祈使句** ——
// 猫是邮差，不是代笔，更不是下指令的人。
function format(letters) {
  if (!Array.isArray(letters) || letters.length === 0) return "";
  const parts = [];
  for (const letter of letters) {
    const when = new Date(letter.createdAt);
    const stamp = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(
      when.getDate()
    ).padStart(2, "0")} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    parts.push(`【桌宠转交 · ${stamp} · 用户本人在桌面上写下，原样转交】\n${letter.text}\n【信完】`);
  }
  return parts.join("\n\n");
}

module.exports = {
  MAX_LETTER_CHARS,
  MAX_PENDING,
  MAX_DIAGNOSTICS_CHARS,
  TTL_MS,
  mailboxDir,
  pendingDir,
  sentDir,
  reportedDir,
  listPending,
  put,
  take,
  prune,
  format,
  buildDiagnostics,
  saveReport,
  listReports,
};
