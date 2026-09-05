export const APP_SERVER_REQUIRED_METHODS = Object.freeze([
  "model/list",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
]);

export class AppServerCompatibilityError extends Error {
  constructor(details) {
    super("Codex version chưa được hỗ trợ");
    this.name = "AppServerCompatibilityError";
    this.code = "app_server_incompatible";
    this.userMessage = "Codex version chưa được hỗ trợ";
    this.details = details;
  }
}

export function assessAppServerCompatibility({ observation, baseline, handshake, schemaSubsetCompatible, methods }) {
  const missingCapabilities = APP_SERVER_REQUIRED_METHODS.filter((name) => methods?.[name] !== true);
  if (handshake?.ok !== true || schemaSubsetCompatible !== true || missingCapabilities.length > 0) {
    throw new AppServerCompatibilityError({
      observedVersion: observation?.version ?? "unknown",
      handshakeCompatible: handshake?.ok === true,
      schemaSubsetCompatible: schemaSubsetCompatible === true,
      missingCapabilities,
    });
  }

  const warnings = [];
  if (baseline?.version && baseline.version !== observation?.version) {
    warnings.push({ code: "codex_version_changed", previous: baseline.version, observed: observation?.version ?? "unknown" });
  }
  if (baseline?.executableSha256 && baseline.executableSha256 !== observation?.executableSha256) {
    warnings.push({ code: "codex_executable_changed" });
  }
  return {
    status: "compatible",
    warnings,
    diagnostics: {
      observedVersion: observation?.version ?? "unknown",
      executableChanged: warnings.some((warning) => warning.code === "codex_executable_changed"),
    },
  };
}
