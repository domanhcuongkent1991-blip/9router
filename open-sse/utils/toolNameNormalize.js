/**
 * Tool-name case normalization for passthrough responses.
 *
 * Some models emit tool_calls whose names differ from the client-declared
 * tool list only by letter case (e.g. "bash"/"read" vs "Bash"/"Read").
 * Case-sensitive clients (ZCode's tool registry, @ai-sdk tool lookups)
 * then reject the call with "Tool not found", breaking agents that run
 * on models with sloppy tool-name casing. On passthrough the router
 * forwards the client's own tool list verbatim, so we can safely rewrite
 * a wrong-case name back to the exact spelling the client declared.
 *
 * Only exact case-insensitive matches are rewritten; unknown or partial
 * names (streamed fragments) pass through untouched, which keeps the
 * transform a no-op for well-behaved models.
 */

/**
 * Build a lowercase → canonical-case lookup from the client's tool list.
 * Accepts OpenAI-shaped tools (`tools[].function.name`) and Claude-shaped
 * tools (`tools[].name`).
 *
 * @param {Array<object>|undefined} tools - tool definitions from the client request body
 * @returns {Map<string, string>|null} lowercase name → canonical name, or null
 *   when the request declares no usable tool names (callers should skip
 *   normalization entirely in that case)
 */
export function buildClientToolNameLookup(tools) {
  if (!Array.isArray(tools)) return null;
  /** @type {Map<string, string>} */
  const lookup = new Map();
  let seen = 0;
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.function?.name === "string" ? tool.function.name
      : typeof tool.name === "string" ? tool.name
      : null;
    if (!name) continue;
    seen += 1;
    const key = name.toLowerCase();
    const existing = lookup.get(key);
    if (existing === undefined) {
      lookup.set(key, name);
    } else if (existing !== name) {
      // Two tools differ only by case: we cannot know which one the model
      // meant, so leave the ambiguous name alone instead of guessing.
      lookup.delete(key);
    }
  }
  return seen > 0 ? lookup : null;
}

/**
 * Rewrite wrong-case tool-call names in a parsed OpenAI-shaped response
 * object (streaming chunk deltas and non-streaming messages), mutating in
 * place. Only names whose lowercase form maps to exactly one declared tool
 * are rewritten.
 *
 * @param {object|null} parsed - a parsed response chunk or full body
 * @param {Map<string, string>|null} lookup - from buildClientToolNameLookup
 * @returns {boolean} true when any name was rewritten
 */
export function normalizeToolCallNamesInObject(parsed, lookup) {
  if (!parsed || !lookup || !Array.isArray(parsed.choices)) return false;
  let changed = false;
  for (const choice of parsed.choices) {
    if (!choice || typeof choice !== "object") continue;
    for (const calls of [choice.delta?.tool_calls, choice.message?.tool_calls]) {
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        const fn = call?.function;
        if (typeof fn?.name !== "string" || fn.name.length === 0) continue;
        const canonical = lookup.get(fn.name.toLowerCase());
        if (canonical !== undefined && canonical !== fn.name) {
          fn.name = canonical;
          changed = true;
        }
      }
    }
  }
  return changed;
}
