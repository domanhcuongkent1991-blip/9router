import { describe, expect, it } from "vitest";
import { validateAndNormalizeResponsesRequest } from "../../open-sse/compat/responses/request.js";

describe("Codex nullable reasoning replay", () => {
  it("accepts absent reasoning content without mutating replay input", () => {
    const reasoning = { type: "reasoning", summary: [], content: null };
    const result = validateAndNormalizeResponsesRequest({ model: "ag/gemini-3.8-flash", input: [
      reasoning,
      { type: "function_call", name: "read_marker", call_id: "call_1", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "marker" },
    ] });
    expect(result.ok).toBe(true);
    expect(result.value.input[0].content).toBeNull();
    expect(reasoning.content).toBeNull();
  });

  it.each(["invalid", 1, {}])("still rejects invalid reasoning content %j", content => {
    const result = validateAndNormalizeResponsesRequest({ model: "ag/gemini-3.8-flash",
      input: [{ type: "reasoning", summary: [], content }] });
    expect(result.ok).toBe(false);
    expect(result.error.param).toBe("input[0].content");
  });
});
