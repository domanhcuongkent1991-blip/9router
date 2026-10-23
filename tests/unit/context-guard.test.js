import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_CONTEXT_GUARD,
  resolveContextGuard,
  estimateRequestTokens,
  checkContextFit,
  contextGuardDeniedResponse,
} from "../../src/sse/services/contextGuard.js";

describe("resolveContextGuard", () => {
  it("is off unless explicitly enabled", () => {
    expect(resolveContextGuard(undefined).enabled).toBe(false);
    expect(resolveContextGuard({}).enabled).toBe(false);
    expect(resolveContextGuard({ contextGuardEnabled: false }).enabled).toBe(false);
  });

  it("enables with sane defaults when switched on", () => {
    const g = resolveContextGuard({ contextGuardEnabled: true });
    expect(g.enabled).toBe(true);
    expect(g.threshold).toBe(DEFAULT_CONTEXT_GUARD.threshold);
    expect(g.warnRatio).toBe(DEFAULT_CONTEXT_GUARD.warnRatio);
  });

  it("clamps threshold into (0, 1]", () => {
    expect(resolveContextGuard({ contextGuardEnabled: true, contextGuardThreshold: 0 }).threshold)
      .toBe(DEFAULT_CONTEXT_GUARD.threshold);
    expect(resolveContextGuard({ contextGuardEnabled: true, contextGuardThreshold: 1.5 }).threshold)
      .toBe(1);
    expect(resolveContextGuard({ contextGuardEnabled: true, contextGuardThreshold: 0.8 }).threshold)
      .toBe(0.8);
  });

  it("treats a non-numeric threshold as the default", () => {
    expect(resolveContextGuard({ contextGuardEnabled: true, contextGuardThreshold: "abc" }).threshold)
      .toBe(DEFAULT_CONTEXT_GUARD.threshold);
  });
});

describe("estimateRequestTokens", () => {
  it("returns 0 for junk input", () => {
    expect(estimateRequestTokens(null)).toBe(0);
    expect(estimateRequestTokens(undefined)).toBe(0);
    expect(estimateRequestTokens("nope")).toBe(0);
  });

  it("scales with body size and rounds up", () => {
    const small = estimateRequestTokens({ messages: [{ role: "user", content: "hi" }] });
    const big = estimateRequestTokens({ messages: [{ role: "user", content: "x".repeat(4000) }] });
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small);
    expect(Number.isInteger(big)).toBe(true);
  });

  it("counts tools, not just messages", () => {
    const withoutTools = estimateRequestTokens({ messages: [{ role: "user", content: "hi" }] });
    const withTools = estimateRequestTokens({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", description: "d".repeat(2000) } }],
    });
    expect(withTools).toBeGreaterThan(withoutTools);
  });
});

describe("checkContextFit", () => {
  const caps = { contextWindow: 100000 };

  it("passes comfortably under the threshold", () => {
    const r = checkContextFit({ estimatedTokens: 1000, capabilities: caps, guard: { enabled: true, threshold: 0.9, warnRatio: 0.7 } });
    expect(r.ok).toBe(true);
    expect(r.level).toBe("ok");
  });

  it("warns in the warning band", () => {
    const r = checkContextFit({ estimatedTokens: 75000, capabilities: caps, guard: { enabled: true, threshold: 0.9, warnRatio: 0.7 } });
    expect(r.ok).toBe(true);
    expect(r.level).toBe("warn");
  });

  it("rejects at or above the threshold", () => {
    const r = checkContextFit({ estimatedTokens: 90000, capabilities: caps, guard: { enabled: true, threshold: 0.9, warnRatio: 0.7 } });
    expect(r.ok).toBe(false);
    expect(r.level).toBe("over");
  });

  it("always allows when the guard is disabled", () => {
    const r = checkContextFit({ estimatedTokens: 10_000_000, capabilities: caps, guard: { enabled: false, threshold: 0.9, warnRatio: 0.7 } });
    expect(r.ok).toBe(true);
    expect(r.level).toBe("ok");
  });

  it("does not block when the window is unknown", () => {
    const r = checkContextFit({ estimatedTokens: 10_000_000, capabilities: {}, guard: { enabled: true, threshold: 0.9, warnRatio: 0.7 } });
    expect(r.ok).toBe(true);
    expect(r.level).toBe("unknown");
  });
});

describe("contextGuardDeniedResponse", () => {
  it("is a 413 carrying the numbers", async () => {
    const res = contextGuardDeniedResponse({
      modelLabel: "oc/minimax-m3.1-flash-free",
      estimatedTokens: 845401,
      contextWindow: 512000,
      threshold: 0.9,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.message).toContain("845401");
    expect(body.error.message).toContain("512000");
    expect(body.error.message).toContain("oc/minimax-m3.1-flash-free");
  });
});
