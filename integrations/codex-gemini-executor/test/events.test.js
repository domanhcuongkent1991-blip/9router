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
