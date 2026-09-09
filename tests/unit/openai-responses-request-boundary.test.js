import { describe, expect, it } from "vitest";

async function loadRequestSubject() {
  const subject = await import("../../open-sse/compat/responses/request.js").catch(() => ({}));
  expect(subject.validateAndNormalizeResponsesRequest).toBeTypeOf("function");
  return subject;
}

const validRequest = (extra = {}) => ({
  model: "provider/model",
  input: "hello",
  ...extra,
});

describe("Responses compatibility request boundary", () => {
  it.each([
    [{ background: true }, "background"],
    [{ store: true }, "store"],
    [{ conversation: null }, "conversation"],
    [{ previous_response_id: null }, "previous_response_id"],
  ])("rejects unsupported stateful input %#", async (extra, param) => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();

    expect(validateAndNormalizeResponsesRequest(validRequest(extra))).toMatchObject({
      ok: false,
      error: { param, code: "unsupported_parameter" },
    });
  });

  it.each([
    [{ model: "provider/model" }, "input"],
    [validRequest({ input: "" }), "input"],
    [validRequest({ input: "   " }), "input"],
    [validRequest({ input: [] }), "input"],
  ])("requires non-empty input %#", async (request, param) => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    expect(validateAndNormalizeResponsesRequest(request)).toMatchObject({
      ok: false,
      error: { param, code: "invalid_value" },
    });
  });

  it("rejects input, content, and tool collections above their limits", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const message = { type: "message", role: "user", content: "x" };

    expect(validateAndNormalizeResponsesRequest(validRequest({
      input: Array.from({ length: 2_049 }, () => message),
    }))).toMatchObject({ ok: false, error: { param: "input", code: "limit_exceeded" } });

    expect(validateAndNormalizeResponsesRequest(validRequest({
      input: [{
        type: "message",
        role: "user",
        content: Array.from({ length: 8_193 }, () => ({ type: "input_text", text: "x" })),
      }],
    }))).toMatchObject({ ok: false, error: { param: "input[0].content", code: "limit_exceeded" } });

    expect(validateAndNormalizeResponsesRequest(validRequest({
      tools: Array.from({ length: 129 }, (_, index) => ({
        type: "function",
        name: `tool_${index}`,
        parameters: { type: "object" },
      })),
    }))).toMatchObject({ ok: false, error: { param: "tools", code: "limit_exceeded" } });
  });

  it("supports string instructions and rejects instruction item arrays", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();

    expect(validateAndNormalizeResponsesRequest(validRequest({ instructions: "Follow the rules." }))).toMatchObject({
      ok: true,
      value: { instructions: "Follow the rules." },
    });
    expect(validateAndNormalizeResponsesRequest(validRequest({ instructions: [] }))).toMatchObject({
      ok: false,
      error: { param: "instructions", code: "invalid_type" },
    });
  });

  it.each([
    [[{ type: "input_image", image_url: "https://example.com/image.png" }], "input[0].type"],
    [[{ type: "hosted_future_call" }], "input[0].type"],
    [[{ type: "message", role: "owner", content: "hello" }], "input[0].role"],
    [[{ type: "message", role: "user", content: [{ type: "input_audio", audio: "abc" }] }], "input[0].content[0].type"],
    [[{ type: "message", role: "user", content: [{ type: "input_text" }] }], "input[0].content[0].text"],
  ])("rejects unsupported or malformed input items %#", async (input, param) => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    expect(validateAndNormalizeResponsesRequest(validRequest({ input }))).toMatchObject({
      ok: false,
      error: { param },
    });
  });

  it("accepts HTTP(S) and valid image data URIs but rejects file-backed or malformed images", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const request = validRequest({
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "https://example.com/image.png" },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      }],
    });

    expect(validateAndNormalizeResponsesRequest(request).ok).toBe(true);
    expect(validateAndNormalizeResponsesRequest(validRequest({
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://" }] }],
    }))).toMatchObject({ ok: false, error: { param: "input[0].content[0].image_url" } });
    expect(validateAndNormalizeResponsesRequest(validRequest({
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,***" }] }],
    }))).toMatchObject({ ok: false, error: { param: "input[0].content[0].image_url" } });
    expect(validateAndNormalizeResponsesRequest(validRequest({
      input: [{ type: "message", role: "user", content: [{ type: "input_image", file_id: "file_secret" }] }],
    }))).toMatchObject({ ok: false, error: { param: "input[0].content[0].file_id", code: "unsupported_parameter" } });
  });

  it("normalizes tool history without mutation and preserves explicit JSON primitives", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const longCallId = `call_${"x".repeat(80)}`;
    const request = validRequest({
      input: [
        { type: "function_call", call_id: longCallId, name: "lookup", arguments: null },
        { type: "function_call_output", call_id: longCallId, output: 0 },
        { type: "custom_tool_call", call_id: "custom_1", name: "exec", input: false },
        { type: "custom_tool_call_output", call_id: "custom_1", output: null },
      ],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });
    const original = structuredClone(request);

    const result = validateAndNormalizeResponsesRequest(request);

    expect(result.ok).toBe(true);
    expect(result.value.store).toBe(false);
    expect(result.value.input[0].call_id).toHaveLength(64);
    expect(result.value.input[1].call_id).toBe(result.value.input[0].call_id);
    expect(result.value.input[0].arguments).toBe("null");
    expect(result.value.input[1].output).toBe("0");
    expect(result.value.input[2].input).toBe("false");
    expect(result.value.input[3].output).toBe("null");
    expect(result.value).not.toBe(request);
    expect(result.value.input).not.toBe(request.input);
    expect(request).toEqual(original);
  });

  it.each([null, []])("accepts reasoning content %# and preserves reasoning metadata without mutation", async (content) => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const reasoning = {
      type: "reasoning",
      content,
      summary: [{ type: "summary_text", text: "brief rationale" }],
      encrypted_content: "opaque-reasoning-payload",
    };
    const request = validRequest({ input: [reasoning] });
    const original = structuredClone(request);

    const result = validateAndNormalizeResponsesRequest(request);

    expect(result).toMatchObject({
      ok: true,
      value: {
        input: [{
          type: "reasoning",
          content,
          summary: [{ type: "summary_text", text: "brief rationale" }],
          encrypted_content: "opaque-reasoning-payload",
        }],
      },
    });
    expect(result.value.input[0]).not.toBe(reasoning);
    expect(result.value.input[0].summary).not.toBe(reasoning.summary);
    if (Array.isArray(content)) expect(result.value.input[0].content).not.toBe(content);
    expect(request).toEqual(original);
  });

  it.each(["not-an-array", { text: "not-an-array" }])("rejects reasoning content with invalid type %#", async (content) => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();

    expect(validateAndNormalizeResponsesRequest(validRequest({
      input: [{ type: "reasoning", content }],
    }))).toMatchObject({
      ok: false,
      error: { param: "input[0].content", code: "invalid_type" },
    });
  });

  it("rejects distinct call identifiers that collide after clamping", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const prefix = "x".repeat(64);
    const result = validateAndNormalizeResponsesRequest(validRequest({
      input: [
        { type: "function_call", call_id: `${prefix}a`, name: "one", arguments: "{}" },
        { type: "function_call", call_id: `${prefix}b`, name: "two", arguments: "{}" },
      ],
    }));

    expect(result).toMatchObject({
      ok: false,
      error: { param: "input[1].call_id", code: "call_id_collision" },
    });
  });

  it("validates function/custom tools and preserves supported tool choices", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();

    for (const toolChoice of ["auto", "none", "required", { type: "function", name: "lookup" }, { type: "custom", name: "exec" }]) {
      const result = validateAndNormalizeResponsesRequest(validRequest({ tool_choice: toolChoice }));
      expect(result.ok).toBe(true);
      expect(result.value.tool_choice).toEqual(toolChoice);
    }

    expect(validateAndNormalizeResponsesRequest(validRequest({ tool_choice: "sometimes" }))).toMatchObject({
      ok: false,
      error: { param: "tool_choice", code: "invalid_value" },
    });
    expect(validateAndNormalizeResponsesRequest(validRequest({ tool_choice: { type: "function", name: "" } }))).toMatchObject({
      ok: false,
      error: { param: "tool_choice.name" },
    });
    expect(validateAndNormalizeResponsesRequest(validRequest({
      tools: [{ type: "function", name: "lookup", parameters: "not-a-schema" }],
    }))).toMatchObject({ ok: false, error: { param: "tools[0].parameters", code: "invalid_type" } });
  });

  it("accepts Codex namespace tools containing function tools", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const namespaceTool = {
      type: "namespace",
      name: "mcp__example",
      description: "Example MCP tools",
      tools: [{
        type: "function",
        name: "lookup",
        description: "Look up a value",
        parameters: { type: "object", properties: { id: { type: "string" } } },
      }],
    };

    expect(validateAndNormalizeResponsesRequest(validRequest({ tools: [namespaceTool] }))).toMatchObject({
      ok: true,
      value: {
        tools: [{
          type: "namespace",
          name: "mcp__example",
          tools: [{ type: "function", name: "lookup" }],
        }],
      },
    });
  });

  it("accepts a namespace-qualified function choice but rejects selecting an entire namespace", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const functionChoice = {
      type: "function",
      name: "lookup",
      namespace: "mcp__example",
    };

    expect(validateAndNormalizeResponsesRequest(validRequest({
      tool_choice: functionChoice,
    }))).toMatchObject({ ok: true, value: { tool_choice: functionChoice } });

    expect(validateAndNormalizeResponsesRequest(validRequest({
      tool_choice: { type: "namespace", name: "mcp__example" },
    }))).toMatchObject({
      ok: false,
      error: { param: "tool_choice.type", code: "unsupported_parameter" },
    });
  });

  it("allows a larger bounded namespace while keeping flat tool limits", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const namespaceTools = Array.from({ length: 129 }, (_, index) => ({
      type: "function",
      name: `lookup_${index}`,
      parameters: { type: "object", properties: {} },
    }));

    expect(validateAndNormalizeResponsesRequest(validRequest({
      tools: [{ type: "namespace", name: "mcp__example", tools: namespaceTools }],
    }))).toMatchObject({ ok: true });

    expect(validateAndNormalizeResponsesRequest(validRequest({
      tools: namespaceTools,
    }))).toMatchObject({ ok: false, error: { param: "tools", code: "limit_exceeded" } });
  });

  it("counts additional tools against the aggregate namespace limit without reapplying the flat limit", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const namespaceTools = Array.from({ length: 129 }, (_, index) => ({
      type: "function",
      name: `lookup_${index}`,
      parameters: { type: "object", properties: {} },
    }));

    expect(validateAndNormalizeResponsesRequest(validRequest({
      tools: [{ type: "namespace", name: "mcp__example", tools: namespaceTools }],
      input: [
        { role: "user", content: "hello" },
        {
          type: "additional_tools",
          tools: Array.from({ length: 128 }, (_, index) => ({
            type: "function",
            name: `late_bound_tool_${index}`,
            parameters: { type: "object", properties: {} },
          })),
        },
      ],
    }))).toMatchObject({ ok: true });
  });

  it("accepts Codex additional_tools while enforcing the aggregate tool limit", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const customTool = { type: "custom", name: "exec", format: { type: "grammar" } };

    expect(validateAndNormalizeResponsesRequest(validRequest({
      input: [{ type: "additional_tools", role: "developer", tools: [customTool] }],
      client_metadata: { originator: "codex_cli_rs" },
    }))).toMatchObject({
      ok: true,
      value: { input: [{ tools: [{ name: "exec" }] }] },
    });

    expect(validateAndNormalizeResponsesRequest(validRequest({
      tools: Array.from({ length: 128 }, (_, index) => ({ type: "function", name: `tool_${index}` })),
      input: [{ type: "additional_tools", role: "developer", tools: [customTool] }],
    }))).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });

  it("does not disclose rejected request values in a composed error response", async () => {
    const { validateAndNormalizeResponsesRequest } = await loadRequestSubject();
    const { createResponsesErrorResponse } = await import("../../open-sse/compat/responses/error.js");
    const secret = "file-sk-secret-sentinel";
    const validation = validateAndNormalizeResponsesRequest(validRequest({
      input: [{ type: "message", role: "user", content: [{ type: "input_image", file_id: secret }] }],
      client_metadata: { authorization: `Bearer ${secret}` },
    }));

    expect(validation.ok).toBe(false);
    const response = createResponsesErrorResponse({ status: 400, ...validation.error });
    expect(await response.text()).not.toContain(secret);
  });
});
