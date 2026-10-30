"use strict";
// ============================================================
// S10-1  权限请求的风险评级（纯函数，无副作用，可单测）
//
// 它是什么：**给用户的提示**，不是安全边界。
//
// 这句话必须写在最上面，因为它决定了后面所有设计取舍：
//   - 它读的是 agent 送过来的字符串，agent 想骗过它有一万种办法
//     （引号切分、变量替换、base64、here-doc、写成脚本文件再执行）。
//   - 所以它的定位是"帮你把明显危险的命令标红"，不是"拦住危险命令"。
//   真要拦，那道闸在 agent 侧的权限系统里，不在这个气泡里。
//
// 由此推出两条硬规则，改这个文件之前先读：
//   1. **评级不改变默认行为**。critical 也不会自动 deny —— deny 会让工具静默
//      失败，用户还以为自己批准过（硬约束 5 / SECURITY S5）。不点依然是 204。
//   2. **误报方向偏严，但阈值要克制**。每条都标红等于没标：用户三秒后就会
//      养成"弹出来就点允许"的肌肉记忆，那比不评级更糟。所以 low 必须占大多数，
//      只有"真值得你停一下看一眼"的才进 high / critical。
//
// 判定的核心是**先认命令词，再判参数**，不是拿正则糊整条字符串。
// 这是第一版踩出来的：在整串上跑 `/\bssh\b/` 会把 `cat ~/.ssh/id_rsa` 判成
// 网络连接（`.ssh` 里的 ssh 前后都是单词边界），把 `rm -rf ./build` 判成删根目录
// （`.` 开头的相对路径被当成 `.`）。两类误报的根因是同一个：**没分清"命令"
// 和"命令里的一个词"**。
//
// 输出：{ level, label, score, reasons: [{ code, text, level }] }
//   level = 所有命中里最高的；reasons 按等级降序，最多 4 条。
// ============================================================

const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
const LABEL = { low: "低", medium: "中", high: "高", critical: "极高" };

// 输入体量预警阈值。一次性塞进来的命令超过这个长度，多半是 here-doc 或拼接脚本。
// 注意这只是体量的**代理指标**，不是 token 计数：本进程看不到 agent 的 tokenizer，
// 所以文案里必须写"体量预警"而不是"token 超标"，别让用户以为我们真的数过。
const BIG_COMMAND_CHARS = 1200;

// ---- 归一化 ------------------------------------------------------------
// 目的不是还原 shell 语义（那是 shell 的事，做不到），而是挡掉最常见的
// 几种**专门为了绕过关键字检测**的写法。
function normalize(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\$\{IFS\}/g, " ")
    .replace(/\$IFS\b/g, " ")
    .replace(/\$\{[a-zA-Z_][a-zA-Z0-9_]*:?-\}/g, "") // ${x:-} 空兜底替换
    .replace(/\\\s+/g, " ") // 反斜杠续行
    .replace(/[ 　]+/g, " ")
    .replace(/[\r\n\t]+/g, " ") // here-doc 摊平看
    .trim();
}

// 按 shell 分隔符切段。`rm -rf / && echo ok` 里要判的是前一段，
// `echo ok && rm -rf /` 里要判的是后一段——所以是全部扫，不是只看开头。
function segments(cmd) {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 极简分词：按空格切，剥掉引号。
// 这里**故意**不做引号感知——`rm "-rf" /` 和 `rm -rf /` 在我们的判据里是同一件事。
function tokens(seg) {
  return seg
    .replace(/["'`]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// 取一段里的"命令词"：跳过 `FOO=bar` 赋值前缀和 sudo / env / nohup 这类包装。
// 之后所有"这是不是 ssh / rm / git"的判断都基于它，不再扫全文。
function commandWord(t) {
  let i = 0;
  while (i < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i])) i++; // VAR=val
  while (i < t.length && /^(?:sudo|doas|pkexec|runas|gsudo|env|nohup|nice|time|command|exec|xargs)$/i.test(t[i])) i++;
  const w = i < t.length ? t[i] : "";
  // /usr/bin/rm 这种带路径的取 basename
  const m = w.match(/(?:^|\/)([\w.-]+)$/);
  return m ? m[1].toLowerCase() : "";
}

// 命令词后面第一个非 flag 的参数，用于 git / npm / systemctl 这类"动词+子命令"
function subCommand(t, cmdWord) {
  let i = 0;
  while (i < t.length && !t[i].toLowerCase().endsWith(cmdWord)) i++;
  for (let j = i + 1; j < t.length; j++) {
    if (t[j].startsWith("-")) continue;
    return t[j].toLowerCase();
  }
  return "";
}

function analyze(raw) {
  const cmd = normalize(raw);
  const segs = segments(cmd).map((seg) => {
    const t = tokens(seg);
    const cw = commandWord(t);
    return { seg, tokens: t, cmd: cw, sub: cw ? subCommand(t, cw) : "" };
  });
  return { cmd, segs, rawLength: typeof raw === "string" ? raw.length : 0 };
}

// ------------------------------------------------------------------------
// 递归删除的目标名单。命中 = 删完机器也别要了。
// `^\.\.?$` 只匹配正好是 `.` / `..` 的——`./build` 不算，它是相对子目录。
// 第一版写成 `\.\.?` 不带边界，于是 `rm -rf ./build` 被判成删根目录。
// ------------------------------------------------------------------------
const RM_CRITICAL_TARGETS =
  /^(?:\/|~|\$HOME|\/\*|~?\/\*|\*|\.\.?|\/(?:home|etc|usr|var|bin|sbin|boot|lib|opt|root|System|Users|Windows|Program\s?Files)(?:\/|$)|[A-Za-z]:\\?)$/;

// 只输出文本、不执行的命令。它们参数里出现 `rm -rf /` 通常是字符串内容，
// 不是真要删——降级处理，否则 `echo "小心 rm -rf /" > note.txt` 会标成红牌。
const TEXT_ONLY_CMDS = /^(?:echo|printf|true|false|cat|head|tail|less|more|man|help)$/;

// 写动作的信号：重定向覆盖 / tee / 复制移动 / 就地编辑
function hasWriteAction(s) {
  return (
    /(?:^|[^>])>(?!>)/.test(s.seg) ||
    /(?:^|[^<])<<</.test(s.seg) ||
    s.cmd === "tee" ||
    /^(?:cp|mv|install|ln|rsync|dd|chmod|chown|chgrp|touch|truncate)$/.test(s.cmd) ||
    (s.cmd === "sed" && /-i|--in-place/.test(s.seg)) ||
    (s.cmd === "cat" && />>?/.test(s.seg))
  );
}

// ---- rm：结构化解析（flag + target 分开判），不走通用正则 ----
function scanRm(a) {
  const hits = [];
  for (const s of a.segs) {
    if (s.cmd !== "rm") continue;
    let recursive = false;
    let force = false;
    const targets = [];
    for (let j = 1; j < s.tokens.length; j++) {
      const tok = s.tokens[j];
      if (tok.startsWith("-") && tok.length > 1) {
        if (/^-{1,2}[a-zA-Z]*[rR]/.test(tok) || tok === "--recursive") recursive = true;
        if (/^-{1,2}[a-zA-Z]*[fF]/.test(tok) || tok === "--force") force = true;
        continue;
      }
      if (tok === "--") continue;
      targets.push(tok);
    }
    if (!targets.length) continue;

    const critical = targets.some((x) => RM_CRITICAL_TARGETS.test(x));
    const soft = TEXT_ONLY_CMDS.test(s.cmd); // rm 本身就是命令词时这里是 false，保留给未来
    let hit;
    if (recursive && critical) hit = { code: "RM_ROOT", level: "critical", text: `递归删除系统或家目录（${targets[0]}），删掉的东西找不回来` };
    else if (recursive) hit = { code: "RM_RECURSIVE", level: force ? "high" : "medium", text: `递归删除目录${force ? "且不询问" : ""}（${targets.slice(0, 2).join(" ")}${targets.length > 2 ? " 等" : ""}）` };
    else if (critical) hit = { code: "RM_ROOT_FILE", level: "high", text: `删除系统或家目录下的文件（${targets[0]}）` };
    else hit = { code: "RM_FILE", level: "low", text: "删除单个文件" };
    if (soft && RANK[hit.level] > RANK.medium) hit = { ...hit, level: "medium" };
    hits.push(hit);
  }
  return hits;
}

// ---- git：按子命令判 ----
function scanGit(a) {
  const hits = [];
  for (const s of a.segs) {
    if (s.cmd !== "git") continue;
    const flags = s.seg;
    if (s.sub === "push" && /--force|-f\b|--force-with-lease/.test(flags)) {
      const toMain = /(?:^|\s)(?:origin\s+)?(?:main|master|HEAD)(?:\s|$)/.test(flags) || !/(?:^|\s)(?:origin\s+)?[a-zA-Z0-9_.-]+\/(?:[a-zA-Z0-9_.-]+)/.test(flags);
      hits.push(
        toMain
          ? { code: "FORCE_PUSH_MAIN", level: "critical", text: "强推到主干分支（main/master），会覆盖别人的提交" }
          : { code: "FORCE_PUSH", level: "high", text: "强推远端分支，会覆盖已有提交" }
      );
    } else if (/^(?:commit|push|merge|rebase|cherry-pick|tag|am)$/.test(s.sub)) {
      hits.push({ code: "GIT_WRITE", level: "medium", text: `写入仓库历史或远端（git ${s.sub}）` });
    } else if (s.sub === "reset" && /--hard/.test(flags)) {
      hits.push({ code: "GIT_HARD_RESET", level: "high", text: "丢弃本地未提交的改动（git reset --hard）" });
    } else if (s.sub === "clean" && /-[a-z]*f/.test(flags)) {
      hits.push({ code: "GIT_CLEAN", level: "high", text: "强制删除未跟踪文件（git clean -f），删掉的不在版本库里" });
    } else if (s.sub === "checkout" && /--\s+\./.test(flags)) {
      hits.push({ code: "GIT_DISCARD", level: "high", text: "丢弃工作区改动（git checkout -- .）" });
    }
  }
  return hits;
}

// ---- 其余规则：多数按命令词判，少数必须看全文 ----
const RULES = [
  // ---- critical ----
  {
    code: "DISK_WIPE",
    level: "critical",
    text: "直接写块设备或格式化磁盘（mkfs / dd of=/dev/ / format）",
    test: (a) =>
      a.segs.some((s) => /^(?:mkfs|mkfs\.[a-z0-9]+|diskpart)$/.test(s.cmd)) ||
      /\bdd\b[\s\S]*\bof\s*=\s*\/dev\//i.test(a.cmd) ||
      a.segs.some((s) => s.cmd === "format" && /[a-z]:\\|\/dev\//i.test(s.seg)),
  },
  {
    code: "FORK_BOMB",
    level: "critical",
    text: "fork 炸弹，几分钟内就能把机器拖死",
    test: (a) => /:\s*\(\s*\)\s*\{[\s\S]*:\s*\|[\s\S]*:\s*&[\s\S]*\}/.test(a.cmd),
  },
  {
    code: "PIPE_REMOTE_EXEC",
    level: "critical",
    text: "从网络拉内容直接喂给解释器执行（curl/wget | sh/bash/python）",
    test: (a) =>
      /(?:curl|wget|Invoke-WebRequest|iwr)[\s\S]{0,400}?\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh|fish|python[23]?|perl|ruby|powershell|pwsh)\b/i.test(a.cmd) ||
      /\|\s*(?:sh|bash|zsh|python[23]?)\s*$/i.test(a.cmd) ||
      /\biex\s*\(/i.test(a.cmd),
  },
  {
    code: "CHMOD_WORLD_ROOT",
    level: "critical",
    text: "把系统或家目录递归改成 777（任何人可读写执行）",
    test: (a) =>
      a.segs.some(
        (s) =>
          s.cmd === "chmod" &&
          /-R|--recursive/.test(s.seg) &&
          /(?:7{3}|a\+rwx|o\+w)/.test(s.seg) &&
          /(?:\/|~|\$HOME|\/(?:home|etc|usr|var|Users|System))/.test(s.seg)
      ),
  },

  // ---- high ----
  {
    code: "SECRET_IN_COMMAND",
    level: "high",
    text: "命令里出现疑似密钥（sk- / ghp_ / AKIA / 私钥头 等），可能被打进日志或历史",
    // 只匹配"形似密钥"的高置信前缀，不做泛化长串判断——那会误伤 base64 参数和 hash
    test: (a) =>
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,})\b/.test(a.cmd) ||
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(a.cmd),
  },
  {
    code: "CREDENTIAL_WRITE",
    level: "high",
    text: "写入凭据文件（~/.ssh、.aws/credentials、.env、.npmrc、.netrc）",
    // 必须同时有写动作。只读（`cat ~/.ssh/id_rsa`）不构成写，降为下面的 medium。
    test: (a) => a.segs.some((s) => hasWriteAction(s) && CREDENTIAL_PATH.test(s.seg)),
  },
  {
    code: "CREDENTIAL_TOUCH",
    level: "medium",
    text: "涉及凭据文件路径（~/.ssh、.env、私钥等）",
    test: (a) => a.segs.some((s) => CREDENTIAL_PATH.test(s.seg)),
  },
  {
    code: "DESTRUCTIVE_SQL",
    level: "high",
    text: "破坏性数据库操作（DROP / TRUNCATE / 无 WHERE 的 DELETE）",
    test: (a) =>
      /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE)\b/i.test(a.cmd) ||
      /\bDELETE\s+FROM\b(?![\s\S]{0,120}\bWHERE\b)/i.test(a.cmd),
  },
  {
    code: "SUDO",
    level: "high",
    text: "以管理员权限执行（sudo / runas / 提权）",
    test: (a) => /\b(?:sudo|doas|pkexec|runas|gsudo)\b/i.test(a.cmd) || /-Verb\s+RunAs/i.test(a.cmd),
  },
  {
    code: "PUBLISH",
    level: "high",
    text: "对外发布制品（npm publish / docker push / twine upload），发出去就撤不回",
    test: (a) =>
      a.segs.some(
        (s) =>
          (/^(?:npm|yarn|pnpm|bun)$/.test(s.cmd) && /^(?:publish|pack)$/.test(s.sub)) ||
          (s.cmd === "docker" && s.sub === "push") ||
          (s.cmd === "twine" && s.sub === "upload") ||
          (s.cmd === "cargo" && s.sub === "publish") ||
          (s.cmd === "helm" && s.sub === "push") ||
          (s.cmd === "gem" && s.sub === "push")
      ),
  },
  {
    code: "SERVICE_KILL",
    level: "high",
    text: "强杀进程或服务（kill -9 / pkill / taskkill /F / systemctl stop）",
    test: (a) =>
      a.segs.some(
        (s) =>
          /^(?:kill|killall|pkill|pkillall)$/.test(s.cmd) ||
          (s.cmd === "taskkill" && /\/F/i.test(s.seg)) ||
          (/^(?:systemctl|service|brew)$/.test(s.cmd) && /^(?:stop|kill)$/.test(s.sub))
      ) || /\bkill\s+-9\b/.test(a.cmd),
  },

  // ---- medium ----
  {
    code: "OUTBOUND_NETWORK",
    level: "medium",
    text: "对外发起网络请求（curl / wget / ssh / scp），数据会离开本机",
    // 只看命令词：`.ssh` 这种路径里的 ssh 不算（第一版就是在这里误报的）
    test: (a) => a.segs.some((s) => /^(?:curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|invoke-webrequest|iwr)$/.test(s.cmd)),
  },
  {
    code: "ESCAPES_CWD",
    level: "medium",
    text: "路径里出现 ..，可能在工作目录之外操作",
    test: (a) => /(?:^|[\s=])~?\.\.[\/\\]/.test(a.cmd),
  },
  {
    code: "OVERWRITE_REDIRECT",
    level: "medium",
    text: "用重定向覆盖已有文件（> file），原内容会被替换",
    test: (a) => a.segs.some((s) => /(?:^|[^>])>(?!>)/.test(s.seg)),
  },
  {
    code: "BIG_PAYLOAD",
    level: "medium",
    text: "这次调用的输入体量很大，可能是大段生成内容（体量预警，非精确 token 计数）",
    test: (a) => a.rawLength > BIG_COMMAND_CHARS,
  },
];

const CREDENTIAL_PATH =
  /(?:~|\$HOME|\/home\/[^\s]+|\/Users\/[^\s]+)?\.ssh\b|\.aws\/credentials|\.netrc|\.npmrc|\.git-credentials|\.docker\/config\.json|\bid_(?:rsa|dsa|ecdsa|ed25519)\b|(?:^|[\s=>])\.?\.env(?:[.=][^\s]*)?(?:\s|$)/i;

// 只读工具：明确无副作用的一类，兜底让 low 成为大多数。
const READ_ONLY_TOOLS = /^(?:Read|Glob|Grep|LS|WebFetch|WebSearch|TodoRead|Task|TaskGet|BashOutput|ReadFile|ListDir)$/i;
// 写入类工具：送过来的"command"是 file_path，命令侧判不出内容，只能按工具名给底。
const WRITE_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|Create|Replace|Delete)$/i;

/**
 * 给一条权限请求评级。
 * @param {{toolName?:string, command?:string, cwd?:string}} req
 * @returns {{level:string, label:string, score:number, reasons:Array<{code:string,text:string,level:string}>}}
 */
function assessRisk(req) {
  const toolName = (req && typeof req.toolName === "string" && req.toolName) || "";
  const raw = (req && typeof req.command === "string" && req.command) || "";
  const a = analyze(raw);

  const hits = [...scanRm(a), ...scanGit(a)];
  for (const rule of RULES) {
    if (rule.test(a)) hits.push({ code: rule.code, level: rule.level, text: rule.text });
  }

  // CREDENTIAL_WRITE 命中时，同族的 CREDENTIAL_TOUCH 就是重复信息，去掉
  const hasCredWrite = hits.some((h) => h.code === "CREDENTIAL_WRITE");

  if (WRITE_TOOLS.test(toolName)) {
    hits.push({ code: "WRITE_TOOL", level: "medium", text: `写入或修改文件（${toolName}）` });
  }

  // 去重：同一 code 只留一条（`rm -rf a && rm -rf /` 会命中两次 RM_ROOT）
  const seen = new Set();
  const reasons = hits
    .filter((h) => (hasCredWrite && h.code === "CREDENTIAL_TOUCH" ? false : seen.has(h.code) ? false : (seen.add(h.code), true)))
    .sort((x, y) => RANK[y.level] - RANK[x.level])
    .slice(0, 4);

  if (!reasons.length && READ_ONLY_TOOLS.test(toolName)) {
    reasons.push({ code: "READ_ONLY", level: "low", text: "只读操作，不改动本机状态" });
  }

  const level = reasons.length ? reasons[0].level : "low";
  return { level, label: LABEL[level], score: RANK[level], reasons };
}

module.exports = {
  assessRisk,
  analyze,
  normalize,
  segments,
  commandWord,
  RANK,
  LABEL,
  BIG_COMMAND_CHARS,
};
