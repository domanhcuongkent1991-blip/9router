import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getExecutor } from "../../open-sse/executors/index.js";

const TRANSPORTS = [
  { format: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
  { format: "claude", baseUrl: "https://opencode.ai/inference/go/anthropic/v1/messages", auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true } },
  { format: "openai-responses", baseUrl: "https://opencode.ai/inference/go/openai/v1/responses", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
];

// translatedSession() in open-sse/executors/opencode-go.js emits
// `ses_` + 12 hex chars (6-byte descending timestamp) + 14 base62 chars
// (sha256-derived). Zen rejects hash-only prefixes with 403 FreeTierError
// (probed 2026-10-13), so the mixed shape is deliberate, not a bug.
const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function makeCredentials(overrides = {}) {
  return {
    apiKey: "test-key",
    connectionId: "connection-a",
    rawHeaders: {},
    runtimeTransport: TRANSPORTS[0],
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { messages: [{ role: "user", content: "hello" }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Go x-opencode-session", () => {
  it("uses a dedicated executor with request-local session credentials", () => {
    const executor = getExecutor("opencode-go");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeGoExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeGoSession).toMatch(SESSION_ID_RE);
    expect(credentials).not.toHaveProperty("_opencodeGoSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
    expect(executor).not.toHaveProperty("_opencodeGoSession");
  });

  it("preserves a valid native session header case-insensitively", () => {
    const executor = getExecutor("opencode-go");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": " native-session-a " } }),
    });

    expect(prepared._opencodeGoSession).toBe("native-session-a");
  });

  it("ignores an oversized native session and uses the translated identity", () => {
    const executor = getExecutor("opencode-go");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "x".repeat(257) } }),
    });

    expect(prepared._opencodeGoSession).toMatch(SESSION_ID_RE);
  });

  it("keeps the translated conversation stable across transports apart from the fresh prefix", () => {
    const executor = getExecutor("opencode-go");
    const values = TRANSPORTS.map((runtimeTransport) => {
      const { prepared } = prepare(executor, {
        credentials: makeCredentials({ runtimeTransport }),
      });
      return executor.buildHeaders(prepared, true)["x-opencode-session"];
    });

    // The 12-hex prefix is a fresh descending timestamp on every call — Zen
    // rejects stale/hash-derived prefixes with 403 FreeTierError (6bf8b207), so
    // only the 14-char sha256-derived suffix has to stay stable.
    const suffixes = values.map((v) => v.slice(-14));
    expect(new Set(suffixes).size).toBe(1);
    for (const v of values) expect(v).toMatch(SESSION_ID_RE);
    expect(values[0]).not.toContain("conversation-a");
  });

  it("isolates different conversations", () => {
    const executor = getExecutor("opencode-go");
    const a = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeGoSession;
    const b = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeGoSession;

    expect(a).not.toBe(b);
  });

  it("isolates different downstream agents that reuse the same raw id", () => {
    const executor = getExecutor("opencode-go");
    const claude = prepare(executor, { clientTool: "claude" }).prepared._opencodeGoSession;
    const codex = prepare(executor, { clientTool: "codex" }).prepared._opencodeGoSession;

    expect(claude).not.toBe(codex);
  });

  it("uses a stable opaque connection fallback when no session is supplied", () => {
    const executor = getExecutor("opencode-go");
    const options = {
      credentials: makeCredentials({ connectionId: "fallback-connection" }),
      providerSessionId: null,
      clientTool: null,
      body: { messages: [{ role: "user", content: "headerless" }] },
    };
    const first = prepare(executor, options).prepared._opencodeGoSession;
    const second = prepare(executor, options).prepared._opencodeGoSession;

    // Same caveat as above: the timestamp prefix rotates, the identity suffix
    // (derived from connectionId + body) is what stays opaque and stable.
    expect(first.slice(-14)).toBe(second.slice(-14));
    expect(first).toMatch(SESSION_ID_RE);
    expect(first).not.toContain("fallback-connection");
  });

  it("adds the prepared session to the actual fetch headers", async () => {
    const executor = getExecutor("opencode-go");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "glm-5.2",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch",
      clientTool: "codex",
    });

    expect(result.headers["x-opencode-session"]).toMatch(SESSION_ID_RE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(credentials).not.toHaveProperty("_opencodeGoSession");
  });

  it("does not add the header to unrelated default executors", () => {
    const headers = new DefaultExecutor("openai").buildHeaders({ apiKey: "test-key" }, false);
    expect(headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("chatCore provider session forwarding", () => {
  it("passes the original provider session and client tool on initial and retry execution", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../open-sse/handlers/chatCore.js", import.meta.url)),
      "utf8",
    );
    const calls = [...source.matchAll(/executor\.execute\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatch(/providerSessionId:\s*sessionSeed/);
      expect(call).toMatch(/\bclientTool\b/);
    }
  });
});
