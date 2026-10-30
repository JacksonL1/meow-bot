#!/usr/bin/env node
"use strict";
// ============================================================
// S4-1  agent hook 适配器（claude / codebuddy / workbuddy 共用）
//
// 它的一生只有几毫秒，只走一个方向：
//   读 stdin JSON → 挑出字段 → POST 给桌宠 → 退出 0
//
// 曾经它还走另一个方向（送信：把信箱里的信写进 stdout，让宿主当上下文收下）。
// 信箱整套 2026-10-30 砍掉了，理由写在 DEVLOG 里：它解决的是一个不存在的问题
// ——用户想让 agent 知道什么，直接在对话里说是一跳直达，经桌宠转交是三跳，
// 还多出一个会丢信的环节。**hook 从此不再往 stdout 写一个字节**，
// 这让下面那条铁律变得更干净：stdout 不再是协议，也不再有"例外"。
//
// 三条铁律（来自 SECURITY.md 的 S4 预判）：
//   1. 绝不阻塞 agent —— stdin 2s 硬超时，POST 1.5s 超时，到点就走
//   2. 绝不打日志 —— stdin 里有用户 prompt、文件路径、工具参数
//   3. 绝不抛异常 —— 任何失败都 process.exit(0)，安静得像没装过
//
// 用法（由 install.js 写进 ~/.claude/settings.json）：
//   node clawd-hook.js PreToolUse
// 事件名优先取 stdin 里的 hook_event_name，命令行参数只是兜底。
// ============================================================

const { readPortFile } = require("../src/port-file");

const STDIN_TIMEOUT_MS = 2000;
const POST_TIMEOUT_MS = 1500;
const MAX_STDIN_BYTES = 1024 * 1024; // 1MB，正常的 hook payload 远小于这个
const MAX_FIELD = 64;
const MAX_CWD = 1024;

// Notification 里有一部分是 WorkBuddy 自己的生命周期闲聊，不是"在等你"。
// 这两个值抄自主仓库 `hooks/workbuddy-hook.js:30` 的实测注释：
//   idle_prompt  —— "再发一条消息吧"的提醒（Stop 之后约 60 秒）
//   auth_success —— 登录成功的 toast（每一轮开头都发一次）
// 必须在**源头**滤掉而不是交给状态机：notification 是"真的在等你"的长状态
// （内置上限 10 分钟，见 state.js），让一条 idle_prompt 挂上来，
// 桌宠就会凭空提示好几分钟。
//
// 白名单式的：只丢明确列出的这两种，没见过的 notification_type 照常放行
// ——反过来的写法（只放行认识的）会把真提示也一起挡掉，而那种 bug
// 从日志上完全看不出来。
const IGNORED_NOTIFICATION_TYPES = new Set(["idle_prompt", "auth_success"]);

// ---- 会话标题：看板上唯一"像人话"的那一行 ----
//
// 两个来源，按质量排序（抄自主仓库 hooks/workbuddy-hook.js:135-160）：
//   ① payload.session_title  —— WorkBuddy 的 /rename，用户自己起的名，最准
//   ② UserPromptSubmit 时 prompt 的**第一行非空文字** —— 没有改名时的兜底
// 刻意**不**回退到 cwd / session_id：服务端对标题是"粘"的（后来的事件大多
// 不带标题，用一个低质量值去覆盖好标题，比没有标题更糟）。
//
// 上限 60 是主仓库的实测值：再长就看板上就开始挤掉目录名了。
const TITLE_MAX = 60;

// 密钥不能进标题。用户 prompt 的第一行有可能**正好就是**一段密钥
// （"帮我把这个 token 配进去 sk-xxxx"），而看板是会**上屏幕**的。
// 命中就**整个标题都不要**，不是"洗掉再显示"——洗到一半的密钥仍然是密钥，
// 而少一行标题只是少一行字。正则同样抄自主仓库。
const TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function clipTitle(s) {
  return s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s;
}

// ---- 关键词：头巾上写的那一个词 ----
//
// 归宿先列清楚，因为**它比标题更暴露**：标题只在打开看板时才上屏幕，
// 关键词是**一直挂在猫头上**的——投屏、截图、远程会议共享桌面，全都在画面里。
// 所以它的隐私口径取最严的那处：**和标题同一把尺（命中密钥就整条不要）**，
// 而且只从 prompt 派生成一个词送出去，原文依旧不离开这个进程（硬约束 28）。
const KEYWORD_MAX = 6; // 头巾就那么大，2~4 个字最合适，最多 6

// 中文没有空格，靠这两张表把一句话切成候选片段。
// **动作词单独一张**：一句"帮我修复登录页面的按钮样式"里真正有信息量的是
// "登录页面"；把"修复"留在词里，头巾上会显示"修复登录"——而动词几乎每个
// 任务都一样，留着它就没有区分度了。
const ZH_STOP = [
  "为什么", "什么样", "怎么样", "这个", "那个", "这段", "那段", "这篇", "我们", "你们", "他们", "咱们", "一下", "一个",
  "一些", "什么", "怎么", "现在", "然后", "但是", "因为", "所以", "如果", "可以", "需要",
  "应该", "麻烦", "能否", "是否", "帮我", "关于", "对于", "还有", "就是", "不是", "没有",
  // 单字只留**真正不可能出现在实词里**的那些。第一版把「用 上 下 中 里 个 好 对」也列进来，
  // 结果 "内存占用降下来" 被切成 "内存占"（"用" 被当虚词切掉）、"一个头巾" 变 "头巾" 时
  // 顺手把 "个" 也切了——中文单字切词的误伤面比想象中大得多，宁可少切几个。
  "的", "了", "是", "在", "和", "与", "或", "把", "被", "给", "让", "帮", "我", "你",
  "他", "她", "它", "们", "这", "那", "哪", "吗", "呢", "吧", "啊", "哦", "嗯",
  // 趋向补语：留在词里只会让关键词变成"xx出来""xx下来"这种半个词
  "出来", "下来", "起来", "过去", "过来", "上去", "下去",
];

const ZH_VERB = [
  "修复", "修一下", "修改", "改一下", "改改", "重构", "优化", "整理", "调整", "排查", "定位",
  "解决", "处理", "添加", "增加", "加一个", "加一下", "删除", "去掉", "移除", "清空",
  "实现", "编写", "写个", "写一个", "创建", "新建", "生成", "做个", "做一个", "统计", "计算",
  "分析", "检查", "验证", "确认", "调试", "运行", "部署", "发布", "提交", "更新",
  "升级", "迁移", "转换", "配置", "安装", "卸载", "替换", "合并", "拆分", "移动", "复制",
  "重命名", "查看", "搜索", "查找", "降低", "修", "改", "加", "删", "写", "做", "查", "看",
  "找", "跑", "抽", "降",
  // 「加个 / 换个 / 建个」这类"动词 + 量词"要整块切。只切"加"会留下"个头巾"，
  // 而把单字"个"列进虚词又会误伤"个人中心"——双字定向是最省事的解法。
  "加个", "换个", "建个", "写个", "做个", "改个", "删个", "修个",
  // 「测试」**故意不在**这张表里：它常常是事情本身而不是动作
  // （"这个测试跑不过"里的测试是名词）。第一版把它当动词切掉，
  // 于是那句话只剩一个"过"字可用——把真关键词切没了。
];

// 拉丁词天然有边界，按词取即可，所以停用词和动词合一张表就够了。
const EN_STOP = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "with", "and", "or", "is", "are", "was",
  "be", "been", "this", "that", "these", "those", "it", "its", "my", "your", "our", "their",
  "please", "help", "me", "can", "could", "would", "should", "will", "do", "does", "did",
  "make", "makes", "add", "adds", "fix", "fixes", "update", "change", "modify", "create",
  "write", "read", "remove", "delete", "refactor", "implement", "get", "set", "run", "test",
  "check", "now", "then", "but", "because", "so", "if", "up", "out", "into", "from", "at",
  "by", "as", "we", "you", "they", "i", "want", "need", "let", "us",
]);

// 长串优先，否则"加一下"会先被"加"切走，剩个"一下"没法用
const ZH_CUT = new RegExp(
  [...ZH_STOP, ...ZH_VERB].sort((a, b) => b.length - a.length).join("|"),
  "g"
);

// 从一段文本里挑一个词。不追求"抽得准"，追求**可预测**：
// 用户看一眼头巾就该知道"哦这在干那件事"，所以宁可粗一点，也不要每次都变。
function pickKeyword(text) {
  // 1) 拉丁词优先：有天然边界，取第一个非停用实词
  const en = text.match(/[A-Za-z][A-Za-z0-9_+#.]*/g) || [];
  for (const w of en) {
    const lw = w.toLowerCase();
    if (EN_STOP.has(lw) || lw.length < 2) continue;
    return w;
  }
  // 2) 中文：按虚词 + 动作词切开，取**最长**的存活片段（一样长取靠前的）。
  //
  // 为什么是最长而不是第一个：切完剩下的往往是名词短语，而真正指事的那个
  // 通常最长（"把桌宠的内存占用降下来" → 桌面 / 内存占用 → 后者才是这轮的事）。
  //
  // **没有兜底返回原段**。第一版写的是"切没了就取整段前几字"，于是
  // "看看" 和 "的了吗呢" 会被原样当成关键词——整段都是虚词时，
  // 正确答案就是"没有词可写"，不是硬凑一个。
  const zh = text.replace(/[^\u4e00-\u9fa5]+/g, "\n");
  let best = "";
  for (const run of zh.split("\n")) {
    for (const frag of run.split(ZH_CUT)) {
      const f = frag.trim();
      if (f.length >= 2 && f.length > best.length) best = f;
    }
  }
  return best || undefined;
}

// 返回 undefined = 这一轮没有值得往头巾上写的词
function deriveKeyword(event, payload) {
  const named = typeof payload.session_title === "string" ? payload.session_title.trim() : "";
  const src = named || (event === "UserPromptSubmit" && typeof payload.prompt === "string" ? payload.prompt : "");
  if (!src) return undefined;

  // 先扒掉代码块 / 行内码 / URL / 路径：这些是最容易把密钥和内网地址带进画面的东西，
  // 而且它们当关键词毫无意义（头巾上写 "https://" 没有任何信息量）。
  const text = src
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\bhttps?:\/\/\S+/g, " ")
    .replace(/[\w.-]*(?:[\\/][\w.-]+){1,}/g, " ")
    // 文件名单独剥一层：它没有空格，会被下面的"拉丁词优先"当成第一个实词取走，
    // 于是 "重构 state.js 的仲裁" 抽出来的是 "state."——既没有信息量，还像半截词。
    .replace(/\b[\w-]+\.(?:js|ts|tsx|jsx|mjs|cjs|json|md|py|go|rs|css|html|svg|yml|yaml|toml|sh|java|c|cpp)\b/gi, " ");

  // 和标题同一把尺：命中疑似密钥就整条不要。
  // 这里**不做"洗掉再显示"**——洗到一半的密钥仍然是密钥，
  // 而头巾空一格只是少一个词。
  if (TITLE_SECRET_RE.test(text)) return undefined;

  const kw = pickKeyword(text);
  if (!kw) return undefined;
  if (TITLE_SECRET_RE.test(kw)) return undefined; // 派生结果再过一遍
  return kw.slice(0, KEYWORD_MAX);
}

// 返回 undefined = 这一轮没有值得显示的标题（调用方就不会带上这个字段）
function deriveTitle(event, payload) {
  const named = typeof payload.session_title === "string" ? payload.session_title.trim() : "";
  if (named) return clipTitle(named);
  if (event === "UserPromptSubmit" && typeof payload.prompt === "string") {
    for (const line of payload.prompt.split(/\r?\n/)) {
      const c = line.trim();
      if (!c) continue; // 跳过开头的空行，第一句话才是标题
      if (TITLE_SECRET_RE.test(c)) return undefined;
      return clipTitle(c);
    }
  }
  return undefined;
}

// 只做长度截断和类型收敛，不做语义判断——语义归状态机
function field(v, max = MAX_FIELD) {
  return typeof v === "string" && v ? v.slice(0, max) : undefined;
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let size = 0;
    const chunks = [];

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => done(null), timeoutMs);

    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) return done(null); // 超限当作读不到，别把内存吃了
      chunks.push(chunk);
    });
    process.stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => done(null));
  });
}

function post(endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  return fetch(`http://127.0.0.1:${endpoint.port}/state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clawd-token": endpoint.token,
    },
    body,
    signal: controller.signal,
  })
    .catch(() => null) // 桌宠中途关了、端口没响应，都算正常情况
    .finally(() => clearTimeout(timer));
}

async function main() {
  // 1) 读 stdin（带硬超时），排在探端口之前。
  //    这个顺序最初是为送信定的（信不依赖桌宠在跑），送信砍掉之后它其实
  //    变成了一个待议项：单看"收"这一路，先探端口能省掉一次 stdin 读取。
  //    但先读也有它的道理——宿主是先把 payload 写进管道再等我们退出的，
  //    我们抢在它写完之前 exit(0)，写的一端就可能拿到 EPIPE。
  //    在有人实测过宿主对 EPIPE 的反应之前，不动这个顺序。
  const raw = await readStdin(STDIN_TIMEOUT_MS);
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {}; // 解析失败按空对象继续，事件名退回 argv
    }
  }
  if (!payload || typeof payload !== "object") payload = {};

  const event = field(payload.hook_event_name) || field(process.argv[2]);
  if (!event) return;


  // 2) 再探端口：桌宠没开就到此为止，不重试、不打印、退 0
  let endpoint;
  try {
    endpoint = readPortFile();
  } catch {
    return;
  }

  // 缺 session_id 的事件**不报**，绝不给它合成一个占位 id。
  //
  // 原来写的是 `field(payload.session_id) || "unknown"`，后果有两层，第二层才要命：
  //   ① 多条真实会话的事件被塞进同一条叫 "unknown" 的会话，Dashboard 上只剩一个幽灵；
  //   ② 它们的事件互相覆盖——A 正在 thinking，B 结束了发一个 Stop →
  //      attention 播完 800ms 回 idle，**A 的画面就变成 idle**。
  //      这正是用户报的"thinking 时显示 idle"的第二个可能来源。
  // 主仓库 hooks/workbuddy-hook.js 这条是带着 bug 编号的（#618 / #648）：
  // 合成 id 会造出一个"后面的事件既更新不了、也清除不掉"的幻影会话。
  // 会话不见了还有 MAX_SESSIONS 的淘汰兜底，状态互相污染没有兜底。
  //
  // 警告走 stderr：**这个文件绝不往 stdout 写一个字节**（信箱砍掉之后，stdout
  // 不再是协议通道，连"例外"都没有了；但 stderr 才是该用来抱怨的地方，这个习惯保留）。
  // trim 过后再判空：`"   "` 是 truthy 字符串，不 trim 就会被当成有效会话号，
  // 于是几条来自不同会话的事件照样会合并到同一条 `"   "` 会话里。
  const rawSid = field(payload.session_id);
  const sid = rawSid ? rawSid.trim() : undefined;
  if (!sid) {
    console.error(`[clawd-hook] 事件 ${event} 没带 session_id，已丢弃（不合成占位会话）`);
    return;
  }

  // Notification 里有一部分是 WorkBuddy 自己的生命周期闲聊，不是"在等你"。
  // 这两个值是主仓库 hooks/workbuddy-hook.js:30 实测列出来的：
  //   idle_prompt —— "再发一条消息吧"的提醒（Stop 之后约 60 秒）
  //   auth_success —— 登录成功的 toast（每一轮开头都发一次）
  // 必须在**源头**滤掉而不是交给状态机：notification 是"真的在等你"的长状态，
  // 让一条 idle_prompt 挂上来，桌宠就会凭空提示好几分钟（见 state.js 那条注释）。
  if (event === "Notification") {
    const ntype = field(payload.notification_type);
    if (ntype && IGNORED_NOTIFICATION_TYPES.has(ntype)) return;
  }

  // 3) 只取需要的字段，其余一律丢弃（不落盘、不打日志）
  //
  // 标题在这里算完再走：prompt 是用户原文，它**不离开这个进程**——
  // 我们只把"第一行"这一条派生结果发出去。真要把 prompt 整段 POST 给桌宠，
  // 就等于给本机 HTTP 那条链路上多挂一份用户原文。
  const title = deriveTitle(event, payload);
  const keyword = deriveKeyword(event, payload);
  const body = JSON.stringify({
    agent: "claude-code",
    session_id: sid,
    event,
    cwd: field(payload.cwd, MAX_CWD),
    tool_name: field(payload.tool_name),
    ...(title ? { title } : {}),
    ...(keyword ? { keyword } : {}),
  });

  await post(endpoint, body);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
