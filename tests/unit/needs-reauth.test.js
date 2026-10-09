import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  getAdapter: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: mocks.validateApiKey,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: mocks.getAdapter,
}));

const auth = await import("../../src/sse/services/auth.js");
const { resetHealthStateOnActivation } = await import(
  "../../src/lib/db/repos/connectionsRepo.js"
);

const conn = (overrides = {}) => ({
  id: "conn-cline-1",
  provider: "cline",
  isActive: true,
  displayName: "Cline account",
  providerSpecificData: {},
  ...overrides,
});

describe("markAccountUnavailable — sticky needsReauth on auth-class errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([conn()]);
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("sets needsReauth on a 401", async () => {
    await auth.markAccountUnavailable(
      "conn-cline-1",
      401,
      "Please make sure you're using the latest version of Cline and re-authenticate your Cline account.",
      "cline",
      "meta/muse-spark-1.3"
    );
    const patch = mocks.updateProviderConnection.mock.calls[0][1];
    expect(patch.needsReauth).toBe(true);
    expect(patch.testStatus).toBe("unavailable");
  });

  it("sets needsReauth on a 403 that asks for re-authentication", async () => {
    await auth.markAccountUnavailable(
      "conn-cline-1",
      403,
      "Session expired, please re-authenticate to continue",
      "cline",
      null
    );
    const patch = mocks.updateProviderConnection.mock.calls[0][1];
    expect(patch.needsReauth).toBe(true);
  });

  it("does not set needsReauth on a non-auth 403 (plan/region errors)", async () => {
    await auth.markAccountUnavailable(
      "conn-cline-1",
      403,
      "Upgrade your plan to access this model",
      "cline",
      null
    );
    const patch = mocks.updateProviderConnection.mock.calls[0][1];
    expect(patch.needsReauth).toBeUndefined();
  });
});

describe("getProviderCredentials — skips and reports needsReauth connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
    mocks.getProxyPools.mockResolvedValue([]);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
    mocks.updateProviderConnection.mockResolvedValue({});
  });

  it("returns a needsReauth result when every candidate connection needs re-auth", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn({ needsReauth: true, lastError: "re-auth required", errorCode: 401 }),
      conn({ id: "conn-cline-2", needsReauth: true }),
    ]);
    const result = await auth.getProviderCredentials("cline", null, null);
    expect(result.allRateLimited).toBe(true);
    expect(result.needsReauth).toBe(true);
    expect(result.retryAfter).toBeNull();
    expect(result.lastError).toContain("re-auth");
  });

  it("still routes to a healthy connection when only some need re-auth", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      conn({ needsReauth: true }),
      conn({ id: "conn-cline-2", displayName: "Healthy account" }),
    ]);
    const result = await auth.getProviderCredentials("cline", null, null);
    expect(result.connectionId).toBe("conn-cline-2");
    expect(result.needsReauth).toBeUndefined();
  });

  it("returns null when there are no connections at all", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    const result = await auth.getProviderCredentials("cline", null, null);
    expect(result).toBeNull();
  });
});

describe("resetHealthStateOnActivation — a token update clears the sticky flag", () => {
  const existing = conn({
    needsReauth: true,
    "modelLock_meta/muse-spark-1.3": "2026-10-08T00:00:00Z",
  });

  it("clears needsReauth when a new token arrives", () => {
    const normalized = resetHealthStateOnActivation(existing, { accessToken: "fresh-token" });
    expect(normalized.needsReauth).toBeNull();
    // token-only update must not touch health state
    expect(normalized.testStatus).toBeUndefined();
  });

  it("clears needsReauth when a new apiKey arrives", () => {
    const normalized = resetHealthStateOnActivation(existing, { apiKey: "sk-new" });
    expect(normalized.needsReauth).toBeNull();
  });

  it("clears needsReauth when a health test passes", () => {
    const normalized = resetHealthStateOnActivation(existing, { testStatus: "active" });
    expect(normalized.needsReauth).toBeNull();
    expect(normalized["modelLock_meta/muse-spark-1.3"]).toBeNull();
  });

  it("leaves unrelated patches untouched", () => {
    const patch = { priority: 3, displayName: "renamed" };
    const normalized = resetHealthStateOnActivation(existing, patch);
    expect(normalized).toBe(patch);
  });
});
