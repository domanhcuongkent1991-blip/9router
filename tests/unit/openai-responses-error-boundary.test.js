import { describe, expect, it } from "vitest";

async function loadSubject() {
  return import("../../open-sse/compat/responses/error.js").catch(() => ({}));
}

describe("Responses compatibility error boundary", () => {
  it("returns an OpenAI-shaped client error", async () => {
    const subject = await loadSubject();
    expect(subject.createResponsesErrorResponse).toBeTypeOf("function");

    const response = subject.createResponsesErrorResponse({
      status: 400,
      message: "This parameter is not supported by the local adapter.",
      param: "previous_response_id",
      code: "unsupported_parameter",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: {
        message: "This parameter is not supported by the local adapter.",
        type: "invalid_request_error",
        param: "previous_response_id",
        code: "unsupported_parameter",
      },
    });
  });

  it("uses a server error type for unexpected internal failures", async () => {
    const { createResponsesErrorResponse } = await loadSubject();
    expect(createResponsesErrorResponse).toBeTypeOf("function");

    const response = createResponsesErrorResponse({
      status: 500,
      message: "The Responses adapter failed.",
      param: null,
      code: "internal_error",
    });

    expect(await response.json()).toEqual({
      error: {
        message: "The Responses adapter failed.",
        type: "server_error",
        param: null,
        code: "internal_error",
      },
    });
  });
});
