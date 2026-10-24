// parseUpstreamError must surface the standard Retry-After header (delta-seconds
// or HTTP-date) as resetsAtMs — the no-auth free lanes have no bespoke
// parseError, so without this their 429 cooldown fell back to a 2s backoff and
// the gateway cooldown gate never held. Executor-provided resetsAtMs wins.
import { describe, expect, it } from "vitest";
import { parseUpstreamError } from "../../open-sse/utils/error.js";

function res(headers, body = JSON.stringify({ error: { message: "no" } }), status = 429) {
  return new Response(body, { status, headers });
}

describe("parseUpstreamError — Retry-After handling", () => {
  it("parses delta-seconds into an absolute resetsAtMs", async () => {
    const before = Date.now();
    const out = await parseUpstreamError(res({ "retry-after": "120" }));
    expect(out.resetsAtMs).toBeGreaterThanOrEqual(before + 120_000);
    expect(out.resetsAtMs).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it("parses an HTTP-date into the exact epoch", async () => {
    const when = new Date(Date.now() + 3600_000).toUTCString();
    const out = await parseUpstreamError(res({ "retry-after": when }));
    expect(out.resetsAtMs).toBe(Date.parse(when));
  });

  it("returns resetsAtMs undefined without the header", async () => {
    const out = await parseUpstreamError(res({}));
    expect(out.resetsAtMs).toBeUndefined();
  });

  it("ignores garbage header values", async () => {
    const out = await parseUpstreamError(res({ "retry-after": "soon-ish" }));
    expect(out.resetsAtMs).toBeUndefined();
  });

  it("keeps executor-provided resetsAtMs over the header", async () => {
    const executor = { parseError: () => ({ status: 429, message: "x", resetsAtMs: 111 }) };
    const out = await parseUpstreamError(res({ "retry-after": "999" }), executor);
    expect(out.resetsAtMs).toBe(111);
  });

  it("falls back to the header when the executor parser has no resetsAtMs", async () => {
    const executor = { parseError: () => ({ status: 429, message: "x" }) };
    const before = Date.now();
    const out = await parseUpstreamError(res({ "retry-after": "60" }), executor);
    expect(out.resetsAtMs).toBeGreaterThanOrEqual(before + 60_000);
  });
});
