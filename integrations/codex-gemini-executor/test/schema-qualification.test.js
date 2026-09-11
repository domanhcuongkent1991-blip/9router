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
  error: "#/definitions/ErrorNotification",
  "turn/completed": "#/definitions/TurnCompletedNotification",
};

const expectedApprovalRefs = {
  "item/commandExecution/requestApproval": "#/definitions/CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval": "#/definitions/FileChangeRequestApprovalParams",
};

function objectDefinition(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function stableDefinitions() {
  return {
    RequestId: { oneOf: [{ type: "integer" }, { type: "string" }] },
    InitializeParams: objectDefinition({
      clientInfo: { type: "object" },
      capabilities: { type: "object" },
    }, ["clientInfo"]),
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
      turn: { $ref: "#/definitions/Turn" },
    }, ["threadId", "turn"]),
    AgentMessageDeltaNotification: objectDefinition({
      threadId: { type: "string" },
      turnId: { type: "string" },
      itemId: { type: "string" },
      delta: { type: "string" },
    }, ["threadId", "turnId", "itemId", "delta"]),
    ErrorNotification: objectDefinition({
      error: { $ref: "#/definitions/TurnError" },
      threadId: { type: "string" },
      turnId: { type: "string" },
      willRetry: { type: "boolean" },
    }, ["error", "threadId", "turnId", "willRetry"]),
    TurnCompletedNotification: objectDefinition({
      threadId: { type: "string" },
      turn: { $ref: "#/definitions/Turn" },
    }, ["threadId", "turn"]),
    CodexErrorInfo: {
      oneOf: [
        { type: "string", enum: [
          "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded", "serverOverloaded",
          "cyberPolicy", "misalignmentPolicyViolation", "internalServerError", "unauthorized", "badRequest",
          "threadRollbackFailed", "sandboxError", "other",
        ] },
        objectDefinition({ httpConnectionFailed: objectDefinition({ httpStatusCode: { type: ["integer", "null"] } }) }, ["httpConnectionFailed"]),
        objectDefinition({ responseStreamConnectionFailed: objectDefinition({ httpStatusCode: { type: ["integer", "null"] } }) }, ["responseStreamConnectionFailed"]),
        objectDefinition({ responseStreamDisconnected: objectDefinition({ httpStatusCode: { type: ["integer", "null"] } }) }, ["responseStreamDisconnected"]),
        objectDefinition({ responseTooManyFailedAttempts: objectDefinition({ httpStatusCode: { type: ["integer", "null"] } }) }, ["responseTooManyFailedAttempts"]),
        objectDefinition({ activeTurnNotSteerable: objectDefinition({ turnKind: { type: "string", enum: ["review", "compact"] } }, ["turnKind"]) }, ["activeTurnNotSteerable"]),
      ],
    },
    TurnError: objectDefinition({
      message: { type: "string" },
      codexErrorInfo: { anyOf: [{ $ref: "#/definitions/CodexErrorInfo" }, { type: "null" }] },
    }, ["message"]),
    Turn: objectDefinition({
      id: { type: "string" }, items: { type: "array" },
      status: { type: "string", enum: ["inProgress", "completed", "interrupted", "failed"] },
      error: { anyOf: [{ $ref: "#/definitions/TurnError" }, { type: "null" }] },
    }, ["id", "items", "status"]),
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

function setApprovalIdRef(bundle, ref) {
  for (const variant of bundle.definitions.ServerRequest.oneOf) {
    variant.properties.id.$ref = ref;
  }
  return bundle;
}

test("qualifies the exact stable request subset", () => {
  const result = qualifyStableSchemaBundle(schema());
  assert.equal(result.schemaSubsetCompatible, true);
  assert.deepEqual(Object.keys(result.methods), APP_SERVER_REQUIRED_METHODS);
  assert.ok(APP_SERVER_REQUIRED_METHODS.every((method) => result.methods[method] === true));
});

test("allows initialize capabilities to remain optional", () => {
  const bundle = schema();
  bundle.definitions.InitializeParams.required = ["clientInfo"];
  assert.equal(qualifyStableSchemaBundle(bundle).schemaSubsetCompatible, true);
});

test("allows additive unrelated request methods", () => {
  const result = qualifyStableSchemaBundle(schema({
    ...expectedRefs,
    "account/read": "#/definitions/AccountReadParams",
  }));
  assert.equal(result.schemaSubsetCompatible, true);
});

test("allows versioned local definition refs when the consumed shapes remain compatible", () => {
  const bundle = schema();
  bundle.definitions.v2 = {};
  const versionedDefinitionNames = new Set([
    "RequestId",
    ...Object.values(expectedRefs).map((ref) => ref.split("/").at(-1)),
    ...Object.values(expectedNotificationRefs).map((ref) => ref.split("/").at(-1)),
  ]);
  for (const name of versionedDefinitionNames) {
    bundle.definitions.v2[name] = bundle.definitions[name];
    delete bundle.definitions[name];
  }
  for (const variant of [
    ...bundle.definitions.ClientRequest.oneOf,
    ...bundle.definitions.ServerNotification.oneOf,
  ]) {
    if (variant.properties.id) variant.properties.id.$ref = "#/definitions/v2/RequestId";
    variant.properties.params.$ref = variant.properties.params.$ref.replace(
      "#/definitions/",
      "#/definitions/v2/",
    );
  }

  assert.equal(qualifyStableSchemaBundle(bundle).schemaSubsetCompatible, true);
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

test("resolves plain, nested, and escaped local request id references", () => {
  assert.equal(qualifyApprovalSchemaBundle(approvalSchema()).schemaSubsetCompatible, true);

  const nested = setApprovalIdRef(approvalSchema(), "#/definitions/v2/RequestId");
  nested.definitions.v2 = { RequestId: nested.definitions.RequestId };
  delete nested.definitions.RequestId;
  assert.equal(qualifyApprovalSchemaBundle(nested).schemaSubsetCompatible, true);

  const escaped = setApprovalIdRef(approvalSchema(), "#/definitions/v2~1types/Request~0Id");
  escaped.definitions["v2/types"] = { "Request~Id": escaped.definitions.RequestId };
  delete escaped.definitions.RequestId;
  assert.equal(qualifyApprovalSchemaBundle(escaped).schemaSubsetCompatible, true);
});

test("rejects missing, malformed, and external request id references", () => {
  const missing = setApprovalIdRef(approvalSchema(), "#/definitions/v2/RequestId");
  delete missing.definitions.RequestId;
  assert.equal(qualifyApprovalSchemaBundle(missing).schemaSubsetCompatible, false);

  const malformed = setApprovalIdRef(approvalSchema(), "#/definitions/v2/RequestId");
  malformed.definitions.v2 = { RequestId: { type: "object", properties: {} } };
  delete malformed.definitions.RequestId;
  assert.equal(qualifyApprovalSchemaBundle(malformed).schemaSubsetCompatible, false);

  const external = setApprovalIdRef(approvalSchema(), "https://example.invalid/RequestId");
  assert.equal(qualifyApprovalSchemaBundle(external).schemaSubsetCompatible, false);

  const malformedPointer = setApprovalIdRef(approvalSchema(), "#/definitions/v2/Request~2Id");
  assert.equal(qualifyApprovalSchemaBundle(malformedPointer).schemaSubsetCompatible, false);
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

test("requires the consumed nested TurnError contract for error notifications and failed turns", () => {
  assert.equal(qualifyStableSchemaBundle(schema()).schemaSubsetCompatible, true);
  for (const mutate of [
    (bundle) => { bundle.definitions.TurnError.properties.message = { type: "number" }; },
    (bundle) => { bundle.definitions.TurnError.required = []; },
    (bundle) => { bundle.definitions.TurnError.properties.codexErrorInfo = { type: "number" }; },
    (bundle) => { bundle.definitions.CodexErrorInfo.oneOf[1].properties.httpConnectionFailed.properties.httpStatusCode = { type: "string" }; },
    (bundle) => { delete bundle.definitions.Turn.properties.error; },
  ]) {
    const incompatible = schema();
    mutate(incompatible);
    assert.equal(qualifyStableSchemaBundle(incompatible).schemaSubsetCompatible, false);
  }
});

test("rejects every future consumed error variant and unsafe TurnError union branch", () => {
  for (const mutate of [
    (bundle) => { bundle.definitions.CodexErrorInfo.oneOf[0].enum.push("futureErrorInfo"); },
    (bundle) => { bundle.definitions.CodexErrorInfo.oneOf.push(
      objectDefinition({ futureErrorInfo: objectDefinition({}) }, ["futureErrorInfo"]),
    ); },
    (bundle) => {
      bundle.definitions.CodexErrorInfo.oneOf.at(-1)
        .properties.activeTurnNotSteerable.properties.turnKind.enum.push("futureTurn");
    },
    (bundle) => {
      const knownTurnError = bundle.definitions.TurnError;
      bundle.definitions.TurnError = {
        anyOf: [
          knownTurnError,
          objectDefinition({ message: { type: "number" } }, ["message"]),
        ],
      };
    },
  ]) {
    const incompatible = schema();
    mutate(incompatible);
    assert.equal(qualifyStableSchemaBundle(incompatible).schemaSubsetCompatible, false);
  }
});

test("rejects missing required fields in consumed objects without throwing", () => {
  for (const mutate of [
    (bundle) => { delete bundle.definitions.TurnError.required; },
    (bundle) => { delete bundle.definitions.Turn.required; },
    (bundle) => { delete bundle.definitions.CodexErrorInfo.oneOf[1].required; },
    (bundle) => {
      delete bundle.definitions.CodexErrorInfo.oneOf.at(-1)
        .properties.activeTurnNotSteerable.required;
    },
  ]) {
    const incompatible = schema();
    mutate(incompatible);
    assert.equal(qualifyStableSchemaBundle(incompatible).schemaSubsetCompatible, false);
  }
});

test("accepts equivalent nullable HTTP status unions and rejects incompatible alternatives", () => {
  for (const keyword of ["anyOf", "oneOf"]) {
    const compatible = schema();
    compatible.definitions.HttpStatus = { type: "integer", minimum: 0, maximum: 65_535 };
    const statusSchema = {
      [keyword]: [{ $ref: "#/definitions/HttpStatus" }, { type: "null" }],
    };
    compatible.definitions.CodexErrorInfo.oneOf[1]
      .properties.httpConnectionFailed.properties.httpStatusCode = statusSchema;
    assert.equal(qualifyStableSchemaBundle(compatible).schemaSubsetCompatible, true);
    for (const invalidType of ["number", "string", "object"]) {
      const incompatible = structuredClone(compatible);
      incompatible.definitions.CodexErrorInfo.oneOf[1]
        .properties.httpConnectionFailed.properties.httpStatusCode[keyword].push({ type: invalidType });
      assert.equal(qualifyStableSchemaBundle(incompatible).schemaSubsetCompatible, false);
    }
  }
});

test("checks concrete outgoing sandbox, approval, effort, and ephemeral values", () => {
  for (const [name, field, restriction] of [
    ["ThreadStartParams", "sandbox", { type: "string", enum: ["workspace-write"] }],
    ["ThreadResumeParams", "sandbox", { type: "string", const: "read-only" }],
    ["ThreadStartParams", "approvalPolicy", { type: "string", enum: ["never"] }],
    ["TurnStartParams", "effort", { type: "string", enum: ["low", "high"] }],
    ["ThreadStartParams", "ephemeral", { type: "boolean", const: true }],
  ]) {
    const bundle = schema();
    bundle.definitions[name].properties[field] = restriction;
    assert.equal(qualifyStableSchemaBundle(bundle).schemaSubsetCompatible, false, `${name}.${field}`);
  }

  const compatible = schema();
  compatible.definitions.Sandbox = { type: "string", enum: ["read-only", "workspace-write", "future"] };
  compatible.definitions.ThreadStartParams.properties.sandbox = {
    allOf: [{ $ref: "#/definitions/Sandbox" }, { type: "string" }],
  };
  assert.equal(qualifyStableSchemaBundle(compatible).schemaSubsetCompatible, true);
  compatible.definitions.ThreadStartParams.properties.sandbox.allOf.push({ enum: ["workspace-write"] });
  assert.equal(qualifyStableSchemaBundle(compatible).schemaSubsetCompatible, false);
});

test("checks the actual text input payload against explicit item constraints", () => {
  const textItem = objectDefinition({
    type: { type: "string", const: "text" },
    text: { type: "string" },
  }, ["type", "text"]);
  for (const items of [
    { type: "number" },
    { ...structuredClone(textItem), required: ["type", "text", "text_elements"] },
    { ...structuredClone(textItem), properties: { type: { type: "string", const: "image" } } },
    { ...structuredClone(textItem), properties: { ...textItem.properties, text: { type: "number" } } },
  ]) {
    const bundle = schema();
    bundle.definitions.TurnStartParams.properties.input.items = items;
    assert.equal(qualifyStableSchemaBundle(bundle).schemaSubsetCompatible, false);
  }

  const compatible = schema();
  compatible.definitions.v2 = { TextInput: textItem };
  compatible.definitions.TurnStartParams.properties.input.items = {
    oneOf: [{ type: "number" }, { $ref: "#/definitions/v2/TextInput" }],
  };
  compatible.definitions.v2.TextInput.properties.text_elements = { type: "array" };
  assert.equal(qualifyStableSchemaBundle(compatible).schemaSubsetCompatible, true);
});

test("requires explicitly described incoming turns to preserve id, items, and status", () => {
  const turn = objectDefinition({
    id: { type: "string" },
    items: { type: "array" },
    status: { type: "string", enum: ["inProgress", "completed", "interrupted", "failed", "future"] },
    error: { anyOf: [{ $ref: "#/definitions/TurnError" }, { type: "null" }] },
  }, ["id", "items", "status"]);
  const compatible = schema();
  compatible.definitions.v2 = { Turn: turn };
  for (const name of ["TurnStartedNotification", "TurnCompletedNotification"]) {
    compatible.definitions[name].properties.turn = { $ref: "#/definitions/v2/Turn" };
  }
  assert.equal(qualifyStableSchemaBundle(compatible).schemaSubsetCompatible, true);

  for (const field of ["id", "items", "status"]) {
    const missing = structuredClone(compatible);
    delete missing.definitions.v2.Turn.properties[field];
    assert.equal(qualifyStableSchemaBundle(missing).schemaSubsetCompatible, false, `missing ${field}`);
    const optional = structuredClone(compatible);
    optional.definitions.v2.Turn.required = ["id", "items", "status"].filter((name) => name !== field);
    assert.equal(qualifyStableSchemaBundle(optional).schemaSubsetCompatible, false, `optional ${field}`);
    const wrongKind = structuredClone(compatible);
    wrongKind.definitions.v2.Turn.properties[field] = { type: "number" };
    assert.equal(qualifyStableSchemaBundle(wrongKind).schemaSubsetCompatible, false, `invalid ${field}`);
  }
  const missingStatus = structuredClone(compatible);
  missingStatus.definitions.v2.Turn.properties.status.enum = ["inProgress", "completed", "failed"];
  assert.equal(qualifyStableSchemaBundle(missingStatus).schemaSubsetCompatible, false);

  const missingError = structuredClone(compatible);
  delete missingError.definitions.v2.Turn.properties.error;
  assert.equal(qualifyStableSchemaBundle(missingError).schemaSubsetCompatible, false);
  const malformedError = structuredClone(compatible);
  malformedError.definitions.TurnError.properties.codexErrorInfo = { type: "number" };
  assert.equal(qualifyStableSchemaBundle(malformedError).schemaSubsetCompatible, false);
});

test("checks optional approval response schemas against every supported decision", () => {
  const compatible = approvalSchema();
  const response = objectDefinition({
    decision: { type: "string", enum: ["accept", "decline", "cancel", "future"] },
  }, ["decision"]);
  compatible.definitions.CommandExecutionRequestApprovalResponse = structuredClone(response);
  compatible.definitions.FileChangeRequestApprovalResponse = structuredClone(response);
  assert.equal(qualifyApprovalSchemaBundle(compatible).schemaSubsetCompatible, true);

  const missingCancel = structuredClone(compatible);
  missingCancel.definitions.FileChangeRequestApprovalResponse.properties.decision.enum = ["accept", "decline"];
  const rejected = qualifyApprovalSchemaBundle(missingCancel);
  assert.equal(rejected.schemaSubsetCompatible, false);
  assert.equal(rejected.serverRequests["item/fileChange/requestApproval"], false);

  const newlyRequired = structuredClone(compatible);
  newlyRequired.definitions.CommandExecutionRequestApprovalResponse.required.push("futureField");
  assert.equal(qualifyApprovalSchemaBundle(newlyRequired).schemaSubsetCompatible, false);

  const versioned = approvalSchema();
  versioned.definitions.v2 = {
    FileChangeRequestApprovalParams: versioned.definitions.FileChangeRequestApprovalParams,
    FileChangeRequestApprovalResponse: response,
  };
  versioned.definitions.ServerRequest.oneOf[1].properties.params.$ref = "#/definitions/v2/FileChangeRequestApprovalParams";
  delete versioned.definitions.FileChangeRequestApprovalParams;
  assert.equal(qualifyApprovalSchemaBundle(versioned).schemaSubsetCompatible, true);
  versioned.definitions.v2.FileChangeRequestApprovalResponse.properties.decision.enum = ["accept"];
  assert.equal(qualifyApprovalSchemaBundle(versioned).schemaSubsetCompatible, false);
  versioned.definitions.v2.FileChangeRequestApprovalResponse = null;
  assert.equal(qualifyApprovalSchemaBundle(versioned).schemaSubsetCompatible, false);
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
