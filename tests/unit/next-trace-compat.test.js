import { homedir } from "node:os";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config.mjs";

const projectRoot = dirname(fileURLToPath(new URL("../../next.config.mjs", import.meta.url)));

class TraceEntryPointsPlugin {
  constructor() {
    this.traceIgnores = [];
  }
}

describe("Next output-tracing compatibility", () => {
  it("excludes the build machine home directory before node-file-trace runs", () => {
    const tracePlugin = new TraceEntryPointsPlugin();
    const webpackConfig = { plugins: [tracePlugin] };

    nextConfig.webpack(webpackConfig, { isServer: true, nextRuntime: "nodejs" });

    const expectedPattern = `${relative(projectRoot, homedir()).replaceAll("\\", "/")}/**`;
    expect(tracePlugin.traceIgnores).toContain(expectedPattern);
  });

  it("excludes WindowsApps before node-file-trace runs", () => {
    const tracePlugin = new TraceEntryPointsPlugin();

    nextConfig.webpack(
      { plugins: [tracePlugin] },
      { isServer: true, nextRuntime: "nodejs" },
    );

    expect(tracePlugin.traceIgnores).toContain("**/WindowsApps/**");
  });

  it("fails closed when a production Next upgrade removes the expected trace hook", () => {
    expect(() => nextConfig.webpack(
      { plugins: [] },
      { isServer: true, dev: false, nextRuntime: "nodejs" },
    ))
      .toThrow(/unsupported Next\.js output tracing/i);
  });

  it("does not require the Node trace hook for an Edge server compilation", () => {
    expect(() => nextConfig.webpack(
      { plugins: [] },
      { isServer: true, dev: false, nextRuntime: "edge" },
    )).not.toThrow();
  });
});
