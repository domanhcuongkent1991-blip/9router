import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ReleaseError, buildRelease, verifyRelease } from "../src/release.js";
import { sourceDigest } from "../src/scoped-qualification.js";

const SCRATCH = "C:\\tmp\\ZCodeScratch\\nine-router-gemini-stabilize";
const GIT = { gitHead: "9b9ce0877de1b28c118698aa6f1f7bd976f4b73d", gitDirty: true, uncommittedFileCount: 26 };

async function makeTree() {
  const root = await mkdtemp(join(SCRATCH, "release-test-"));
  const src = join(root, "src");
  await mkdir(join(src, "app-server"), { recursive: true });
  await writeFile(join(src, "core.js"), "export const core = 1;\n");
  await writeFile(join(src, "router-transport.js"), "export const transport = 2;\n");
  await writeFile(join(src, "app-server", "runtime.js"), "export const runtime = 3;\n");
  const lockPath = join(root, "package-lock.json");
  await writeFile(lockPath, JSON.stringify({ lockfileVersion: 3, packages: {} }));
  return { root, src, lockPath };
}

test("builds a content-addressed provenance manifest over the source tree", async () => {
  const { root, src, lockPath } = await makeTree();
  try {
    const first = await buildRelease({ sourceDirectory: src, lockPath, gitInfo: GIT });
    const second = await buildRelease({ sourceDirectory: src, lockPath, gitInfo: GIT });
    assert.equal(first.releaseId, second.releaseId);
    assert.match(first.releaseId, /^[a-f0-9]{12}$/u);
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.notEqual(first.createdAt, second.createdAt);
    assert.equal(first.provenance.gitHead, GIT.gitHead);
    assert.equal(first.provenance.gitDirty, true);
    assert.equal(first.provenance.uncommittedFileCount, 26);
    assert.equal(first.companionSha256, await sourceDigest(src));
    assert.equal(first.dependencyLockSha256, createHash("sha256").update(await readFile(lockPath)).digest("hex"));
    assert.deepEqual(first.sourceManifest.map((entry) => entry.path),
      ["app-server/runtime.js", "core.js", "router-transport.js"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verifies an untouched tree against its manifest", async () => {
  const { root, src, lockPath } = await makeTree();
  try {
    const manifest = await buildRelease({ sourceDirectory: src, lockPath, gitInfo: GIT });
    const verified = await verifyRelease(manifest, { sourceDirectory: src, lockPath });
    assert.equal(verified.ok, true);
    assert.equal(verified.releaseId, manifest.releaseId);
    assert.equal(verified.manifestSha256, manifest.manifestSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fails closed when a source file drifts, is added, or is removed", async () => {
  const { root, src, lockPath } = await makeTree();
  try {
    const manifest = await buildRelease({ sourceDirectory: src, lockPath, gitInfo: GIT });
    await writeFile(join(src, "core.js"), "export const core = 999;\n");
    await assert.rejects(verifyRelease(manifest, { sourceDirectory: src, lockPath }),
      (error) => error instanceof ReleaseError
        && error.code === "release_manifest_mismatch" && error.details.reason === "source_tree_drift");
    await writeFile(join(src, "core.js"), "export const core = 1;\n");

    await writeFile(join(src, "extra.js"), "export const extra = 1;\n");
    await assert.rejects(verifyRelease(manifest, { sourceDirectory: src, lockPath }),
      (error) => error.details.reason === "source_tree_drift");
    await rm(join(src, "extra.js"));

    await rm(join(src, "app-server", "runtime.js"));
    await assert.rejects(verifyRelease(manifest, { sourceDirectory: src, lockPath }),
      (error) => error.details.reason === "source_tree_drift");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fails closed when the lock digest or manifest integrity breaks", async () => {
  const { root, src, lockPath } = await makeTree();
  try {
    const manifest = await buildRelease({ sourceDirectory: src, lockPath, gitInfo: GIT });
    const otherLock = join(root, "other-lock.json");
    await writeFile(otherLock, "{}");
    await assert.rejects(verifyRelease(manifest, { sourceDirectory: src, lockPath: otherLock }),
      (error) => error.details.reason === "dependency_lock_drift");

    await assert.rejects(verifyRelease({ ...manifest, schemaVersion: 2 }, { sourceDirectory: src, lockPath }),
      { code: "release_manifest_invalid" });
    await assert.rejects(verifyRelease({ ...manifest, releaseId: "deadbeefdead" }, { sourceDirectory: src, lockPath }),
      { code: "release_manifest_invalid" });
    await assert.rejects(verifyRelease({ ...manifest, companionSha256: "e".repeat(64) }, { sourceDirectory: src, lockPath }),
      (error) => error.details.reason === "companion_source_drift");
    await assert.rejects(verifyRelease(null, { sourceDirectory: src, lockPath }), { code: "release_manifest_invalid" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
