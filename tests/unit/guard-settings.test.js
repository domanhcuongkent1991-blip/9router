import { describe, it, expect } from "vitest";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";
import { resolveContextGuard, DEFAULT_CONTEXT_GUARD } from "../../src/sse/services/contextGuard.js";
import { resolveGrowthGuard, DEFAULT_GROWTH_GUARD } from "../../src/sse/services/sessionGrowth.js";

// mergeWithDefaults is the single place defaults are applied, so asserting on it
// covers what a fresh install and an upgraded install both end up with.
const defaults = mergeWithDefaults({});

describe("guard settings are present after the defaults merge", () => {
  it("declares the context guard keys", () => {
    expect(defaults).toHaveProperty("contextGuardEnabled", false);
    expect(defaults).toHaveProperty("contextGuardThreshold", DEFAULT_CONTEXT_GUARD.threshold);
    expect(defaults).toHaveProperty("contextGuardWarnRatio", DEFAULT_CONTEXT_GUARD.warnRatio);
  });

  it("declares the growth guard keys", () => {
    expect(defaults).toHaveProperty("sessionGrowthGuardEnabled", false);
    expect(defaults).toHaveProperty("sessionGrowthMinSamples", DEFAULT_GROWTH_GUARD.minSamples);
    expect(defaults).toHaveProperty("sessionGrowthRatio", DEFAULT_GROWTH_GUARD.growthRatio);
    expect(defaults).toHaveProperty("sessionGrowthWindowSize", DEFAULT_GROWTH_GUARD.windowSize);
  });

  it("defaults resolve to both guards off, so an upgrade changes nothing", () => {
    expect(resolveContextGuard(defaults).enabled).toBe(false);
    expect(resolveGrowthGuard(defaults).enabled).toBe(false);
  });

  it("tuned values survive the merge and resolve unchanged", () => {
    const merged = mergeWithDefaults({
      contextGuardEnabled: true,
      contextGuardThreshold: 0.85,
      sessionGrowthGuardEnabled: true,
      sessionGrowthRatio: 2,
    });
    expect(resolveContextGuard(merged)).toMatchObject({ enabled: true, threshold: 0.85 });
    expect(resolveGrowthGuard(merged)).toMatchObject({ enabled: true, growthRatio: 2 });
  });
});
