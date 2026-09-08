import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AppServerCompatibilityError } from "./app-server/compatibility.js";

export const REQUIRED_CANARY_CHECKS = Object.freeze([
  "protocol", "readOnly", "status", "cancel", "resume", "approvalAccept",
  "approvalDecline", "multiTurnTools", "streamDisconnect", "workspaceIsolation", "processCleanup",
  "desktopTools", "desktopOptionalStartup",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function combinationFingerprint(identity) {
  return createHash("sha256").update(JSON.stringify(stable(identity))).digest("hex");
}

export function requireQualifiedCombination(identity, approval) {
  if (approval?.schemaVersion !== 1 || !Number.isFinite(Date.parse(approval.approvedAt))
    || !approval.identity || REQUIRED_CANARY_CHECKS.some((name) => approval.checks?.[name] !== true)
    || combinationFingerprint(identity) !== combinationFingerprint(approval.identity)) {
    throw new AppServerCompatibilityError({ stage: "qualification", reason: "combination_not_qualified" });
  }
  return combinationFingerprint(identity);
}

export async function sourceDigest(directory) {
  const hash = createHash("sha256");
  async function visit(relative = "") {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const name = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Source links are not qualified");
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

export async function readRouterIdentity({ fetchJson = fetch, baseUrl = "http://127.0.0.1:20128" } = {}) {
  let value;
  try {
    const response = await fetchJson(`${baseUrl}/api/compatibility`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (Buffer.byteLength(text) > 4096) throw new Error();
    value = JSON.parse(text);
    if (value.contractVersion !== 1 || typeof value.version !== "string" || !value.version
      || typeof value.buildId !== "string" || !value.buildId || value.buildId.length > 256) throw new Error();
  } catch {
    throw new AppServerCompatibilityError({ stage: "router", reason: "router_identity_unavailable" });
  }
  return { version: value.version, buildId: value.buildId, contractVersion: value.contractVersion };
}
