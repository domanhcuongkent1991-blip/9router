import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";

import {
  AppServerProtocolError,
  createAppServerJsonlClient,
} from "../src/app-server/jsonl-client.js";

function fixture(overrides = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const fatal = [];
  const client = createAppServerJsonlClient({
    readable,
    writable,
    requestTimeoutMs: 100,
    maxLineBytes: 1024,
    onFatal: (error) => fatal.push(error.code),
    ...overrides,
  });
  return { readable, writable, fatal, client };
}

test("writes headerless requests and correlates responses by id", async () => {
  const { readable, writable, client } = fixture();
  const pending = client.request("model/list", { limit: 1 });
  const [chunk] = await once(writable, "data");
  const sent = JSON.parse(chunk.toString("utf8"));
  assert.deepEqual(sent, { method: "model/list", id: 1, params: { limit: 1 } });
  assert.equal(Object.hasOwn(sent, "jsonrpc"), false);
  readable.write(`${JSON.stringify({ id: 1, result: { data: [] } })}\n`);
  assert.deepEqual(await pending, { data: [] });
  client.close();
});

test("routes notifications and server requests separately", async () => {
  const notifications = [];
  const serverRequests = [];
  const { readable, client } = fixture({
    onNotification: (message) => notifications.push(message.method),
    onServerRequest: (message) => serverRequests.push(message.method),
  });
  readable.write(`${JSON.stringify({ method: "turn/started", params: {} })}\n`);
  readable.write(`${JSON.stringify({ method: "item/commandExecution/requestApproval", id: 9, params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, ["turn/started"]);
  assert.deepEqual(serverRequests, ["item/commandExecution/requestApproval"]);
  client.close();
});

test("fails the connection on malformed or oversized input without exposing raw data", async () => {
  const { readable, client, fatal } = fixture({ maxLineBytes: 64 });
  const pending = client.request("model/list", {});
  readable.write(`${"x".repeat(65)}\n`);
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof AppServerProtocolError);
    assert.equal(error.code, "app_server_protocol_error");
    assert.equal(JSON.stringify(error).includes("x".repeat(20)), false);
    return true;
  });
  assert.deepEqual(fatal, ["app_server_protocol_error"]);
});

test("fails all pending requests when the stream closes", async () => {
  const { readable, client } = fixture();
  const first = client.request("model/list", {});
  const second = client.request("model/list", { cursor: "next" });
  readable.end();
  await assert.rejects(first, { code: "app_server_protocol_error" });
  await assert.rejects(second, { code: "app_server_protocol_error" });
});

test("a request timeout closes the client and blocks later writes", async () => {
  const { writable, client } = fixture({ requestTimeoutMs: 20 });
  const writes = [];
  writable.on("data", (chunk) => writes.push(chunk));

  await assert.rejects(client.request("model/list", {}), (error) => {
    assert.equal(error.details.reason, "request_timeout");
    return true;
  });
  assert.equal(client.isClosed(), true);
  const countAfterTimeout = writes.length;
  await assert.rejects(client.request("model/list", { limit: 1 }), { code: "app_server_protocol_error" });
  assert.equal(writes.length, countAfterTimeout);
});

test("absorbs rejected asynchronous fatal-reporting callbacks", async () => {
  const { readable, client } = fixture({
    maxLineBytes: 64,
    onFatal: async () => {
      throw new Error("sensitive reporting failure");
    },
  });
  const pending = client.request("model/list", {});
  readable.write(`${"x".repeat(65)}\n`);
  await assert.rejects(pending, { code: "app_server_protocol_error" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.isClosed(), true);
});
