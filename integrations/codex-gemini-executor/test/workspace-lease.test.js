import test from "node:test";
import assert from "node:assert/strict";

import { WorkspaceLeaseError, createWorkspaceLeaseManager } from "../src/workspace-lease.js";

test("allows concurrent readers but only one writer per canonical workspace", async () => {
  const leases = createWorkspaceLeaseManager();
  const readerA = await leases.acquire({ workspace: "D:\\Repo", access: "read-only" });
  const readerB = await leases.acquire({ workspace: "d:\\repo", access: "read-only" });
  const writer = await leases.acquire({ workspace: "D:\\Repo", access: "workspace-write" });

  await assert.rejects(
    leases.acquire({ workspace: "d:\\repo", access: "workspace-write" }),
    WorkspaceLeaseError,
  );
  await readerA.release();
  await readerB.release();
  await writer.release();
  await writer.release();
  const next = await leases.acquire({ workspace: "D:\\Repo", access: "workspace-write" });
  await next.release();
});

test("rejects malformed lease requests", async () => {
  const leases = createWorkspaceLeaseManager();
  for (const request of [
    { workspace: "relative", access: "workspace-write" },
    { workspace: "D:\\Repo", access: "full" },
  ]) {
    await assert.rejects(leases.acquire(request), { code: "workspace_lease_error" });
  }
});
