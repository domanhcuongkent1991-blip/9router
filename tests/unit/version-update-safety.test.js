import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updater = vi.hoisted(() => ({
  killAppProcesses: vi.fn(),
  spawnUpdaterAndExit: vi.fn(),
}));

vi.mock("@/lib/appUpdater", () => updater);

import { POST } from "../../src/app/api/version/update/route.js";

describe("POST /api/version/update safety", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it.each(["production", "development"])("requires a manual upgrade in %s without starting the updater", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({ success: false, code: "manual_upgrade_required" });
    expect(body.message).toMatch(/backup/i);
    expect(body.message).toMatch(/MCP/i);
    expect(updater.killAppProcesses).not.toHaveBeenCalled();
    expect(updater.spawnUpdaterAndExit).not.toHaveBeenCalled();
  });
});
