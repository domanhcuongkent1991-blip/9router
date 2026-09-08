import { win32 } from "node:path";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
const MAX_CHANGED_FILES = 1_024;

export class WorkspacePrepareError extends Error {
  constructor(code, reason) {
    super("Workspace preparation failed");
    this.name = "WorkspacePrepareError";
    this.code = code;
    this.details = { reason };
  }
}

function contained(root, candidate) {
  const relative = win32.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative);
}

function containedOrEqual(root, candidate) {
  return win32.normalize(root).toLowerCase() === win32.normalize(candidate).toLowerCase() || contained(root, candidate);
}

function safeJobSegment(jobId) {
  if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(jobId)) {
    throw new WorkspacePrepareError("workspace_prepare_error", "invalid_job_id");
  }
  return jobId;
}

function stdoutOf(result) {
  const value = typeof result === "string" || Buffer.isBuffer(result) ? result : result?.stdout;
  const output = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_GIT_OUTPUT_BYTES) {
    throw new WorkspacePrepareError("workspace_prepare_error", "invalid_git_output");
  }
  return output;
}

export function createWorkspaceManager({
  worktreeRoot,
  execFile,
  realpathPath,
  lstatPath,
  mkdirPath,
}) {
  if (typeof worktreeRoot !== "string" || !win32.isAbsolute(worktreeRoot)
    || typeof execFile !== "function" || typeof realpathPath !== "function"
    || typeof lstatPath !== "function" || typeof mkdirPath !== "function") {
    throw new WorkspacePrepareError("workspace_prepare_error", "invalid_configuration");
  }

  async function git(workspace, args) {
    try {
      return stdoutOf(await execFile("git", ["-C", workspace, ...args], {
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: 10_000,
      }));
    } catch (error) {
      if (error instanceof WorkspacePrepareError) throw error;
      throw new WorkspacePrepareError("workspace_prepare_error", "git_failed");
    }
  }

  async function prepare(request, jobId, repository) {
    const workspace = request?.workspace;
    if (typeof workspace !== "string" || !win32.isAbsolute(workspace)) {
      throw new WorkspacePrepareError("workspace_prepare_error", "invalid_workspace");
    }
    if (request.sessionId) {
      const context = request.resumeContext;
      if (!context || !win32.isAbsolute(context.executionWorkspace ?? "")) {
        throw new WorkspacePrepareError("invalid_request", "unknown_session_workspace");
      }
      const actual = await realpathPath(context.executionWorkspace);
      if (win32.normalize(actual).toLowerCase() !== win32.normalize(context.executionWorkspace).toLowerCase()) {
        throw new WorkspacePrepareError("invalid_request", "session_workspace_changed");
      }
      if (request.access === "read-only") {
        if (context.worktreePath !== null || !containedOrEqual(workspace, actual) || actual.toLowerCase() !== workspace.toLowerCase()) {
          throw new WorkspacePrepareError("invalid_request", "session_access_changed");
        }
      } else {
        if (context.worktreePath !== actual || !contained(await realpathPath(worktreeRoot), actual)
          || !COMMIT_PATTERN.test(context.head ?? "")) {
          throw new WorkspacePrepareError("invalid_request", "invalid_session_worktree");
        }
        const common = async (directory) => realpathPath((await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
        if ((await common(workspace)).toLowerCase() !== (await common(actual)).toLowerCase()
          || (await git(actual, ["rev-parse", "--verify", "HEAD"])).trim().toLowerCase() !== context.head) {
          throw new WorkspacePrepareError("invalid_request", "session_repository_changed");
        }
      }
      return Object.freeze({ ...context });
    }
    if (request.access === "read-only") {
      return Object.freeze({ executionWorkspace: workspace, worktreePath: null, head: null });
    }
    if (request.access !== "workspace-write") {
      throw new WorkspacePrepareError("workspace_prepare_error", "invalid_access");
    }

    const repositoryRoot = repository?.repositoryRoot ?? workspace;
    const status = await git(repositoryRoot, ["status", "--porcelain=v1", "-z"]);
    if (status.length > 0) throw new WorkspacePrepareError("workspace_dirty", "existing_changes");
    const head = (await git(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).trim().toLowerCase();
    if (!COMMIT_PATTERN.test(head)) throw new WorkspacePrepareError("workspace_prepare_error", "invalid_head");

    await mkdirPath(worktreeRoot, { recursive: true });
    let canonicalRoot;
    try {
      canonicalRoot = await realpathPath(worktreeRoot);
    } catch {
      throw new WorkspacePrepareError("workspace_prepare_error", "worktree_root_unavailable");
    }
    const target = win32.join(canonicalRoot, safeJobSegment(jobId));
    if (!contained(canonicalRoot, target)) throw new WorkspacePrepareError("workspace_prepare_error", "worktree_escape");
    try {
      await lstatPath(target);
      throw new WorkspacePrepareError("workspace_prepare_error", "worktree_exists");
    } catch (error) {
      if (error instanceof WorkspacePrepareError) throw error;
      if (error?.code !== "ENOENT") throw new WorkspacePrepareError("workspace_prepare_error", "worktree_probe_failed");
    }

    await git(repositoryRoot, ["worktree", "add", "--detach", target, head]);
    let canonicalTarget;
    try {
      canonicalTarget = await realpathPath(target);
    } catch {
      throw new WorkspacePrepareError("workspace_prepare_error", "worktree_unavailable");
    }
    if (!contained(canonicalRoot, canonicalTarget) || win32.normalize(canonicalTarget) !== win32.normalize(target)) {
      // Never remove a suspicious worktree automatically; retain it for inspection.
      throw new WorkspacePrepareError("workspace_prepare_error", "worktree_escape");
    }
    return Object.freeze({ executionWorkspace: canonicalTarget, worktreePath: canonicalTarget, head });
  }

  async function resolveRepository(request) {
    const workspace = request?.workspace;
    if (request?.access !== "workspace-write" || typeof workspace !== "string" || !win32.isAbsolute(workspace)) {
      throw new WorkspacePrepareError("workspace_prepare_error", "invalid_repository_request");
    }
    const reported = (await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
    if (!win32.isAbsolute(reported)) throw new WorkspacePrepareError("workspace_prepare_error", "invalid_repository_root");
    let repositoryRoot;
    try { repositoryRoot = await realpathPath(reported); } catch {
      throw new WorkspacePrepareError("workspace_prepare_error", "repository_root_unavailable");
    }
    if (!win32.isAbsolute(repositoryRoot) || !containedOrEqual(repositoryRoot, workspace)) {
      throw new WorkspacePrepareError("workspace_prepare_error", "workspace_outside_repository");
    }
    return Object.freeze({ repositoryRoot });
  }

  async function collectChanges(workspace) {
    if (!workspace?.worktreePath) return [];
    if (typeof workspace.executionWorkspace !== "string" || !win32.isAbsolute(workspace.executionWorkspace)
      || !COMMIT_PATTERN.test(workspace.head ?? "")) {
      throw new WorkspacePrepareError("workspace_prepare_error", "invalid_worktree_context");
    }
    const tracked = await git(workspace.executionWorkspace, ["diff", "--name-only", "-z", "--no-ext-diff", workspace.head]);
    const untracked = await git(workspace.executionWorkspace, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const files = [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))].sort();
    if (files.length > MAX_CHANGED_FILES || files.some((file) => {
      const normalized = win32.normalize(file);
      return win32.isAbsolute(file) || normalized === ".." || normalized.startsWith(`..${win32.sep}`)
        || Buffer.byteLength(file, "utf8") > 4096;
    })) {
      throw new WorkspacePrepareError("workspace_prepare_error", "invalid_changed_files");
    }
    return files;
  }

  return Object.freeze({ resolveRepository, prepare, collectChanges });
}
