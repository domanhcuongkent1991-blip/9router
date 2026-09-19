import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validatePublicRouterUrl } from "./router-transport.js";

export const REQUIRED_SCOPED_CANARY_CHECKS = Object.freeze([
  "responsesContract", "brokerReadWrite", "scopeDenials", "desktopGrantAccept",
  "desktopGrantDeclineCancel", "cancelCleanup", "recovery", "runtimeIsolation",
]);

// A bootstrap record exists only to break the qualification chicken-and-egg
// safely. It can authorize one read-only host canary, never an arbitrary job.
export const REQUIRED_SCOPED_BOOTSTRAP_CHECKS = Object.freeze([
  "responsesContract", "brokerReadWrite", "scopeDenials", "cancelCleanup", "recovery", "runtimeIsolation",
]);

export const SCOPED_BOOTSTRAP_PROFILE = Object.freeze({
  workspace: "C:\\Users\\Admin\\.codex\\9router-canary-fixture",
  task: "Read only canary-marker.txt and reply with its byte count. Do not write, create, list, or search files.",
  read: Object.freeze(["canary-marker.txt"]),
  write: Object.freeze([]),
  allow_create: false,
});

export class ScopedQualificationError extends Error {
  constructor(reason) {
    super("Scoped runtime qualification failed");
    this.name = "ScopedQualificationError";
    this.code = "app_server_incompatible";
    this.details = { stage: "qualification", reason };
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function createScopedIdentity({ nodePath = process.execPath, nodeVersion = process.version,
  companionSha256, dependencyLockSha256, router, model }) {
  if (typeof companionSha256 !== "string" || typeof dependencyLockSha256 !== "string"
    || !router || typeof model !== "string") throw new ScopedQualificationError("scoped_identity_invalid");
  return {
    backend: "router-responses-v1",
    policyVersion: 1,
    node: { path: nodePath, version: nodeVersion },
    companionSha256,
    dependencyLockSha256,
    router,
    model,
  };
}

export function requireScopedQualification(identity, approval) {
  if (approval?.schemaVersion !== 2
    || identity?.backend !== "router-responses-v1"
    || identity?.policyVersion !== 1
    || approval?.identity?.backend !== "router-responses-v1"
    || approval?.identity?.policyVersion !== 1
    || !Number.isFinite(Date.parse(approval.approvedAt))
    || REQUIRED_SCOPED_CANARY_CHECKS.some((name) => approval.checks?.[name] !== true)
    || fingerprint(identity) !== fingerprint(approval.identity)) {
    throw new ScopedQualificationError("scoped_combination_not_qualified");
  }
  return fingerprint(identity);
}

export function requireScopedBootstrap(identity, approval) {
  if (approval?.schemaVersion !== 2
    || approval?.mode !== "bootstrap"
    || !Number.isFinite(Date.parse(approval.approvedAt))
    || REQUIRED_SCOPED_BOOTSTRAP_CHECKS.some((name) => approval.checks?.[name] !== true)
    || fingerprint(identity) !== fingerprint(approval.identity)
    || fingerprint(SCOPED_BOOTSTRAP_PROFILE) !== fingerprint(approval.bootstrap)) {
    throw new ScopedQualificationError("scoped_bootstrap_not_qualified");
  }
  return fingerprint(identity);
}

function normalizeBootstrapPath(value) {
  return typeof value === "string" ? value.trim().replaceAll("/", "\\").replace(/[\\]+$/u, "").toLowerCase() : value;
}

function sameStringList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => normalizeBootstrapPath(value) === normalizeBootstrapPath(expected[index]));
}

export function matchesScopedBootstrapRequest(request) {
  return request?.scoped === true
    && request.access === "read-only"
    && normalizeBootstrapPath(request.workspace) === normalizeBootstrapPath(SCOPED_BOOTSTRAP_PROFILE.workspace)
    && request.task === SCOPED_BOOTSTRAP_PROFILE.task
    && sameStringList(request.scope?.read, SCOPED_BOOTSTRAP_PROFILE.read)
    && sameStringList(request.scope?.write, SCOPED_BOOTSTRAP_PROFILE.write)
    && request.scope?.allow_create === false;
}

export async function sourceDigest(directory) {
  const hash = createHash("sha256");
  async function visit(relative = "") {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const name = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new ScopedQualificationError("source_link_not_allowed");
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) {
        hash.update(name.replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(await readFile(join(directory, name)));
        hash.update("\0");
      }
    }
  }
  await visit();
  return hash.digest("hex");
}

export async function readScopedRouterIdentity({ fetchJson = fetch, baseUrl } = {}) {
  try {
    validatePublicRouterUrl(baseUrl);
    const response = await fetchJson(`${baseUrl}/api/compatibility`, {
      signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 4_096) throw new Error();
    const value = JSON.parse(text);
    if (value.contractVersion !== 1 || typeof value.version !== "string" || !value.version
      || typeof value.buildId !== "string" || !value.buildId || value.buildId.length > 256) throw new Error();
    return { version: value.version, buildId: value.buildId, contractVersion: value.contractVersion };
  } catch {
    throw new ScopedQualificationError("router_identity_unavailable");
  }
}
