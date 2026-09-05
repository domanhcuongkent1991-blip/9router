const REDACTED = "[REDACTED]";
const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 2_048,
  maxStringBytes: 64 * 1024,
  maxOutputBytes: 256 * 1024,
});

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret|credential|credentials)$/iu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu;
const ASSIGNMENT = /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret)\s*([:=])\s*([^\s,;]+)/giu;
const CREDENTIAL_HEADER = /(^|[\r\n])([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)[ \t]*[:=][ \t]*)([^\r\n]*)/gimu;
const MAX_KNOWN_SECRETS = 64;

export class CompanionRedactionError extends Error {
  constructor(reason) {
    super("Companion redaction failed");
    this.name = "CompanionRedactionError";
    this.code = "redaction_failed";
    this.details = { reason };
  }
}

function positiveInteger(value, fallback) {
  return value === undefined ? fallback : Number.isInteger(value) && value > 0 ? value : undefined;
}

function validateConfiguration(options) {
  const limits = {
    maxDepth: positiveInteger(options.maxDepth, DEFAULT_LIMITS.maxDepth),
    maxNodes: positiveInteger(options.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxStringBytes: positiveInteger(options.maxStringBytes, DEFAULT_LIMITS.maxStringBytes),
    maxOutputBytes: positiveInteger(options.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
  };
  if (Object.values(limits).some((value) => value === undefined)) {
    throw new CompanionRedactionError("invalid_configuration");
  }
  if (!Array.isArray(options.knownSecrets)
    || options.knownSecrets.some((value) => typeof value !== "string"
      || value.length === 0
      || Buffer.byteLength(value, "utf8") > DEFAULT_LIMITS.maxStringBytes)) {
    throw new CompanionRedactionError("invalid_known_secrets");
  }
  if (options.knownSecrets.length > MAX_KNOWN_SECRETS) {
    throw new CompanionRedactionError("too_many_known_secrets");
  }
  return limits;
}

function replaceAllLiteral(value, search) {
  return search.length === 0 ? value : value.split(search).join(REDACTED);
}

export function createCompanionRedactor(options = {}) {
  const normalizedOptions = { knownSecrets: [], ...options };
  const limits = validateConfiguration(normalizedOptions);
  const knownSecrets = [...new Set(normalizedOptions.knownSecrets)].sort((a, b) => b.length - a.length);

  function redactString(value) {
    if (Buffer.byteLength(value, "utf8") > limits.maxStringBytes) {
      throw new CompanionRedactionError("string_too_large");
    }
    let output = value;
    for (const secret of knownSecrets) output = replaceAllLiteral(output, secret);
    output = output.replace(CREDENTIAL_HEADER, (_, boundary, label) => `${boundary}${label}${REDACTED}`);
    output = output.replace(BEARER, "Bearer [REDACTED]");
    output = output.replace(JWT, REDACTED);
    output = output.replace(ASSIGNMENT, (_, key, separator) => (
      `${key}${separator}${separator === ":" ? " " : ""}${REDACTED}`
    ));
    return output;
  }

  function redactJson(value) {
    const active = new WeakSet();
    let nodes = 0;

    function visit(current, depth) {
      nodes += 1;
      if (nodes > limits.maxNodes) throw new CompanionRedactionError("node_limit_exceeded");
      if (depth > limits.maxDepth) throw new CompanionRedactionError("depth_limit_exceeded");
      if (current === null || typeof current === "boolean") return current;
      if (typeof current === "string") return redactString(current);
      if (typeof current === "number") {
        if (!Number.isFinite(current)) throw new CompanionRedactionError("non_json_number");
        return current;
      }
      if (typeof current !== "object") throw new CompanionRedactionError("unsupported_type");
      if (active.has(current)) throw new CompanionRedactionError("cycle_detected");
      if (!Array.isArray(current)) {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new CompanionRedactionError("unsupported_object");
        }
      }

      active.add(current);
      try {
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const enumerableKeys = Object.keys(descriptors).filter((key) => descriptors[key].enumerable).sort();
        if (enumerableKeys.some((key) => descriptors[key].get || descriptors[key].set)) {
          throw new CompanionRedactionError("accessor_not_allowed");
        }
        if (Array.isArray(current)) {
          if (enumerableKeys.some((key) => key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) {
            throw new CompanionRedactionError("invalid_array_property");
          }
          if (current.length + nodes > limits.maxNodes) {
            throw new CompanionRedactionError("node_limit_exceeded");
          }
          return Array.from({ length: current.length }, (_, index) => {
            const descriptor = descriptors[index];
            return descriptor ? visit(descriptor.value, depth + 1) : null;
          });
        }
        const output = {};
        for (const key of enumerableKeys) {
          output[key] = SENSITIVE_KEY.test(key) ? REDACTED : visit(descriptors[key].value, depth + 1);
        }
        return output;
      } finally {
        active.delete(current);
      }
    }

    let output;
    try {
      output = visit(value, 0);
    } catch (error) {
      if (error instanceof CompanionRedactionError) throw error;
      throw new CompanionRedactionError("reflection_failed");
    }
    let serialized;
    try {
      serialized = JSON.stringify(output);
    } catch {
      throw new CompanionRedactionError("serialization_failed");
    }
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > limits.maxOutputBytes) {
      throw new CompanionRedactionError("output_too_large");
    }
    return output;
  }

  function sanitizeForDisplay(value) {
    if (value === null) return null;
    if (typeof value !== "string") throw new CompanionRedactionError("display_value_not_string");
    const output = redactString(value);
    if (Buffer.byteLength(output, "utf8") > limits.maxOutputBytes) {
      throw new CompanionRedactionError("output_too_large");
    }
    return output;
  }

  function redactError(error) {
    if (!(error instanceof Error)) throw new CompanionRedactionError("invalid_error");
    try {
      const descriptors = Object.getOwnPropertyDescriptors(error);
      for (const key of ["name", "code", "message", "details"]) {
        if (descriptors[key]?.get || descriptors[key]?.set) {
          throw new CompanionRedactionError("accessor_not_allowed");
        }
      }
      const record = {
        name: typeof error.name === "string" ? error.name : "Error",
        ...(typeof error.code === "string" ? { code: error.code } : {}),
        message: typeof error.message === "string" ? error.message : "Error",
        ...(Object.hasOwn(error, "details") ? { details: descriptors.details?.value } : {}),
      };
      return redactJson(record);
    } catch (failure) {
      if (failure instanceof CompanionRedactionError) throw failure;
      throw new CompanionRedactionError("error_reflection_failed");
    }
  }

  return Object.freeze({ redactJson, redactError, sanitizeForDisplay });
}
