import { win32 } from "node:path";

const CHILD_MARKER = "NINEROUTER_GEMINI_CHILD";
function configFor(model) {
  if (typeof model !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/u.test(model)) {
    throw new ChildHomeError("child_home_error", "invalid_model");
  }
  return `model = "${model}"
model_provider = "nine_router"
approval_policy = "on-request"
sandbox_mode = "read-only"

[sandbox_workspace_write]
network_access = false

[model_providers.nine_router]
name = "9Router Gemini"
base_url = "http://127.0.0.1:20128/v1"
env_key = "NINEROUTER_API_KEY"
wire_api = "responses"
`;
}

export class ChildHomeError extends Error {
  constructor(code, reason) {
    super("Isolated Codex home preparation failed");
    this.name = "ChildHomeError";
    this.code = code;
    this.details = { reason };
  }
}

export function createChildHomeManager({ runtimeRoot, mkdirPath, writeFile, renamePath, fixedModel = "gemini-fixed" }) {
  if (typeof runtimeRoot !== "string" || !win32.isAbsolute(runtimeRoot)
    || typeof mkdirPath !== "function" || typeof writeFile !== "function" || typeof renamePath !== "function") {
    throw new ChildHomeError("child_home_error", "invalid_configuration");
  }
  const codexHome = win32.join(runtimeRoot, "codex-home");
  const configPath = win32.join(codexHome, "config.toml");
  const tempPath = `${configPath}.tmp`;
  const config = configFor(fixedModel);

  async function prepare(environment) {
    if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
      throw new ChildHomeError("child_home_error", "invalid_environment");
    }
    if (environment[CHILD_MARKER] === "1") {
      throw new ChildHomeError("recursive_child_blocked", "recursion_marker_present");
    }
    try {
      await mkdirPath(codexHome, { recursive: true });
      await writeFile(tempPath, config, { encoding: "utf8", flag: "w", mode: 0o600 });
      await renamePath(tempPath, configPath);
    } catch (error) {
      if (error instanceof ChildHomeError) throw error;
      throw new ChildHomeError("child_home_error", "write_failed");
    }
    return Object.freeze({
      codexHome,
      environment: Object.freeze({ ...environment, [CHILD_MARKER]: "1" }),
    });
  }

  return Object.freeze({ prepare });
}
