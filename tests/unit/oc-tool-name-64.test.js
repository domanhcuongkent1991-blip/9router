import { describe, it, expect } from "vitest";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import { takeRenamedToolNames } from "../../open-sse/utils/opencodeFingerprint.js";

const NAME65 = "mcp__plugin_project-memory_basic-memory-kie__list_memory_projects";
const NAME64 = "mcp__plugin_project-memory_basic-memory-kie__list_memory_project";

expect(NAME65.length).toBe(65);
expect(NAME64.length).toBe(64);

describe("oc executor — tool names longer than 64 are aliased for opencode upstream", () => {
  const executor = new OpenCodeExecutor();

  it("responses path: flat tool name >64 becomes a ≤64 alias recorded for restore", () => {
    const body = {
      model: "oc/muse-spark-1.3-contributor-free",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", name: NAME65, parameters: { type: "object", properties: {} } }],
      tool_choice: { type: "function", name: NAME65 },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "call_1", name: NAME65, arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    };

    const out = executor.transformRequest(body.model, body, true, {});
    const tools = Array.isArray(out.tools) ? out.tools : [];
    const target = tools.find((t) => t && t.name && t.name !== "bash" && t.name !== "glob" && t.name !== "grep" && t.name !== "read");
    expect(target).toBeTruthy();
    expect(target.name.length).toBeLessThanOrEqual(64);
    expect(target.name).not.toBe(NAME65);

    // tool_choice follows the alias
    expect(out.tool_choice.name).toBe(target.name);

    // prior-turn function_call item uses the SAME alias (deterministic per original name)
    const callItem = out.input.find((i) => i.type === "function_call");
    expect(callItem.name).toBe(target.name);

    // restore map: alias -> original
    const map = takeRenamedToolNames(out);
    expect(map).toBeTruthy();
    expect(map.get(target.name)).toBe(NAME65);
  });

  it("chat path: nested function tool name >64 becomes a ≤64 alias recorded for restore", () => {
    const body = {
      model: "oc/mimo-v2.6-flash-free",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: NAME65, parameters: { type: "object", properties: {} } } }],
tool_choice: { type: "function", function: { name: NAME65 } },
    };

    const out = executor.transformRequest(body.model, body, true, {});
    const tools = Array.isArray(out.tools) ? out.tools : [];
    const target = tools.find((t) => t?.function?.name && t.function.name !== "bash" && t.function.name !== "glob" && t.function.name !== "grep" && t.function.name !== "read");
    expect(target).toBeTruthy();
    expect(target.function.name.length).toBeLessThanOrEqual(64);
    const map = takeRenamedToolNames(out);
    expect(map?.get(target.function.name)).toBe(NAME65);
  });

  it("names already ≤64 are left untouched", () => {
    const body = {
      model: "oc/muse-spark-1.3-contributor-free",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", name: NAME64, parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    };
    const out = executor.transformRequest(body.model, body, true, {});
    const target = (out.tools || []).find((t) => t?.name === NAME64);
    expect(target).toBeTruthy();
    expect(takeRenamedToolNames(out)?.size || 0).toBe(0);
  });
});

describe("oc-zen executor — same 64-char clamp", () => {
  const executor = new OpenCodeZenExecutor();

  it("flat tool name >64 becomes alias recorded for restore", () => {
    const body = {
      model: "ocz/glm-5-turbo",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: NAME65, parameters: { type: "object", properties: {} } } }],
    };
    const out = executor.transformRequest(body.model, body, true, {});
    const tools = Array.isArray(out.tools) ? out.tools : [];
    const target = tools.find((t) => t?.function?.name || (t?.type === "function" && t.name));
    expect(target).toBeTruthy();
    const sentName = target.function?.name ?? target.name;
    expect(sentName.length).toBeLessThanOrEqual(64);
    expect(takeRenamedToolNames(out)?.get(sentName)).toBe(NAME65);
  });
});
