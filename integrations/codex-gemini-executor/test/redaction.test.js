import test from "node:test";
import assert from "node:assert/strict";

import { CompanionRedactionError, createCompanionRedactor } from "../src/redaction.js";

const SECRET = "sentinel-secret-value";

test("redacts known secrets, sensitive keys, bearer tokens, JWTs, and narrow assignments", () => {
  const redactor = createCompanionRedactor({ knownSecrets: [SECRET] });
  const input = {
    safe: `prefix ${SECRET} suffix`,
    authorization: "should-not-survive",
    nested: {
      cookie: "session=raw",
      text: "Bearer abcdefghijklmnop api_key=key-value password: hunter2",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturevalue",
    },
  };

  const output = redactor.redactJson(input);
  assert.equal(JSON.stringify(output).includes(SECRET), false);
  assert.equal(output.authorization, "[REDACTED]");
  assert.equal(output.nested.cookie, "[REDACTED]");
  assert.equal(output.nested.text, "Bearer [REDACTED] api_key=[REDACTED] password: [REDACTED]");
  assert.equal(output.nested.jwt, "[REDACTED]");
  assert.equal(input.authorization, "should-not-survive");
  assert.deepEqual(redactor.redactJson(output), output);
});

test("provides a direct approval-display sanitizer", () => {
  const redactor = createCompanionRedactor({ knownSecrets: [SECRET] });
  assert.equal(redactor.sanitizeForDisplay(`run --token=${SECRET}`), "run --token=[REDACTED]");
  assert.equal(redactor.sanitizeForDisplay(null), null);
  assert.throws(() => redactor.sanitizeForDisplay({ command: SECRET }), CompanionRedactionError);
});

test("returns JSON-compatible sanitized error records without stacks", () => {
  const redactor = createCompanionRedactor({ knownSecrets: [SECRET] });
  const error = Object.assign(new TypeError(`failed with Bearer ${SECRET}`), {
    code: "provider_auth_failed",
    details: { apiKey: SECRET, retryable: false },
  });
  const output = redactor.redactError(error);
  assert.deepEqual(output, {
    name: "TypeError",
    code: "provider_auth_failed",
    message: "failed with Bearer [REDACTED]",
    details: { apiKey: "[REDACTED]", retryable: false },
  });
  assert.doesNotThrow(() => JSON.stringify(output));
  assert.equal(Object.hasOwn(output, "stack"), false);
});

test("rejects cycles, accessors, non-JSON types, oversized strings, and excessive depth safely", () => {
  const redactor = createCompanionRedactor({
    knownSecrets: [SECRET],
    maxDepth: 3,
    maxNodes: 20,
    maxStringBytes: 32,
    maxOutputBytes: 256,
  });
  const cycle = {};
  cycle.self = cycle;
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { throw new Error(SECRET); } });

  for (const value of [cycle, accessor, { value: 1n }, { value: undefined }, { deep: { a: { b: { c: true } } } }, "x".repeat(33)]) {
    assert.throws(() => redactor.redactJson(value), (error) => {
      assert.ok(error instanceof CompanionRedactionError);
      assert.equal(error.code, "redaction_failed");
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      return true;
    });
  }
});

test("normalizes failures from reflective object traps without exposing their message", () => {
  const redactor = createCompanionRedactor({ knownSecrets: [SECRET] });
  const hostile = new Proxy({}, {
    getPrototypeOf() { throw new Error(SECRET); },
  });
  assert.throws(() => redactor.redactJson(hostile), (error) => {
    assert.ok(error instanceof CompanionRedactionError);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    return true;
  });
});

test("normalizes sparse arrays and rejects hostile Error accessors safely", () => {
  const redactor = createCompanionRedactor({ knownSecrets: [SECRET] });
  const sparse = [];
  sparse[1] = "value";
  assert.deepEqual(redactor.redactJson(sparse), [null, "value"]);

  const hostile = new Error("safe");
  Object.defineProperty(hostile, "code", {
    enumerable: true,
    get() { throw new Error(SECRET); },
  });
  assert.throws(() => redactor.redactError(hostile), (error) => {
    assert.ok(error instanceof CompanionRedactionError);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    return true;
  });
});

test("redacts credential header and assignment values in free text", () => {
  const redactor = createCompanionRedactor();
  const input = [
    "Authorization: Basic dXNlcjpwYXNz",
    "Proxy-Authorization=Digest opaque-value",
    "Cookie: sid=private-cookie; theme=dark",
    "Set-Cookie: session=private-cookie; HttpOnly",
    "x-api-key: private-key",
  ].join("\n");
  const output = redactor.sanitizeForDisplay(input);
  assert.equal(output.includes("dXNlcjpwYXNz"), false);
  assert.equal(output.includes("opaque-value"), false);
  assert.equal(output.includes("private-cookie"), false);
  assert.equal(output.includes("private-key"), false);
  assert.match(output, /Authorization: \[REDACTED\]/u);
  assert.match(output, /Cookie: \[REDACTED\]/u);
});

test("redacts quoted and unquoted credential headers embedded in curl commands", () => {
  const redactor = createCompanionRedactor();
  const commands = [
    "curl -H Authorization: Basic dXNlcjpwYXNz -H Cookie: sid=private-cookie http://localhost",
    "curl -H \"Authorization: Basic dXNlcjpwYXNz\" -H \"Cookie: sid=private-cookie\" http://localhost",
  ];
  for (const command of commands) {
    const output = redactor.sanitizeForDisplay(command);
    assert.equal(output.includes("dXNlcjpwYXNz"), false);
    assert.equal(output.includes("private-cookie"), false);
    assert.match(output, /Authorization: \[REDACTED\]/u);
  }
});

test("bounds known-secret catalogs and approval display output", () => {
  assert.throws(
    () => createCompanionRedactor({ knownSecrets: Array.from({ length: 65 }, (_, index) => `secret-${index}`) }),
    { code: "redaction_failed", details: { reason: "too_many_known_secrets" } },
  );
  const redactor = createCompanionRedactor({ maxStringBytes: 32, maxOutputBytes: 12 });
  assert.throws(
    () => redactor.sanitizeForDisplay("a".repeat(13)),
    { code: "redaction_failed", details: { reason: "output_too_large" } },
  );
});
