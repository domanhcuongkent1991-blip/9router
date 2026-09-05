const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

export function createResponsesErrorResponse({
  status = 400,
  message,
  param = null,
  code = "invalid_request",
}) {
  const type = status >= 500 ? "server_error" : "invalid_request_error";
  return new Response(JSON.stringify({
    error: { message, type, param, code },
  }), {
    status,
    headers: JSON_HEADERS,
  });
}
