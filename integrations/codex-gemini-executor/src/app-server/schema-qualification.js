import { APP_SERVER_REQUIRED_METHODS } from "./compatibility.js";

const EXPECTED_PARAMETER_REFS = Object.freeze({
  initialize: "#/definitions/InitializeParams",
  "model/list": "#/definitions/ModelListParams",
  "thread/start": "#/definitions/ThreadStartParams",
  "thread/resume": "#/definitions/ThreadResumeParams",
  "turn/start": "#/definitions/TurnStartParams",
  "turn/interrupt": "#/definitions/TurnInterruptParams",
});

const EXPECTED_NOTIFICATION_REFS = Object.freeze({
  "turn/started": "#/definitions/TurnStartedNotification",
  "item/agentMessage/delta": "#/definitions/AgentMessageDeltaNotification",
  "turn/completed": "#/definitions/TurnCompletedNotification",
});

const EXPECTED_APPROVAL_REFS = Object.freeze({
  "item/commandExecution/requestApproval": "#/definitions/CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval": "#/definitions/FileChangeRequestApprovalParams",
});

export class AppServerSchemaError extends Error {
  constructor(reason) {
    super("App Server schema qualification failure");
    this.name = "AppServerSchemaError";
    this.code = "app_server_schema_error";
    this.details = { reason };
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function variantMethod(variant) {
  const values = variant?.properties?.method?.enum;
  return Array.isArray(values) && values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : undefined;
}

function isCompatibleVariant(variant, method, expectedRef, requiresId) {
  if (!isObject(variant) || !isObject(variant.properties)) return false;
  if (!Array.isArray(variant.required)) return false;
  const requiredFields = requiresId ? ["id", "method", "params"] : ["method", "params"];
  if (!requiredFields.every((name) => variant.required.includes(name))) return false;
  return variantMethod(variant) === method
    && variant.properties.params?.$ref === expectedRef;
}

function qualifyVariants(variants, expectedRefs, { requiresId }) {
  return Object.fromEntries(Object.entries(expectedRefs).map(([method, ref]) => {
    const matches = variants.filter((variant) => variantMethod(variant) === method);
    return [method, matches.length === 1 && isCompatibleVariant(matches[0], method, ref, requiresId)];
  }));
}

function allCompatible(compatibility) {
  return Object.values(compatibility).every(Boolean);
}

export function qualifyStableSchemaBundle(bundle) {
  const clientVariants = bundle?.definitions?.ClientRequest?.oneOf;
  const notificationVariants = bundle?.definitions?.ServerNotification?.oneOf;
  if (!isObject(bundle) || !Array.isArray(clientVariants) || !Array.isArray(notificationVariants)) {
    throw new AppServerSchemaError("invalid_schema_structure");
  }

  const clientCompatibility = qualifyVariants(clientVariants, EXPECTED_PARAMETER_REFS, { requiresId: true });
  const notificationCompatibility = qualifyVariants(notificationVariants, EXPECTED_NOTIFICATION_REFS, { requiresId: false });

  const methods = Object.fromEntries(
    APP_SERVER_REQUIRED_METHODS.map((method) => [method, clientCompatibility[method] === true]),
  );
  return {
    schemaSubsetCompatible: allCompatible(clientCompatibility) && allCompatible(notificationCompatibility),
    methods,
  };
}

export function qualifyApprovalSchemaBundle(bundle) {
  const variants = bundle?.definitions?.ServerRequest?.oneOf;
  if (!isObject(bundle) || !Array.isArray(variants)) {
    throw new AppServerSchemaError("invalid_schema_structure");
  }
  const serverRequests = qualifyVariants(variants, EXPECTED_APPROVAL_REFS, { requiresId: true });
  return { schemaSubsetCompatible: allCompatible(serverRequests), serverRequests };
}

function hasMethodShape(value) {
  return isObject(value?.methods)
    && APP_SERVER_REQUIRED_METHODS.every((method) => typeof value.methods[method] === "boolean");
}

function safeMethods(value) {
  return Object.fromEntries(APP_SERVER_REQUIRED_METHODS.map((method) => [method, value?.methods?.[method] === true]));
}

export function combineSchemaQualifications(stable, approvals) {
  const stableValid = typeof stable?.schemaSubsetCompatible === "boolean" && hasMethodShape(stable);
  const approvalsValid = typeof approvals?.schemaSubsetCompatible === "boolean"
    && isObject(approvals.serverRequests)
    && Object.keys(EXPECTED_APPROVAL_REFS).every((method) => typeof approvals.serverRequests[method] === "boolean");
  return {
    schemaSubsetCompatible: stableValid && approvalsValid
      && stable.schemaSubsetCompatible === true
      && approvals.schemaSubsetCompatible === true,
    methods: safeMethods(stable),
  };
}

export function parseAndQualifyStableSchema(text, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof text !== "string") throw new AppServerSchemaError("invalid_schema_text");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new AppServerSchemaError("schema_too_large");
  }

  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    throw new AppServerSchemaError("invalid_json");
  }
  return qualifyStableSchemaBundle(bundle);
}
