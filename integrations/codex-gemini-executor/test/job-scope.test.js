import test from "node:test";
import assert from "node:assert/strict";

import {
  JobScopeError,
  authorizePath,
  createGrant,
  normalizeToolPath,
  resolveScope,
} from "../src/job-scope.js";

function fixture() {
  const entries = new Map([
    ["D:\\Repo", "directory"],
    ["D:\\Repo\\src", "directory"],
    ["D:\\Repo\\src2", "directory"],
    ["D:\\Repo\\src\\auth.js", "file"],
    ["D:\\Repo\\src\\new.js", "file"],
    ["D:\\Repo\\.env", "file"],
    ["C:\\Runtime", "directory"],
  ]);
  const links = new Set();
  return {
    entries,
    links,
    permittedWorkspaceRoots: ["D:\\Repo"],
    realpathPath: async (path) => {
      if (!entries.has(path) && path !== "D:\\Repo\\src\\created.js") {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return path;
    },
    lstatPath: async (path) => {
      if (!entries.has(path)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      const kind = entries.get(path);
      return {
        isFile: () => kind === "file",
        isDirectory: () => kind === "directory",
        isSymbolicLink: () => links.has(path),
        nlink: 1,
      };
    },
    statPath: async (path) => ({
      isDirectory: () => entries.get(path) === "directory",
    }),
  };
}

async function scopedGrant(overrides = {}) {
  const fs = fixture();
  const resolvedScope = await resolveScope({
    workspace: "D:\\Repo",
    access: "scoped-edit",
    task: "edit auth",
    scope: { read: ["src"], write: ["src"], allow_create: true },
  }, { permittedWorkspaceRoots: fs.permittedWorkspaceRoots }, fs);
  return { fs, grant: createGrant({
    jobId: "job_scope",
    resolvedScope,
    taskHash: "a".repeat(64),
    runtimeFingerprint: "runtime-fingerprint",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }) };
}

test("preserves exact Windows file identities larger than Number.MAX_SAFE_INTEGER", async () => {
  const fs = fixture();
  const originalLstat = fs.lstatPath;
  const optionsSeen = [];
  fs.lstatPath = async (path, options) => {
    optionsSeen.push(options);
    return { ...await originalLstat(path), dev: 42n, ino: 36591746973877641n, nlink: 1, size: 8 };
  };
  const resolved = await resolveScope({ workspace: "D:\\Repo", access: "read-only", task: "fixture",
    scope: { read: ["src"], write: [], allow_create: false } }, { permittedWorkspaceRoots: fs.permittedWorkspaceRoots }, fs);
  assert.equal(resolved.read[0].identity.ino, "36591746973877641");
  assert.ok(optionsSeen.length > 0 && optionsSeen.every((options) => options.bigint === true));
});

test("rejects sibling-prefix writes and protected files before granting scope", async () => {
  const fs = fixture();
  await assert.rejects(resolveScope({
    workspace: "D:\\Repo",
    access: "scoped-edit",
    task: "edit",
    scope: { read: ["src"], write: ["src2"], allow_create: false },
  }, { permittedWorkspaceRoots: fs.permittedWorkspaceRoots }, fs), (error) => error instanceof JobScopeError && error.code === "scope_denied");

  await assert.rejects(resolveScope({
    workspace: "D:\\Repo",
    access: "read-only",
    task: "read env",
    scope: { read: [".env"], write: [], allow_create: false },
  }, { permittedWorkspaceRoots: fs.permittedWorkspaceRoots }, fs), { code: "scope_denied" });
});

test("rejects links, hardlinks, and protected runtime overlap", async () => {
  const fs = fixture();
  fs.links.add("D:\\Repo\\src");
  await assert.rejects(resolveScope({
    workspace: "D:\\Repo",
    access: "read-only",
    task: "inspect",
    scope: { read: ["src"], write: [], allow_create: false },
  }, { permittedWorkspaceRoots: fs.permittedWorkspaceRoots }, fs), { code: "scope_denied" });

  fs.links.clear();
  fs.lstatPath = async (path) => ({
    isFile: () => path.endsWith("auth.js"),
    isDirectory: () => !path.endsWith("auth.js"),
    isSymbolicLink: () => false,
    nlink: path.endsWith("auth.js") ? 2 : 1,
  });
  await assert.rejects(resolveScope({
    workspace: "D:\\Repo",
    access: "read-only",
    task: "inspect",
    scope: { read: ["src\\auth.js"], write: [], allow_create: false },
  }, { permittedWorkspaceRoots: fs.permittedWorkspaceRoots }, fs), { code: "scope_denied" });

  const protectedFixture = fixture();
  protectedFixture.entries.set("D:\\Repo\\runtime", "directory");
  await assert.rejects(resolveScope({
    workspace: "D:\\Repo",
    access: "read-only",
    task: "inspect",
    scope: { read: ["runtime"], write: [], allow_create: false },
  }, { permittedWorkspaceRoots: protectedFixture.permittedWorkspaceRoots, runtimeRoot: "D:\\Repo\\runtime" }, protectedFixture), { code: "scope_denied" });
});

test("authorizes exact scoped files and denies outside paths without leaking bytes", async () => {
  const { fs, grant } = await scopedGrant();
  const authorized = await authorizePath(grant, { operation: "read_text", path: "src\\auth.js" }, fs);
  assert.equal(authorized.relativePath, "src\\auth.js");
  await assert.rejects(authorizePath(grant, { operation: "replace_text", path: "src2\\auth.js" }, fs), { code: "scope_denied" });
  await assert.rejects(authorizePath(grant, { operation: "delete", path: "src\\auth.js" }, fs), { code: "operation_denied" });
});

test("rechecks lexical reparse points and hardlink identity on every authorized operation", async () => {
  const { fs, grant } = await scopedGrant();
  fs.entries.set("D:\\Repo\\src\\alias", "directory");
  fs.entries.set("D:\\Repo\\src\\alias\\marker.txt", "file");
  fs.links.add("D:\\Repo\\src\\alias");
  const originalRealpath = fs.realpathPath;
  fs.realpathPath = async (path) => path.startsWith("D:\\Repo\\src\\alias")
    ? path.replace("D:\\Repo\\src\\alias", "D:\\Repo\\src\\.git")
    : originalRealpath(path);
  await assert.rejects(authorizePath(grant, { operation: "read_text", path: "src\\alias\\marker.txt" }, fs), { code: "scope_denied" });

  fs.links.clear();
  fs.entries.set("D:\\Repo\\src\\linked.txt", "file");
  const originalLstat = fs.lstatPath;
  fs.lstatPath = async (path) => {
    const stats = await originalLstat(path);
    if (path === "D:\\Repo\\src\\linked.txt") return { ...stats, nlink: 2 };
    return stats;
  };
  await assert.rejects(authorizePath(grant, { operation: "read_text", path: "src\\linked.txt" }, fs), { code: "scope_denied" });
});

test("authorizes create only under an existing write directory and rejects expired grants", async () => {
  const { fs, grant } = await scopedGrant();
  const target = await authorizePath(grant, { operation: "create_text", path: "src\\created.js" }, fs);
  assert.equal(target.exists, false);
  assert.equal(target.parentPath, "D:\\Repo\\src");
  await assert.rejects(authorizePath(grant, { operation: "create_text", path: "src2\\created.js" }, fs), { code: "scope_denied" });
  const expired = { ...grant, expiresAt: Date.now() - 1 };
  await assert.rejects(authorizePath(expired, { operation: "read_text", path: "src\\auth.js" }, fs), { code: "grant_expired" });
});

test("rejects a missing create target when the grant does not allow creation", async () => {
  const fs = fixture();
  const resolvedScope = await resolveScope({
    workspace: "D:\\Repo",
    access: "scoped-edit",
    task: "edit",
    scope: { read: ["src"], write: ["src"], allow_create: false },
  }, { permittedWorkspaceRoots: fs.permittedWorkspaceRoots }, fs);
  const grant = createGrant({
    jobId: "job_no_create",
    resolvedScope,
    taskHash: "a".repeat(64),
    runtimeFingerprint: "runtime-fingerprint",
    expiresAt: Date.now() + 60_000,
  });
  await assert.rejects(authorizePath(grant, { operation: "create_text", path: "src\\new-file.js" }, fs), { code: "operation_denied" });
});

test("rejects path segments ending in a dot or space", () => {
  assert.throws(() => normalizeToolPath("src\\bad."), { code: "invalid_request" });
  assert.throws(() => normalizeToolPath("src\\bad "), { code: "invalid_request" });
});
