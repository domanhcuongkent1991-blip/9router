// Spec compliance for the OpenAI Responses emitter: response.completed must
// carry the finalized output array + usage, and output items must expose
// lifecycle status — the signals spec-strict parsers use to finalize tool
// calls. Covers both live emitters (stream transformer + translator registry).
import { describe, it, expect } from "vitest";

import { createResponsesApiTransformStream } from "../../open-sse/transformer/responsesTransformer.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { buildResponsesCompleted, responsesUsageFromChat } from "../../open-sse/utils/responsesTerminal.js";

function chatChunk(delta, extra = {}) {
  return { id: "chatcmpl_1", choices: [{ index: 0, delta, ...extra }] };
}

const TOOL_CALL_START = { index: 0, id: "call_1", type: "function", function: { name: "exec_command", arguments: "" } };
const TOOL_CALL_ARGS = { index: 0, function: { arguments: '{"cmd":"ls"}' } };
const UPSTREAM_USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 4 };
const EXPECTED_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 4 },
};

async function runTransformer(chunks) {
  const stream = createResponsesApiTransformStream(null);
  const writer = stream.writable.getWriter();
  const collected = [];
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";
      for (const message of messages) {
        const eventMatch = message.match(/^event:\s*(.+)$/m);
        const dataMatch = message.match(/^data:\s*(.+)$/m);
        if (!eventMatch || !dataMatch || dataMatch[1].trim() === "[DONE]") continue;
        collected.push({ event: eventMatch[1].trim(), data: JSON.parse(dataMatch[1]) });
      }
    }
  })();
  const encoder = new TextEncoder();
  for (const chunk of chunks) {
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }
  await writer.write(encoder.encode("data: [DONE]\n\n"));
  await writer.close();
  await readAll;
  return collected;
}

function runTranslator(chunks) {
  // Production wires the forward translator with the openai-responses state
  // (responsesHandler passes sourceFormatOverride), so mirror that here.
  const state = { ...initState(FORMATS.OPENAI_RESPONSES) };
  const events = [];
  for (const chunk of chunks) {
    events.push(...openaiToOpenAIResponsesResponse(chunk, state));
  }
  events.push(...openaiToOpenAIResponsesResponse(null, state));
  return events;
}

function assertSpecCompliance(events) {
  const byType = (type) => events.filter((entry) => entry.data?.type === type || entry.event === type);

  const addedMessages = byType("response.output_item.added");
  expect(addedMessages.length).toBeGreaterThan(0);
  for (const entry of addedMessages) {
    expect(entry.data.item.status).toBe("in_progress");
  }

  const doneItems = byType("response.output_item.done");
  expect(doneItems.length).toBeGreaterThan(0);
  for (const entry of doneItems) {
    expect(entry.data.item.status).toBe("completed");
  }

  const completions = byType("response.completed");
  expect(completions).toHaveLength(1);
  return completions[0].data.response;
}

describe("Responses emitter spec compliance (transformer path)", () => {
  it("finalizes tool calls with status and a spec-shaped response.completed", async () => {
    const events = await runTransformer([
      chatChunk({ role: "assistant", content: "Hello" }),
      chatChunk({ tool_calls: [TOOL_CALL_START] }),
      chatChunk({ tool_calls: [TOOL_CALL_ARGS] }),
      // Usage bundled into the final choices chunk: the pipeline terminates
      // the client response at finish_reason, so later chunks cannot
      // contribute to response.completed.
      { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: UPSTREAM_USAGE },
    ]);

    const response = assertSpecCompliance(events);
    expect(response.status).toBe("completed");
    expect(response.output).toHaveLength(2);
    expect(response.output.map((item) => item.type)).toEqual(["message", "function_call"]);
    const call = response.output[1];
    expect(call.status).toBe("completed");
    expect(call.call_id).toBe("call_1");
    expect(call.arguments).toBe('{"cmd":"ls"}');
    expect(response.usage).toEqual(EXPECTED_USAGE);
  });

  it("omits usage when the upstream stream carries none", async () => {
    const events = await runTransformer([
      chatChunk({ role: "assistant", content: "Hello" }),
      chatChunk({}, { finish_reason: "stop" }),
    ]);
    const response = assertSpecCompliance(events);
    expect(Object.hasOwn(response, "usage")).toBe(false);
  });

  it("synthesizes a completed response from flushed items when finish_reason never arrives", async () => {
    const events = await runTransformer([
      chatChunk({ role: "assistant", content: "partial" }),
      { id: "chatcmpl_1", choices: [], usage: UPSTREAM_USAGE },
    ]);
    const response = assertSpecCompliance(events);
    expect(response.output).toHaveLength(1);
    expect(response.output[0].status).toBe("completed");
    expect(response.usage).toEqual(EXPECTED_USAGE);
  });
});

describe("Responses emitter spec compliance (translator path)", () => {
  it("finalizes tool calls with status and a spec-shaped response.completed", () => {
    const events = runTranslator([
      chatChunk({ role: "assistant", content: "Hello" }),
      chatChunk({ tool_calls: [TOOL_CALL_START] }),
      chatChunk({ tool_calls: [TOOL_CALL_ARGS] }),
      { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: UPSTREAM_USAGE },
    ]);

    const response = assertSpecCompliance(events);
    expect(response.status).toBe("completed");
    expect(response.output).toHaveLength(2);
    expect(response.output[1].type).toBe("function_call");
    expect(response.output[1].status).toBe("completed");
    expect(response.output[1].arguments).toBe('{"cmd":"ls"}');
    expect(response.usage).toEqual(EXPECTED_USAGE);
  });

  it("omits usage when the upstream stream carries none", () => {
    const events = runTranslator([
      chatChunk({ role: "assistant", content: "Hello" }),
      chatChunk({}, { finish_reason: "stop" }),
    ]);
    const response = assertSpecCompliance(events);
    expect(Object.hasOwn(response, "usage")).toBe(false);
  });

  it("flushes a completed response when the stream ends without finish_reason", () => {
    const events = runTranslator([chatChunk({ role: "assistant", content: "partial" })]);
    const response = assertSpecCompliance(events);
    expect(response.output).toHaveLength(1);
    expect(response.output[0].status).toBe("completed");
  });
});

describe("responsesTerminal helpers", () => {
  it("orders the output array by output index regardless of completion order", () => {
    const completed = buildResponsesCompleted({
      responseId: "resp_1",
      created: 123,
      outputItems: [
        { outputIndex: 2, item: { type: "function_call", call_id: "c" } },
        { outputIndex: 0, item: { type: "reasoning" } },
      ],
      usage: null,
    });
    expect(completed.response.output.map((item) => item.type)).toEqual(["reasoning", "function_call"]);
    expect(Object.hasOwn(completed.response, "usage")).toBe(false);
  });

  it("maps chat usage to the responses shape and rejects empty usage", () => {
    expect(responsesUsageFromChat(UPSTREAM_USAGE)).toEqual(EXPECTED_USAGE);
    expect(responsesUsageFromChat(null)).toBeUndefined();
    expect(responsesUsageFromChat({})).toBeUndefined();
    expect(responsesUsageFromChat({ prompt_tokens: "7", completion_tokens: 3 })).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
    });
  });
});
