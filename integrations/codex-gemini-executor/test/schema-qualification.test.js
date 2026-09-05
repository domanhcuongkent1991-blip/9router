import test from "node:test";
import assert from "node:assert/strict";

import { APP_SERVER_REQUIRED_METHODS } from "../src/app-server/compatibility.js";
import {
  AppServerSchemaError,
  combineSchemaQualifications,
  parseAndQualifyStableSchema,
  qualifyApprovalSchemaBundle,
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

const expectedNotificationRefs = {
  "turn/started": "#/definitions/TurnStartedNotification",
  "item/agentMessage/delta": "#/definitions/AgentMessageDeltaNotification",
  "turn/completed": "#/definitions/TurnCompletedNotification",
};

const expectedApprovalRefs = {
  "item/commandExecution/requestApproval": "#/definitions/CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval": "#/definitions/FileChangeRequestApprovalParams",
};

function objectDefinition(properties, required = []) {
  return { type: "object", properties, required };
}

function stableDefinitions() {
  return {
    RequestId: { oneOf: [{ type: "integer" }, { type: "string" }] },
    InitializeParams: objectDefinition({
      clientInfo: { type: "object" },
      capabilities: { type: "object" },
    }, ["clientInfo", "capabilities"]),
    ModelListParams: objectDefinition({
      limit: { type: "integer" },
      includeHidden: { type: "boolean" },
    }),
    ThreadStartParams: objectDefinition({
      cwd: { type: "string" },
      model: { type: "string" },
      modelProvider: { type: "string" },
      sandbox: { type: "string" },
      approvalPolicy: { type: "string" },
      ephemeral: { type: "boolean" },
    }),
    ThreadResumeParams: objectDefinition({
      threadId: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      modelProvider: { type: "string" },
      sandbox: { type: "string" },
      approvalPolicy: { type: "string" },
    }, ["threadId"]),
    TurnStartParams: objectDefinition({
      threadId: { type: "string" },
      input: { type: "array" },
      model: { type: "string" },
      effort: { type: "string" },
    }, ["threadId", "input"]),
    TurnInterruptParams: objectDefinition({
      threadId: { type: "string" },
      turnId: { type: "string" },
    }, ["threadId", "turnId"]),
    TurnStartedNotification: objectDefinition({
      threadId: { type: "string" },
      turn: { type: "object" },
    }, ["threadId", "turn"]),
    AgentMessageDeltaNotification: objectDefinition({
      threadId: { type: "string" },
      turnId: { type: "string" },
      itemId: { type: "string" },
      delta: { type: "string" },
    }, ["threadId", "turnId", "itemId", "delta"]),
    TurnCompletedNotification: objectDefinition({
      threadId: { type: "string" },
      turn: { type: "object" },
    }, ["threadId", "turn"]),
  };
}

function approvalDefinitions() {
  const approvalProperties = {
    threadId: { type: "string" },
    turnId: { type: "string" },
    itemId: { type: "string" },
  };
  return {
    RequestId: { oneOf: [{ type: "integer" }, { type: "string" }] },
    CommandExecutionRequestApprovalParams: objectDefinition(
      structuredClone(approvalProperties),
      ["threadId", "turnId", "itemId"],
    ),
    FileChangeRequestApprovalParams: objectDefinition(
      structuredClone(approvalProperties),
      ["threadId", "turnId", "itemId"],
    ),
  };
}

function variant(method, ref, { request = false } = {}) {
  return {
    type: "object",
    required: request ? ["id", "method", "params"] : ["method", "params"],
    properties: {
      ...(request ? { id: { $ref: "#/definitions/RequestId" } } : {}),
      method: { type: "string", enum: [method] },
      params: { $ref: ref },
    },
  };
}

function schema(methods = expectedRefs, notifications = expectedNotificationRefs) {
  return {
    definitions: {
      ...stableDefinitions(),
      ClientRequest: {
        oneOf: Object.entries(methods).map(([method, ref]) => variant(method, ref, { request: true })),
      },
      ServerNotification: { oneOf: Object.entries(notifications).map(([method, ref]) => variant(method, ref)) },
    },
  };
}

function approvalSchema(requests = expectedApprovalRefs) {
  return {
    definitions: {
      ...approvalDefinitions(),
      ServerRequest: { oneOf: Object.entries(requests).map(([method, ref]) => variant(method, ref, { request: true })) },
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

test("rejects unresolved and malformed expected parameter definitions", () => {
  const missing = schema();
  delete missing.definitions.TurnStartParams;
  assert.equal(qualifyStableSchemaBundle(missing).schemaSubsetCompatible, false);

  const malformed = schema();
  malformed.definitions.AgentMessageDeltaNotification = { description: "not an object schema" };
  assert.equal(qualifyStableSchemaBundle(malformed).schemaSubsetCompatible, false);

  const mixedTarget = schema();
  mixedTarget.definitions.TurnStartParams.type = ["object", "string"];
  assert.equal(qualifyStableSchemaBundle(mixedTarget).schemaSubsetCompatible, false);

  const missingApproval = approvalSchema();
  delete missingApproval.definitions.FileChangeRequestApprovalParams;
  assert.equal(qualifyApprovalSchemaBundle(missingApproval).schemaSubsetCompatible, false);
});

test("rejects malformed request and notification envelopes", () => {
  const wrongRequestIdRef = schema();
  wrongRequestIdRef.definitions.ClientRequest.oneOf[0].properties.id.$ref = "#/definitions/OtherId";
  assert.equal(qualifyStableSchemaBundle(wrongRequestIdRef).schemaSubsetCompatible, false);

  const objectRequestId = schema();
  objectRequestId.definitions.RequestId = { type: "object", properties: {} };
  assert.equal(qualifyStableSchemaBundle(objectRequestId).schemaSubsetCompatible, false);

  const objectApprovalRequestId = approvalSchema();
  objectApprovalRequestId.definitions.RequestId = { type: "object", properties: {} };
  assert.equal(qualifyApprovalSchemaBundle(objectApprovalRequestId).schemaSubsetCompatible, false);

  const wrongApprovalIdRef = approvalSchema();
  wrongApprovalIdRef.definitions.ServerRequest.oneOf[0].properties.id.$ref = "#/definitions/OtherId";
  assert.equal(qualifyApprovalSchemaBundle(wrongApprovalIdRef).schemaSubsetCompatible, false);

  const nonStringMethod = schema();
  nonStringMethod.definitions.ClientRequest.oneOf[0].properties.method.type = "object";
  assert.equal(qualifyStableSchemaBundle(nonStringMethod).schemaSubsetCompatible, false);

  const notificationWithId = schema();
  const notification = notificationWithId.definitions.ServerNotification.oneOf[0];
  notification.properties.id = { $ref: "#/definitions/RequestId" };
  notification.required.push("id");
  assert.equal(qualifyStableSchemaBundle(notificationWithId).schemaSubsetCompatible, false);

  const notificationDeclaringOptionalId = schema();
  notificationDeclaringOptionalId.definitions.ServerNotification.oneOf[0].properties.id = {
    $ref: "#/definitions/RequestId",
  };
  assert.equal(qualifyStableSchemaBundle(notificationDeclaringOptionalId).schemaSubsetCompatible, false);
});

test("rejects incompatible primitive and container kinds", () => {
  const wrongInput = schema();
  wrongInput.definitions.TurnStartParams.properties.input = { type: "object" };
  assert.equal(qualifyStableSchemaBundle(wrongInput).schemaSubsetCompatible, false);

  const wrongDelta = schema();
  wrongDelta.definitions.AgentMessageDeltaNotification.properties.delta = { type: "object" };
  assert.equal(qualifyStableSchemaBundle(wrongDelta).schemaSubsetCompatible, false);

  const wrongApprovalId = approvalSchema();
  wrongApprovalId.definitions.FileChangeRequestApprovalParams.properties.itemId = { type: "object" };
  assert.equal(qualifyApprovalSchemaBundle(wrongApprovalId).schemaSubsetCompatible, false);
});

test("rejects removed consumed fields and newly required unsent request fields", () => {
  const removedNotificationField = schema();
  delete removedNotificationField.definitions.TurnCompletedNotification.properties.turn;
  assert.equal(qualifyStableSchemaBundle(removedNotificationField).schemaSubsetCompatible, false);

  const removedApprovalField = approvalSchema();
  delete removedApprovalField.definitions.CommandExecutionRequestApprovalParams.properties.itemId;
  assert.equal(qualifyApprovalSchemaBundle(removedApprovalField).schemaSubsetCompatible, false);

  const newlyRequiredUnsent = schema();
  newlyRequiredUnsent.definitions.ThreadStartParams.properties.futureRequired = { type: "string" };
  newlyRequiredUnsent.definitions.ThreadStartParams.required.push("futureRequired");
  assert.equal(qualifyStableSchemaBundle(newlyRequiredUnsent).schemaSubsetCompatible, false);
});

test("allows additive optional and unrelated definition fields", () => {
  const additive = schema();
  additive.definitions.ThreadStartParams.properties.futureOptional = { type: "string" };
  additive.definitions.Unrelated = objectDefinition({ anything: { type: "number" } });
  assert.equal(qualifyStableSchemaBundle(additive).schemaSubsetCompatible, true);
});

test("requires all consumed notification variants while preserving client method results", () => {
  const notifications = { ...expectedNotificationRefs };
  delete notifications["turn/completed"];
  const missing = qualifyStableSchemaBundle(schema(expectedRefs, notifications));
  assert.equal(missing.schemaSubsetCompatible, false);
  assert.ok(APP_SERVER_REQUIRED_METHODS.every((method) => missing.methods[method] === true));

  const wrong = qualifyStableSchemaBundle(schema(expectedRefs, {
    ...expectedNotificationRefs,
    "turn/started": "#/definitions/WrongNotification",
  }));
  assert.equal(wrong.schemaSubsetCompatible, false);
});

test("allows additive notifications but rejects duplicate consumed notification variants", () => {
  const additive = schema(expectedRefs, {
    ...expectedNotificationRefs,
    "item/other": "#/definitions/OtherNotification",
  });
  additive.definitions.ServerNotification.oneOf[0].properties.extra = { type: "string" };
  assert.equal(qualifyStableSchemaBundle(additive).schemaSubsetCompatible, true);

  const duplicate = schema();
  duplicate.definitions.ServerNotification.oneOf.push(
    structuredClone(duplicate.definitions.ServerNotification.oneOf[0]),
  );
  assert.equal(qualifyStableSchemaBundle(duplicate).schemaSubsetCompatible, false);
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

test("does not discover required notifications in descriptions or arbitrary strings", () => {
  const notifications = { ...expectedNotificationRefs };
  delete notifications["turn/completed"];
  const bundle = schema(expectedRefs, notifications);
  bundle.description = "turn/completed";
  bundle.definitions.Unrelated = { const: "turn/completed" };
  assert.equal(qualifyStableSchemaBundle(bundle).schemaSubsetCompatible, false);
});

test("qualifies exact approval server-request variants", () => {
  const result = qualifyApprovalSchemaBundle(approvalSchema());
  assert.deepEqual(result, {
    schemaSubsetCompatible: true,
    serverRequests: {
      "item/commandExecution/requestApproval": true,
      "item/fileChange/requestApproval": true,
    },
  });
});

test("marks missing, duplicate, malformed, and wrong approval variants incompatible", () => {
  const missing = { ...expectedApprovalRefs };
  delete missing["item/fileChange/requestApproval"];
  assert.equal(qualifyApprovalSchemaBundle(approvalSchema(missing)).schemaSubsetCompatible, false);

  const wrong = qualifyApprovalSchemaBundle(approvalSchema({
    ...expectedApprovalRefs,
    "item/fileChange/requestApproval": "#/definitions/WrongParams",
  }));
  assert.equal(wrong.schemaSubsetCompatible, false);

  const duplicate = approvalSchema();
  duplicate.definitions.ServerRequest.oneOf.push(structuredClone(duplicate.definitions.ServerRequest.oneOf[0]));
  assert.equal(qualifyApprovalSchemaBundle(duplicate).schemaSubsetCompatible, false);

  const malformed = approvalSchema();
  malformed.definitions.ServerRequest.oneOf[0] = { method: "item/commandExecution/requestApproval" };
  assert.equal(qualifyApprovalSchemaBundle(malformed).schemaSubsetCompatible, false);
});

test("rejects invalid approval root structure without raw content", () => {
  assert.throws(
    () => qualifyApprovalSchemaBundle({ definitions: { ServerRequest: { oneOf: "sensitive root schema" } } }),
    (error) => error instanceof AppServerSchemaError
      && error.details.reason === "invalid_schema_structure"
      && !JSON.stringify(error).includes("sensitive root schema"),
  );
});

test("combines stable and approval qualifications into the existing handshake shape", () => {
  const stable = qualifyStableSchemaBundle(schema());
  const approvals = qualifyApprovalSchemaBundle(approvalSchema());
  assert.deepEqual(combineSchemaQualifications(stable, approvals), {
    schemaSubsetCompatible: true,
    methods: stable.methods,
  });

  const missingApprovals = qualifyApprovalSchemaBundle(approvalSchema({
    "item/commandExecution/requestApproval": expectedApprovalRefs["item/commandExecution/requestApproval"],
  }));
  const combined = combineSchemaQualifications(stable, missingApprovals);
  assert.equal(combined.schemaSubsetCompatible, false);
  assert.deepEqual(combined.methods, stable.methods);
  assert.deepEqual(Object.keys(combined).sort(), ["methods", "schemaSubsetCompatible"]);
});
