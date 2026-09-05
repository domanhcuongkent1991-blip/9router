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

test("records a server request before allowing one synchronous response", async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  let client;
  client = createAppServerJsonlClient({
    readable,
    writable,
    onServerRequest: (message) => client.respond(message.id, { decision: "accept" }),
  });
  assert.equal(typeof client.respond, "function");

  const response = once(writable, "data");
  readable.write(`${JSON.stringify({ method: "approval", id: "request_1", params: {} })}\n`);
  const [chunk] = await response;
  assert.equal(chunk.toString("utf8"), '{"id":"request_1","result":{"decision":"accept"}}\n');
  assert.equal(Object.hasOwn(JSON.parse(chunk.toString("utf8")), "jsonrpc"), false);
  assert.equal(client.isClosed(), false);
  client.close();
});

test("accepts only safe integer or bounded non-empty string server request ids", async () => {
  const invalidIds = [1.5, Number.MAX_SAFE_INTEGER + 1, "", "   ", "x".repeat(513), null, {}];
  for (const id of invalidIds) {
    const { readable, client, fatal } = fixture({ onServerRequest: () => {} });
    readable.write(`${JSON.stringify({ method: "approval", id, params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.isClosed(), true, `id should close the client: ${typeof id}`);
    assert.deepEqual(fatal, ["app_server_protocol_error"]);
  }

  for (const id of [0, Number.MAX_SAFE_INTEGER, "request_1"]) {
    const { readable, client } = fixture({ onServerRequest: () => {} });
    readable.write(`${JSON.stringify({ method: "approval", id, params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.isClosed(), false);
    client.close();
  }
});

test("fails closed for unknown, duplicate, already-responded, or excessive server requests", async () => {
  const unknown = fixture({ onServerRequest: () => {} });
  assert.throws(() => unknown.client.respond("missing", {}), AppServerProtocolError);
  assert.equal(unknown.client.isClosed(), true);

  const duplicate = fixture({ onServerRequest: () => {} });
  const duplicateFrame = `${JSON.stringify({ method: "approval", id: 1, params: {} })}\n`;
  duplicate.readable.write(duplicateFrame);
  duplicate.readable.write(duplicateFrame);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(duplicate.client.isClosed(), true);

  const responded = fixture({ onServerRequest: () => {} });
  responded.readable.write(`${JSON.stringify({ method: "approval", id: 2, params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  responded.client.respond(2, { decision: "decline" });
  assert.throws(() => responded.client.respond(2, { decision: "cancel" }), AppServerProtocolError);
  assert.equal(responded.client.isClosed(), true);

  const excessive = fixture({ onServerRequest: () => {} });
  for (let id = 1; id <= 8; id += 1) {
    excessive.readable.write(`${JSON.stringify({ method: "approval", id, params: {} })}\n`);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(excessive.client.isClosed(), false);
  excessive.readable.write(`${JSON.stringify({ method: "approval", id: 9, params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(excessive.client.isClosed(), true);
});

test("response serialization and size failures close the client and reject pending requests", async () => {
  for (const result of [{ value: 1n }, { value: "x".repeat(1024) }]) {
    const { readable, client } = fixture({ onServerRequest: () => {} });
    const pending = client.request("model/list", {});
    readable.write(`${JSON.stringify({ method: "approval", id: "request_1", params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.throws(
      () => client.respond("request_1", result),
      (error) => error instanceof AppServerProtocolError
        && error.code === "app_server_protocol_error"
        && !JSON.stringify(error).includes("x".repeat(20)),
    );
    await assert.rejects(pending, AppServerProtocolError);
    assert.equal(client.isClosed(), true);
  }
});

test("rejects response results that JSON serialization removes from the frame", async () => {
  const omittedResults = [
    undefined,
    () => {},
    Symbol("omitted"),
    { toJSON() { return undefined; } },
  ];
  for (const result of omittedResults) {
    const { readable, writable, client } = fixture({ onServerRequest: () => {} });
    const writes = [];
    writable.on("data", (chunk) => writes.push(chunk));
    const pending = client.request("model/list", {}).catch((error) => error);
    readable.write(`${JSON.stringify({ method: "approval", id: 1, params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    const writesBeforeResponse = writes.length;

    let responseError;
    try {
      client.respond(1, result);
    } catch (error) {
      responseError = error;
    }
    const closedByResponse = client.isClosed();
    if (!closedByResponse) client.close();
    const pendingError = await pending;

    assert.ok(responseError instanceof AppServerProtocolError);
    assert.equal(closedByResponse, true);
    assert.equal(writes.length, writesBeforeResponse);
    assert.ok(pendingError instanceof AppServerProtocolError);
    assert.equal(JSON.stringify(responseError).includes("omitted"), false);
  }
});

test("close clears server requests and prevents later responses from writing", async () => {
  const { readable, writable, client } = fixture({ onServerRequest: () => {} });
  const writes = [];
  writable.on("data", (chunk) => writes.push(chunk));
  readable.write(`${JSON.stringify({ method: "approval", id: 7, params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  client.close();
  const countAfterClose = writes.length;
  assert.throws(() => client.respond(7, { decision: "cancel" }), AppServerProtocolError);
  assert.equal(writes.length, countAfterClose);
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
