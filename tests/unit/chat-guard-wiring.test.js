import { describe, it, expect } from "vitest";
import { handleChat } from "../../src/sse/handlers/chat.js";
import { resolveContextGuard, checkContextFit, estimateRequestTokens } from "../../src/sse/services/contextGuard.js";
import { resolveGrowthGuard, observeSessionGrowth } from "../../src/sse/services/sessionGrowth.js";

describe("chat handler wiring", () => {
  it("loads with the context guard and growth modules resolved", () => {
    expect(typeof handleChat).toBe("function");
    expect(typeof resolveContextGuard).toBe("function");
    expect(typeof resolveGrowthGuard).toBe("function");
  });

  it("keeps both guards off by default so existing traffic is unaffected", () => {
    const settings = {};
    expect(resolveContextGuard(settings).enabled).toBe(false);
    expect(resolveGrowthGuard(settings).enabled).toBe(false);
  });

  it("a disabled guard never blocks, whatever the prompt size", () => {
    const fit = checkContextFit({
      estimatedTokens: estimateRequestTokens({ messages: [{ role: "user", content: "x".repeat(500000) }] }),
      capabilities: { contextWindow: 1000 },
      guard: resolveContextGuard({}),
    });
    expect(fit.ok).toBe(true);
  });

  it("a disabled growth guard never warns", () => {
    let warned = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = observeSessionGrowth({
        sessionId: "wiring",
        promptTokens: 1000 * (i + 1),
        guard: resolveGrowthGuard({}),
      });
      if (r.warning) warned += 1;
    }
    expect(warned).toBe(0);
  });
});
