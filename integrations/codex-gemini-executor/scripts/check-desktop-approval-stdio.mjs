#!/usr/bin/env node
// Real candidate, SDK and wire round trips, but SCRIPTED decisions, never Desktop evidence.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { createHarnessCore, requestFor, CASES, check } from "./desktop-approval-canary.mjs";

export async function runScriptedProtocol(descriptorPath) {
  const { core, pkg, d, load } = await createHarnessCore(descriptorPath, { mode: "scripted" });
  const require = createRequire(win32.join(pkg, "package.json"));
  const { InMemoryTransport } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/server")));
  const { createGeminiMcpServer } = await load("mcp-bridge.js");
  const trace = [];
  const server = createGeminiMcpServer({ core, onApprovalTrace: (event) => { if (trace.length < 128) trace.push(event); } });
  const [client, transport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  let next = 0;
  let current;
  let prompts = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("protocol_deadline")); }, 195000);
    pending.set(id, { resolve, reject, timer });
    client.send({ jsonrpc: "2.0", id, method, params }).catch(reject);
  });
  client.onmessage = (message) => {
    if (message.method === "elicitation/create") {
      prompts++;
      const reply = () => client.send({ jsonrpc: "2.0", id: message.id, result: {
        action: current === "timeout" ? "cancel" : current,
        ...(current === "accept" ? { content: {
          decision: "accept", commandActions: message.params.requestedSchema.properties.commandActions.const,
        } } : {}),
      } });
      if (current === "timeout") {
        // Do not decide within the real 1-minute job deadline. Afterwards release
        // the legacy SDK's outstanding request; this does not approve the job.
        void (async () => {
          await new Promise((resolve) => setTimeout(resolve, 31000));
          await new Promise((resolve) => setTimeout(resolve, 30000));
          await reply();
        })().catch(() => {});
      } else void reply();
      return;
    }
    const p = pending.get(message.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(message.id);
    if (message.error) p.reject(new Error("protocol_error")); else p.resolve(message.result);
  };
  const report = { status: "running", scope: "scripted protocol and real fixture writes; not Desktop UI", desktopAcceptance: false, scenarios: [], trace };
  try {
    await client.start(); await server.connect(transport);
    const initialized = await send("initialize", { protocolVersion: "2025-11-25", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "qualification-scripted", version: "1" } });
    check(initialized.protocolVersion === "2025-11-25", "unexpected_protocol");
    report.protocol = initialized.protocolVersion;
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    const list = await send("tools/list");
    check(list.tools.length === 3, "tools_missing");
    for (const c of CASES) {
      current = c; prompts = 0;
      let r;
      let lateResponseRejected = false;
      try { r = await send("tools/call", { name: "run_gemini_task", arguments: requestFor(win32.join(d.fixtureRoot, "scripted"), c) }); }
      catch (e) {
        if (c !== "timeout" || e.message !== "protocol_error") throw e;
        lateResponseRejected = true;
      }
      check(prompts === 1, "approval_not_exercised");
      const recorded = JSON.parse(await readFile(win32.join(d.root, "scripted-evidence", c + ".result.json"), "utf8"));
      check(recorded.status === "pass", "harness_result_failed");
      // A legacy shim may reject the stale continuation after timeout; persisted
      // status must still show a timed-out job and confirmed cleanup.
      const expected = ({ accept: "completed", decline: "failed", cancel: "cancelled", timeout: "failed" })[c];
      if (c !== "timeout") check(r.structuredContent?.status === expected, "wire_scenario_failed");
      const status = await send("tools/call", { name: "get_gemini_status", arguments: { job_id: recorded.jobId } });
      check(status.structuredContent?.status === expected, "wire_status_mismatch");
      report.scenarios.push({ scenario: c, status: status.structuredContent.status, jobId: recorded.jobId, prompts,
        ...(c === "timeout" ? { lateResponseRejected, terminalCode: status.structuredContent.error?.category } : {}) });
    }
    report.status = "pass";
  } catch(e) { report.status = "failed"; report.error = /^[a-z_]+$/.test(e.message) ? e.message : "protocol_check_failed"; }
  finally {
    await server.close(); await client.close();
    for (const p of pending.values()) clearTimeout(p.timer);
  }
  await writeFile(win32.join(d.root, "scripted-protocol.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  return report;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runScriptedProtocol(process.argv[2]).then((r) => { process.stdout.write(JSON.stringify(r) + "\n"); process.exitCode = r.status === "pass" ? 0 : 1; })
    .catch(() => { process.stderr.write("Scripted qualification failed; no retry\n"); process.exitCode = 1; });
}
