import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async (value) => value),
  verifyDashboardPassword: vi.fn(async (value) => value === "configured-initial-fixture"),
}));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/lib/auth/dashboardSession", () => ({ verifyDashboardPassword: mocks.verifyDashboardPassword }));
vi.mock("@/lib/network/outboundProxy", () => ({ applyOutboundProxyEnv: vi.fn() }));
vi.mock("open-sse/services/combo.js", () => ({ resetComboRotation: vi.fn() }));
const { PATCH } = await import("../../src/app/api/settings/route.js");

describe("settings password with configured initial password", () => {
  it("accepts the same current password verifier as login and persists only a hash", async () => {
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH", body: JSON.stringify({ currentPassword: "configured-initial-fixture", newPassword: "replacement-fixture" }),
    }));
    expect(response.status).toBe(200);
    const saved = mocks.updateSettings.mock.calls.at(-1)[0];
    expect(saved.password).toMatch(/^\$2/);
    expect(saved).not.toHaveProperty("newPassword");
    expect(saved).not.toHaveProperty("currentPassword");
  });
  it.each([undefined, "wrong-fixture"])("rejects missing or incorrect current password: %s", async (currentPassword) => {
    mocks.updateSettings.mockClear();
    const response = await PATCH(new Request("http://localhost/api/settings", {
      method: "PATCH", body: JSON.stringify({ currentPassword, newPassword: "replacement-fixture" }),
    }));
    expect([400, 401]).toContain(response.status);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
