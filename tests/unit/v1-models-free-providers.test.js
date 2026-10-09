import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  updateProviderCredentials: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
}));

const { GET } = await import("../../src/app/api/v1/models/route.js");

const req = (url = "http://localhost:20128/v1/models") => new Request(url);

async function getModelIds(url) {
  const res = await GET(req(url));
  const body = await res.json();
  return { status: res.status, ids: body.data.map((m) => m.id), entries: body.data };
}

describe("GET /v1/models — callable free (noAuth) providers are listed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // One healthy antigravity connection; no connection for opencode at all.
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-ag",
        provider: "antigravity",
        isActive: true,
        priority: 1,
        email: "t@example.com",
      },
    ]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue([]);
    mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  });

  it("lists oc/ free models although opencode has no connection", async () => {
    const { status, ids } = await getModelIds();
    expect(status).toBe(200);
    const ocModels = ids.filter((id) => id.startsWith("oc/"));
    expect(ocModels.length).toBeGreaterThan(0);
  });

  it("still lists models of providers that do have an active connection", async () => {
    const { ids } = await getModelIds();
    expect(ids.some((id) => id.startsWith("ag/"))).toBe(true);
  });

  it("does not list paywalled ocz/ models in the default response", async () => {
    const { ids } = await getModelIds();
    expect(ids.some((id) => id.startsWith("ocz/"))).toBe(false);
  });

  it("?include=all adds needs-connection models tagged with availability", async () => {
    const { entries } = await getModelIds("http://localhost:20128/v1/models?include=all");
    const oczEntry = entries.find((m) => m.id.startsWith("ocz/"));
    expect(oczEntry).toBeTruthy();
    expect(oczEntry.availability).toBe("needs-connection");
  });

  it("?include=all keeps ready providers untagged", async () => {
    const { entries } = await getModelIds("http://localhost:20128/v1/models?include=all");
    const agEntry = entries.find((m) => m.id.startsWith("ag/"));
    expect(agEntry.availability).toBeUndefined();
  });
});
