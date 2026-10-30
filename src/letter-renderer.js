"use strict";
// ============================================================
// 信纸窗口的渲染逻辑
//
// 它只负责三件事：把字数显示对、把信寄出去、出错时把原因说清楚。
// 任何"这封信该不该寄""寄到哪"的判断都不在这里 ——
// 那些在主进程（mailbox.js）里，因为渲染进程是可以被 F12 改的。
// ============================================================

const text = document.getElementById("text");
const count = document.getElementById("count");
const note = document.getElementById("note");
const btnSend = document.getElementById("btnSend");
const btnCancel = document.getElementById("btnCancel");

const DEFAULT_NOTE = note.textContent;
// 「报告问题」的说明行：强调预填的现场是**可以删的草稿**，不是证据。
// 这句话是这个功能的边界——猫把现场摆出来供你参考，不替你决定该报什么。
const REPORT_NOTE =
  "现场已附在下面，可以删、可以改 · Ctrl+Enter 寄出 · Esc 算了。你下次开口时，它跟着你的话一起送过去。";
let maxChars = 4000;
let sending = false;
let kind = "letter"; // "letter" | "report"
let prefill = "";

function refresh() {
  const n = text.value.length;
  count.textContent = `${n} / ${maxChars}`;
  count.classList.toggle("over", n > maxChars);
  // 超长 / 空白时把「寄出」按掉，比让用户点了再吃一个错误提示更省事
  btnSend.disabled = sending || n === 0 || n > maxChars;
}

function setNote(msg, isError) {
  note.textContent = msg;
  note.classList.toggle("err", !!isError);
}

function reset() {
  text.value = prefill ? `${prefill}\n` : "";
  sending = false;
  setNote(prefill ? REPORT_NOTE : DEFAULT_NOTE, false);
  refresh();
  // 窗口刚 show 出来时焦点可能还没落到页面，下一帧再 focus 更稳
  requestAnimationFrame(() => {
    text.focus();
    // 光标必须放到最后。预填的诊断在前面，用户要写的话在后面——
    // 不挪的话光标停在第 0 位，一打字就插进诊断中间去了。
    const end = text.value.length;
    text.setSelectionRange(end, end);
    text.scrollTop = text.scrollHeight;
  });
}

async function send() {
  if (sending) return;
  const body = text.value.trim();
  if (!body) return;
  sending = true;
  refresh();
  try {
    const r = await window.letter.send(body, kind);
    if (r && r.ok) {
      // 寄成功后由主进程负责关窗，这里不再做任何事 ——
      // 关窗权集中在主进程，避免"渲染层说自己关了、主进程还留着窗口"的错位
      return;
    }
    sending = false;
    setNote((r && r.error) || "寄出失败", true);
    refresh();
  } catch (err) {
    sending = false;
    setNote(`寄出失败：${err && err.message ? err.message : err}`, true);
    refresh();
  }
}

text.addEventListener("input", () => {
  // 用户重新开始打字时，把上一条错误提示收回去
  if (note.classList.contains("err")) setNote(DEFAULT_NOTE, false);
  refresh();
});

text.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    window.letter.cancel();
    return;
  }
  // Ctrl+Enter / Cmd+Enter 寄出。单按 Enter 是换行 —— 信是要分段的。
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
});

btnSend.addEventListener("click", send);
btnCancel.addEventListener("click", () => window.letter.cancel());

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.letter.cancel();
});

if (window.letter && typeof window.letter.onOpen === "function") {
  window.letter.onOpen((data) => {
    if (data && Number.isFinite(data.maxChars) && data.maxChars > 0) maxChars = data.maxChars;
    kind = data && data.kind === "report" ? "report" : "letter";
    // 预填只在报告模式用；普通写信必须是干净的一张纸。
    // 兜底裁一刀：万一诊断有一天比上限还长，也不能让用户一打开就"超长、寄不出去"。
    const raw = kind === "report" && typeof data.prefill === "string" ? data.prefill : "";
    prefill = raw.length > maxChars - 200 ? raw.slice(0, Math.max(0, maxChars - 200)) : raw;
    reset();
  });
} else {
  // 浏览器里直接开这个页面时不该是一片死白
  reset();
}
