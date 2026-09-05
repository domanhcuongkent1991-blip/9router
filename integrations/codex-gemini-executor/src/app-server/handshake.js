import { posix, win32 } from "node:path";

import { APP_SERVER_REQUIRED_METHODS } from "./compatibility.js";

const MAX_IDENTITY_BYTES = 4096;

export class AppServerHandshakeError extends Error {
  constructor(reason, stage) {
    super("App Server handshake failure");
    this.name = "AppServerHandshakeError";
    this.code = "app_server_handshake_error";
    this.details = { reason, stage };
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && Buffer.byteLength(value, "utf8") <= MAX_IDENTITY_BYTES;
}

function hasExactKeys(value, expected) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function validInitializeRequest(request) {
  if (!isObject(request) || !hasExactKeys(request, ["clientInfo", "capabilities"])) return false;
  if (!hasExactKeys(request.clientInfo, ["name", "title", "version"])) return false;
  if (!Object.values(request.clientInfo).every(isBoundedString)) return false;
  return hasExactKeys(request.capabilities, ["experimentalApi"])
    && request.capabilities.experimentalApi === false;
}

function validInitializeResponse(response) {
  if (!isObject(response)) return false;
  if (!["userAgent", "platformFamily", "platformOs", "codexHome"].every(
    (name) => isBoundedString(response[name]),
  )) return false;
  return win32.isAbsolute(response.codexHome) || posix.isAbsolute(response.codexHome);
}

function normalizedQualification(value) {
  if (!isObject(value) || typeof value.schemaSubsetCompatible !== "boolean" || !isObject(value.methods)) {
    return undefined;
  }
  if (!APP_SERVER_REQUIRED_METHODS.every((method) => typeof value.methods[method] === "boolean")) {
    return undefined;
  }
  return {
    schemaSubsetCompatible: value.schemaSubsetCompatible,
    methods: Object.fromEntries(
      APP_SERVER_REQUIRED_METHODS.map((method) => [method, value.methods[method]]),
    ),
  };
}

export function createStableHandshakeDriver({ client, schemaQualification }) {
  let initializeAttempted = false;
  let initialized = false;
  let probeAttempted = false;

  async function initialize(request) {
    if (initializeAttempted) {
      throw new AppServerHandshakeError("initialize_already_attempted", "initialize");
    }
    initializeAttempted = true;
    if (!validInitializeRequest(request)) {
      throw new AppServerHandshakeError("invalid_initialize_request", "initialize");
    }

    let response;
    try {
      response = await client.request("initialize", request);
    } catch {
      throw new AppServerHandshakeError("initialize_request_failed", "initialize");
    }
    if (!validInitializeResponse(response)) {
      throw new AppServerHandshakeError("invalid_initialize_response", "initialize");
    }
    try {
      await client.notify("initialized", {});
    } catch {
      throw new AppServerHandshakeError("initialized_notification_failed", "initialize");
    }
    initialized = true;
    return { ok: true };
  }

  async function probeRequiredContract() {
    if (!initialized) throw new AppServerHandshakeError("initialize_required", "probe");
    if (probeAttempted) throw new AppServerHandshakeError("probe_already_attempted", "probe");
    probeAttempted = true;

    const qualification = normalizedQualification(schemaQualification);
    if (!qualification) {
      throw new AppServerHandshakeError("invalid_schema_qualification", "probe");
    }

    let response;
    try {
      response = await client.request("model/list", { limit: 1, includeHidden: true });
    } catch {
      throw new AppServerHandshakeError("model_list_failed", "probe");
    }
    if (!isObject(response) || !Array.isArray(response.data)) {
      throw new AppServerHandshakeError("invalid_model_list_response", "probe");
    }
    return qualification;
  }

  return Object.freeze({ initialize, probeRequiredContract });
}
