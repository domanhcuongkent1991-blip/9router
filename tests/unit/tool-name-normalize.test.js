/**
 * Unit tests for open-sse/utils/toolNameNormalize.js
 *
 * Some models emit tool_calls whose names differ from the client-declared
 * tool list only by letter case (e.g. "bash"/"read" vs "Bash"/"Read").
 * Case-sensitive clients (ZCode registry, AI SDK) then fail with
 * "Tool not found". These helpers rewrite mismatched names back to the
 * client's canonical spelling on passthrough responses.
 */

import { describe, it, expect } from "vitest";
import {
  buildClientToolNameLookup,
  normalizeToolCallNamesInObject,
} from "../../open-sse/utils/toolNameNormalize.js";

describe("buildClientToolNameLookup", () => {
  it("maps lowercase to canonical name for OpenAI-shaped tools", () => {
    const lookup = buildClientToolNameLookup([
      { type: "function", function: { name: "Bash", description: "run a command" } },
      { type: "function", function: { name: "Read", description: "read a file" } },
    ]);
    expect(lookup.get("bash")).toBe("Bash");
    expect(lookup.get("read")).toBe("Read");
    expect(lookup.get("bash")).not.toBe("bash");
  });

  it("maps Claude-shaped tools (tools[].name)", () => {
    const lookup = buildClientToolNameLookup([
      { name: "todo_write", input_schema: { type: "object" } },
    ]);
    expect(lookup.get("todo_write")).toBe("todo_write");
  });

  it("supports mixed shapes in one request", () => {
    const lookup = buildClientToolNameLookup([
      { type: "function", function: { name: "Bash" } },
      { name: "mcp__server__tool" },
    ]);
    expect(lookup.get("bash")).toBe("Bash");
    expect(lookup.get("mcp__server__tool")).toBe("mcp__server__tool");
  });

  it("drops entries where two tools differ only by case instead of guessing", () => {
    const lookup = buildClientToolNameLookup([
      { type: "function", function: { name: "Bash" } },
      { type: "function", function: { name: "BASH" } },
    ]);
    expect(lookup.has("bash")).toBe(false);
  });

  it("returns null when there are no tools so callers can skip normalize", () => {
    expect(buildClientToolNameLookup(undefined)).toBeNull();
    expect(buildClientToolNameLookup([])).toBeNull();
    expect(buildClientToolNameLookup([{ type: "function", function: {} }])).toBeNull();
  });

  it("never maps a canonical name to itself through the lowercase key collision", () => {
    // A tool already named in lowercase must not shadow a differently-cased one.
    const lookup = buildClientToolNameLookup([
      { type: "function", function: { name: "WebFetch" } },
    ]);
    expect(lookup.get("webfetch")).toBe("WebFetch");
  });
});

describe("normalizeToolCallNamesInObject", () => {
  const lookup = buildClientToolNameLookup([
    { type: "function", function: { name: "Bash" } },
    { type: "function", function: { name: "Read" } },
    { type: "function", function: { name: "WebFetch" } },
  ]);

  it("fixes a wrong-case tool name in a streaming delta and reports changed", () => {
    const chunk = {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "bash", arguments: "" } }] },
      }],
    };
    expect(normalizeToolCallNamesInObject(chunk, lookup)).toBe(true);
    expect(chunk.choices[0].delta.tool_calls[0].function.name).toBe("Bash");
  });

  it("fixes names in non-stream message.tool_calls", () => {
    const body = {
      choices: [{
        index: 0,
        message: { tool_calls: [{ id: "call-2", type: "function", function: { name: "read", arguments: "{}" } }] },
      }],
    };
    expect(normalizeToolCallNamesInObject(body, lookup)).toBe(true);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("Read");
  });

  it("leaves unknown tool names untouched", () => {
    const body = {
      choices: [{
        message: { tool_calls: [{ function: { name: "totally_unknown", arguments: "{}" } }] },
      }],
    };
    expect(normalizeToolCallNamesInObject(body, lookup)).toBe(false);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("totally_unknown");
  });

  it("leaves already-correct names untouched and reports no change", () => {
    const body = {
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { name: "Bash", arguments: "" } }] },
      }],
    };
    expect(normalizeToolCallNamesInObject(body, lookup)).toBe(false);
    expect(body.choices[0].delta.tool_calls[0].function.name).toBe("Bash");
  });

  it("leaves name fragments from split deltas untouched (no exact match)", () => {
    // Some providers stream the tool name in pieces; a partial fragment must
    // not be rewritten. The canonical spelling arrives whole in the first
    // delta in the common case; fragments that do not match any declared
    // name are passed through as-is.
    const body = {
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { name: "We", arguments: "" } }] },
      }],
    };
    expect(normalizeToolCallNamesInObject(body, lookup)).toBe(false);
    expect(body.choices[0].delta.tool_calls[0].function.name).toBe("We");
  });

  it("normalizes every choice and every parallel tool call", () => {
    const body = {
      choices: [
        { index: 0, delta: { tool_calls: [
          { index: 0, function: { name: "bash", arguments: "" } },
          { index: 1, function: { name: "read", arguments: "" } },
        ] } },
        { index: 1, delta: { tool_calls: [
          { index: 0, function: { name: "webfetch", arguments: "" } },
        ] } },
      ],
    };
    expect(normalizeToolCallNamesInObject(body, lookup)).toBe(true);
    expect(body.choices[0].delta.tool_calls[0].function.name).toBe("Bash");
    expect(body.choices[0].delta.tool_calls[1].function.name).toBe("Read");
    expect(body.choices[1].delta.tool_calls[0].function.name).toBe("WebFetch");
  });

  it("is idempotent — a second pass reports no change", () => {
    const body = {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: "" } }] } }],
    };
    expect(normalizeToolCallNamesInObject(body, lookup)).toBe(true);
    expect(normalizeToolCallNamesInObject(body, lookup)).toBe(false);
  });

  it("tolerates bodies without choices and null lookup without throwing", () => {
    expect(normalizeToolCallNamesInObject({}, lookup)).toBe(false);
    expect(normalizeToolCallNamesInObject({ choices: [{ delta: {} }] }, lookup)).toBe(false);
    expect(normalizeToolCallNamesInObject({ choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] }, null)).toBe(false);
    expect(normalizeToolCallNamesInObject(null, lookup)).toBe(false);
  });
});
