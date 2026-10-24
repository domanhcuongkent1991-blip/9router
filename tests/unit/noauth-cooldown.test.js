// L1 free-lane cooldown: no-auth providers (connectionId "noauth") have no
// connection record to carry modelLock_* keys, so upstream 429s used to leave
// no trace and every next request went straight back upstream. The RAM store
// below is what the gateway gate in getProviderCredentials reads.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  markNoauthCooldown,
  getNoauthCooldownUntil,
  resetNoauthCooldowns,
} from "../../open-sse/services/noauthCooldown.js";

afterEach(() => {
  resetNoauthCooldowns();
  vi.useRealTimers();
});

describe("noauthCooldown — free-lane RAM lock", () => {
  it("arms and reports a future expiry for provider:model", () => {
    markNoauthCooldown("opencode", "nous/foo:free", 60_000);
    const until = getNoauthCooldownUntil("opencode", "nous/foo:free");
    expect(until).not.toBeNull();
    expect(until).toBeGreaterThan(Date.now());
    expect(until).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("does not block a different model on the same provider", () => {
    markNoauthCooldown("opencode", "nous/foo:free", 60_000);
    expect(getNoauthCooldownUntil("opencode", "nous/bar:free")).toBeNull();
  });

  it("does not block a different provider", () => {
    markNoauthCooldown("opencode", "nous/foo:free", 60_000);
    expect(getNoauthCooldownUntil("other", "nous/foo:free")).toBeNull();
  });

  it("expires and lazily cleans up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
    markNoauthCooldown("opencode", "m", 5_000);
    expect(getNoauthCooldownUntil("opencode", "m")).not.toBeNull();
    vi.setSystemTime(new Date("2026-10-24T00:00:06Z"));
    expect(getNoauthCooldownUntil("opencode", "m")).toBeNull();
  });

  it("wildcard lock (no model) blocks every model of the provider", () => {
    markNoauthCooldown("opencode", null, 60_000);
    expect(getNoauthCooldownUntil("opencode", "anything:free")).not.toBeNull();
    expect(getNoauthCooldownUntil("opencode", null)).not.toBeNull();
  });

  it("caps the cooldown at 6 hours", () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-24T00:00:00Z");
    vi.setSystemTime(now);
    markNoauthCooldown("opencode", "m", 30 * 24 * 60 * 60 * 1000);
    expect(getNoauthCooldownUntil("opencode", "m")).toBeLessThanOrEqual(now.getTime() + 6 * 60 * 60 * 1000);
  });

  it("never shortens an already-longer cooldown", () => {
    vi.useFakeTimers();
    const now = new Date("2026-10-24T00:00:00Z");
    vi.setSystemTime(now);
    markNoauthCooldown("opencode", "m", 300_000);
    markNoauthCooldown("opencode", "m", 60_000);
    expect(getNoauthCooldownUntil("opencode", "m")).toBeGreaterThan(now.getTime() + 240_000);
  });

  it("ignores non-positive durations", () => {
    markNoauthCooldown("opencode", "m", 0);
    markNoauthCooldown("opencode", "m2", -5);
    expect(getNoauthCooldownUntil("opencode", "m")).toBeNull();
    expect(getNoauthCooldownUntil("opencode", "m2")).toBeNull();
  });
});
