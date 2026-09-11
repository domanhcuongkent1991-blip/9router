import test from "node:test";
import assert from "node:assert/strict";

import { AppServerCompatibilityError } from "../src/app-server/compatibility.js";
import { normalizeAppServerNotification } from "../src/app-server/events.js";

test("normalizes the three supported text-turn notifications", () => {
  assert.deepEqual(normalizeAppServerNotification({
    method: "turn/started",
    params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status: "inProgress" } },
  }), { type: "turn_started", threadId: "thr_1", turnId: "turn_1", status: "running" });

  assert.deepEqual(normalizeAppServerNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "hello" },
  }), { type: "assistant_delta", threadId: "thr_1", turnId: "turn_1", itemId: "item_1", text: "hello" });

  assert.deepEqual(normalizeAppServerNotification({
    method: "turn/completed",
    params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status: "completed" } },
  }), { type: "turn_completed", threadId: "thr_1", turnId: "turn_1", status: "completed" });
});

test("maps only completed terminal statuses", () => {
  for (const [status, normalized] of [["completed", "completed"], ["interrupted", "cancelled"], ["failed", "failed"]]) {
    assert.equal(normalizeAppServerNotification({
      method: "turn/completed",
      params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status } },
    }).status, normalized);
  }
});

test("ignores unknown notifications without examining params", () => {
  assert.equal(normalizeAppServerNotification({ method: "unknown/event", params: "unfamiliar raw payload" }), null);
});

test("normalizes only safe metadata from correlated turn errors", () => {
  const secret = "turn-error-secret";
  assert.deepEqual(normalizeAppServerNotification({
    method: "error",
    params: {
      threadId: "thr_1", turnId: "turn_1", willRetry: false,
      error: { message: secret, additionalDetails: secret, codexErrorInfo: "usageLimitExceeded" },
    },
  }), {
    type: "turn_error", threadId: "thr_1", turnId: "turn_1", willRetry: false,
    error: { code: "usageLimitExceeded" },
  });

  assert.deepEqual(normalizeAppServerNotification({
    method: "turn/completed",
    params: {
      threadId: "thr_1",
      turn: {
        id: "turn_1", status: "failed", items: [],
        error: { message: secret, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } } },
      },
    },
  }), {
    type: "turn_completed", threadId: "thr_1", turnId: "turn_1", status: "failed",
    error: { code: "responseStreamDisconnected", status: 503 },
  });
});

test("fails closed on malformed supported turn-error metadata without retaining raw payload", () => {
  const secret = "malformed-turn-error-secret";
  for (const params of [
    { threadId: "thr_1", turnId: "turn_1", willRetry: false, error: { message: secret, codexErrorInfo: "notARealCode" } },
    { threadId: "thr_1", turnId: "turn_1", willRetry: "false", error: { message: secret } },
    { threadId: "thr_1", turnId: "turn_1", willRetry: false, error: { message: secret, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: "503" } } } },
  ]) {
    assert.throws(() => normalizeAppServerNotification({ method: "error", params }), (error) => (
      error.code === "app_server_incompatible"
      && error.details.reason === "invalid_turn_error"
      && !JSON.stringify(error).includes(secret)
    ));
  }
});

test("normalizes execution lifecycle and output activity without retaining command content", () => {
  for (const itemType of ["commandExecution", "fileChange"]) {
    for (const [method, type] of [["item/started", "execution_started"], ["item/completed", "execution_completed"]]) {
      assert.deepEqual(normalizeAppServerNotification({
        method,
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { id: "item_1", type: itemType, command: "private command", aggregatedOutput: "private output" },
        },
      }), { type, threadId: "thr_1", turnId: "turn_1", itemId: "item_1" });
    }
  }
  assert.deepEqual(normalizeAppServerNotification({
    method: "item/commandExecution/outputDelta",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "private output" },
  }), { type: "activity", threadId: "thr_1", turnId: "turn_1", itemId: "item_1" });
});

test("rejects malformed execution activity and ignores unrelated lifecycle items", () => {
  for (const method of ["item/started", "item/completed"]) {
    for (const item of [{ type: "agentMessage" }, { type: "futureItem" }, null]) {
      assert.equal(normalizeAppServerNotification({ method, params: { item } }), null);
    }
    for (const params of [
      { threadId: "", turnId: "turn_1", item: { type: "commandExecution", id: "item_1" } },
      { threadId: "thr_1", turnId: "x".repeat(513), item: { type: "fileChange", id: "item_1" } },
      { threadId: "thr_1", turnId: "turn_1", item: { type: "commandExecution", id: null } },
    ]) {
      assert.throws(() => normalizeAppServerNotification({ method, params }), { code: "app_server_incompatible" });
    }
  }
  for (const override of [{ threadId: "" }, { turnId: null }, { itemId: 1 }, { delta: 1 }]) {
    assert.throws(() => normalizeAppServerNotification({
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "private output", ...override },
    }), { code: "app_server_incompatible" });
  }
});

test("accepts an empty bounded delta and rejects oversized ids or text", () => {
  assert.equal(normalizeAppServerNotification({
    method: "item/agentMessage/delta",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "" },
  }).text, "");
  for (const message of [
    { method: "turn/started", params: { threadId: "x".repeat(513), turn: { id: "turn_1", items: [], status: "inProgress" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: "x".repeat(1024 * 1024 + 1) } },
  ]) {
    assert.throws(() => normalizeAppServerNotification(message), { code: "app_server_incompatible" });
  }
});

test("fails closed with sanitized compatibility details for malformed supported events", () => {
  const invalid = [
    null,
    { method: 7, params: {} },
    { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status: "completed" } } },
    { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1", delta: 1 } },
    { method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", items: [], status: "inProgress" } } },
  ];
  for (const message of invalid) {
    assert.throws(() => normalizeAppServerNotification(message), (error) => {
      assert.ok(error instanceof AppServerCompatibilityError);
      assert.equal(error.code, "app_server_incompatible");
      assert.equal(error.userMessage, "Codex version chưa được hỗ trợ");
      assert.deepEqual(Object.keys(error.details).sort(), ["method", "reason", "stage"]);
      assert.equal(error.details.stage, "event");
      assert.equal(JSON.stringify(error).includes("unfamiliar raw"), false);
      return true;
    });
  }
});
