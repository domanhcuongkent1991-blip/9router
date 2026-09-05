import { describe, expect, it } from "vitest";

import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState, translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";
import { handleForcedSSEToJson } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";

const namespaceTool = {
  type: "namespace",
  name: "mcp__example",
  description: "Example MCP tools",
  tools: [{
    type: "function",
    name: "lookup",
    description: "Look up a value",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  }],
};

describe("Responses namespace tool compatibility", () => {
  it("flattens namespace tools for Chat providers and records a reversible mapping", () => {
    const out = openaiResponsesToOpenAIRequest("gemini", {
      input: "Use the lookup tool",
      tools: [namespaceTool],
      stream: true,
    });

    expect(out.tools).toHaveLength(1);
    expect(out.tools[0]).toMatchObject({
      type: "function",
      function: {
        description: expect.stringContaining("Example MCP tools"),
        parameters: namespaceTool.tools[0].parameters,
      },
    });

    const alias = out.tools[0].function.name;
    expect(alias).toMatch(/^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/);
    expect(out._namespaceToolMap).toEqual({
      [alias]: {
        namespace: "mcp__example",
        name: "lookup",
        type: "function",
      },
    });
  });

  it("maps namespace-qualified tool choices to their flattened alias", () => {
    const out = openaiResponsesToOpenAIRequest("gemini", {
      input: "Use the lookup tool",
      tools: [namespaceTool],
      tool_choice: {
        type: "function",
        name: "lookup",
        namespace: "mcp__example",
      },
    });

    const alias = out.tools[0].function.name;
    expect(out.tool_choice).toEqual({
      type: "function",
      function: { name: alias },
    });
  });

  it("preserves extension fields on already Chat-shaped function tools", () => {
    const chatTool = {
      type: "function",
      x_provider_tool: "keep",
      function: {
        name: "search",
        description: "Search values",
        parameters: { type: "object", properties: {} },
        strict: true,
        x_provider_function: { mode: "native" },
      },
    };

    const out = openaiResponsesToOpenAIRequest("gemini", {
      input: "Search",
      tools: [chatTool],
    });

    expect(out.tools).toEqual([chatTool]);
  });

  it("restores namespace metadata on streamed function calls", () => {
    const alias = "mcp__example__lookup_12345678";
    const state = initState("openai-responses");
    state.namespaceToolMap = {
      [alias]: { namespace: "mcp__example", name: "lookup", type: "function" },
    };

    const events = openaiToOpenAIResponsesResponse({
      id: "chatcmpl-test",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: alias, arguments: '{"id":"42"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }, state);

    const added = events.find((event) => event.event === "response.output_item.added");
    const done = events.find((event) => event.event === "response.output_item.done");
    expect(added.data.item).toMatchObject({
      type: "function_call",
      name: "lookup",
      namespace: "mcp__example",
    });
    expect(done.data.item).toMatchObject({
      type: "function_call",
      name: "lookup",
      namespace: "mcp__example",
    });
  });

  it("threads namespace mappings through the streaming adapter", async () => {
    const alias = "mcp__example__lookup_12345678";
    const input = [
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: alias, arguments: '{"id":"42"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(input));
        controller.close();
      },
    }).pipeThrough(createSSETransformStreamWithLogger(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      "antigravity",
      null,
      null,
      "gemini",
      null,
      null,
      null,
      null,
      null,
      { [alias]: { namespace: "mcp__example", name: "lookup", type: "function" } },
    ));

    let output = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
    output += decoder.decode();

    expect(output).toContain('"name":"lookup"');
    expect(output).toContain('"namespace":"mcp__example"');
  });

  it("restores namespace metadata on non-streaming function calls", () => {
    const alias = "mcp__example__lookup_12345678";
    const output = translateNonStreamingResponse({
      id: "chatcmpl-test",
      model: "gemini",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: alias, arguments: '{"id":"42"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, {
      [alias]: { namespace: "mcp__example", name: "lookup", type: "function" },
    });

    expect(output.output[0]).toMatchObject({
      type: "function_call",
      name: "lookup",
      namespace: "mcp__example",
    });
  });

  it("classifies custom tools when metadata arrives as the translated array", () => {
    const output = translateNonStreamingResponse({
      id: "chatcmpl-custom",
      model: "gemini",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_exec",
            type: "function",
            function: { name: "exec", arguments: '{"input":"return 1;"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }, FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, ["exec"]);

    expect(output.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      input: "return 1;",
    });
  });

  it("classifies custom tools on the forced-SSE JSON path", async () => {
    const providerResponse = new Response([
      'data: {"id":"chatcmpl-custom","model":"gemini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_exec","type":"function","function":{"name":"exec","arguments":"{\\"input\\":\\"return 1;\\"}"}}]},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });

    const result = await handleForcedSSEToJson({
      providerResponse,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      targetFormat: FORMATS.OPENAI,
      provider: "openai",
      model: "gemini",
      body: { model: "gemini", input: "run" },
      stream: false,
      translatedBody: null,
      finalBody: null,
      requestStartTime: Date.now(),
      connectionId: "test",
      apiKey: null,
      clientRawRequest: { endpoint: "/v1/responses" },
      onRequestSuccess: null,
      customToolNames: ["exec"],
      namespaceToolMap: null,
      trackDone: () => {},
      appendLog: () => {},
      reqTag: "test",
      log: null,
    });

    expect(result.success).toBe(true);
    expect((await result.response.json()).output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
    });
  });

  it("preserves namespace mappings while translating through Gemini format", () => {
    const translated = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.GEMINI,
      "gemini-3.8-flash",
      {
        model: "gemini-3.8-flash",
        input: "Use the lookup tool",
        tools: [namespaceTool],
        stream: true,
      },
      true,
      {},
      "ag",
    );

    expect(translated._namespaceToolMap).toBeDefined();
    const [alias] = Object.keys(translated._namespaceToolMap);
    expect(translated._namespaceToolMap).toEqual({
      [alias]: {
        namespace: "mcp__example",
        name: "lookup",
        type: "function",
      },
    });
  });
});
