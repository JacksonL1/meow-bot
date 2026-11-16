// ============================================================
// DSH → 桌宠的审批桥（2026-11-16）
//
// 为什么需要它：DSH 的审批是一个**可插拔的应答者**（`approval/request` waterfall，
// 见 `@deepseek-ai/dsh-user-approval` 的 README）。桌面端由 GUI 应答；**headless 没有
// 任何应答者**——实测它对需要审批的操作直接报
// `sandbox escalation ... requires approval, but no approval channel is available`。
// 而桌宠「说一句」走的正是 headless，所以"它需要确认"这件事以前既看不见、也答不了。
//
// 这个插件就是那个缺失的应答者：把请求原样 POST 给桌宠的 `/permission`
// （和 Claude Code 共用一条链路、同一个气泡），把用户的点击翻回 DSH 的词汇。
//
// 三条自觉的边界：
//   1. **桌宠不在就立即 `next()`**——不阻塞、不报错、不假装自己答了；
//      没有应答者时 DSH 本来就 fail closed，行为与未安装完全一致。
//   2. **只允许这一次**：`allowed-once` 是唯一的授权词汇，不写任何"永久允许"。
//   3. **不碰凭据、不读别的配置**：只读桌宠的端点文件拿端口号（`/permission`
//      按设计不校 token——它是裁决端点，安全边界在 Host/Origin/Content-Type 上）。
// ============================================================

import fs from "node:fs";
import path from "node:path";

/// 端点文件的默认位置（与 `src/port-file.js` 同一约定）。`CLAWD_PORT_FILE` 是测试隔离口。
function portFile(env = process.env) {
  return (
    env.CLAWD_PORT_FILE ||
    path.join(env.APPDATA || "", "clawd-starter", "clawd-starter.port")
  );
}

/// 桌宠此刻在哪。读不到 = 它没开，这不是错误。
export function petEndpoint(env = process.env) {
  try {
    const raw = fs.readFileSync(portFile(env), "utf8");
    const j = JSON.parse(raw);
    if (!j || !Number.isInteger(j.port) || j.port <= 0 || j.port > 65535) return null;
    return `http://127.0.0.1:${j.port}/permission?via=dsh`;
  } catch {
    return null;
  }
}

/// 桌宠的 HTTP 回答 → DSH 的审批词汇。
/// 204 是桌宠的"我不做决定"（超时 / 关掉气泡 / 退出），**不是拒绝**：
/// 翻成 unavailable 让 DSH 按"没有应答者"收尾，语义才对得上。
export function outcomeOf(status, body) {
  if (status === 204) return "unavailable";
  if (status !== 200) return null; // 意外状态：交给下一个应答者
  // 与 Claude Code 共用裁决端点，所以决定位于 hookSpecificOutput 里。
  // 读成 body.decision 会把真实的 allow/deny 全部错译成 unavailable。
  const behavior = body?.hookSpecificOutput?.decision?.behavior;
  if (behavior === "allow") return "allowed-once";
  if (behavior === "deny") return "rejected";
  return "unavailable";
}

/// 一次审批的完整往返。抽出来是为了能拿假 ctx 直接测，不用真起 DSH。
export async function askPet(req, fetchImpl = fetch) {
  const url = petEndpoint();
  if (!url) return null; // 桌宠没开 → 调用方 next()

  const signal = AbortSignal.any(
    [AbortSignal.timeout(130_000), req.signal].filter(Boolean)
  );
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 和 Claude Code 的 hook 一样走本地回环；Host/Origin 由桌宠侧校验。
      },
      body: JSON.stringify({
        session_id: req.agent?.session?.id,
        tool_name: req.toolName,
        // 气泡的"命令原文"位置放 DSH 给的理由：审批请求里没有命令文本，
        // 只有 toolName / callId / reason（见 ApprovalService.request）。
        tool_input: { command: req.reason || "" },
        agent: "dsh",
      }),
      signal,
    });
  } catch (e) {
    // 用户取消了这一轮（DSH 那边 abort）→ cancelled；网络断/超时 → 交给别人。
    if (req.signal?.aborted) return "cancelled";
    return null;
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // 204 没有 body，这不是错误
  }
  return outcomeOf(res.status, body);
}

export default {
  name: "clawd-approval-bridge",
  apply(ctx) {
    ctx.on("approval/request", async (req, next) => {
      // 已经中止的轮次不要再弹窗：用户早就走了。
      if (req.signal?.aborted) return "cancelled";
      const outcome = await askPet(req);
      // null = 桌宠不在 / 网络不通 / 意外状态。委托给下一个应答者，
      // 让"没装桌宠"和"装了但它没开"都不改变 DSH 的原有行为。
      if (outcome === null) return next();
      return outcome;
    });
  },
};
