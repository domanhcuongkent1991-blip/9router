import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyRecovery, createFileBroker, previewRecovery, summarizeRecoveryJournal } from "../src/file-broker.js";
import { createGrant, resolveScope } from "../src/job-scope.js";

async function fixture({ allowCreate = true } = {}) {
  const scratchRoot = "C:\\tmp\\CodexScratch";
  await mkdir(scratchRoot, { recursive: true });
  const workspace = await mkdtemp(join(scratchRoot, "2026-09-08-gemini-scoped-edit-broker-"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "auth.js"), Buffer.from("\uFEFFold\r\nsecond\r\n", "utf8"));
  await writeFile(join(workspace, "src", "other.js"), "needle here\n", "utf8");
  const resolvedScope = await resolveScope({
    workspace,
    access: "scoped-edit",
    task: "edit source",
    scope: { read: ["src"], write: ["src"], allow_create: allowCreate },
  }, { permittedWorkspaceRoots: [workspace] });
  const grant = createGrant({
    jobId: "job_broker",
    resolvedScope,
    taskHash: "a".repeat(64),
    runtimeFingerprint: "router-responses-v1",
    expiresAt: Date.now() + 60_000,
  });
  const journalDirectory = join(workspace, "runtime");
  return { workspace, grant, journalDirectory };
}

async function withBroker(callback, options = {}) {
  const { fixtureOptions, ...brokerOptions } = options;
  const value = await fixture(fixtureOptions);
  const broker = createFileBroker({ ...value, ...brokerOptions });
  try { return await callback({ ...value, broker }); }
  finally { await broker.finish(); await rm(value.workspace, { recursive: true, force: true }); }
}

test("reads text, lists scoped files, and searches literal content", async () => {
  await withBroker(async ({ broker }) => {
    const text = await broker.dispatch("read_text", { path: "src\\auth.js" });
    assert.equal(text.text, "old\r\nsecond\r\n");
    assert.equal(text.bom, true);
    assert.equal(text.newline, "crlf");
    assert.match(text.sha256, /^[a-f0-9]{64}$/u);

    const listing = await broker.dispatch("list_files", { path: "src" });
    assert.deepEqual(listing.entries.sort(), ["src\\auth.js", "src\\other.js"]);
    const search = await broker.dispatch("search_text", { path: "src", query: "needle" });
    assert.equal(search.matches[0].path, "src\\other.js");
    assert.equal(search.matches[0].line, 1);
  });
});

test("replaces exactly one match, preserves bytes outside the edit, and detects conflicts", async () => {
  await withBroker(async ({ broker, workspace }) => {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    const changed = await broker.dispatch("replace_text", {
      path: "src\\auth.js",
      expected_sha256: before.sha256,
      old_text: "old",
      new_text: "new",
    });
    assert.equal(changed.bytes, Buffer.byteLength("\uFEFFnew\r\nsecond\r\n"));
    assert.deepEqual(await readFile(join(workspace, "src", "auth.js")), Buffer.from("\uFEFFnew\r\nsecond\r\n"));

    await writeFile(join(workspace, "src", "auth.js"), "external\r\n", "utf8");
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\auth.js",
      expected_sha256: changed.sha256,
      old_text: "new",
      new_text: "again",
    }), { code: "file_conflict" });
  });
});

test("creates only a new file and never overwrites an existing target", async () => {
  await withBroker(async ({ broker }) => {
    const created = await broker.dispatch("create_text", { path: "src\\created.js", text: "export const ok = true;\n" });
    assert.match(created.sha256, /^[a-f0-9]{64}$/u);
    await assert.rejects(broker.dispatch("create_text", { path: "src\\created.js", text: "overwrite" }), { code: "operation_denied" });
  });
});

test("rejects a pre-existing create target before it creates recovery journal state", async () => {
  const value = await fixture();
  const target = join(value.workspace, "src", "auth.js");
  const before = await readFile(target);
  const broker = createFileBroker(value);
  try {
    await assert.rejects(broker.dispatch("create_text", { path: "src\\auth.js", text: "must not overwrite\n" }),
      { code: "operation_denied" });
    assert.deepEqual(await readFile(target), before);
    assert.deepEqual(broker.recoverySummary(), { filesChanged: [], recoveryRequired: false });
    await assert.rejects(readFile(join(value.journalDirectory, "job_broker.jsonl")), { code: "ENOENT" });
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("keeps recovery visible when a create target appears after its prepared journal record", async () => {
  const value = await fixture();
  const relativePath = "src\\appeared-after-preflight.js";
  const target = join(value.workspace, "src", "appeared-after-preflight.js");
  let injected = false;
  const broker = createFileBroker({
    ...value,
    fs: {
      openPath: async (path, ...args) => {
        if (path === target && args[0] === "wx+" && !injected) {
          injected = true;
          await writeFile(target, "external file\n", "utf8");
        }
        return open(path, ...args);
      },
    },
  });
  try {
    await assert.rejects(broker.dispatch("create_text", { path: relativePath, text: "broker file\n" }),
      (error) => error.code === "operation_denied"
        && error.recoveryRequired === true
        && error.filesChanged.includes(relativePath));
    assert.equal(await readFile(target, "utf8"), "external file\n");
    const { recoveryOperationIds, ...summary } = broker.recoverySummary();
    assert.equal(recoveryOperationIds.length, 1);
    assert.deepEqual(summary, {
      filesChanged: [relativePath], recoveryRequired: true, recoveryId: "recovery_job_broker",
    });
    const records = (await readFile(join(value.journalDirectory, "job_broker.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(recoveryOperationIds[0], records[0].opId);
    assert.deepEqual(records.map((record) => record.phase), ["prepared", "recovery_required"]);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("does not create a file when the approved grant disables creation", async () => {
  await withBroker(async ({ broker, workspace }) => {
    await assert.rejects(broker.dispatch("create_text", { path: "src\\denied.js", text: "must not exist" }), { code: "operation_denied" });
    await assert.rejects(readFile(join(workspace, "src", "denied.js")), { code: "ENOENT" });
  }, { fixtureOptions: { allowCreate: false } });
});

test("checks the file size before loading an oversized text file", async () => {
  let directReads = 0;
  await withBroker(async ({ broker }) => {
    await assert.rejects(broker.dispatch("read_text", { path: "src\\auth.js" }), { code: "limit_exceeded" });
    assert.equal(directReads, 0);
  }, {
    limits: { maxFileBytes: 4 },
    fs: { readFilePath: async (...args) => { directReads += 1; return readFile(...args); } },
  });
});

test("rejects an under-budget replacement before backup or target mutation", async () => {
  const value = await fixture();
  const target = join(value.workspace, "src", "budget.txt");
  await writeFile(target, "old text", "utf8");
  const expected = createHash("sha256").update("old text", "utf8").digest("hex");
  const broker = createFileBroker({ ...value, limits: { maxReadBytes: 20 } });
  try {
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\budget.txt", expected_sha256: expected, old_text: "old", new_text: "new",
    }), { code: "limit_exceeded" });
    assert.equal(await readFile(target, "utf8"), "old text");
    await assert.rejects(readFile(join(value.journalDirectory, "job_broker.jsonl")), { code: "ENOENT" });
    assert.equal(broker.recoverySummary().recoveryRequired, false);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("uses exactly 24 read-budget bytes for a replacement without a prior read", async () => {
  await withBroker(async ({ broker, workspace }) => {
    const target = join(workspace, "src", "budget-24.txt");
    await writeFile(target, "old text", "utf8");
    const expected = createHash("sha256").update("old text", "utf8").digest("hex");

    const changed = await broker.dispatch("replace_text", {
      path: "src\\budget-24.txt", expected_sha256: expected, old_text: "old", new_text: "new",
    });

    assert.equal(changed.bytes, 8);
    assert.equal(await readFile(target, "utf8"), "new text");
    assert.equal(broker.recoverySummary().recoveryRequired, false);
  }, { limits: { maxReadBytes: 24 } });
});

test("accounts for a prior read before reserving replacement reads", async () => {
  await withBroker(async ({ broker, workspace }) => {
    const target = join(workspace, "src", "budget-prior-read.txt");
    await writeFile(target, "old text", "utf8");
    const before = await broker.dispatch("read_text", { path: "src\\budget-prior-read.txt" });

    await broker.dispatch("replace_text", {
      path: "src\\budget-prior-read.txt", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });

    assert.equal(await readFile(target, "utf8"), "new text");
    assert.equal(broker.recoverySummary().recoveryRequired, false);
  }, { limits: { maxReadBytes: 32 } });
});

test("keeps recovery metadata when a prepared journal write cannot be confirmed", async () => {
  for (const operation of ["replace", "create"]) {
    for (const fault of ["write", "sync", "close"]) {
      const value = await fixture();
      const relativePath = operation === "replace" ? "src\\auth.js" : `src\\${fault}-prepared-create.js`;
      const target = join(value.workspace, ...relativePath.split("\\"));
      const original = operation === "replace" ? await readFile(target) : null;
      const journalPath = join(value.journalDirectory, "job_broker.jsonl");
      let writeCalls = 0;
      let faultInjected = false;
      const broker = createFileBroker({
        ...value,
        fs: {
          openPath: async (path, ...args) => {
            const handle = await open(path, ...args);
            if (!path.endsWith(".jsonl")) return handle;
            if (fault === "write") {
              const originalWrite = handle.write.bind(handle);
              handle.write = async (buffer, ...writeArgs) => {
                writeCalls += 1;
                if (writeCalls === 1) return originalWrite(buffer.subarray(0, 1), ...writeArgs);
                const error = new Error("prepared journal write unavailable");
                error.code = "EIO";
                throw error;
              };
            } else if (fault === "sync") {
              const originalSync = handle.sync.bind(handle);
              handle.sync = async () => {
                await originalSync();
                if (!faultInjected) {
                  faultInjected = true;
                  const error = new Error("prepared journal sync unavailable");
                  error.code = "EIO";
                  throw error;
                }
              };
            } else {
              const originalClose = handle.close.bind(handle);
              handle.close = async () => {
                await originalClose();
                if (!faultInjected) {
                  faultInjected = true;
                  const error = new Error("prepared journal close unavailable");
                  error.code = "EIO";
                  throw error;
                }
              };
            }
            return handle;
          },
        },
      });
      try {
        const args = operation === "replace"
          ? {
            path: relativePath,
            expected_sha256: createHash("sha256").update(original).digest("hex"),
            old_text: "old",
            new_text: "new",
          }
          : { path: relativePath, text: "must not be written\n" };
        await assert.rejects(broker.dispatch(`${operation}_text`, args), (error) => error.code === "recovery_required"
          && error.recoveryRequired === true
          && error.recoveryId === "recovery_job_broker"
          && error.filesChanged.includes(relativePath));
        if (operation === "replace") {
          assert.deepEqual(await readFile(target), original);
          const backupRef = createHash("sha256").update(original).digest("hex");
          assert.deepEqual(await readFile(join(value.journalDirectory, "backups", "job_broker", `${backupRef}.bin`)), original);
        }
        else await assert.rejects(readFile(target), { code: "ENOENT" });
        const { recoveryOperationIds, ...summary } = broker.recoverySummary();
        assert.equal(recoveryOperationIds.length, 1);
        assert.match(recoveryOperationIds[0], /^[a-f0-9-]{36}$/u);
        assert.deepEqual(summary, {
          filesChanged: [relativePath], recoveryRequired: true, recoveryId: "recovery_job_broker",
        });
        const journal = await readFile(journalPath, "utf8");
        if (fault === "write") assert.equal(journal, "{");
        else assert.equal(JSON.parse(journal).phase, "prepared");
      } finally {
        await broker.finish();
        await rm(value.workspace, { recursive: true, force: true });
      }
    }
  }
});

test("does not overwrite an external edit made after the backup is durable", async () => {
  const value = await fixture();
  const target = join(value.workspace, "src", "auth.js");
  const realOpen = open;
  let injected = false;
  const broker = createFileBroker({
    ...value,
    fs: {
      openPath: async (path, ...args) => {
        const handle = await realOpen(path, ...args);
        if (!path.endsWith(".bin")) return handle;
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          if (!injected) {
            injected = true;
            await writeFile(target, "user edit\n", "utf8");
          }
        };
        return handle;
      },
    },
  });
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    }), { code: "file_conflict" });
    assert.equal(await readFile(target, "utf8"), "user edit\n");
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("denies every later write after a broker operation requires recovery", async () => {
  const value = await fixture();
  const first = join(value.workspace, "src", "auth.js");
  const deniedCreate = join(value.workspace, "src", "must-not-create.js");
  let injected = false;
  const broker = createFileBroker({
    ...value,
    fs: {
      openPath: async (path, ...args) => {
        const handle = await open(path, ...args);
        if (!path.endsWith(".bin")) return handle;
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          if (!injected) {
            injected = true;
            await writeFile(first, "external edit\n", "utf8");
          }
        };
        return handle;
      },
    },
  });
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    }), (error) => error.code === "file_conflict" && error.recoveryRequired === true);
    await assert.rejects(broker.dispatch("create_text", { path: "src\\must-not-create.js", text: "blocked\n" }),
      (error) => error.code === "recovery_required" && error.recoveryRequired === true);
    await assert.rejects(readFile(deniedCreate), { code: "ENOENT" });
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("does not write after the grant expires during preparation", async () => {
  const value = await fixture();
  const expiresAt = Date.now() + 1_000;
  value.grant = { ...value.grant, expiresAt };
  let current = Date.now();
  const broker = createFileBroker({
    ...value,
    clock: () => current,
    fs: {
      openPath: async (path, ...args) => {
        const handle = await open(path, ...args);
        if (path.endsWith(".bin")) {
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => { await originalSync(); current = expiresAt + 1; };
        }
        return handle;
      },
    },
  });
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    }), { code: "grant_expired" });
    assert.equal((await readFile(join(value.workspace, "src", "auth.js"))).toString(), "\uFEFFold\r\nsecond\r\n");
    assert.equal(broker.recoverySummary().recoveryRequired, true);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("marks a prepared replacement for recovery when cancellation arrives before its write", async () => {
  const value = await fixture();
  const abort = new AbortController();
  let journalSyncs = 0;
  const broker = createFileBroker({
    ...value,
    signal: abort.signal,
    fs: {
      openPath: async (path, ...args) => {
        const handle = await open(path, ...args);
        if (!path.endsWith(".jsonl")) return handle;
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          journalSyncs += 1;
          if (journalSyncs === 1) abort.abort();
        };
        return handle;
      },
    },
  });
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    }), (error) => error.code === "cancelled"
      && error.recoveryRequired === true
      && error.filesChanged.includes("src\\auth.js"));
    assert.deepEqual(await readFile(join(value.workspace, "src", "auth.js")), Buffer.from("\uFEFFold\r\nsecond\r\n", "utf8"));
    const summary = broker.recoverySummary();
    assert.deepEqual(summary.filesChanged, ["src\\auth.js"]);
    assert.equal(summary.recoveryRequired, true);
    const records = (await readFile(join(value.journalDirectory, "job_broker.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(records.map((record) => record.phase), ["prepared", "recovery_required"]);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("retains a newly created file when its applied journal record cannot be confirmed", async () => {
  const value = await fixture();
  const abort = new AbortController();
  const createdPath = join(value.workspace, "src", "pending.js");
  const broker = createFileBroker({
    ...value,
    signal: abort.signal,
    fs: {
      openPath: async (path, ...args) => {
        const handle = await open(path, ...args);
        if (path !== createdPath) return handle;
        const originalSync = handle.sync.bind(handle);
        handle.sync = async () => {
          await originalSync();
          abort.abort();
        };
        return handle;
      },
    },
  });
  try {
    await assert.rejects(broker.dispatch("create_text", { path: "src\\pending.js", text: "export const pending = true;\n" }),
      (error) => error.code === "cancelled" && error.recoveryRequired === true);
    assert.equal(await readFile(createdPath, "utf8"), "export const pending = true;\n");
    assert.equal(broker.recoverySummary().recoveryRequired, true);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("does not modify the target when backup storage short-writes", async () => {
  const value = await fixture();
  const target = join(value.workspace, "src", "auth.js");
  const realOpen = open;
  let backupWrites = 0;
  const broker = createFileBroker({
    ...value,
    fs: {
      openPath: async (path, ...args) => {
        const handle = await realOpen(path, ...args);
        if (!path.endsWith(".bin")) return handle;
        const originalWrite = handle.write.bind(handle);
        handle.write = async (buffer, offset = 0, length = buffer.length, position = null) => {
          backupWrites += 1;
          if (backupWrites > 1) return { bytesWritten: 0, buffer };
          const shortLength = Math.min(1, length);
          return originalWrite(buffer, offset, shortLength, position);
        };
        return handle;
      },
    },
  });
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    }), { code: "recovery_required" });
    assert.deepEqual(await readFile(target), Buffer.from("\uFEFFold\r\nsecond\r\n", "utf8"));
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("does not write the target when the backup cannot be stored", async () => {
  await withBroker(async ({ broker, workspace }) => {
    const before = await readFile(join(workspace, "src", "auth.js"));
    const sourceBroker = createFileBroker;
    assert.equal(typeof sourceBroker, "function");
    await assert.rejects(broker.dispatch("replace_text", {
      path: "src\\auth.js",
      expected_sha256: "b".repeat(64),
      old_text: "old",
      new_text: "new",
    }), { code: "file_conflict" });
    assert.deepEqual(await readFile(join(workspace, "src", "auth.js")), before);
  });
});

test("previews and applies an operator-selected backup only after hash confirmation", async () => {
  const value = await fixture();
  const broker = createFileBroker(value);
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    const changed = await broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });
    await broker.finish();
    const preview = await previewRecovery({ ...value, jobId: value.grant.jobId, workspace: value.workspace });
    assert.equal(preview.records.length, 1);
    assert.equal(preview.records[0].phase, "applied");
    const journalText = await readFile(join(value.journalDirectory, "job_broker.jsonl"), "utf8");
    const prepared = JSON.parse(journalText.split("\n")[0]);
    const applied = JSON.parse(journalText.split("\n")[1]);
    assert.equal(applied.phase, "applied");
    assert.equal(changed.sha256, applied.intendedAfterHash);
    const restored = await applyRecovery({
      ...value,
      jobId: value.grant.jobId,
      relativePath: "src\\auth.js",
      backupRef: prepared.backupRef,
      expectedCurrentHash: changed.sha256,
    });
    assert.equal(restored.status, "restored");
    assert.deepEqual(await readFile(join(value.workspace, "src", "auth.js")), Buffer.from("\uFEFFold\r\nsecond\r\n"));
    const restoredPreview = await previewRecovery({ ...value, jobId: value.grant.jobId, workspace: value.workspace });
    assert.equal(restoredPreview.recoveryRequired, false);
    assert.equal(restoredPreview.records.find((record) => record.operation === "replace_text").unresolved, false);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("recovery refuses to overwrite an external save made before its final handle check", async () => {
  const value = await fixture();
  const target = join(value.workspace, "src", "auth.js");
  const broker = createFileBroker(value);
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    const changed = await broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });
    await broker.finish();
    const [prepared] = (await readFile(join(value.journalDirectory, "job_broker.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse);
    let injected = false;
    await assert.rejects(applyRecovery({
      ...value,
      jobId: value.grant.jobId,
      relativePath: "src\\auth.js",
      backupRef: prepared.backupRef,
      expectedCurrentHash: changed.sha256,
      fs: {
        openPath: async (path, ...args) => {
          const handle = await open(path, ...args);
          if (path === target && args[0] === "r+" && !injected) {
            injected = true;
            await writeFile(target, "later user edit\n", "utf8");
          }
          return handle;
        },
      },
    }), { code: "file_conflict" });
    assert.equal(await readFile(target, "utf8"), "later user edit\n");
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("recovery refuses a target path replaced after its prepared record", async () => {
  const value = await fixture();
  const target = join(value.workspace, "src", "auth.js");
  const moved = join(value.workspace, "src", "moved-auth.js");
  const broker = createFileBroker(value);
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    const changed = await broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });
    await broker.finish();
    const [prepared] = (await readFile(join(value.journalDirectory, "job_broker.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse);
    let injected = false;
    await assert.rejects(applyRecovery({
      ...value,
      jobId: value.grant.jobId,
      relativePath: "src\\auth.js",
      backupRef: prepared.backupRef,
      expectedCurrentHash: changed.sha256,
      fs: {
        openPath: async (path, ...args) => {
          const handle = await open(path, ...args);
          if (path !== join(value.journalDirectory, "job_broker.jsonl") || args[0] !== "a") return handle;
          const originalSync = handle.sync.bind(handle);
          handle.sync = async () => {
            await originalSync();
            if (!injected) {
              injected = true;
              await rename(target, moved);
              await writeFile(target, "user replacement\n", "utf8");
            }
          };
          return handle;
        },
      },
    }), { code: "file_conflict" });
    assert.deepEqual(await readFile(moved), Buffer.from("\uFEFFnew\r\nsecond\r\n", "utf8"));
    assert.equal(await readFile(target, "utf8"), "user replacement\n");
    const preview = await previewRecovery({ ...value, jobId: value.grant.jobId, workspace: value.workspace });
    assert.equal(preview.recoveryRequired, true);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("preview marks a prepared source operation resolved after its linked restore applies", async () => {
  const value = await fixture();
  const broker = createFileBroker(value);
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    const changed = await broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });
    await broker.finish();
    const journalPath = join(value.journalDirectory, "job_broker.jsonl");
    const [prepared] = (await readFile(journalPath, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    await writeFile(journalPath, `${JSON.stringify(prepared)}\n`, "utf8");
    await applyRecovery({
      ...value,
      jobId: value.grant.jobId,
      relativePath: "src\\auth.js",
      backupRef: prepared.backupRef,
      expectedCurrentHash: changed.sha256,
    });
    const preview = await previewRecovery({ ...value, jobId: value.grant.jobId, workspace: value.workspace });
    assert.equal(preview.recoveryRequired, false);
    assert.equal(preview.records.find((record) => record.operation === "replace_text")?.unresolved, false);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("records recovery uncertainty when restore bytes are written but its applied journal append fails", async () => {
  const value = await fixture();
  const broker = createFileBroker(value);
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    const changed = await broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });
    await broker.finish();
    const [prepared] = (await readFile(join(value.journalDirectory, "job_broker.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse);
    let recoveryJournalWrites = 0;
    await assert.rejects(applyRecovery({
      ...value,
      jobId: value.grant.jobId,
      relativePath: "src\\auth.js",
      backupRef: prepared.backupRef,
      expectedCurrentHash: changed.sha256,
      fs: {
        openPath: async (path, ...args) => {
          const handle = await open(path, ...args);
          if (!path.endsWith(".jsonl")) return handle;
          const originalWrite = handle.write.bind(handle);
          handle.write = async (...writeArgs) => {
            recoveryJournalWrites += 1;
            if (recoveryJournalWrites === 2) throw new Error("applied journal unavailable");
            return originalWrite(...writeArgs);
          };
          return handle;
        },
      },
    }), { code: "recovery_required" });
    assert.deepEqual(await readFile(join(value.workspace, "src", "auth.js")), Buffer.from("\uFEFFold\r\nsecond\r\n", "utf8"));
    const records = (await readFile(join(value.journalDirectory, "job_broker.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(JSON.parse)
      .filter((record) => record.operation === "recovery_restore");
    assert.deepEqual(records.map((record) => record.phase), ["prepared", "recovery_required"]);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("a failed restore sync cannot clear recovery when its error marker also fails", async () => {
  const value = await fixture();
  const broker = createFileBroker(value);
  try {
    const before = await broker.dispatch("read_text", { path: "src/auth.js" });
    const changed = await broker.dispatch("replace_text", {
      path: "src/auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });
    await broker.finish();
    const journalPath = join(value.journalDirectory, "job_broker.jsonl");
    const [source] = (await readFile(journalPath, "utf8")).trim().split("\n").map(JSON.parse);
    let journalOpens = 0;
    await assert.rejects(applyRecovery({ ...value, jobId: "job_broker", relativePath: "src/auth.js",
      backupRef: before.sha256, expectedCurrentHash: changed.sha256, fs: {
        openPath: async (path, ...args) => {
          if (path === journalPath && ++journalOpens >= 3) throw Object.assign(new Error("marker unavailable"), { code: "EIO" });
          const handle = await open(path, ...args);
          if (path === journalPath && journalOpens === 2) {
            handle.sync = async () => { throw Object.assign(new Error("applied sync failed"), { code: "EIO" }); };
          }
          return handle;
        },
      } }), { code: "recovery_required" });
    const failed = await summarizeRecoveryJournal({ ...value, jobId: "job_broker" });
    assert.equal(failed.recoveryRequired, true);
    assert.ok(!failed.resolvedOperationIds.includes(source.opId));
    assert.equal((await previewRecovery({ ...value, jobId: "job_broker" })).recoveryRequired, true);
    let retryJournalSyncs = 0;
    await assert.rejects(applyRecovery({ ...value, jobId: "job_broker", relativePath: "src/auth.js",
      backupRef: before.sha256, expectedCurrentHash: before.sha256, fs: {
        openPath: async (path, ...args) => {
          const handle = await open(path, ...args);
          if (path === journalPath) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
              if (++retryJournalSyncs === 2) throw Object.assign(new Error("retry sync failed"), { code: "EIO" });
              return sync();
            };
          }
          return handle;
        },
      } }), { code: "recovery_required" });
    // A later operator-confirmed retry for the same source can complete recovery.
    await applyRecovery({ ...value, jobId: "job_broker", relativePath: "src/auth.js",
      backupRef: before.sha256, expectedCurrentHash: before.sha256 });
    const recovered = await summarizeRecoveryJournal({ ...value, jobId: "job_broker" });
    assert.equal(recovered.recoveryRequired, false);
    assert.ok(recovered.resolvedOperationIds.includes(source.opId));
  } finally { await broker.finish(); await rm(value.workspace, { recursive: true, force: true }); }
});

test("preview retains validated journal records when the tail is malformed", async () => {
  const value = await fixture();
  const broker = createFileBroker(value);
  try {
    const before = await broker.dispatch("read_text", { path: "src\\auth.js" });
    await broker.dispatch("replace_text", {
      path: "src\\auth.js", expected_sha256: before.sha256, old_text: "old", new_text: "new",
    });
    await broker.finish();
    await writeFile(join(value.journalDirectory, "job_broker.jsonl"), "{broken tail\n", { flag: "a" });
    const preview = await previewRecovery({ ...value, jobId: value.grant.jobId, workspace: value.workspace });
    assert.equal(preview.tailInvalid, true);
    assert.equal(preview.recoveryRequired, true);
    assert.equal(preview.records.length, 1);
  } finally {
    await broker.finish();
    await rm(value.workspace, { recursive: true, force: true });
  }
});

test("treats only an absent journal as safe and fails closed for unavailable journals", async () => {
  const value = await fixture();
  try {
    for (const [code, recoveryRequired, journalState] of [
      ["ENOENT", false, "absent"],
      ["EACCES", true, "unavailable"],
      ["EIO", true, "unavailable"],
    ]) {
      const summary = await summarizeRecoveryJournal({
        journalDirectory: value.journalDirectory,
        jobId: value.grant.jobId,
        fs: {
          readFilePath: async () => {
            const error = new Error(`journal ${code}`);
            error.code = code;
            throw error;
          },
        },
      });
      assert.equal(summary.recoveryRequired, recoveryRequired);
      assert.equal(summary.journalState, journalState);
      assert.equal(summary.journalVerified, false);
      if (recoveryRequired) assert.equal(summary.recoveryId, "recovery_job_broker");
      else assert.equal(summary.recoveryId, undefined);
    }
    const malformed = await summarizeRecoveryJournal({
      journalDirectory: value.journalDirectory,
      jobId: value.grant.jobId,
      fs: { readFilePath: async () => "{broken journal\n" },
    });
    assert.deepEqual(malformed, {
      filesChanged: [], recoveryRequired: true, recoveryId: "recovery_job_broker",
      resolvedOperationIds: [],
      journalState: "invalid", journalVerified: false,
    });
    const oversized = await summarizeRecoveryJournal({
      journalDirectory: value.journalDirectory,
      jobId: value.grant.jobId,
      fs: { readFilePath: async () => "x".repeat((2 * 1024 * 1024) + 1) },
    });
    assert.deepEqual(oversized, {
      filesChanged: [], recoveryRequired: true, recoveryId: "recovery_job_broker",
      journalState: "oversize", journalVerified: false,
    });
  } finally {
    await rm(value.workspace, { recursive: true, force: true });
  }
});
