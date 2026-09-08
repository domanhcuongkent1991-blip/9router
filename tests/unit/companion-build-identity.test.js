import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

describe("companion build identity", () => {
  it("returns production build identity without querying registry or credentials", async () => {
    const { readFile } = await import("node:fs/promises");
    readFile.mockResolvedValue("build_1\n");
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { GET } = await import("../../src/app/api/compatibility/route.js");
      const response = await GET();
      expect(await response.json()).toMatchObject({ buildId: "build_1", contractVersion: 1 });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      readFile.mockRejectedValue(new Error("private-path"));
      expect((await (await GET()).json()).buildId).toBe("build_1");
      vi.resetModules();
      const missingBuild = await import("../../src/app/api/compatibility/route.js");
      expect((await missingBuild.GET()).status).toBe(503);
    } finally { process.env.NODE_ENV = previous; }
  });
});
