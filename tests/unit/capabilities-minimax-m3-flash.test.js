import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// MiniMax's models endpoint reports MiniMax-M3.1-Flash with a 512K default
// context window (1M is an opt-in higher_usage tier) and 128K max output.
// The GA id "MiniMax-M3.1-Flash" used to miss the exact
// "MiniMax-M3.1-Flash-Preview" entry and fall through the *minimax-m3* wildcard,
// which declares 1M — so clients (ZCode) never compacted and requests climbed
// toward the real 512K ceiling (session 38a9a7eb, 2026-10-27: 41K → 433K).

describe("MiniMax M3.1 Flash capabilities", () => {
  it("reports the GA MiniMax-M3.1-Flash id at the default 512K context, not the 1M wildcard", () => {
    // Provider-scoped: minimax-code-global aliases the minimax-code section
    // (capabilities.js "minimax-code-global" assignment); qoder also serves an
    // id with this name over openai transport, so no provider-unscoped flat
    // entry is added.
    expect(getCapabilitiesForModel("minimax-code-global", "MiniMax-M3.1-Flash")).toMatchObject({
      vision: true,
      reasoning: true,
      contextWindow: 512000,
      maxOutput: 128000,
      thinkingCanDisable: false,
    });
    expect(getCapabilitiesForModel("minimax-code", "MiniMax-M3.1-Flash")).toMatchObject({
      contextWindow: 512000,
      maxOutput: 128000,
    });
  });

  it("keeps the Preview id at 512K", () => {
    expect(getCapabilitiesForModel("minimax-code-global", "MiniMax-M3.1-Flash-Preview")).toMatchObject({
      contextWindow: 512000,
      maxOutput: 128000,
    });
  });
});
