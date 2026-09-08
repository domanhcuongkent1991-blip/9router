import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backup = vi.hoisted(() => ({
  makeBackupDir: vi.fn(),
  backupDbLite: vi.fn(),
  backupFile: vi.fn(),
  pruneOldBackups: vi.fn(),
}));

// Keep migration control flow real while isolating all disk/DB operations.
vi.mock("@/lib/db/backup.js", () => backup);
vi.mock("@/lib/db/paths.js", () => ({ DB_DIR: "memory-db", LEGACY_FILES: {} }));
vi.mock("@/lib/db/version.js", () => ({ getAppVersion: () => "test-version" }));
vi.mock("node:fs", () => ({ default: { existsSync: () => false } }));

import { runMigrationOnce } from "@/lib/db/migrate.js";
import { SCHEMA_VERSION, TABLES, buildCreateTableSql } from "@/lib/db/schema.js";
import { latestVersion } from "@/lib/db/migrations/index.js";

function createAdapter() {
  const meta = new Map([["backupSchemaVersion", "0"], ["schemaVersion", "0"]]);
  return {
    meta,
    exec: vi.fn(),
    get: vi.fn((sql, params) => {
      if (sql.includes("COUNT(*)")) return { c: meta.size };
      return meta.has(params[0]) ? { value: meta.get(params[0]) } : undefined;
    }),
    all: vi.fn((sql) => {
      const table = /^PRAGMA table_info\((\w+)\)$/.exec(sql)?.[1];
      if (!table) throw new Error(`Unexpected query: ${sql}`);
      return Object.keys(TABLES[table].columns).map((name) => ({ name }));
    }),
    run: vi.fn((_sql, [key, value]) => meta.set(key, value)),
    transaction: vi.fn((fn) => fn()),
  };
}

describe("Schema migration backup gate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    backup.makeBackupDir.mockReturnValue("memory-backup");
    backup.backupDbLite.mockReturnValue("memory-backup/data.sqlite");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["makeBackupDir", "backupDbLite"])("aborts when %s fails and retries the same adapter after recovery", async (operation) => {
    const adapter = createAdapter();
    const backupError = new Error("checkpoint unavailable");
    backup[operation].mockImplementationOnce(() => { throw backupError; });

    await expect(runMigrationOnce(adapter)).rejects.toThrow(/pre-schema backup failed.*aborted/i);
    expect(adapter.exec.mock.calls).toEqual([[buildCreateTableSql("_meta", TABLES._meta)]]);
    expect(adapter.run).not.toHaveBeenCalled();
    expect(adapter.transaction).not.toHaveBeenCalled();
    expect(backup.pruneOldBackups).not.toHaveBeenCalled();
    expect(adapter.meta.get("backupSchemaVersion")).toBe("0");

    await runMigrationOnce(adapter);

    expect(backup.makeBackupDir).toHaveBeenCalledTimes(2);
    expect(adapter.meta.get("backupSchemaVersion")).toBe(String(SCHEMA_VERSION));
    expect(adapter.meta.get("schemaVersion")).toBe(String(latestVersion()));
    const successfulBackupOrder = backup.backupDbLite.mock.invocationCallOrder.at(-1);
    expect(successfulBackupOrder).toBeLessThan(adapter.transaction.mock.invocationCallOrder[0]);
    expect(successfulBackupOrder).toBeLessThan(adapter.run.mock.invocationCallOrder[0]);

    const completedExecCount = adapter.exec.mock.calls.length;
    await runMigrationOnce(adapter);
    expect(adapter.exec).toHaveBeenCalledTimes(completedExecCount);
    expect(backup.makeBackupDir).toHaveBeenCalledTimes(2);
  });
});
