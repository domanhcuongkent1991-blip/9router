import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { win32 } from "node:path";

export const DEFAULT_TEST_SCRATCH_ROOT = "C:\\tmp\\CodexScratch";

export function getTestScratchRoot() {
  const configured = process.env.NINEROUTER_TEST_SCRATCH_ROOT?.trim();
  return configured || DEFAULT_TEST_SCRATCH_ROOT;
}

export class TestEnvironmentBlockedError extends Error {
  constructor(root, cause) {
    super(`Test scratch root is not writable: ${root}`);
    this.name = "TestEnvironmentBlockedError";
    this.code = "test_environment_blocked";
    this.root = root;
    this.cause = cause;
  }
}

export async function ensureTestScratchRoot({ prefix = ".codex-probe-", root = getTestScratchRoot() } = {}) {
  if (!/^[A-Za-z]:[\\/]/u.test(root) || win32.parse(win32.resolve(root)).root === win32.resolve(root)
    || !/^[A-Za-z0-9._-]+$/u.test(prefix)) {
    throw new TestEnvironmentBlockedError(root, new Error("scratch_root_must_be_absolute_non_root"));
  }
  try {
    await mkdir(root, { recursive: true });
    const probe = await mkdtemp(win32.join(root, prefix));
    if (win32.dirname(probe).toLowerCase() !== win32.resolve(root).toLowerCase()) throw new Error("probe_outside_root");
    await rm(probe, { recursive: true, force: true });
    return root;
  } catch (error) {
    throw new TestEnvironmentBlockedError(root, error);
  }
}

export async function createTestScratchDirectory(prefix) {
  const root = await ensureTestScratchRoot({ prefix: ".codex-probe-" });
  try {
    return await mkdtemp(win32.join(root, prefix));
  } catch (error) {
    throw new TestEnvironmentBlockedError(root, error);
  }
}
