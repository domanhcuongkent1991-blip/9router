import test from "node:test";
import assert from "node:assert/strict";

import { classifyCompanionError } from "../src/error-classification.js";
import { AppServerCompatibilityError } from "../src/app-server/compatibility.js";
import { createAppServerSessionAdapter } from "../src/app-server/session.js";

function remote({ source, code, status } = {}) {
  return Object.assign(new Error("remote body contains api_key=secret"), {
    code: "app_server_session_error",
    details: {
      ...(source === undefined ? {} : { remoteSource: source }),
      ...(code === undefined ? {} : { remoteCode: code }),
      ...(status === undefined ? {} : { remoteStatus: status }),
    },
  });
}

test("classifies only explicit trusted error layers", () => {
  assert.deepEqual(classifyCompanionError(remote({ source: "codex_account", code: "account_usage_limit" })),
    { category: "quota_exceeded", source: "codex_account", code: "account_usage_limit" });
  assert.deepEqual(classifyCompanionError(remote({ source: "mcp_execution", code: "mcp_timeout" })),
    { category: "timeout", source: "mcp_execution", code: "mcp_timeout" });
  assert.deepEqual(classifyCompanionError(remote({ source: "router", code: "router_connect_failed" })),
    { category: "router_unavailable", source: "router", code: "router_connect_failed" });
  assert.deepEqual(classifyCompanionError(remote({ source: "router", code: "router_auth_failed" })),
    { category: "protocol_error", source: "router" });
  assert.deepEqual(classifyCompanionError(remote({ source: "provider", code: "provider_auth_failed" })),
    { category: "provider_auth_failed", source: "provider", code: "provider_auth_failed" });
  assert.deepEqual(classifyCompanionError(remote({ source: "provider", code: "provider_rate_limit" })),
    { category: "rate_limited", source: "provider", code: "provider_rate_limit" });
  assert.deepEqual(classifyCompanionError(remote({ source: "model", code: "model_not_found" })),
    { category: "model_unavailable", source: "model", code: "model_not_found" });
});

test("keeps ambiguous or malformed remote failures uncertain and redacted", () => {
  const ambiguous = classifyCompanionError(remote({ status: 429 }));
  assert.deepEqual(ambiguous, { category: "protocol_error", source: "unknown", status: 429 });
  const malformed = classifyCompanionError(remote({ source: "provider", code: "secret value\n" }));
  assert.deepEqual(malformed, { category: "protocol_error", source: "unknown" });
  assert.equal(JSON.stringify([ambiguous, malformed]).includes("secret"), false);
});

test("uses explicit source and HTTP status without guessing from unknown codes", () => {
  assert.deepEqual(classifyCompanionError(remote({ source: "router", status: 503 })),
    { category: "router_unavailable", source: "router", status: 503 });
  assert.deepEqual(classifyCompanionError(remote({ source: "provider", status: 401 })),
    { category: "provider_auth_failed", source: "provider", status: 401 });
  assert.deepEqual(classifyCompanionError(remote({ source: "provider", status: 429 })),
    { category: "rate_limited", source: "provider", status: 429 });
  assert.deepEqual(classifyCompanionError(remote({ source: "provider", code: "future_quota_auth_code" })),
    { category: "protocol_error", source: "provider" });
});

test("does not let HTTP 429 override explicit rate-limit or quota semantics", () => {
  for (const status of [undefined, 429]) {
    assert.deepEqual(classifyCompanionError(remote({ source: "provider", code: "rateLimitExceeded", status })),
      { category: "rate_limited", source: "provider", code: "rateLimitExceeded", ...(status === undefined ? {} : { status }) });
    assert.deepEqual(classifyCompanionError(remote({ source: "provider", code: "usageLimitExceeded", status })),
      { category: "quota_exceeded", source: "provider", code: "usageLimitExceeded", ...(status === undefined ? {} : { status }) });
  }
  assert.deepEqual(classifyCompanionError(remote({ source: "provider", code: "provider_rate_limit", status: 429 })),
    { category: "rate_limited", source: "provider", code: "provider_rate_limit", status: 429 });
  assert.deepEqual(classifyCompanionError(remote({ source: "provider", status: 429 })),
    { category: "rate_limited", source: "provider", status: 429 });
  assert.deepEqual(classifyCompanionError(remote({ status: 429 })),
    { category: "protocol_error", source: "unknown", status: 429 });
});

test("keeps known Codex camelCase codes semantically distinct without inventing provenance", () => {
  assert.deepEqual(classifyCompanionError(remote({ code: "usageLimitExceeded" })),
    { category: "quota_exceeded", source: "unknown", code: "usageLimitExceeded" });
  assert.deepEqual(classifyCompanionError(remote({ code: "rateLimitExceeded" })),
    { category: "rate_limited", source: "unknown", code: "rateLimitExceeded" });
  assert.deepEqual(classifyCompanionError(remote({ code: "unauthorized" })),
    { category: "protocol_error", source: "unknown", code: "unauthorized" });
});

test("retains only bounded local gate details and maps router identity failures to router", () => {
  const router = Object.assign(new Error("router secret"), {
    code: "app_server_incompatible",
    details: { stage: "router", reason: "router_identity_unavailable", field: "candidate" },
  });
  assert.deepEqual(classifyCompanionError(router), {
    category: "app_server_incompatible", source: "router", code: "app_server_incompatible",
    stage: "router", reason: "router_identity_unavailable", field: "candidate",
  });
  for (const reason of ["qualification_record_missing", "runtime_changed_during_setup", "invalid_schema_structure"]) {
    const classified = classifyCompanionError(Object.assign(new Error("secret"), {
      code: "app_server_incompatible", details: { stage: "qualification", reason },
    }));
    assert.equal(classified.reason, reason);
    assert.equal(classified.source, "unknown");
    assert.equal(JSON.stringify(classified).includes("secret"), false);
  }
  assert.deepEqual(classifyCompanionError(Object.assign(new Error("secret"), {
    code: "invalid_request", details: { field: "model", reason: "not_allowed" },
  })), {
    category: "invalid_request", source: "unknown", code: "invalid_request", field: "model", reason: "not_allowed",
  });
});

test("keeps finite diagnostics emitted by the real session adapter and runtime compatibility paths", async () => {
  const session = createAppServerSessionAdapter({
    model: "gemini-fixed",
    client: { request: async () => ({ thread: { id: "" } }) },
  });
  await assert.rejects(
    session.startThread({ cwd: "D:\\Repo", sandbox: "read-only", approvalPolicy: "on-request" }),
    (error) => {
      assert.deepEqual(classifyCompanionError(error), {
        category: "protocol_error", source: "unknown", stage: "response", reason: "invalid_thread_response",
      });
      return true;
    },
  );
  for (const reason of ["turn_start_mismatch", "runtime_unavailable", "no_active_turn", "handshake_failed"]) {
    assert.deepEqual(classifyCompanionError(new AppServerCompatibilityError({ stage: "runtime", reason })), {
      category: "app_server_incompatible", source: "unknown", code: "app_server_incompatible", stage: "runtime", reason,
    });
  }
});

test("drops caller-controlled metadata and inherited-property codes at the public boundary", () => {
  const sentinel = "sentinel-untrusted-4829";
  assert.deepEqual(classifyCompanionError(Object.assign(new Error("secret"), {
    code: "invalid_request", details: { field: sentinel, reason: sentinel, stage: sentinel },
  })), {
    category: "invalid_request", source: "unknown", code: "invalid_request",
  });
  for (const code of ["toString", "constructor", "valueOf", "__proto__", sentinel]) {
    const classified = classifyCompanionError(remote({ source: "provider", code }));
    assert.deepEqual(classified, { category: "protocol_error", source: "provider" });
    assert.equal(typeof classified.category, "string");
    assert.equal(JSON.stringify(classified).includes(sentinel), false);
  }
});
