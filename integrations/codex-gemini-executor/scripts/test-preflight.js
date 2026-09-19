#!/usr/bin/env node
import { ensureTestScratchRoot, getTestScratchRoot } from "../test/scratch-root.js";

try {
  const root = await ensureTestScratchRoot({ prefix: ".codex-test-preflight-" });
  process.stdout.write(`${JSON.stringify({ status: "pass", scratchRoot: root })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "test_environment_blocked",
    scratchRoot: getTestScratchRoot(),
    reason: error?.code ?? "unknown",
  })}\n`);
  process.exitCode = 2;
}
