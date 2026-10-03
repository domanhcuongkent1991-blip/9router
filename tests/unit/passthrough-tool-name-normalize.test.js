/**
 * Passthrough tool-name normalization — handler-level guard tests.
 *
 * Regression guards for the "Tool not found: bash/read" incident: models
 * that emit wrong-case tool names (e.g. oc/space-bunny-free emitting
 * "bash" for a client-declared "Bash") must get their tool_calls rewritten
 * to the client's canonical spelling on the OpenAI→OpenAI passthrough
 * path, in both streaming and non-streaming responses. Chunks whose names
 * are already correct must keep flowing through as untouched bytes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const CLIENT_TOOLS = [
  { type: "function", function: { name: "Bash", description: "run a command" } },
  { type: "function", function: { name: "Read", description: "read a file" } },
];

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function pumpThroughPassthrough(lines, body) {
  const stream = createPassthroughStreamWithLogger("openai", null, "gpt-x", "test-conn", body, null, null);
  const encoder = new TextEncoder();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writePromise = (async () => {
    for (const line of lines) await writer.write(encoder.encode(line));
    await writer.close();
  })();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await writePromise;
  return text;
}

describe("passthrough streaming tool-name normalization", () => {
  const body = { model: "gpt-x", stream: true, tools: CLIENT_TOOLS };

  it("rewrites a wrong-case tool name in streaming tool_calls back to the client spelling", async () => {
    const out = await pumpThroughPassthrough([
      sseLine({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: "" } }] } }] }),
      "data: [DONE]\n\n",
    ], body);
    expect(out).toContain('"name":"Bash"');
    expect(out).not.toContain('"name":"bash"');
    expect(out).toContain("data: [DONE]");
  });

  it("rewrites names in every parallel tool call delta", async () => {
    const out = await pumpThroughPassthrough([
      sseLine({ id: "chatcmpl-2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "call-a", type: "function", function: { name: "read", arguments: "" } },
        { index: 1, id: "call-b", type: "function", function: { name: "bash", arguments: "" } },
      ] } }] }),
      "data: [DONE]\n\n",
    ], body);
    expect(out).toContain('"name":"Read"');
    expect(out).toContain('"name":"Bash"');
  });

  it("keeps already-correct chunks byte-identical to the upstream line", async () => {
    // object/created are present so the router's own field injection stays
    // out of the way — with nothing to rewrite, the chunk must pass through
    // without re-serialization.
    const raw = sseLine({ id: "chatcmpl-3", object: "chat.completion.chunk", created: 1234567890, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "Bash", arguments: "" } }] } }] });
    const out = await pumpThroughPassthrough([raw, "data: [DONE]\n\n"], body);
    expect(out).toContain(raw);
  });
});

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
  pipeWithDisconnect: vi.fn(),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("non-streaming passthrough tool-name normalization", () => {
  function makeOptions() {
    const body = {
      model: "gpt-x",
      stream: false,
      tools: CLIENT_TOOLS,
      messages: [{ role: "user", content: "list the files" }],
    };
    return {
      body,
      // Provider id không có trong registry: forceStream undefined (không ép
      // streaming như provider "openai" thật) và targetFormat fallback "openai"
      // → request non-streaming đi đúng nhánh handleNonStreamingResponse.
      modelInfo: { provider: "p-test-x", model: "gpt-x" },
      credentials: { apiKey: "sk-test", providerSpecificData: {} },
      connectionId: "test-conn",
      headroomEnabled: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body,
        headers: { accept: "application/json" },
      },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  }

  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-n1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-n1", type: "function", function: { name: "read", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("rewrites a wrong-case tool name in the non-streaming response", async () => {
    const res = await handleChatCore(makeOptions());
    expect(res).toBeTruthy();
    const payload = res && typeof res.json === "function" ? res : res?.response;
    const body = await payload.json();
    const calls = body?.choices?.[0]?.message?.tool_calls;
    expect(Array.isArray(calls)).toBe(true);
    expect(calls[0].function.name).toBe("Read");
  });
});
