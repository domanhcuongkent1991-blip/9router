/**
 * Upstream Responses APIs (OpenAI + opencode.ai) require max_output_tokens >= 16.
 * Agentic clients send small max_tokens for auxiliary calls (chat title/summary
 * generation); pass-through produced a 400 invalid_request_error.
 * https://platform.openai.com/docs/api-reference/responses/create#responses-create-max_output_tokens
 */
import { describe, it, expect } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

describe("openai→responses: max_output_tokens clamped to upstream minimum 16", () => {
  const base = { messages: [{ role: "user", content: "hi" }] };

  it("clamps small max_tokens up to 16", () => {
    const out = openaiToOpenAIResponsesRequest("muse-spark-1.3", { ...base, max_tokens: 8 }, true, null);
    expect(out.max_output_tokens).toBe(16);
  });

  it("clamps small max_completion_tokens up to 16", () => {
    const out = openaiToOpenAIResponsesRequest("muse-spark-1.3", { ...base, max_completion_tokens: 3 }, true, null);
    expect(out.max_output_tokens).toBe(16);
  });

  it("clamps small direct max_output_tokens up to 16", () => {
    const out = openaiToOpenAIResponsesRequest("muse-spark-1.3", { ...base, max_output_tokens: 1 }, true, null);
    expect(out.max_output_tokens).toBe(16);
  });

  it("leaves values >= 16 untouched", () => {
    const out = openaiToOpenAIResponsesRequest("muse-spark-1.3", { ...base, max_tokens: 500 }, true, null);
    expect(out.max_output_tokens).toBe(500);
  });
});
