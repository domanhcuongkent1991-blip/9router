import { describe, it, expect } from "vitest";
import { isFreeModel, getPricingForModel, ZERO_PRICING } from "../../open-sse/providers/pricing.js";

describe("free-tier models bill $0", () => {
  it("detects the -free suffix", () => {
    expect(isFreeModel("glm-5.3-flash-free")).toBe(true);
    expect(isFreeModel("minimax-m3.1-flash-free")).toBe(true);
    expect(isFreeModel("deepseek-v4.1-flash-free")).toBe(true);
  });

  it("detects the :free suffix", () => {
    expect(isFreeModel("minimax/minimax-m3.1-flash:free")).toBe(true);
  });

  it("detects the cline-free namespace", () => {
    expect(isFreeModel("cline-free/deepseek-v4.1-flash")).toBe(true);
  });

  it("does not flag paid models", () => {
    expect(isFreeModel("glm-5.3-flash")).toBe(false);
    expect(isFreeModel("freeway-pro")).toBe(false);
    expect(isFreeModel("")).toBe(false);
    expect(isFreeModel(null)).toBe(false);
  });

  it("returns ZERO_PRICING for -free ids that would otherwise hit a paid pattern", () => {
    // "glm-5.3-flash-free" matches the paid "glm-5*" pattern; the free guard must win.
    expect(getPricingForModel("opencode", "glm-5.3-flash-free")).toEqual(ZERO_PRICING);
    expect(getPricingForModel("opencode", "minimax-m3.1-flash-free")).toEqual(ZERO_PRICING);
    expect(getPricingForModel("opencode", "deepseek-v4.1-flash-free")).toEqual(ZERO_PRICING);
  });

  it("still prices the paid counterpart", () => {
    const paid = getPricingForModel("opencode", "glm-5.3-flash");
    expect(paid.input).toBeGreaterThan(0);
  });
});
