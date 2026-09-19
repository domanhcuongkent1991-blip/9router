import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createRouterResponsesRuntime,
  validateRouterBaseUrl,
} from "../src/router-responses-runtime.js";
import { createFileBroker } from "../src/file-broker.js";
import { createGrant, resolveScope } from "../src/job-scope.js";

function response(output) {
  return new Response(JSON.stringify({
    object: "response",
    status: "completed",
    output,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function message(text) {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

function call(name, callId, args) {
  return { type: "function_call", name, call_id: callId, arguments: JSON.stringify(args) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function runtimeFixture(fetchImpl, dispatch = async () => ({ text: "ok" })) {
  const calls = [];
  const broker = {
    dispatch: async (name, args) => { calls.push({ name, args }); return dispatch(name, args); },
    finish: async () => {},
    recoverySummary: () => ({ filesChanged: [], recoveryRequired: false }),
  };
  return {
    calls,
    runtime: createRouterResponsesRuntime({
      baseUrl: "https://router.example.test",
      apiKey: "test-key",
      model: "ag/gemini-test",
      effort: "medium",
      broker,
      fetchImpl,
    }),
  };
}

function writeCall(callId, { oldText = "old", newText = "new" } = {}) {
  return call("replace_text", callId, {
    path: "src\\auth.js", expected_sha256: "a".repeat(64), old_text: oldText, new_text: newText,
  });
}

test("validates the configured router URL and rejects unapproved local or credential-bearing URLs", () => {
  assert.equal(validateRouterBaseUrl("https://router.example.test"), "https://router.example.test/v1/responses");
  assert.equal(validateRouterBaseUrl("http://127.0.0.1:20128"), "http://127.0.0.1:20128/v1/responses");
  assert.throws(() => validateRouterBaseUrl("http://127.0.0.1:20129"), { code: "invalid_request" });
  assert.throws(() => validateRouterBaseUrl("http://user:pass@router.example.test"), { code: "invalid_request" });
  assert.throws(() => validateRouterBaseUrl("https://router.example.test/api"), { code: "invalid_request" });
});

test("completes a Responses function-call round trip and sends the fixed policy body", async () => {
  const bodies = [];
  let round = 0;
  const { runtime, calls } = runtimeFixture(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    round += 1;
    return round === 1
      ? response([call("read_text", "call_1", { path: "src\\auth.js" })])
      : response([message("finished")]);
  }, async () => ({ text: "source" }));
  const result = await runtime.run({
    request: { task: "inspect source", access: "read-only", effort: "medium" },
  });
  assert.equal(result.finalAnswer, "finished");
  assert.deepEqual(calls, [{ name: "read_text", args: { path: "src\\auth.js" } }]);
  assert.equal(bodies[0].stream, false);
  assert.equal(bodies[0].store, false);
  assert.equal(bodies[0].parallel_tool_calls, false);
  assert.equal(bodies[0].tools.length, 3);
  assert.match(bodies[0].instructions, /workspace-relative/u);
  assert.match(bodies[0].instructions, /scope or path error/u);
  assert.equal(bodies[0].input[0].role, "user");
  assert.match(bodies[0].input[0].content[0].text, /inspect source/u);
});

test("pauses a validated workspace write before broker mutation and resumes exactly once", async () => {
  const events = [];
  let rounds = 0;
  let dispatches = 0;
  const broker = {
    dispatch: async () => { dispatches += 1; return { sha256: "b".repeat(64), bytes: 3 }; },
    finish: async () => {}, recoverySummary: () => ({ filesChanged: [], recoveryRequired: false }),
  };
  const runtime = createRouterResponsesRuntime({
    baseUrl: "https://router.example.test", apiKey: "test-key", model: "ag/gemini-test", broker,
    fetchImpl: async () => {
      rounds += 1;
      return rounds === 1
        ? response([call("replace_text", "replace_1", {
          path: "src\\auth.js", expected_sha256: "a".repeat(64), old_text: "old", new_text: "new",
        })])
        : response([message("done")]);
    },
  });
  const decision = deferred();
  const running = runtime.run({
    request: { task: "edit", access: "workspace-write", effort: "medium" },
    requestDecision: async (approval) => { events.push(approval); return decision.promise; },
  });
  while (events.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatches, 0);
  assert.equal(events[0].type, "write_intent");
  assert.equal(events[0].operation, "replace_text");
  assert.equal(events[0].path, "src\\auth.js");
  assert.equal(events[0].expectedSha256, "a".repeat(64));
  assert.equal(typeof events[0].deadline, "number");
  assert.equal(typeof events[0].operationFingerprint, "string");
  assert.equal(Object.hasOwn(events[0], "old_text"), false);
  assert.equal(Object.hasOwn(events[0], "new_text"), false);
  assert.equal(Object.hasOwn(events[0], "text"), false);
  decision.resolve("accept");
  assert.equal((await running).finalAnswer, "done");
  assert.equal(dispatches, 1);
});

test("fails closed for declined, cancelled, invalid, or timed-out write intent decisions", async () => {
  for (const decision of ["decline", "cancel", "unexpected", new Promise(() => {})]) {
    let rounds = 0;
    let dispatches = 0;
    const { runtime } = runtimeFixture(async () => {
      rounds += 1;
      return response([writeCall("replace_1")]);
    }, async () => { dispatches += 1; return {}; });
    await assert.rejects(runtime.run({
      request: { task: "edit", access: "scoped-edit", effort: "medium", approvalTimeoutMs: 1 },
      requestDecision: async () => decision,
    }), (error) => error.code === (decision === "cancel" ? "cancelled" : "approval_required"));
    assert.equal(dispatches, 0);
    assert.equal(rounds, 1);
  }
});

test("binds approval to exact write arguments and requests a new decision after an altered retry", async () => {
  let rounds = 0;
  let dispatches = 0;
  const approvals = [];
  const { runtime } = runtimeFixture(async () => {
    rounds += 1;
    if (rounds === 1) return response([writeCall("replace_1", { newText: "first" })]);
    if (rounds === 2) return response([writeCall("replace_2", { newText: "second" })]);
    return response([message("done")]);
  }, async () => { dispatches += 1; return {}; });
  const result = await runtime.run({
    request: { task: "edit", access: "scoped-edit", effort: "medium" },
    onEvent: async (event) => { if (event.type === "write_intent") approvals.push(event.approval); },
    requestDecision: async () => "accept",
  });
  assert.equal(result.finalAnswer, "done");
  assert.equal(dispatches, 2);
  assert.equal(approvals.length, 2);
  assert.notEqual(approvals[0].operationFingerprint, approvals[1].operationFingerprint);
  assert.equal(JSON.stringify(approvals).includes("first"), false);
  assert.equal(JSON.stringify(approvals).includes("second"), false);
});

test("emits execution lifecycle events for HTTP and broker work without text output", async () => {
  let round = 0;
  const events = [];
  const { runtime } = runtimeFixture(async () => {
    round += 1;
    return round === 1
      ? response([call("read_text", "call_1", { path: "src\\auth.js" })])
      : response([message("finished")]);
  });
  await runtime.run({
    request: { task: "inspect", access: "read-only", effort: "medium" },
    onEvent: async (event) => events.push(event),
  });
  assert.deepEqual(events.filter((event) => event.type === "execution_started").map((event) => event.itemId),
    ["http_1", "tool_1_1", "http_2"]);
  assert.deepEqual(events.filter((event) => event.type === "execution_completed").map((event) => event.itemId),
    ["http_1", "tool_1_1", "http_2"]);
  assert.equal(events.some((event) => event.type === "broker_state"), true);
});

test("validates the complete response batch before dispatching any tool", async () => {
  let dispatches = 0;
  const { runtime } = runtimeFixture(async () => response([
    call("replace_text", "call_valid", {
      path: "src\\auth.js", expected_sha256: "a".repeat(64), old_text: "old", new_text: "new",
    }),
    call("shell", "call_invalid", { command: "whoami" }),
  ]), async () => { dispatches += 1; return {}; });
  await assert.rejects(runtime.run({ request: { task: "inspect", access: "scoped-edit", effort: "medium" } }), { code: "protocol_error" });
  assert.equal(dispatches, 0);
});

test("rejects malformed tool arguments in a batch before a preceding replace can write", async () => {
  const { runtime, calls } = runtimeFixture(async () => response([
    call("replace_text", "replace_first", {
      path: "src\\auth.js", expected_sha256: "a".repeat(64), old_text: "old", new_text: "new",
    }),
    call("read_text", "read_malformed", { path: 42, extra: true }),
  ]));
  await assert.rejects(runtime.run({ request: { task: "edit", access: "scoped-edit", effort: "medium" } }), { code: "protocol_error" });
  assert.deepEqual(calls, []);
});

test("rejects conflicting duplicate call ids in a batch before the first write", async () => {
  const { runtime, calls } = runtimeFixture(async () => response([
    call("replace_text", "same_call", {
      path: "src\\auth.js", expected_sha256: "a".repeat(64), old_text: "old", new_text: "new",
    }),
    call("replace_text", "same_call", {
      path: "src\\auth.js", expected_sha256: "a".repeat(64), old_text: "old", new_text: "different",
    }),
  ]));
  await assert.rejects(runtime.run({ request: { task: "edit", access: "scoped-edit", effort: "medium" } }), { code: "protocol_error" });
  assert.deepEqual(calls, []);
});

test("preserves changed-file recovery metadata when a broker write becomes uncertain", async () => {
  const uncertain = Object.assign(new Error("write uncertain"), { code: "recovery_required" });
  const broker = {
    dispatch: async () => { throw uncertain; },
    finish: async () => {},
    recoverySummary: () => ({ filesChanged: ["src\\auth.js"], recoveryRequired: true, recoveryId: "recovery_job_1" }),
  };
  const runtime = createRouterResponsesRuntime({
    baseUrl: "https://router.example.test", apiKey: "test-key", model: "ag/gemini-test", broker,
    fetchImpl: async () => response([call("replace_text", "write_1", {
      path: "src\\auth.js", expected_sha256: "a".repeat(64), old_text: "old", new_text: "new",
    })]),
  });
  await assert.rejects(runtime.run({ request: { task: "edit", access: "scoped-edit", effort: "medium" } }),
    (error) => error.code === "protocol_error"
      && error.recoveryRequired === true
      && error.recoveryId === "recovery_job_1"
      && JSON.stringify(error.filesChanged) === JSON.stringify(["src\\auth.js"]));
});

test("stops before the next HTTP round when a real broker reports recovery uncertainty", async () => {
  const workspace = await mkdtemp(join("D:\\9Router\\", ".test-gemini-recovery-stop-"));
  const source = join(workspace, "src");
  const first = join(source, "first.txt");
  const second = join(source, "second.txt");
  let broker;
  try {
    await mkdir(source);
    await writeFile(first, "old text\n", "utf8");
    await writeFile(second, "unchanged\n", "utf8");
    const resolvedScope = await resolveScope({
      workspace, access: "scoped-edit", task: "edit both", scope: { read: ["src"], write: ["src"], allow_create: false },
    }, { permittedWorkspaceRoots: [workspace] });
    const grant = createGrant({
      jobId: "job_runtime_recovery", resolvedScope, taskHash: "a".repeat(64),
      runtimeFingerprint: "router-responses-v1", expiresAt: Date.now() + 60_000,
    });
    let injected = false;
    broker = createFileBroker({
      grant,
      journalDirectory: join(workspace, "runtime"),
      fs: {
        openPath: async (path, ...args) => {
          const handle = await open(path, ...args);
          if (!path.endsWith(".bin")) return handle;
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            if (!injected) {
              injected = true;
              await writeFile(first, "external edit\n", "utf8");
            }
          };
          return handle;
        },
      },
    });
    const firstHash = createHash("sha256").update("old text\n", "utf8").digest("hex");
    const secondHash = createHash("sha256").update("unchanged\n", "utf8").digest("hex");
    let rounds = 0;
    const runtime = createRouterResponsesRuntime({
      baseUrl: "https://router.example.test", apiKey: "test-key", model: "ag/gemini-test", broker,
      fetchImpl: async () => {
        rounds += 1;
        if (rounds === 1) return response([call("replace_text", "first_write", {
          path: "src\\first.txt", expected_sha256: firstHash, old_text: "old", new_text: "new",
        })]);
        if (rounds === 2) return response([call("replace_text", "second_write", {
          path: "src\\second.txt", expected_sha256: secondHash, old_text: "unchanged", new_text: "changed after recovery",
        })]);
        return response([message("must not reach final response")]);
      },
    });

    await assert.rejects(runtime.run({
      request: { task: "edit both", access: "scoped-edit", effort: "medium" },
      requestDecision: async () => "accept",
    }),
      (error) => error.code === "protocol_error"
        && error.recoveryRequired === true
        && error.filesChanged.includes("src\\first.txt"));
    assert.equal(rounds, 1);
    assert.equal(await readFile(second, "utf8"), "unchanged\n");
  } finally {
    await broker?.finish();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deduplicates an identical call id without repeating a write", async () => {
  let round = 0;
  const { runtime, calls } = runtimeFixture(async () => {
    round += 1;
    return round === 1
      ? response([
        call("create_text", "same_call", { path: "src\\new.js", text: "x" }),
        call("create_text", "same_call", { path: "src\\new.js", text: "x" }),
      ])
      : response([message("done")]);
  });
  const result = await runtime.run({
    request: { task: "create", access: "scoped-edit", effort: "medium" },
    requestDecision: async () => "accept",
  });
  assert.equal(result.finalAnswer, "done");
  assert.equal(calls.length, 1);
});

test("does not misclassify an unqualified router 429 as provider quota", async () => {
  let fetchCalls = 0;
  const { runtime } = runtimeFixture(async () => {
    fetchCalls += 1;
    return new Response("quota", { status: 429 });
  });
  await assert.rejects(runtime.run({ request: { task: "inspect", access: "read-only", effort: "medium" } }),
    (error) => error.code === "protocol_error" && error.details?.reason === "router_http_429");
  assert.equal(fetchCalls, 1);
});

test("cancels an in-flight HTTP call through the runtime signal", async () => {
  let aborted = false;
  const { runtime } = runtimeFixture((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  }));
  const running = runtime.run({ request: { task: "inspect", access: "read-only", effort: "medium" } });
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.cancel();
  await assert.rejects(running, { code: "cancelled" });
  assert.equal(aborted, true);
});

test("fails closed when the decision callback itself throws", async () => {
  const { runtime, calls } = runtimeFixture(async () => response([writeCall("replace_1")]));
  let thrown;
  try {
    await runtime.run({
      request: { task: "edit", access: "scoped-edit", effort: "medium" },
      requestDecision: async () => { throw new Error("approval bridge gone"); },
    });
    assert.fail("run must reject");
  } catch (error) { thrown = error; }
  assert.equal(thrown.code, "approval_required");
  assert.equal(thrown.details?.reason, "write_intent_decision_failed");
  assert.deepEqual(thrown.filesChanged ?? [], []);
  assert.deepEqual(calls, []);
});

test("keeps filesChanged empty when a workspace-write read precedes a declined write", async () => {
  let rounds = 0;
  const dispatched = [];
  const { runtime } = runtimeFixture(async () => {
    rounds += 1;
    return rounds === 1
      ? response([call("read_text", "read_1", { path: "src\auth.js" })])
      : response([writeCall("replace_1")]);
  }, async (name) => { dispatched.push(name); return {}; });
  let thrown;
  try {
    await runtime.run({
      request: { task: "read then edit", access: "workspace-write", effort: "medium" },
      requestDecision: async (approval) => approval.type === "write_intent" ? "decline" : "accept",
    });
    assert.fail("run must reject");
  } catch (error) { thrown = error; }
  assert.equal(thrown.code, "approval_required");
  assert.equal(thrown.details?.reason, "write_intent_declined");
  assert.deepEqual(dispatched, ["read_text"]);
  assert.deepEqual(thrown.filesChanged ?? [], []);
});
