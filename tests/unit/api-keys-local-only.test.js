import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  next: vi.fn(() => ({ passthrough: true })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  hasTrustedPeerHeaders: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.json, next: mocks.next },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

vi.mock("@/lib/auth/trustedPeer", () => ({
  hasTrustedPeerHeaders: mocks.hasTrustedPeerHeaders,
}));

const { proxy } = await import("../../src/dashboardGuard.js");

function makeRequest(pathname, headers = {}) {
  const entries = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]);
  const map = new Map(entries);
  return {
    nextUrl: { pathname, searchParams: new URLSearchParams() },
    headers: { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) },
    cookies: { get: () => undefined },
  };
}

// GET /api/keys returns raw key material; with requireLogin=false the route
// must still be unreachable from tunnels/LAN peers (loopback dashboard only).
describe("/api/keys is local-only (raw key material)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Matches the live settings DB: local mode without dashboard login.
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("denies a tunnel-forwarded request with 403 Local only", async () => {
    const request = makeRequest("/api/keys", { "x-9r-via-proxy": "cloudflare" });
    const response = await proxy(request);
    expect(mocks.json).toHaveBeenCalledWith(
      { error: "Local only: CLI token required" },
      { status: 403 }
    );
    expect(response.status).toBe(403);
  });

  it("denies a non-loopback peer request without trusted headers", async () => {
    mocks.hasTrustedPeerHeaders.mockReturnValue(false);
    const request = makeRequest("/api/keys");
    const response = await proxy(request);
    expect(response.status).toBe(403);
  });

  it("covers /api/keys/:id management routes via prefix match", async () => {
    const request = makeRequest("/api/keys/7c2f1e9a", { "x-9r-via-proxy": "cloudflare" });
    const response = await proxy(request);
    expect(response.status).toBe(403);
  });

  it("allows a loopback dashboard request when requireLogin is disabled", async () => {
    mocks.hasTrustedPeerHeaders.mockReturnValue(true);
    const request = makeRequest("/api/keys", { "x-9r-real-ip": "127.0.0.1" });
    await proxy(request);
    expect(mocks.next).toHaveBeenCalled();
  });
});
