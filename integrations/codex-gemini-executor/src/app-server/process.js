import { win32 } from "node:path";

const stopOperations = new WeakMap();

export class AppServerProcessError extends Error {
  constructor(reason, stage, cause) {
    super("App Server process failure");
    this.name = "AppServerProcessError";
    this.code = "app_server_process_error";
    this.details = { reason, ...(stage ? { stage } : {}) };
    if (cause !== undefined) {
      this.details.causeType = cause instanceof Error ? cause.name : "UnknownError";
    }
  }
}

function requireAbsolute(value, reason) {
  if (typeof value !== "string" || !win32.isAbsolute(value)) {
    throw new AppServerProcessError(reason, "validate");
  }
}

function spawnExact(spawnProcess, executablePath, args, options, stage) {
  try {
    return spawnProcess(executablePath, args, options);
  } catch (error) {
    throw new AppServerProcessError("spawn_failed", stage, error);
  }
}

export function launchAppServer({
  executablePath,
  codexHome,
  workingDirectory,
  environment,
  spawnProcess,
}) {
  requireAbsolute(executablePath, "executable_path_not_absolute");
  requireAbsolute(codexHome, "codex_home_not_absolute");
  requireAbsolute(workingDirectory, "working_directory_not_absolute");
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new AppServerProcessError("invalid_environment", "validate");
  }

  return spawnExact(
    spawnProcess,
    executablePath,
    ["app-server", "--listen", "stdio://"],
    {
      cwd: workingDirectory,
      env: { ...environment, CODEX_HOME: codexHome },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
    "launch",
  );
}

function runBoundedCommand({
  executablePath,
  args,
  spawnProcess,
  timeoutMs,
  stage,
  collectStdout,
  maxStdoutBytes = 4096,
  maxStderrBytes = 4096,
}) {
  const child = spawnExact(spawnProcess, executablePath, args, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }, stage);

  return new Promise((resolve, reject) => {
    let complete = false;
    let timer;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];

    function cleanup() {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdout?.off("data", onStdout);
      child.stdout?.off("error", onStdoutError);
      child.stderr?.off("data", onStderr);
      child.stderr?.off("error", onStderrError);
    }

    function finish(error, value) {
      if (complete) return;
      complete = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    }

    function terminate(reason) {
      finish(new AppServerProcessError(reason, stage));
      try { child.kill?.("SIGKILL"); } catch { /* completion is already sanitized */ }
    }

    function onStdout(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxStdoutBytes) {
        terminate("stdout_too_large");
      } else if (collectStdout) {
        stdout.push(bytes);
      }
    }

    function onStderr(chunk) {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxStderrBytes) terminate("stderr_too_large");
    }

    function onError(error) {
      finish(new AppServerProcessError("child_error", stage, error));
    }

    function onStdoutError(error) {
      finish(new AppServerProcessError("stdout_error", stage, error));
    }

    function onStderrError(error) {
      finish(new AppServerProcessError("stderr_error", stage, error));
    }

    function onClose(code) {
      if (code !== 0) {
        finish(new AppServerProcessError("nonzero_exit", stage));
        return;
      }
      finish(undefined, collectStdout ? Buffer.concat(stdout).toString("utf8") : { ok: true });
    }

    child.on("error", onError);
    child.on("close", onClose);
    child.stdout?.on("data", onStdout);
    child.stdout?.on("error", onStdoutError);
    child.stderr?.on("data", onStderr);
    child.stderr?.on("error", onStderrError);
    timer = setTimeout(() => terminate("timeout"), timeoutMs);
    timer.unref?.();
  });
}

export async function readExecutableVersion({ executablePath, spawnProcess, timeoutMs = 5_000 }) {
  requireAbsolute(executablePath, "executable_path_not_absolute");
  const output = await runBoundedCommand({
    executablePath,
    args: ["--version"],
    spawnProcess,
    timeoutMs,
    stage: "version",
    collectStdout: true,
  });
  const version = output.trim();
  if (version.length === 0) throw new AppServerProcessError("empty_output", "version");
  return version;
}

export async function generateStableSchemaBundle({
  executablePath,
  outputDirectory,
  spawnProcess,
  timeoutMs = 10_000,
}) {
  requireAbsolute(executablePath, "executable_path_not_absolute");
  requireAbsolute(outputDirectory, "output_directory_not_absolute");
  return runBoundedCommand({
    executablePath,
    args: ["app-server", "generate-json-schema", "--out", outputDirectory],
    spawnProcess,
    timeoutMs,
    stage: "schema_generation",
    collectStdout: false,
  });
}

export async function stopChildProcess(child, { graceMs = 1_000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (stopOperations.has(child)) return stopOperations.get(child);

  const operation = new Promise((resolve, reject) => {
    let graceTimer;
    let forceTimer;
    let forced = false;
    let complete = false;
    const finish = (error) => {
      if (complete) return;
      complete = true;
      clearTimeout(graceTimer);
      clearTimeout(forceTimer);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    child.on("exit", onExit);
    try {
      child.kill();
    } catch (error) {
      finish(new AppServerProcessError("termination_failed", "stop", error));
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    graceTimer = setTimeout(() => {
      if (forced) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      forced = true;
      try {
        child.kill("SIGKILL");
      } catch (error) {
        finish(new AppServerProcessError("termination_failed", "stop", error));
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        finish();
        return;
      }
      forceTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) finish();
        else finish(new AppServerProcessError("termination_timeout", "stop"));
      }, graceMs);
      forceTimer.unref?.();
    }, graceMs);
    graceTimer.unref?.();
  });
  stopOperations.set(child, operation);
  return operation;
}
