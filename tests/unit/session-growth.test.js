import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_GROWTH_GUARD,
  resolveGrowthGuard,
  resetGrowthStore,
  observeSessionGrowth,
  growthWarningMessage,
} from "../../src/sse/services/sessionGrowth.js";

const NOW = 1_700_000_000_000;

beforeEach(() => resetGrowthStore());

const guard = { enabled: true, minSamples: 3, growthRatio: 1.5, windowSize: 6 };

describe("resolveGrowthGuard", () => {
  it("is off unless enabled", () => {
    expect(resolveGrowthGuard(undefined).enabled).toBe(false);
    expect(resolveGrowthGuard({}).enabled).toBe(false);
  });

  it("uses defaults when switched on", () => {
    const g = resolveGrowthGuard({ sessionGrowthGuardEnabled: true });
    expect(g.enabled).toBe(true);
    expect(g.minSamples).toBe(DEFAULT_GROWTH_GUARD.minSamples);
    expect(g.growthRatio).toBe(DEFAULT_GROWTH_GUARD.growthRatio);
  });

  it("rejects nonsense numbers", () => {
    const g = resolveGrowthGuard({
      sessionGrowthGuardEnabled: true,
      sessionGrowthMinSamples: "abc",
      sessionGrowthRatio: -2,
    });
    expect(g.minSamples).toBe(DEFAULT_GROWTH_GUARD.minSamples);
    expect(g.growthRatio).toBe(DEFAULT_GROWTH_GUARD.growthRatio);
  });

  it("accepts a tuned ratio", () => {
    expect(resolveGrowthGuard({ sessionGrowthGuardEnabled: true, sessionGrowthRatio: 2.2 }).growthRatio)
      .toBe(2.2);
  });
});

describe("observeSessionGrowth", () => {
  it("stays quiet until it has enough samples", () => {
    const a = observeSessionGrowth({ sessionId: "s1", promptTokens: 1000, guard, now: NOW });
    const b = observeSessionGrowth({ sessionId: "s1", promptTokens: 9000, guard, now: NOW + 1 });
    expect(a.warning).toBe(null);
    expect(b.warning).toBe(null);
  });

  it("warns when the prompt keeps growing across turns", () => {
    const samples = [1000, 2000, 3000, 4500];
    const warnings = [];
    for (const [i, tokens] of samples.entries()) {
      const r = observeSessionGrowth({ sessionId: "s1", promptTokens: tokens, guard, now: NOW + i });
      if (r.warning) warnings.push(r.warning);
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("monotonic-growth");
    expect(warnings[0].lastTokens).toBeGreaterThan(warnings[0].firstTokens);
  });

  it("does not warn when the prompt shrinks (compaction happened)", () => {
    const samples = [10000, 12000, 5000, 6000];
    let last = null;
    for (const [i, tokens] of samples.entries()) {
      last = observeSessionGrowth({ sessionId: "s1", promptTokens: tokens, guard, now: NOW + i });
    }
    expect(last.warning).toBe(null);
  });

  it("does not warn on a flat session", () => {
    let last = null;
    for (let i = 0; i < 6; i += 1) {
      last = observeSessionGrowth({ sessionId: "s1", promptTokens: 2000, guard, now: NOW + i });
    }
    expect(last.warning).toBe(null);
  });

  it("keeps sessions isolated", () => {
    for (let i = 0; i < 4; i += 1) {
      observeSessionGrowth({ sessionId: "growing", promptTokens: 1000 * (i + 1), guard, now: NOW + i });
    }
    const fresh = observeSessionGrowth({ sessionId: "other", promptTokens: 1000, guard, now: NOW + 10 });
    expect(fresh.warning).toBe(null);
  });

  it("ignores everything when disabled", () => {
    const off = { enabled: false, minSamples: 3, growthRatio: 1.5, windowSize: 6 };
    let last = null;
    for (let i = 0; i < 6; i += 1) {
      last = observeSessionGrowth({ sessionId: "s1", promptTokens: 1000 * (i + 1), guard: off, now: NOW + i });
    }
    expect(last.warning).toBe(null);
  });

  it("ignores a missing session id", () => {
    const r = observeSessionGrowth({ sessionId: null, promptTokens: 99999, guard, now: NOW });
    expect(r.warning).toBe(null);
  });

  it("does not re-warn on every turn once flagged", () => {
    let warned = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = observeSessionGrowth({ sessionId: "s1", promptTokens: 1000 * (i + 1), guard, now: NOW + i });
      if (r.warning) warned += 1;
    }
    expect(warned).toBe(1);
  });

  it("only remembers the most recent window of samples", () => {
    const g = { ...guard, windowSize: 3, minSamples: 3 };
    observeSessionGrowth({ sessionId: "s1", promptTokens: 100, guard: g, now: NOW });
    observeSessionGrowth({ sessionId: "s1", promptTokens: 200, guard: g, now: NOW + 1 });
    observeSessionGrowth({ sessionId: "s1", promptTokens: 300, guard: g, now: NOW + 2 });
    const r = observeSessionGrowth({ sessionId: "s1", promptTokens: 310, guard: g, now: NOW + 3 });
    expect(r.samples).toBeLessThanOrEqual(3);
  });
});

describe("growthWarningMessage", () => {
  it("names the session, the growth and the advice", () => {
    const msg = growthWarningMessage({
      sessionId: "s1",
      firstTokens: 1000,
      lastTokens: 4000,
      samples: 4,
    });
    expect(msg).toContain("s1");
    expect(msg).toContain("1000");
    expect(msg).toContain("4000");
    expect(msg.toLowerCase()).toContain("compact");
  });
});
