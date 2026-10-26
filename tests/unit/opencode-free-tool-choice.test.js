import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

// Muse Spark 1.3-contributor-free died upstream (410 deprecated, 2026-10-26)
// and its forceAutoToolChoiceModels quirk was removed with the model. These
// guards keep the still-true invariants of the free lane: the fingerprint
// tool append fills an absent choice with "auto", and nothing demotes a
// client's explicit named choice on live models.
const CREDS = { connectionId: "opencode-free-tool-choice-test" };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
const TOOLS = [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: {} } }];

function responsesBody(model, tool_choice) {
  const body = { model, input: structuredClone(INPUT), tools: structuredClone(TOOLS) };
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  return body;
}

describe("opencode Free tool_choice (muse 1.3 retired)", () => {
  it("registry no longer carries the retired quirk", () => {
    expect(PROVIDERS.opencode.quirks?.forceAutoToolChoiceModels).toBeUndefined();
  });

  it.each([
    ["retired 1.2-Free id", "muse-spark-1.2-contributor-free"],
    ["future 1.4-Free", "muse-spark-1.4-contributor-free"],
    ["Go id", "muse-spark-1.3-contributor"],
    ["non-Muse", "big-pickle"],
  ])("không đổi tool_choice của %s", (_label, model) => {
    const choice = { type: "function", name: "get_weather" };
    const body = responsesBody(model, structuredClone(choice));
    const out = new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
    expect(out.tool_choice).toEqual(choice);
  });
});
