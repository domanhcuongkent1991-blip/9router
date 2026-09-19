// Bounded TOML subset used by the safe MCP writer. Unsupported syntax in the
// target tables fails closed; unrelated Codex tables are not interpreted.
const baseName = "mcp_servers.nine-router-gemini";
function invalid() { throw new Error("mcp_config_invalid"); }
function stripComment(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
    } else if (quote === "'") {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i).trim();
  }
  return line.trim();
}
function value(text) {
  if (/^'(?:[^'\r\n])*'$/.test(text)) return text.slice(1, -1);
  if (/^"(?:[^"\\\r\n]|\\.)*"$/.test(text)) {
    try { return JSON.parse(text); } catch { invalid(); }
  }
  if (text === "true" || text === "false") return text === "true";
  if (/^(?:0|[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    let remaining = text.slice(1, -1).trim();
    const result = [];
    while (remaining) {
      const match = remaining.match(/^(?:'[^'\r\n]*'|"(?:[^"\\\r\n]|\\.)*")/);
      if (!match) invalid();
      result.push(value(match[0]));
      remaining = remaining.slice(match[0].length).trim();
      if (!remaining) break;
      if (remaining[0] !== ",") invalid();
      remaining = remaining.slice(1).trim();
    }
    return result;
  }
  invalid();
}
export function parseMcpConfig(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) invalid();
  const tables = new Map();
  let table;
  let pending = "";
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line) continue;
    if (!pending && line.startsWith("[")) {
      const header = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
      table = header && [baseName, baseName + ".env"].includes(header[1]) ? header[1] : null;
      if (table) {
        if (tables.has(table)) invalid();
        tables.set(table, Object.create(null));
      }
      continue;
    }
    if (!table) continue;
    pending += (pending ? " " : "") + line;
    const assignment = pending.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) invalid();
    if (assignment[2].startsWith("[") && !assignment[2].endsWith("]")) continue;
    if (Object.hasOwn(tables.get(table), assignment[1])) invalid();
    tables.get(table)[assignment[1]] = value(assignment[2]);
    pending = "";
  }
  if (pending || !tables.has(baseName) || !tables.has(baseName + ".env")) invalid();
  const base = tables.get(baseName);
  const env = tables.get(baseName + ".env");
  if (Object.hasOwn(env, "NINEROUTER_API_KEY")) invalid();
  return {
    command: base.command, args: base.args, cwd: base.cwd,
    enabled: base.enabled ?? true, required: base.required ?? false,
    startupTimeoutSec: base.startup_timeout_sec, toolTimeoutSec: base.tool_timeout_sec,
    envVars: base.env_vars,
    backend: env.NINEROUTER_EXECUTION_BACKEND,
    model: env.NINEROUTER_GEMINI_MODEL,
    models: env.NINEROUTER_GEMINI_MODELS ?? env.NINEROUTER_GEMINI_MODEL,
    routerBaseUrl: env.NINEROUTER_ROUTER_BASE_URL,
    runtimeRoot: env.NINEROUTER_RUNTIME_ROOT ?? "C:\\Users\\Admin\\Documents\\Codex\\9router-gemini-runtime",
    permittedWorkspaces: env.NINEROUTER_PERMITTED_WORKSPACES,
  };
}
