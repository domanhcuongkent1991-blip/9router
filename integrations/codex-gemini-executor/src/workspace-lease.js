import { posix, win32 } from "node:path";

export class WorkspaceLeaseError extends Error {
  constructor(code, reason) {
    super(code === "workspace_locked" ? "Workspace already has an active writer" : "Invalid workspace lease request");
    this.name = "WorkspaceLeaseError";
    this.code = code;
    this.details = { reason };
  }
}

function workspaceKey(workspace) {
  if (typeof workspace !== "string" || (!win32.isAbsolute(workspace) && !posix.isAbsolute(workspace))) {
    throw new WorkspaceLeaseError("workspace_lease_error", "absolute_workspace_required");
  }
  return win32.isAbsolute(workspace) ? win32.normalize(workspace).toLowerCase() : posix.normalize(workspace);
}

export function createWorkspaceLeaseManager() {
  const writers = new Set();

  async function acquire({ workspace, access } = {}) {
    const key = workspaceKey(workspace);
    if (access !== "read-only" && access !== "workspace-write") {
      throw new WorkspaceLeaseError("workspace_lease_error", "invalid_access");
    }
    if (access === "workspace-write" && writers.has(key)) {
      throw new WorkspaceLeaseError("workspace_locked", "writer_active");
    }
    if (access === "workspace-write") writers.add(key);
    let released = false;
    return Object.freeze({
      async release() {
        if (released) return;
        released = true;
        if (access === "workspace-write") writers.delete(key);
      },
    });
  }

  return Object.freeze({ acquire });
}
