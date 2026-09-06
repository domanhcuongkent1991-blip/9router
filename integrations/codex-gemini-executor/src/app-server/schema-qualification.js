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
  },
  "#/definitions/TurnStartParams": {
    direction: "outgoing",
    fields: { threadId: "string", input: "array", model: "string", effort: "string" },
    required: ["threadId", "input"],
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
  },
  "#/definitions/AgentMessageDeltaNotification": {
    direction: "incoming",
    fields: { threadId: "string", turnId: "string", itemId: "string", delta: "string" },
    required: ["threadId", "turnId", "itemId", "delta"],
  },
  "#/definitions/TurnCompletedNotification": {
    direction: "incoming",
    fields: { threadId: "string", turn: "object" },
    required: ["threadId", "turn"],
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
  ));
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
