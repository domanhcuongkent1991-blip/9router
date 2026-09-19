import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, win32 } from "node:path";

import { runActivationRehearsal } from "../src/rehearsal-cli.js";
import { ensureTestScratchRoot } from "./scratch-root.js";

const PRODUCTION_RUNTIME_ROOT = "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime";

test("rehearses activation end to end inside a scratch runtime root", async () => {
  const scratch = await ensureTestScratchRoot({ prefix: ".codex-rehearsal-probe-" });
  const scratchRoot = await mkdtemp(join(scratch, "rehearsal-"));
  try {
    const result = await runActivationRehearsal({
      scratchRoot,
      environment: { NINEROUTER_TEST_SCRATCH_ROOT: scratch },
    });
    assert.equal(result.status, "pass");
    assert.match(result.releaseId, /^[a-f0-9]{12}$/u);
    assert.match(result.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.equal(result.recordPath.startsWith(scratchRoot), true);
    assert.equal(result.recordPath.includes("9router-gemini-runtime"), false);
  } finally { await rm(scratchRoot, { recursive: true, force: true }); }
});

test("rehearsal refuses unsafe scratch roots before any I/O", async () => {
  await assert.rejects(runActivationRehearsal({ scratchRoot: "rehearsal-tmp", environment: {} }),
    (error) => error.code === "rehearsal_root_invalid");
  await assert.rejects(runActivationRehearsal({ scratchRoot: "C:\\Users\\Admin\\scratch", environment: {} }),
    (error) => error.code === "rehearsal_root_invalid");
  await assert.rejects(runActivationRehearsal({ scratchRoot: PRODUCTION_RUNTIME_ROOT, environment: {} }),
    (error) => error.code === "rehearsal_root_invalid");
  assert.equal(win32.isAbsolute(PRODUCTION_RUNTIME_ROOT), true);
  await assert.rejects(runActivationRehearsal({ scratchRoot: "C:\\scratch-other\\job",
    environment: { NINEROUTER_TEST_SCRATCH_ROOT: "C:\\scratch" } }), { code: "rehearsal_root_invalid" });
  await assert.rejects(runActivationRehearsal({ scratchRoot: "C:\\scratch",
    environment: { NINEROUTER_TEST_SCRATCH_ROOT: "C:\\scratch" } }), { code: "rehearsal_root_invalid" });
});
