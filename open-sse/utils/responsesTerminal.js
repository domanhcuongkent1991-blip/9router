// Shared helpers for OpenAI Responses API output item status and the terminal
// response.completed event. Used by both the streaming transformer
// (transformer/responsesTransformer.js) and the translator registry
// (translator/response/openai-responses.js) so the two emitters cannot drift
// apart on the wire contract.
import { normalizeUsage } from "./usageTracking.js";

const ITEM_STATUS = Object.freeze({ added: "in_progress", done: "completed" });

// OpenAI Responses items carry a lifecycle status; codex and spec-strict
// clients key tool-call finalization off the completed state.
export function withItemStatus(item, phase) {
  const status = ITEM_STATUS[phase];
  if (!status || item === null || typeof item !== "object") return item;
  return { ...item, status };
}

// Map a Chat Completions usage object onto the Responses API usage shape.
// Returns undefined when the upstream stream carried no usage so callers can
// omit the field entirely instead of fabricating zero counts.
export function responsesUsageFromChat(chatUsage) {
  const normalized = normalizeUsage(chatUsage);
  if (!normalized) return undefined;

  const usage = {};
  const inputTokens = normalized.prompt_tokens;
  const outputTokens = normalized.completion_tokens;
  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.total_tokens = normalized.total_tokens ?? (inputTokens ?? 0) + (outputTokens ?? 0);
  }

  const inputDetails = {};
  if (normalized.cached_tokens !== undefined) inputDetails.cached_tokens = normalized.cached_tokens;
  else if (normalized.prompt_tokens_details?.cached_tokens !== undefined) {
    inputDetails.cached_tokens = normalized.prompt_tokens_details.cached_tokens;
  }
  if (Object.keys(inputDetails).length > 0) usage.input_tokens_details = inputDetails;

  const outputDetails = {};
  if (normalized.reasoning_tokens !== undefined) outputDetails.reasoning_tokens = normalized.reasoning_tokens;
  else if (normalized.completion_tokens_details?.reasoning_tokens !== undefined) {
    outputDetails.reasoning_tokens = normalized.completion_tokens_details.reasoning_tokens;
  }
  if (Object.keys(outputDetails).length > 0) usage.output_tokens_details = outputDetails;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

// Build the terminal response.completed event. outputItems entries are
// { outputIndex, item } pairs where item is the final output_item.done payload;
// the response.output array is ordered by output index per the spec.
export function buildResponsesCompleted({ responseId, created, outputItems = [], usage }) {
  const output = outputItems
    .map((entry, position) => ({
      index: Number.isFinite(entry?.outputIndex) ? entry.outputIndex : position,
      item: entry?.item,
    }))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.item);

  const responseUsage = responsesUsageFromChat(usage);
  return {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: created,
      status: "completed",
      background: false,
      error: null,
      output,
      ...(responseUsage ? { usage: responseUsage } : {}),
    },
  };
}
