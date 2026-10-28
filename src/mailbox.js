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
  const keepMs = 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names;
  try {
    names = fs.readdirSync(sentDir());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(sentDir(), name);
    try {
      if (now - fs.statSync(file).mtimeMs > keepMs) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {}
  }
  return removed;
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
  TTL_MS,
  mailboxDir,
  pendingDir,
  sentDir,
  listPending,
  put,
  take,
  prune,
  format,
};
