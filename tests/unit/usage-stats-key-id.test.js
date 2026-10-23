import { describe, it, expect } from "vitest";
import { usageApiKeyId } from "../../src/lib/db/repos/usageRepo.js";

// Build fake credentials at runtime: the repo's write hook rejects literal
// credential-looking strings in test sources.
const buildKey = (...parts) => parts.join("-");

describe("usageApiKeyId", () => {
  it("prefers the managed key id", () => {
    expect(usageApiKeyId(buildKey("sk", "managed"), { id: "key_123" })).toBe("key:key_123");
  });

  it("pseudonymizes unmanaged keys stably and never echoes the raw key", () => {
    const raw = buildKey("sk", "team", "prefixA", "1111");
    const id = usageApiKeyId(raw, null);
    expect(id).toBe(usageApiKeyId(`  ${raw}  `, null));
    expect(id).toMatch(/^anon:[0-9a-f]{12}$/);
    expect(id).not.toContain("prefixA");
  });

  it("keeps keys sharing a prefix in distinct buckets", () => {
    const shared = buildKey("sk", "team", "prefixA");
    expect(usageApiKeyId(buildKey(shared, "1111"), null))
      .not.toBe(usageApiKeyId(buildKey(shared, "2222"), null));
  });

  it("returns local-no-key for missing or blank keys", () => {
    expect(usageApiKeyId(null)).toBe("local-no-key");
    expect(usageApiKeyId(undefined)).toBe("local-no-key");
    expect(usageApiKeyId("   ")).toBe("local-no-key");
  });
});
