export class AppServerProtocolError extends Error {
  constructor(reason, details = {}) {
    super("App Server protocol failure");
    this.name = "AppServerProtocolError";
    this.code = "app_server_protocol_error";
    this.details = { reason, ...details };
  }
}

function protocolError(reason, error) {
  if (error instanceof AppServerProtocolError) return error;
  return new AppServerProtocolError(reason, {
    causeType: error instanceof Error ? error.name : "UnknownError",
  });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarRemoteCode(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? value
    : undefined;
}

export function createAppServerJsonlClient({
  readable,
  writable,
  requestTimeoutMs = 5_000,
  maxLineBytes = 1_048_576,
  onNotification = () => {},
  onServerRequest = () => {
    throw new AppServerProtocolError("unexpected_server_request");
  },
  onFatal = () => {},
}) {
  let closed = false;
  let input = Buffer.alloc(0);
  let nextRequestId = 1;
  const pending = new Map();

  function removeListeners() {
    readable.off("data", handleData);
    readable.off("end", handleReadableClosed);
    readable.off("close", handleReadableClosed);
    readable.off("error", handleReadableError);
    writable.off("error", handleWritableError);
  }

  function finish(error, fatal = true) {
    if (closed) return;
    closed = true;
    input = Buffer.alloc(0);
    removeListeners();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    if (fatal) {
      try {
        Promise.resolve(onFatal(error)).catch(() => {});
      } catch {
        // Fatal reporting must never replace or expose the protocol failure.
      }
    }
  }

  function fail(reason, error) {
    finish(protocolError(reason, error));
  }

  function runCallback(callback, message) {
    try {
      Promise.resolve(callback(message)).catch((error) => fail("callback_failure", error));
    } catch (error) {
      fail("callback_failure", error);
    }
  }

  function handleMessage(message) {
    if (!isObject(message)) {
      fail("invalid_message");
      return;
    }

    const hasId = Object.hasOwn(message, "id");
    const hasMethod = Object.hasOwn(message, "method");
    if (hasMethod) {
      if (typeof message.method !== "string") {
        fail("invalid_method");
        return;
      }
      runCallback(hasId ? onServerRequest : onNotification, message);
      return;
    }

    if (!hasId) {
      fail("invalid_message");
      return;
    }
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      fail("invalid_response");
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      fail("unknown_response_id");
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (hasError) {
      const remoteCode = isObject(message.error)
        ? scalarRemoteCode(message.error.code)
        : undefined;
      const details = remoteCode === undefined ? {} : { remoteCode };
      entry.reject(new AppServerProtocolError("remote_error", details));
      return;
    }
    entry.resolve(message.result);
  }

  function handleLine(line) {
    if (line.length > maxLineBytes) {
      fail("line_too_large");
      return;
    }
    const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    let message;
    try {
      message = JSON.parse(normalized.toString("utf8"));
    } catch (error) {
      fail("invalid_json", error);
      return;
    }
    handleMessage(message);
  }

  function handleData(chunk) {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    input = input.length === 0 ? bytes : Buffer.concat([input, bytes]);

    let newline;
    while (!closed && (newline = input.indexOf(0x0a)) !== -1) {
      const line = input.subarray(0, newline);
      input = input.subarray(newline + 1);
      handleLine(line);
    }
    if (!closed && input.length > maxLineBytes) fail("line_too_large");
  }

  function handleReadableClosed() {
    fail("transport_closed");
  }

  function handleReadableError(error) {
    fail("read_failure", error);
  }

  function handleWritableError(error) {
    fail("write_failure", error);
  }

  function encode(message) {
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      throw protocolError("serialization_failure", error);
    }
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length - 1 > maxLineBytes) {
      throw new AppServerProtocolError("outgoing_line_too_large");
    }
    return bytes;
  }

  function write(message) {
    if (closed) throw new AppServerProtocolError("client_closed");
    const bytes = encode(message);
    try {
      writable.write(bytes);
    } catch (error) {
      const normalized = protocolError("write_failure", error);
      finish(normalized);
      throw normalized;
    }
  }

  function request(method, params) {
    if (closed) return Promise.reject(new AppServerProtocolError("client_closed"));
    if (typeof method !== "string") return Promise.reject(new AppServerProtocolError("invalid_method"));
    const id = nextRequestId;
    nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(new AppServerProtocolError("request_timeout"));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      try {
        write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(protocolError("write_failure", error));
      }
    });
  }

  function notify(method, params) {
    if (typeof method !== "string") throw new AppServerProtocolError("invalid_method");
    write({ method, params });
  }

  function close() {
    finish(new AppServerProtocolError("client_closed"), false);
  }

  readable.on("data", handleData);
  readable.on("end", handleReadableClosed);
  readable.on("close", handleReadableClosed);
  readable.on("error", handleReadableError);
  writable.on("error", handleWritableError);

  return Object.freeze({ request, notify, close, isClosed: () => closed });
}
