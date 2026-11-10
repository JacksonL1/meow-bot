"use strict";
// ============================================================
// 输入窗：桌宠的「说一句话」入口（2026-11-05）
//
// 这扇窗唯一的职责是把一句话交给宿主，并且**在交出去之前**把两件事说清楚：
//   1. 这句话会落到哪（新会话 / 某条会话的标题 + 目录）
//   2. 它能不能落到那儿（桌面端建的会话，一次性 runner 写不进去）
// 第 2 点必须在打开时就显示，而不是等用户按了回车再报错。
//
// 安全：这里是全项目唯一处理"用户刚敲进来的原文"的页面。
//   · 只用 textContent 写 DOM，绝不 innerHTML。
//   · 不自己拼命令行、不碰路径——目标由宿主从状态机里查，前端传的 id 只是一个 id。
// ============================================================

const el = {
  card: document.getElementById("card"),
  to: document.getElementById("to"),
  text: document.getElementById("text"),
  foot: document.getElementById("foot"),
  msg: document.getElementById("msg"),
  ans: document.getElementById("ans"),
};

const HINT_IDLE = "Enter 发送 · Shift+Enter 换行";
const HINT_BUSY = "正在交给 dsh…";
// 别写"通常 10 秒"：实测同一条命令有 9s / 35s / 90s+ 三种（模型冷启动 + 网络），
// 报一个偏乐观的数，用户等到第 20 秒就开始怀疑是不是坏了。
const HINT_SENT = "已送出 · 等它回话（慢的时候要一两分钟）";
const HINT_ANSWER = "它说完了 · Esc 关闭";
// 窗口基准高度由宿主定义（`COMPOSE_H`）。传 0 = 恢复基准，别在这里抄一个 128 出来。
const H_BASE = 0;
const H_MAX = 420;

/** 当前目标。由 compose_context / compose:open 注入。 */
let target = null;
/** 目标的指纹。用来判断"这次重新问到的，真的是另一个目标吗"。 */
let targetSig = "";
/** 发送中就不要重复发。同一目标宿主那边也只允许一条在飞。 */
let busy = false;
/** 正在等回话的那一句原文。用来把"迟到的结局"和"这一发"对上号。 */
let sentPrompt = "";
/** 有焦点时的定时器：保证"目标变了"这件事一定收敛（理由见 startPolling）。 */
let pollTimer = null;

function sigOf(t) {
  if (!t) return "";
  return [t.id || "", t.title || "", t.cwd || "", t.can_resume ? "1" : "0"].join("\u0001");
}

function renderTarget() {
  el.to.replaceChildren();
  if (!target || !target.id) {
    const label = document.createElement("b");
    label.textContent = "新会话";
    el.to.append(label);
    // 新会话落在哪个目录必须写出来：DSH 的会话是按工作目录分桶的，
    // 起错目录等于起在一个空工作区里，而用户会以为"它没看见我的文件"。
    if (target && target.cwd) {
      const dir = document.createElement("span");
      dir.textContent = ` · ${target.cwd}`;
      el.to.append(dir);
    }
    return;
  }
  const label = document.createElement("b");
  label.textContent = target.title || "未命名会话";
  el.to.append(document.createTextNode("接着 "), label);
  if (target.cwd) {
    const dir = document.createElement("span");
    dir.textContent = ` · ${target.cwd}`;
    el.to.append(dir);
  }
  if (target.can_resume === false) {
    // 提前说清，免得白打一屏字。原因见 Rust 侧 say.rs 文件头第 3 条。
    const warn = document.createElement("span");
    warn.textContent = " · 桌面端会话，写不进去";
    el.to.append(warn);
    setFoot("这条是在桌面端建的，DSH 不许一次性 runner 往里写；在这儿发会新起一条", true);
    el.text.disabled = false;
  }
}

function setFoot(text, bad) {
  el.msg.textContent = text;
  el.foot.classList.toggle("bad", Boolean(bad));
}

// ---- 答案区：这张卡的"下半场"（2026-11-10）----

/** 把一段回复写进卡片，并把窗口长到刚好放得下。 */
function showAnswer(text) {
  const body = (text || "").trim();
  if (!body) {
    // 空答案不是错误，是事实：它跑完了但没说话。不编一句"任务完成"糊过去。
    setFoot("它跑完了，但没有文字回答（记录在看板里）", false);
    return;
  }
  el.ans.hidden = false;
  el.ans.textContent = body;
  setFoot(HINT_ANSWER, false);
  growToFit();
}

/**
 * 卡片是 `height:100%` 撑满窗口的，所以量它自己的高度只会得到"当前窗口多高"。
 * 先把它临时改成 auto 量内容，再还原——一次性测量，不改变最终布局。
 */
function growToFit() {
  requestAnimationFrame(() => {
    const prev = el.card.style.height;
    el.card.style.height = "auto";
    const h = Math.ceil(el.card.getBoundingClientRect().height) + 12; // body 上下各 6px
    el.card.style.height = prev;
    window.clawd.composeHeight(Math.min(H_MAX, h));
  });
}

function resetAnswer() {
  // 换了目标/重新打开 = 上一次的等待作废，迟到的 say:done 一律不认。
  sentPrompt = "";
  el.ans.hidden = true;
  el.ans.textContent = "";
  window.clawd.composeHeight(H_BASE);
}

/** 一句话的结局（成功 / 失败）都从这里进，界面上只有一处状态机。 */
function handleDone(d) {
  if (!d) return;
  // 只认自己这一发。窗会被复用：用户可能在等答案时按 Esc 藏起来，
  // 过了半分钟又打开它写另一句话——这时上一发的 say:done 才到。
  // 不比对原文的话，旧答案会直接写进新那句话的卡片下面（看着像它答错了）。
  if (!sentPrompt || d.prompt !== sentPrompt) return;
  sentPrompt = "";
  busy = false;
  el.card.classList.remove("busy");
  if (d.ok) {
    showAnswer(d.reply);
    return;
  }
  // 失败发生在"窗已经藏起来"之后——送出是立即返回的，成不成几十秒后才知道
  // （模型 401 / 网络断 / 45 分钟超时）。宿主会把窗重新亮出来（见 say_send 的注释），
  // 这里负责把原话放回输入框：用户改一改就能重发，不用从头再打一遍。
  if (d.prompt && !el.text.value) el.text.value = d.prompt;
  setFoot(d.message || "dsh 退出了", true);
  el.text.focus();
}

function adopt(t) {
  const sig = sigOf(t);
  // 同一个目标就不要重复 adopt：轮询每 500ms 调一次，每次重置提示行的话，
  // 用户刚看到的报错会被"Enter 发送"盖掉，而且打字时输入框会被反复打扰。
  if (sig === targetSig) return;
  targetSig = sig;
  target = t || null;
  // 换了目标 = 这扇窗被重新叫出来了：上一次的残句必须清掉，
  // 否则用户以为发的是这次打的字。
  el.text.value = "";
  busy = false;
  el.card.classList.remove("busy");
  resetAnswer();
  renderTarget();
  if (target && target.can_resume === false) return; // 已经写了原因
  setFoot(HINT_IDLE, false);
}

async function submit() {
  if (busy) return;
  const text = el.text.value.trim();
  if (!text) {
    setFoot("还没写要说什么", true);
    el.text.focus();
    return;
  }
  busy = true;
  el.card.classList.add("busy");
  setFoot(HINT_BUSY, false);

  // 已经提前告知"写不进去"的会话，就**不续**它——发一条新会话，
  // 比发出去然后弹一个用户没法处理的错误要好。用户要的就是"让它动起来"。
  const id = target && target.id && target.can_resume !== false ? target.id : null;

  sentPrompt = text;
  let r = null;
  let errMsg = "";
  try {
    r = await window.clawd.saySend(id, text);
  } catch (err) {
    // Tauri 的 invoke 在命令返回 Err 时是 reject，Err 的字符串就是第一个参数
    errMsg = typeof err === "string" ? err : String((err && err.message) || err);
  }
  if (r && r.ok) {
    // **不关窗**（2026-11-10 改）。原来这里 420ms 后 composeClose()：
    // 用户只看到"已送出"一闪，答案回来时窗早就没了，而回复只发给看板——
    // 看板没开就等于"发进黑洞"。现在窗口留着，等 say:done 把答案填进来。
    el.text.value = "";
    setFoot(HINT_SENT, false);
    return;
  }
  // 失败：留在窗里，把原因显示出来，文字不丢（用户可以直接改了再发）
  busy = false;
  el.card.classList.remove("busy");
  setFoot(errMsg || (r && r.error) || "发送失败", true);
  el.text.focus();
}

// ---- 键盘 ----
el.text.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    window.clawd.composeClose();
    return;
  }
  // Enter 发送，Shift+Enter 换行。用 isComposing 挡掉输入法选词时的回车——
  // 中文用户按回车确认候选词，那一下绝不能当成"发送"。
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

// Esc 在 textarea 之外也要有效（比如焦点跑到卡片上）
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement !== el.text) {
    window.clawd.composeClose();
  }
});

// 每次被叫出来，输入框都是空的且已聚焦。
// 窗口是复用的，上一次的残句留在这里是个陷阱：用户以为发的是这次打的字。
window.clawd.onComposeOpen((t) => {
  // 事件是"快"的那条路（通常几毫秒就到）。但它**不能是唯一**的路：
  // 宿主是在另一个线程里 emit 的，窗口刚 show 出来时那一下有可能落空。
  // 所以下面还有一条"有焦点就轮询"的慢路兜底。
  //
  // 这里显式把状态清干净（不依赖 adopt 的指纹判断）：被叫出来就意味着
  // "这一段是新的"，上一次的残句、上一次的报错都不该跟着进来。
  el.text.value = "";
  busy = false;
  el.card.classList.remove("busy");
  resetAnswer();
  setFoot(HINT_IDLE, false);
  adopt(t);
  el.text.focus();
});

// 慢的那条路：只要有焦点，就每 500ms 问一次"这次要发给谁"。
//
// 为什么需要它：`compose:open` 事件可能赶在窗口就绪之前或者 show 的那一帧丢掉
// （实测：第二次点击 ✎ 时页面还停在第一次的目标上）。轮询一次本地 IPC 的代价
// 可以忽略，而"点了 ✎ 却对空说话"是那种当场就毁掉信任的 bug。
// 没有焦点时停掉：那时轮询没有任何意义，用户已经不看它了。
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    window.clawd
      .composeContext()
      .then((t) => {
        if (t) adopt(t);
      })
      .catch(() => {});
  }, 500);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

window.addEventListener("focus", startPolling);
window.addEventListener("blur", stopPolling);

window.clawd
  .composeContext()
  .then((t) => {
    if (t) adopt(t);
    el.text.focus();
  })
  .catch(() => {});
if (document.hasFocus()) startPolling();

// 一句话的结局：成功时把答案写进这张卡，失败时把原因和原话留下。
// 两条路都走 handleDone，界面只有一处状态机。
window.clawd.onSayDone(handleDone);

// 调试入口：回归脚本用它灌一份目标 / 读回当前状态 / 模拟一次结局
window.composeDebug = {
  adopt,
  // 回归里不真的调模型（一次 8 秒 + 花钱），但"答案要落在卡上"必须钉住，
  // 所以把结局入口也露出来——它和 say:done 走的是同一个函数，不是复制品。
  sayDone: (d) => handleDone(d),
  state: () => ({
    target,
    busy,
    text: el.text.value,
    to: el.to.textContent,
    msg: el.msg.textContent,
    ans: el.ans.hidden ? "" : el.ans.textContent,
    bad: el.foot.classList.contains("bad"),
  }),
};
