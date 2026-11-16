#!/usr/bin/env node
"use strict";
// DSH 审批桥的快速闸门：不调用模型，不碰真实 ~/.dsh。
// 安装器用临时 profile；HTTP 往返用本机假桌宠；真机链路另做人工/CDP 验证。

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const INSTALLER = path.join(ROOT, "hooks", "install-dsh-approval.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-verify-dsh-approval-"));
let pass = 0;
let fail = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}  ${err.message}`);
  }
}

function runInstaller(profile, ...extra) {
  const r = spawnSync(process.execPath, [INSTALLER, "--profile-dir", profile, ...extra], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}

async function main() {
  const profile = path.join(TMP, "headless");
  fs.mkdirSync(profile, { recursive: true });
  const patch = path.join(profile, "cordis.patch.yml");
  const plugin = path.join(profile, "clawd-approval-bridge.mjs");
  const original = `# 用户自己的模型配置\n- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: cmg\n    model: keep-me\n# 实验原型（无 marker，安装器也必须接管）\n- insert:\n    - id: clawd-approval-bridge\n      name: "./clawd-approval-bridge.mjs"\n`;
  fs.writeFileSync(patch, original);
  fs.writeFileSync(plugin, 'export default { name: "prototype", apply() { return "rejected"; } };\n');

  await ok("dry-run 不碰插件或 YAML", async () => {
    runInstaller(profile, "--dry-run");
    assert.equal(fs.readFileSync(patch, "utf8"), original);
    assert.match(fs.readFileSync(plugin, "utf8"), /prototype/);
  });

  await ok("安装接管固定 rejected 原型，用户模型配置逐字保留", async () => {
    runInstaller(profile);
    const next = fs.readFileSync(patch, "utf8");
    assert.match(next, /provider: cmg\n    model: keep-me/);
    assert.equal((next.match(/id: clawd-approval-bridge/g) || []).length, 1);
    assert.match(next, /# >>> clawd-starter dsh approval bridge >>>/);
    assert.equal(
      fs.readFileSync(plugin, "utf8"),
      fs.readFileSync(path.join(ROOT, "hooks", "dsh-approval-bridge.mjs"), "utf8")
    );
  });

  await ok("重复安装幂等，不再制造备份或重复 insert", async () => {
    const beforePatch = fs.readFileSync(patch, "utf8");
    const beforePlugin = fs.readFileSync(plugin, "utf8");
    const backupsBefore = fs.readdirSync(profile).filter((x) => x.includes(".clawd-backup-")).length;
    const out = runInstaller(profile);
    assert.match(out, /无变化/);
    assert.equal(fs.readFileSync(patch, "utf8"), beforePatch);
    assert.equal(fs.readFileSync(plugin, "utf8"), beforePlugin);
    assert.equal(fs.readdirSync(profile).filter((x) => x.includes(".clawd-backup-")).length, backupsBefore);
  });

  await ok("卸载只摘自己的插件和配置段", async () => {
    runInstaller(profile, "--uninstall");
    assert.equal(fs.existsSync(plugin), false);
    const next = fs.readFileSync(patch, "utf8");
    assert.doesNotMatch(next, /clawd-approval-bridge/);
    assert.match(next, /model: keep-me/);
    const again = runInstaller(profile, "--uninstall");
    assert.match(again, /无变化/);
  });

  const bridge = await import(pathToFileURL(path.join(ROOT, "hooks", "dsh-approval-bridge.mjs")).href);
  const portFile = path.join(TMP, "pet.port");
  fs.writeFileSync(portFile, JSON.stringify({ port: 32123, token: "not-sent-by-bridge" }));

  await ok("端点文件只取合法回环端口，不带 token 进裁决请求", async () => {
    assert.equal(bridge.petEndpoint({ CLAWD_PORT_FILE: portFile }), "http://127.0.0.1:32123/permission?via=dsh");
    fs.writeFileSync(portFile, JSON.stringify({ port: 70000 }));
    assert.equal(bridge.petEndpoint({ CLAWD_PORT_FILE: portFile }), null);
  });

  await ok("真实 hookSpecificOutput 回包映射成 DSH 词汇", async () => {
    assert.equal(bridge.outcomeOf(200, { hookSpecificOutput: { decision: { behavior: "allow" } } }), "allowed-once");
    assert.equal(bridge.outcomeOf(200, { hookSpecificOutput: { decision: { behavior: "deny" } } }), "rejected");
    assert.equal(bridge.outcomeOf(204, null), "unavailable");
    assert.equal(bridge.outcomeOf(500, null), null);
    assert.equal(bridge.outcomeOf(200, { decision: { behavior: "allow" } }), "unavailable");
  });

  let mode = "allow";
  let received = null;
  let hanging = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
      if (mode === "hang") {
        hanging = res;
        return;
      }
      if (mode === "empty") {
        res.writeHead(204).end();
        return;
      }
      const behavior = mode === "deny" ? "deny" : "allow";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  fs.writeFileSync(portFile, JSON.stringify({ port, token: "secret-not-for-permission" }));
  process.env.CLAWD_PORT_FILE = portFile;

  let listener = null;
  bridge.default.apply({ on(event, fn) { assert.equal(event, "approval/request"); listener = fn; } });
  const next = async () => "next";
  const req = { toolName: "pwsh", callId: "call-test", reason: "escalate sandbox to danger-full-access: test" };

  await ok("DSH 请求上桌宠，点击允许返回 allowed-once", async () => {
    mode = "allow";
    assert.equal(await listener(req, next), "allowed-once");
    assert.equal(received.url, "/permission?via=dsh");
    assert.equal(received.body.agent, "dsh");
    assert.equal(received.body.tool_name, "pwsh");
    assert.equal(received.body.tool_input.command, req.reason);
    assert.equal(received.headers["x-clawd-token"], undefined);
  });

  await ok("点击拒绝返回 rejected，超时/关窗的 204 返回 unavailable", async () => {
    mode = "deny";
    assert.equal(await listener(req, next), "rejected");
    mode = "empty";
    assert.equal(await listener(req, next), "unavailable");
  });

  await ok("DSH 轮次已中止时不再弹窗", async () => {
    const controller = new AbortController();
    controller.abort();
    received = null;
    assert.equal(await listener({ ...req, signal: controller.signal }, next), "cancelled");
    assert.equal(received, null);
  });

  await ok("等待气泡时 DSH 中止，桥返回 cancelled", async () => {
    mode = "hang";
    const controller = new AbortController();
    const pending = listener({ ...req, signal: controller.signal }, next);
    setTimeout(() => controller.abort(), 40);
    assert.equal(await pending, "cancelled");
    if (hanging) hanging.end();
    hanging = null;
  });

  await new Promise((resolve) => server.close(resolve));

  await ok("桌宠不在时委托 next，保持 DSH 原有 fail-closed", async () => {
    assert.equal(await listener(req, next), "next");
  });

  console.log(`\nDSH 审批桥：${pass} PASS / ${fail} FAIL`);
  if (fail) throw new Error(failures.join("；"));
}

main()
  .catch((err) => {
    console.error(err.stack || err);
    process.exitCode = 1;
  })
  .finally(() => {
    delete process.env.CLAWD_PORT_FILE;
    fs.rmSync(TMP, { recursive: true, force: true });
  });
