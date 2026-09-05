import { win32 } from "node:path";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const STATUSES = new Set(["starting", "running", "awaiting_approval", ...TERMINAL]);
const MAX_STATE_BYTES = 64 * 1024;
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/u;

export class JobStateError extends Error {
  constructor(code, reason) {
    super("Gemini job state failure");
    this.name = "JobStateError";
    this.code = code;
    this.details = { reason };
  }
}

function minimal(snapshot, revision, updatedAt) {
  if (!snapshot || !SAFE_JOB_ID.test(snapshot.jobId) || !STATUSES.has(snapshot.status)) {
    throw new JobStateError("state_error", "invalid_snapshot");
  }
  const output = {
    jobId: snapshot.jobId,
    status: snapshot.status,
    revision,
    ...(typeof snapshot.workspace === "string" ? { workspace: snapshot.workspace } : {}),
    ...(Object.hasOwn(snapshot, "worktreePath") ? { worktreePath: snapshot.worktreePath ?? null } : {}),
    ...(typeof snapshot.sessionId === "string" ? { sessionId: snapshot.sessionId } : {}),
    updatedAt,
  };
  const category = snapshot.error?.category;
  if (typeof category === "string") output.error = { category };
  const json = JSON.stringify(output);
  if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) throw new JobStateError("state_error", "state_too_large");
  return output;
}

export function createJobStateStore({ stateRoot, mkdirPath, writeFile, renamePath, readFile, listDirectory, now = () => new Date().toISOString() }) {
  if (typeof stateRoot !== "string" || !win32.isAbsolute(stateRoot)
    || [mkdirPath, writeFile, renamePath, readFile, listDirectory, now].some((value) => typeof value !== "function")) {
    throw new JobStateError("state_error", "invalid_configuration");
  }
  const revisions = new Map();
  const writes = new Map();
  const pathFor = (jobId) => win32.join(stateRoot, `${jobId}.json`);

  async function existingRevision(jobId) {
    if (revisions.has(jobId)) return revisions.get(jobId);
    try {
      const raw = await readFile(pathFor(jobId), "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) throw new JobStateError("state_error", "state_too_large");
      const parsed = JSON.parse(raw);
      const revision = Number.isSafeInteger(parsed?.revision) && parsed.revision >= 0 ? parsed.revision : 0;
      revisions.set(jobId, revision);
      return revision;
    } catch (error) {
      if (error?.code === "ENOENT") { revisions.set(jobId, 0); return 0; }
      if (error instanceof JobStateError) throw error;
      throw new JobStateError("state_error", "read_failed");
    }
  }

  async function persistNow(snapshot, { expectedRevision } = {}) {
    if (!snapshot || !SAFE_JOB_ID.test(snapshot.jobId ?? "")) throw new JobStateError("state_error", "invalid_job_id");
    const current = await existingRevision(snapshot.jobId);
    if (expectedRevision !== undefined && expectedRevision !== current) {
      throw new JobStateError("stale_state_revision", "revision_mismatch");
    }
    const next = minimal(snapshot, current + 1, now());
    const destination = pathFor(snapshot.jobId);
    const temporary = `${destination}.${current + 1}.tmp`;
    try {
      await mkdirPath(stateRoot, { recursive: true });
      await writeFile(temporary, JSON.stringify(next), { encoding: "utf8", flag: "w", mode: 0o600 });
      await renamePath(temporary, destination);
    } catch (error) {
      throw new JobStateError("state_error", "write_failed");
    }
    revisions.set(snapshot.jobId, current + 1);
    return structuredClone(next);
  }

  function persist(snapshot, options = {}) {
    const jobId = snapshot?.jobId;
    const previous = writes.get(jobId) ?? Promise.resolve();
    const operation = previous.then(() => persistNow(snapshot, options));
    writes.set(jobId, operation.catch(() => {}));
    return operation;
  }

  async function reconcile() {
    let names;
    try { names = await listDirectory(stateRoot); } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw new JobStateError("state_error", "list_failed");
    }
    if (!Array.isArray(names) || names.length > 10_000) throw new JobStateError("state_error", "invalid_directory_listing");
    const recovered = [];
    for (const name of names) {
      const match = typeof name === "string" ? /^([A-Za-z0-9_-]{1,128})\.json$/u.exec(name) : null;
      if (!match) continue;
      let record;
      try {
        const raw = await readFile(win32.join(stateRoot, name), "utf8");
        if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) continue;
        record = JSON.parse(raw);
      } catch { continue; }
      if (record?.jobId !== match[1] || !STATUSES.has(record?.status) || !Number.isSafeInteger(record?.revision)) continue;
      revisions.set(record.jobId, record.revision);
      if (TERMINAL.has(record.status)) {
        recovered.push(minimal(record, record.revision, typeof record.updatedAt === "string" ? record.updatedAt : "unknown"));
        continue;
      }
      recovered.push(await persist({
        jobId: record.jobId,
        status: "failed",
        ...(typeof record.workspace === "string" ? { workspace: record.workspace } : {}),
        ...(Object.hasOwn(record, "worktreePath") ? { worktreePath: record.worktreePath } : {}),
        error: { category: "protocol_error" },
      }, { expectedRevision: record.revision }));
    }
    return recovered;
  }

  return Object.freeze({ persist, reconcile });
}
