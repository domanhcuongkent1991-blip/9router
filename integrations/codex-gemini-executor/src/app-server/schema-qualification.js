import { APP_SERVER_REQUIRED_METHODS } from "./compatibility.js";

const EXPECTED_PARAMETER_REFS = Object.freeze({
  initialize: "#/definitions/InitializeParams",
  "model/list": "#/definitions/ModelListParams",
  "thread/start": "#/definitions/ThreadStartParams",
  "thread/resume": "#/definitions/ThreadResumeParams",
  "turn/start": "#/definitions/TurnStartParams",
  "turn/interrupt": "#/definitions/TurnInterruptParams",
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

function isCompatibleVariant(variant, method) {
  if (!isObject(variant) || !isObject(variant.properties)) return false;
  if (!Array.isArray(variant.required)) return false;
  if (!["id", "method", "params"].every((name) => variant.required.includes(name))) return false;
  return variantMethod(variant) === method
    && variant.properties.params?.$ref === EXPECTED_PARAMETER_REFS[method];
}

export function qualifyStableSchemaBundle(bundle) {
  const variants = bundle?.definitions?.ClientRequest?.oneOf;
  if (!isObject(bundle) || !Array.isArray(variants)) {
    throw new AppServerSchemaError("invalid_schema_structure");
  }

  const compatibility = {};
  for (const method of Object.keys(EXPECTED_PARAMETER_REFS)) {
    const matches = variants.filter((variant) => variantMethod(variant) === method);
    compatibility[method] = matches.length === 1 && isCompatibleVariant(matches[0], method);
  }

  const methods = Object.fromEntries(
    APP_SERVER_REQUIRED_METHODS.map((method) => [method, compatibility[method] === true]),
  );
  return {
    schemaSubsetCompatible: Object.values(compatibility).every(Boolean),
    methods,
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
