import { isDeepStrictEqual } from "node:util";

import { APP_SERVER_REQUIRED_METHODS } from "./compatibility.js";
import {
  CODEX_ERROR_INFO_CODES,
  HTTP_ERROR_INFO_CODES,
  NON_STEERABLE_TURN_KINDS,
} from "./events.js";

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
  error: "#/definitions/ErrorNotification",
  "turn/completed": "#/definitions/TurnCompletedNotification",
});

const EXPECTED_APPROVAL_REFS = Object.freeze({
  "item/commandExecution/requestApproval": "#/definitions/CommandExecutionRequestApprovalParams",
  "item/fileChange/requestApproval": "#/definitions/FileChangeRequestApprovalParams",
});

const PARAMETER_CONTRACTS = Object.freeze({
  "#/definitions/InitializeParams": {
    direction: "outgoing",
    fields: { clientInfo: "object", capabilities: "object" },
    required: ["clientInfo"],
  },
  "#/definitions/ModelListParams": {
    direction: "outgoing",
    fields: { limit: "integer", includeHidden: "boolean" },
    required: [],
  },
  "#/definitions/ThreadStartParams": {
    direction: "outgoing",
    fields: {
      cwd: "string",
      model: "string",
      modelProvider: "string",
      sandbox: "string",
      approvalPolicy: "string",
      ephemeral: "boolean",
    },
    required: [],
    values: {
      sandbox: ["read-only", "workspace-write"],
      approvalPolicy: ["on-request", "never"],
      ephemeral: [false],
    },
  },
  "#/definitions/ThreadResumeParams": {
    direction: "outgoing",
    fields: {
      threadId: "string",
      cwd: "string",
      model: "string",
      modelProvider: "string",
      sandbox: "string",
      approvalPolicy: "string",
    },
    required: ["threadId"],
    values: {
      sandbox: ["read-only", "workspace-write"],
      approvalPolicy: ["on-request", "never"],
    },
  },
  "#/definitions/TurnStartParams": {
    direction: "outgoing",
    fields: { threadId: "string", input: "array", model: "string", effort: "string" },
    required: ["threadId", "input"],
    values: {
      input: [[{ type: "text", text: "task" }]],
      effort: ["low", "medium", "high"],
    },
  },
  "#/definitions/TurnInterruptParams": {
    direction: "outgoing",
    fields: { threadId: "string", turnId: "string" },
    required: ["threadId", "turnId"],
  },
  "#/definitions/TurnStartedNotification": {
    direction: "incoming",
    fields: { threadId: "string", turn: "object" },
    required: ["threadId", "turn"],
    turnStatuses: ["inProgress"],
  },
  "#/definitions/AgentMessageDeltaNotification": {
    direction: "incoming",
    fields: { threadId: "string", turnId: "string", itemId: "string", delta: "string" },
    required: ["threadId", "turnId", "itemId", "delta"],
  },
  "#/definitions/ErrorNotification": {
    direction: "incoming",
    fields: { error: "object", threadId: "string", turnId: "string", willRetry: "boolean" },
    required: ["error", "threadId", "turnId", "willRetry"],
    turnError: true,
  },
  "#/definitions/TurnCompletedNotification": {
    direction: "incoming",
    fields: { threadId: "string", turn: "object" },
    required: ["threadId", "turn"],
    turnStatuses: ["completed", "interrupted", "failed"],
  },
  "#/definitions/CommandExecutionRequestApprovalParams": {
    direction: "incoming",
    fields: { threadId: "string", turnId: "string", itemId: "string" },
    required: ["threadId", "turnId", "itemId"],
  },
  "#/definitions/FileChangeRequestApprovalParams": {
    direction: "incoming",
    fields: { threadId: "string", turnId: "string", itemId: "string" },
    required: ["threadId", "turnId", "itemId"],
  },
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

function definitionPath(ref) {
  const prefix = "#/definitions/";
  if (typeof ref !== "string" || !ref.startsWith(prefix)) return undefined;
  const pointer = ref.slice(prefix.length);
  if (pointer.length === 0) return undefined;
  const path = [];
  for (const token of pointer.split("/")) {
    if (/~(?:[^01]|$)/u.test(token)) return undefined;
    path.push(token.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return path;
}

function resolveDefinition(definitions, ref) {
  const path = definitionPath(ref);
  if (path === undefined || !isObject(definitions)) return undefined;
  let value = definitions;
  for (const segment of path) {
    if (!isObject(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function schemaKinds(schema, definitions, seen = new Set()) {
  if (!isObject(schema)) return new Set();
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return new Set();
    const target = resolveDefinition(definitions, schema.$ref);
    if (!isObject(target)) return new Set();
    const nextSeen = new Set(seen);
    nextSeen.add(schema.$ref);
    return schemaKinds(target, definitions, nextSeen);
  }

  const kinds = new Set();
  const declaredTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  for (const type of declaredTypes) {
    if (typeof type === "string") kinds.add(type);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) {
      for (const kind of schemaKinds(branch, definitions, seen)) kinds.add(kind);
    }
  }
  return kinds;
}

function validRequired(required) {
  return required === undefined
    || (Array.isArray(required)
      && required.every((field) => typeof field === "string")
      && new Set(required).size === required.length);
}

function validRequestId(definitions, ref) {
  const requestId = resolveDefinition(definitions, ref);
  if (!isObject(requestId)) return false;
  const kinds = schemaKinds(requestId, definitions);
  return kinds.size > 0
    && [...kinds].every((kind) => kind === "integer" || kind === "string");
}

function fieldKindCompatible(schema, expectedKind, definitions, direction) {
  const kinds = schemaKinds(schema, definitions);
  if (!kinds.has(expectedKind)) return false;
  return direction === "outgoing" || [...kinds].every((kind) => kind === expectedKind);
}

// Check the concrete wire shapes this adapter sends, not every JSON Schema feature.
function acceptsValue(schema, value, definitions, depth = 0) {
  if (schema === true) return true;
  if (!isObject(schema) || depth > 32) return false;
  const accepts = (child, candidate = value) => acceptsValue(child, candidate, definitions, depth + 1);
  if (Object.hasOwn(schema, "$ref") && !accepts(resolveDefinition(definitions, schema.$ref))) return false;
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(schema.const, value)) return false;
  if (Object.hasOwn(schema, "enum")
    && (!Array.isArray(schema.enum) || !schema.enum.some((entry) => isDeepStrictEqual(entry, value)))) return false;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.some((type) => type === kind || (type === "integer" && Number.isInteger(value)))) return false;
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (schema[keyword] === undefined) continue;
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) return false;
    const matches = branches.filter((branch) => accepts(branch)).length;
    if (keyword === "allOf" ? matches !== branches.length : keyword === "oneOf" ? matches !== 1 : matches === 0) {
      return false;
    }
  }
  if (schema.not !== undefined && accepts(schema.not)) return false;
  if (isObject(value)) {
    if (!validRequired(schema.required) || schema.required?.some((field) => !Object.hasOwn(value, field))) return false;
    if (schema.properties !== undefined && !isObject(schema.properties)) return false;
    for (const [field, fieldValue] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, field)) {
        if (!accepts(schema.properties[field], fieldValue)) return false;
      } else if (schema.additionalProperties !== undefined && !accepts(schema.additionalProperties, fieldValue)) {
        return false;
      }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (Array.isArray(schema.items)) {
      if (!value.every((entry, index) => accepts(schema.items[index] ?? schema.additionalItems ?? true, entry))) return false;
    } else if (schema.items !== undefined && !value.every((entry) => accepts(schema.items, entry))) {
      return false;
    }
  }
  return true;
}

const CODEX_ERROR_INFO_SAMPLES = Object.freeze([
  null,
  ...CODEX_ERROR_INFO_CODES,
  ...HTTP_ERROR_INFO_CODES.map((code) => ({ [code]: { httpStatusCode: 503 } })),
  ...NON_STEERABLE_TURN_KINDS.map((turnKind) => ({ activeTurnNotSteerable: { turnKind } })),
]);

const SCHEMA_ANNOTATIONS = new Set(["$schema", "title", "description", "default", "examples"]);

function onlyWrapperKeys(schema, allowed) {
  return Object.keys(schema).every((key) => allowed.has(key) || SCHEMA_ANNOTATIONS.has(key));
}

// The protocol's error values are finite. For consumed unions, every admissible
// branch must be understood by events.js; allOf is rejected until this narrow
// verifier can prove its intersection without weakening the runtime contract.
function consumedAlternatives(schema, definitions, depth = 0) {
  if (!isObject(schema) || depth > 32) return undefined;
  if (Object.hasOwn(schema, "$ref")) {
    if (!onlyWrapperKeys(schema, new Set(["$ref"]))) return undefined;
    return consumedAlternatives(resolveDefinition(definitions, schema.$ref), definitions, depth + 1);
  }
  if (schema.allOf !== undefined) return undefined;
  const unions = ["anyOf", "oneOf"].filter((keyword) => schema[keyword] !== undefined);
  if (unions.length === 0) return [schema];
  if (unions.length !== 1 || !onlyWrapperKeys(schema, new Set([unions[0]]))) return undefined;
  const branches = schema[unions[0]];
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const alternatives = branches.map((branch) => consumedAlternatives(branch, definitions, depth + 1));
  return alternatives.some((branch) => branch === undefined) ? undefined : alternatives.flat();
}

function consumedSchema(schema, definitions, depth = 0) {
  const alternatives = consumedAlternatives(schema, definitions, depth);
  return alternatives?.length === 1 ? alternatives[0] : undefined;
}

function onlyKind(schema, kind, definitions) {
  const kinds = schemaKinds(schema, definitions);
  return kinds.size === 1 && kinds.has(kind);
}

function exactEnumSubset(schema, allowed, definitions) {
  const concrete = consumedSchema(schema, definitions);
  return concrete !== undefined
    && onlyKind(concrete, "string", definitions)
    && Array.isArray(concrete.enum)
    && concrete.enum.length > 0
    && concrete.enum.every((value) => typeof value === "string" && allowed.has(value));
}

function integerOrNullSchema(schema, definitions) {
  const alternatives = consumedAlternatives(schema, definitions);
  return alternatives !== undefined && alternatives.every((alternative) => {
    const kinds = schemaKinds(alternative, definitions);
    return kinds.size > 0 && [...kinds].every((kind) => kind === "integer" || kind === "null");
  }) && acceptsValue(schema, 503, definitions) && acceptsValue(schema, null, definitions);
}

function knownObjectErrorVariant(schema, definitions) {
  const concrete = consumedSchema(schema, definitions);
  if (concrete === undefined || !onlyKind(concrete, "object", definitions)
    || !isObject(concrete.properties) || !validRequired(concrete.required)
    || concrete.additionalProperties !== false) return false;

  const [code] = Object.keys(concrete.properties);
  if (Object.keys(concrete.properties).length !== 1 || !concrete.required?.includes(code)) return false;
  const details = consumedSchema(concrete.properties[code], definitions);
  if (details === undefined || !onlyKind(details, "object", definitions)
    || !isObject(details.properties) || !validRequired(details.required)) return false;

  if (HTTP_ERROR_INFO_CODES.includes(code)) {
    return Object.hasOwn(details.properties, "httpStatusCode")
      && integerOrNullSchema(details.properties.httpStatusCode, definitions);
  }
  if (code !== "activeTurnNotSteerable") return false;
  return details.required?.includes("turnKind") === true
    && Object.hasOwn(details.properties, "turnKind")
    && exactEnumSubset(details.properties.turnKind, new Set(NON_STEERABLE_TURN_KINDS), definitions);
}

function codexErrorInfoShapeCompatible(schema, definitions) {
  const alternatives = consumedAlternatives(schema, definitions);
  if (!alternatives || !alternatives.every((alternative) => {
    const concrete = consumedSchema(alternative, definitions);
    if (concrete === undefined) return false;
    if (onlyKind(concrete, "null", definitions)) return acceptsValue(concrete, null, definitions);
    if (onlyKind(concrete, "string", definitions)) {
      return exactEnumSubset(concrete, new Set(CODEX_ERROR_INFO_CODES), definitions);
    }
    return knownObjectErrorVariant(concrete, definitions);
  })) return false;
  return CODEX_ERROR_INFO_SAMPLES.every((sample) => acceptsValue(schema, sample, definitions));
}

function turnErrorObjectCompatible(schema, definitions) {
  const concrete = consumedSchema(schema, definitions);
  if (concrete === undefined || !onlyKind(concrete, "object", definitions)
    || !isObject(concrete.properties) || !validRequired(concrete.required)
    || !concrete.required?.includes("message")
    || !Object.hasOwn(concrete.properties, "message")
    || !fieldKindCompatible(concrete.properties.message, "string", definitions, "incoming")
    || !Object.hasOwn(concrete.properties, "codexErrorInfo")) return false;
  return codexErrorInfoShapeCompatible(concrete.properties.codexErrorInfo, definitions);
}

function turnErrorShapeCompatible(schema, definitions) {
  const alternatives = consumedAlternatives(schema, definitions);
  return alternatives !== undefined
    && alternatives.every((alternative) => turnErrorObjectCompatible(alternative, definitions))
    && CODEX_ERROR_INFO_SAMPLES.every((codexErrorInfo) => acceptsValue(schema, {
      message: "error", codexErrorInfo,
    }, definitions));
}

function nullableTurnErrorShapeCompatible(schema, definitions) {
  const alternatives = consumedAlternatives(schema, definitions);
  if (!alternatives) return false;
  let allowsError = false;
  for (const alternative of alternatives) {
    const concrete = consumedSchema(alternative, definitions);
    if (concrete === undefined) return false;
    if (onlyKind(concrete, "null", definitions)) {
      if (!acceptsValue(concrete, null, definitions)) return false;
    } else if (turnErrorObjectCompatible(concrete, definitions)) {
      allowsError = true;
    } else {
      return false;
    }
  }
  return allowsError && CODEX_ERROR_INFO_SAMPLES.every((codexErrorInfo) => acceptsValue(schema, {
      message: "error", codexErrorInfo,
    }, definitions));
}

function turnShapeCompatible(schema, statuses, definitions) {
  const alternatives = consumedAlternatives(schema, definitions);
  return alternatives !== undefined && alternatives.every((alternative) => {
    const concrete = consumedSchema(alternative, definitions);
    // Failed turns need an explicitly described error branch for fallback classification.
    if (concrete === undefined) return false;
    if (concrete.properties === undefined && concrete.required === undefined) return !statuses.includes("failed");
    if (!onlyKind(concrete, "object", definitions)
      || !isObject(concrete.properties) || !validRequired(concrete.required)) return false;
    const baseShapeCompatible = Object.entries({ id: "string", items: "array", status: "string" }).every(([field, kind]) => (
      concrete.required?.includes(field)
      && fieldKindCompatible(concrete.properties[field], kind, definitions, "incoming")
      && (field !== "status" || statuses.every((status) => acceptsValue(concrete.properties.status, status, definitions)))
    ));
    if (!baseShapeCompatible) return false;
    return !statuses.includes("failed")
      || (Object.hasOwn(concrete.properties, "error")
        && nullableTurnErrorShapeCompatible(concrete.properties.error, definitions));
  });
}

function definitionCompatible(definitions, actualRef, expectedRef) {
  const contract = PARAMETER_CONTRACTS[expectedRef];
  const definition = resolveDefinition(definitions, actualRef);
  if (!contract || !isObject(definition) || !isObject(definition.properties)) return false;
  if (!validRequired(definition.required)) return false;
  const definitionKinds = schemaKinds(definition, definitions);
  if (definitionKinds.size !== 1 || !definitionKinds.has("object")) return false;

  const required = definition.required ?? [];
  if (!contract.required.every((field) => required.includes(field))) return false;
  if (contract.direction === "outgoing"
    && required.some((field) => !Object.hasOwn(contract.fields, field))) return false;

  return Object.entries(contract.fields).every(([field, kind]) => (
    Object.hasOwn(definition.properties, field)
    && fieldKindCompatible(definition.properties[field], kind, definitions, contract.direction)
    && (contract.direction === "outgoing" || required.includes(field))
    && (contract.values?.[field] ?? []).every((value) => acceptsValue(definition.properties[field], value, definitions))
    && (field !== "error" || !contract.turnError
      || turnErrorShapeCompatible(definition.properties.error, definitions))
    && (field !== "turn" || !contract.turnStatuses
      || turnShapeCompatible(definition.properties.turn, contract.turnStatuses, definitions))
  ));
}

function approvalResponseCompatible(definitions, actualRef, expectedRef) {
  const responseName = expectedRef.split("/").at(-1).replace(/Params$/u, "Response");
  if (!definitionPath(actualRef)) return false;
  const parentRef = actualRef.slice(0, actualRef.lastIndexOf("/") + 1);
  const localResponse = resolveDefinition(definitions, `${parentRef}${responseName}`);
  const response = localResponse === undefined
    ? resolveDefinition(definitions, `#/definitions/${responseName}`)
    : localResponse;
  return response === undefined
    || ["accept", "decline", "cancel"].every((decision) => acceptsValue(response, { decision }, definitions));
}

function isCompatibleVariant(variant, method, expectedRef, requiresId, definitions) {
  if (!isObject(variant) || !isObject(variant.properties)) return false;
  if (!Array.isArray(variant.required)) return false;
  const requiredFields = requiresId ? ["id", "method", "params"] : ["method", "params"];
  if (!requiredFields.every((name) => variant.required.includes(name))) return false;
  if (variant.properties.method?.type !== "string") return false;
  if (requiresId) {
    const idRef = variant.properties.id?.$ref;
    if (!validRequestId(definitions, idRef)) return false;
  } else if (Object.hasOwn(variant.properties, "id") || variant.required.includes("id")) {
    return false;
  }
  const actualRef = variant.properties.params?.$ref;
  return variantMethod(variant) === method
    && definitionCompatible(definitions, actualRef, expectedRef);
}

function qualifyVariants(variants, expectedRefs, { requiresId, definitions }) {
  return Object.fromEntries(Object.entries(expectedRefs).map(([method, ref]) => {
    const matches = variants.filter((variant) => variantMethod(variant) === method);
    return [method, matches.length === 1
      && isCompatibleVariant(matches[0], method, ref, requiresId, definitions)];
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

  const definitions = bundle.definitions;
  const clientCompatibility = qualifyVariants(clientVariants, EXPECTED_PARAMETER_REFS, {
    requiresId: true,
    definitions,
  });
  const notificationCompatibility = qualifyVariants(notificationVariants, EXPECTED_NOTIFICATION_REFS, {
    requiresId: false,
    definitions,
  });

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
  const serverRequests = qualifyVariants(variants, EXPECTED_APPROVAL_REFS, {
    requiresId: true,
    definitions: bundle.definitions,
  });
  for (const [method, expectedRef] of Object.entries(EXPECTED_APPROVAL_REFS)) {
    if (!serverRequests[method]) continue;
    const actualRef = variants.find((variant) => variantMethod(variant) === method).properties.params.$ref;
    serverRequests[method] = approvalResponseCompatible(bundle.definitions, actualRef, expectedRef);
  }
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
