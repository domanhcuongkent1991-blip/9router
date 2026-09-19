import { win32 } from "node:path";

const CHILD_MARKER = "NINEROUTER_GEMINI_CHILD";
function configFor(model, approvalPolicy) {
  if (typeof model !== "string" || !/^[A-Za-z0-9._:/-]{1,256}$/u.test(model)) {
    throw new ChildHomeError("child_home_error", "invalid_model");
  }
  if (!["on-request", "never"].includes(approvalPolicy)) {
    throw new ChildHomeError("child_home_error", "invalid_approval_policy");
  }
  return `model = "${model}"
model_provider = "nine_router"
approval_policy = "${approvalPolicy}"
sandbox_mode = "read-only"
web_search = "disabled"

[sandbox_workspace_write]
network_access = false

[model_providers.nine_router]
name = "9Router Gemini"
base_url = "http://127.0.0.1:20128/v1"
env_key = "NINEROUTER_API_KEY"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 300000
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

export function createChildHomeManager({ runtimeRoot, mkdirPath, writeFile, renamePath }) {
  if (typeof runtimeRoot !== "string" || !win32.isAbsolute(runtimeRoot)
    || typeof mkdirPath !== "function" || typeof writeFile !== "function" || typeof renamePath !== "function") {
    throw new ChildHomeError("child_home_error", "invalid_configuration");
  }
  const codexHome = win32.join(runtimeRoot, "codex-home");
  const configPath = win32.join(codexHome, "config.toml");
  const tempPath = `${configPath}.tmp`;
  let preparation = Promise.resolve();

  function prepare(environment, model, approvalPolicy = "on-request") {
    if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
      return Promise.reject(new ChildHomeError("child_home_error", "invalid_environment"));
    }
    if (environment[CHILD_MARKER] === "1") {
      return Promise.reject(new ChildHomeError("recursive_child_blocked", "recursion_marker_present"));
    }
    let config;
    try {
      config = configFor(model, approvalPolicy);
    } catch (error) {
      return Promise.reject(error instanceof ChildHomeError
        ? error
        : new ChildHomeError("child_home_error", "invalid_model"));
    }
    const childEnvironment = Object.freeze({ ...environment, [CHILD_MARKER]: "1" });
    const operation = preparation.then(async () => {
      try {
        await mkdirPath(codexHome, { recursive: true });
        await writeFile(tempPath, config, { encoding: "utf8", flag: "w", mode: 0o600 });
        await renamePath(tempPath, configPath);
      } catch (error) {
        if (error instanceof ChildHomeError) throw error;
        throw new ChildHomeError("child_home_error", "write_failed");
      }
      return Object.freeze({ codexHome, environment: childEnvironment });
    });
    preparation = operation.catch(() => {});
    return operation;
  }

  return Object.freeze({ prepare });
}
