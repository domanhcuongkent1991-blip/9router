/**
 * Stream merge contract for the v0.5.109 upstream update.
 *
 * The 109 merge combines two features that touch the same passthrough
 * streaming path:
 *  - local: tool-name normalization (wrong-case tool names restored to the
 *    client's spelling, see passthrough-tool-name-normalize.test.js)
 *  - upstream #4986: ensureStreamToolCallIds (streaming tool_call fragments
 *    that arrive without an id get one, stable per fragment index)
 *
 * These tests pin the CONTRACT of the merged stream: both behaviors must
 * coexist. Written before resolving the merge; they fail on pre-merge master
 * (no id minting) and must pass after the merge is resolved.
 */

import { describe, expect, it } from "vitest";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const CLIENT_TOOLS = [
  { type: "function", function: { name: "Bash", description: "run a command" } },
  { type: "function", function: { name: "Read", description: "read a file" } },
];

function sseLine(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function pump(lines, body = { model: "gpt-x", stream: true, tools: CLIENT_TOOLS }) {
  const stream = createPassthroughStreamWithLogger("openai", null, "gpt-x", "test-conn", body, null, null);
  const encoder = new TextEncoder();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writePromise = (async () => {
    for (const line of lines) await writer.write(encoder.encode(line));
    await writer.close();
  })();
  let text = "";
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await writePromise;
  return text;
}

function toolCallIdAt(text, chunkIdx, tcIndex) {
  const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
  const chunk = JSON.parse(dataLines[chunkIdx].slice(6));
  const tc = chunk.choices[0].delta.tool_calls.find((t) => t.index === tcIndex);
  return tc ? tc.id : undefined;
}

describe("stream contract: id minting + tool-name normalization coexist (v0.5.109 merge)", () => {
  it("mints ids for tool_call fragments that arrive without one, stable per index", async () => {
    const out = await pump([
      sseLine({ id: "chatcmpl-c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "Bash", arguments: "" } }] } }] }),
      sseLine({ id: "chatcmpl-c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "Bash", arguments: "{\"cmd\":1}" } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    const id1 = toolCallIdAt(out, 0, 0);
    const id2 = toolCallIdAt(out, 1, 0);
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1); // fragments of the same call share one id
  });

  it("mints distinct ids for different tool call indexes in the same chunk", async () => {
    const out = await pump([
      sseLine({ id: "chatcmpl-c2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, type: "function", function: { name: "Bash", arguments: "" } },
        { index: 1, type: "function", function: { name: "Read", arguments: "" } },
      ] } }] }),
      "data: [DONE]\n\n",
    ]);
    const id0 = toolCallIdAt(out, 0, 0);
    const id1 = toolCallIdAt(out, 0, 1);
    expect(id0).toBeTruthy();
    expect(id1).toBeTruthy();
    expect(id0).not.toBe(id1);
  });

  it("normalizes a wrong-case tool name AND mints the missing id in the same chunk", async () => {
    const out = await pump([
      sseLine({ id: "chatcmpl-c3", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, type: "function", function: { name: "bash", arguments: "" } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(out).toContain('"name":"Bash"');
    expect(out).not.toContain('"name":"bash"');
    const id = toolCallIdAt(out, 0, 0);
    expect(id).toBeTruthy();
  });

  it("keeps chunks with both correct names and ids untouched (byte-identical passthrough)", async () => {
    const raw = sseLine({ id: "chatcmpl-c4", object: "chat.completion.chunk", created: 1234567890, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-keep", type: "function", function: { name: "Bash", arguments: "" } }] } }] });
    const out = await pump([raw, "data: [DONE]\n\n"]);
    expect(out).toContain(raw);
    expect(out).toContain('"id":"call-keep"');
  });
});
