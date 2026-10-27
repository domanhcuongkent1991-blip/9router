import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// ZCode reads cache hits from `prompt_tokens_details.cached_tokens` on the final
// chat-completions chunk. For claude-transport upstreams (minimax-code-global
// /v1/messages, kiro, ...) the translator folds upstream cache into that nested
// field — but the finish-chunk branch in stream.js overwrites item.usage with a
// filtered flat state.usage, whose `cache_read_input_tokens` field is not in the
// OpenAI field whitelist. The client then reports cache=0 while upstream keeps
// hitting cache (~50% on a long agent session, 9Router DB 2026-10-27).

async function runTransform(targetFormat, sourceFormat, lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines.join("\n")));
      controller.close();
    },
  });

  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(targetFormat, sourceFormat, "test", null, null, "test-model"),
  );

  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseDataEvents(text) {
  return text
    .split("\n\n")
    .map((block) => block.match(/^data: (.+)$/m)?.[1])
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

const sse = (data) => [`data: ${JSON.stringify(data)}`, ""];
const claudeSse = (data) => [`event: ${data.type}`, `data: ${JSON.stringify(data)}`, ""];

const claudeEventsWithCache = [
  ...claudeSse({
    type: "message_start",
    message: {
      id: "msg_1", type: "message", role: "assistant", model: "MiniMax-M3.1-Flash", content: [],
      usage: { input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0, output_tokens: 1 },
    },
  }),
  ...claudeSse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ...claudeSse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
  ...claudeSse({ type: "content_block_stop", index: 0 }),
  ...claudeSse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } }),
  ...claudeSse({ type: "message_stop" }),
];

describe("finish-chunk usage cache for OpenAI chat clients", () => {
  it("keeps prompt_tokens_details.cached_tokens from a claude-transport upstream", async () => {
    const chunks = parseDataEvents(await runTransform(FORMATS.CLAUDE, FORMATS.OPENAI, claudeEventsWithCache));

    const withUsage = chunks.filter((chunk) => chunk.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0].usage).toMatchObject({
      // 1000 input + 200 cache-read = 1200, reported unbuffered (phase 2:
      // the anti-context-overflow buffer no longer inflates client usage)
      prompt_tokens: 1200,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 200 },
    });
  });

  it("reports unbuffered usage for an openai-transport finish chunk that carries usage", async () => {
    const chunks = parseDataEvents(await runTransform(FORMATS.OPENAI, FORMATS.OPENAI, [
      ...sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Hi" } }] }),
      ...sse({
        id: "c1", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, cached_tokens: 100 },
      }),
      "data: [DONE]",
      "",
    ]));

    const withUsage = chunks.filter((chunk) => chunk.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0].usage).toMatchObject({
      prompt_tokens: 300,
      completion_tokens: 20,
      cached_tokens: 100,
    });
  });

  it("keeps flat cached_tokens from an openai-transport upstream through the buffer", async () => {
    const chunks = parseDataEvents(await runTransform(FORMATS.OPENAI, FORMATS.OPENAI, [
      ...sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] }),
      ...sse({
        id: "c1", object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, cached_tokens: 100 },
      }),
      "data: [DONE]",
      "",
    ]));

    const withUsage = chunks.filter((chunk) => chunk.usage);
    expect(withUsage).toHaveLength(1);
    // Trailing usage-only chunks pass through untouched (no buffer): guard that
    // flat cached_tokens survives the pipeline for same-format upstreams.
    expect(withUsage[0].usage).toMatchObject({
      prompt_tokens: 300,
      completion_tokens: 20,
      cached_tokens: 100,
    });
  });
});
