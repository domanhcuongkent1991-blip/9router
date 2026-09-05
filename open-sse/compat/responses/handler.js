import { createResponsesErrorResponse } from "./error.js";
import { validateAndNormalizeResponsesRequest } from "./request.js";

const invalidJsonResponse = () => createResponsesErrorResponse({
  status: 400,
  message: "Request body must contain valid JSON.",
  param: null,
  code: "invalid_json",
});

const initializationFailureResponse = () => createResponsesErrorResponse({
  status: 500,
  message: "The Responses adapter could not initialize.",
  param: null,
  code: "initialization_failed",
});

const dispatchFailureResponse = () => createResponsesErrorResponse({
  status: 500,
  message: "The Responses adapter failed to dispatch the request.",
  param: null,
  code: "dispatch_failed",
});

function isResponseLike(value) {
  try {
    return value !== null
      && typeof value === "object"
      && Object.prototype.toString.call(value) === "[object Response]"
      && Number.isInteger(value.status)
      && (value.status === 0 || (value.status >= 200 && value.status <= 599))
      && typeof value.headers?.get === "function"
      && typeof value.clone === "function"
      && typeof value.text === "function"
      && typeof value.arrayBuffer === "function"
      && "body" in value;
  } catch {
    return false;
  }
}

function cancelBody(value) {
  try {
    const cancellation = value?.body?.cancel?.();
    if (cancellation !== undefined) {
      void Promise.resolve(cancellation).catch(() => undefined);
    }
  } catch {
    // A failed best-effort cleanup must not replace the fixed error response.
  }
}

export function createResponsesHandler({ initialize = async () => undefined, dispatch }) {
  if (typeof initialize !== "function") throw new TypeError("initialize must be a function");
  if (typeof dispatch !== "function") throw new TypeError("dispatch must be a function");

  let initialization;

  return async function handleResponsesRequest(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return invalidJsonResponse();
    }

    const validation = validateAndNormalizeResponsesRequest(body);
    if (!validation.ok) {
      return createResponsesErrorResponse({ status: 400, ...validation.error });
    }

    try {
      initialization ??= Promise.resolve().then(initialize);
      await initialization;
    } catch {
      initialization = undefined;
      return initializationFailureResponse();
    }

    let forwardedRequest;
    try {
      const headers = new Headers(request.headers);
      headers.set("Content-Type", "application/json");
      headers.delete("Content-Length");
      forwardedRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify(validation.value),
        signal: request.signal,
      });
    } catch {
      return dispatchFailureResponse();
    }

    try {
      const response = await dispatch(forwardedRequest);
      if (!isResponseLike(response) || response.status >= 500) {
        cancelBody(response);
        return dispatchFailureResponse();
      }
      return response;
    } catch (error) {
      if (request.signal.aborted || error?.name === "AbortError") throw error;
      return dispatchFailureResponse();
    }
  };
}
