import test from "node:test";
import assert from "node:assert/strict";

import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import {
  AppServerSchemaError,
  parseAndQualifyStableSchema,
  qualifyStableSchemaBundle,
} from "../src/app-server/schema-qualification.js";

const expectedRefs = {
  initialize: "#/definitions/InitializeParams",
  "model/list": "#/definitions/ModelListParams",
  "thread/start": "#/definitions/ThreadStartParams",
  "thread/resume": "#/definitions/ThreadResumeParams",
  "turn/start": "#/definitions/TurnStartParams",
  "turn/interrupt": "#/definitions/TurnInterruptParams",
};

function schema(methods = expectedRefs) {
  return {
    definitions: {
      ClientRequest: {
        oneOf: Object.entries(methods).map(([method, ref]) => ({
          type: "object",
          required: ["id", "method", "params"],
          properties: {
            id: { $ref: "#/definitions/RequestId" },
            method: { type: "string", enum: [method] },
            params: { $ref: ref },
          },
        })),
      },
    },
  };
}

test("qualifies the exact stable request subset", () => {
  const result = qualifyStableSchemaBundle(schema());
  assert.equal(result.schemaSubsetCompatible, true);
  assert.deepEqual(Object.keys(result.methods), APP_SERVER_REQUIRED_METHODS);
  assert.ok(APP_SERVER_REQUIRED_METHODS.every((method) => result.methods[method] === true));
});

test("allows additive unrelated request methods", () => {
  const result = qualifyStableSchemaBundle(schema({
    ...expectedRefs,
    "account/read": "#/definitions/AccountReadParams",
  }));
  assert.equal(result.schemaSubsetCompatible, true);
});

test("marks a missing required method incompatible", () => {
  const methods = { ...expectedRefs };
  delete methods["thread/resume"];
  const result = qualifyStableSchemaBundle(schema(methods));
  assert.equal(result.methods["thread/resume"], false);
  assert.equal(result.schemaSubsetCompatible, false);
});

test("rejects wrong parameter references and duplicate consumed variants", () => {
  const wrong = qualifyStableSchemaBundle(schema({
    ...expectedRefs,
    "turn/start": "#/definitions/WrongParams",
  }));
  assert.equal(wrong.methods["turn/start"], false);
  assert.equal(wrong.schemaSubsetCompatible, false);

  const duplicate = schema();
  duplicate.definitions.ClientRequest.oneOf.push(
    structuredClone(duplicate.definitions.ClientRequest.oneOf[1]),
  );
  const duplicatedResult = qualifyStableSchemaBundle(duplicate);
  assert.equal(duplicatedResult.methods["model/list"], false);
  assert.equal(duplicatedResult.schemaSubsetCompatible, false);
});

test("rejects malformed schema structure with sanitized errors", () => {
  assert.throws(
    () => qualifyStableSchemaBundle({ definitions: { ClientRequest: { oneOf: "sensitive raw schema" } } }),
    (error) => {
      assert.ok(error instanceof AppServerSchemaError);
      assert.equal(error.code, "app_server_schema_error");
      assert.equal(JSON.stringify(error).includes("sensitive raw schema"), false);
      return true;
    },
  );
});

test("rejects invalid JSON and input over the byte limit without raw data", () => {
  assert.throws(
    () => parseAndQualifyStableSchema('{"secret":"unterminated"'),
    (error) => error.code === "app_server_schema_error"
      && error.details.reason === "invalid_json"
      && !JSON.stringify(error).includes("unterminated"),
  );
  assert.throws(
    () => parseAndQualifyStableSchema("x".repeat(4 * 1024 * 1024 + 1)),
    { code: "app_server_schema_error", details: { reason: "schema_too_large" } },
  );
});

test("does not discover required methods in descriptions or arbitrary strings", () => {
  const methods = { ...expectedRefs };
  delete methods["turn/interrupt"];
  const bundle = schema(methods);
  bundle.description = "turn/interrupt";
  bundle.definitions.Unrelated = { const: "turn/interrupt" };
  const result = qualifyStableSchemaBundle(bundle);
  assert.equal(result.methods["turn/interrupt"], false);
  assert.equal(result.schemaSubsetCompatible, false);
});
