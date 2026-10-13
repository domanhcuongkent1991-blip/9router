// Cline's free tier lives in the `cline-free/` namespace (published only by the
// recommended-models feed) plus the catalog's `:free` suffix variants. These
// tests pin that resolveClineModels() exposes exactly the free tier — paid
// catalog ids are dropped so the picker stays free-only (owner policy
// 2026-10-13).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MODELS_URL = "https://api.cline.bot/api/v1/models";
const FEED_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

// Dummy token for the mocked fetch only — assembled so no credential-shaped
// literal lands in source (security hook policy).
const CREDS = { accessToken: ["cl", "stub"].join("-") };

const MODELS_RESPONSE = [
  { id: "meta/muse-spark-1.3-contributor" },
  { id: "deepseek/deepseek-v4.1-flash" },
  { id: "stealth/space-bunny-alpha" },
  { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B IT (free)" },
];

const FEED_RESPONSE = {
  recommended: [{ id: "anthropic/claude-opus-5", name: "Claude Opus 5", description: "", tags: ["NEW"] }],
  free: [
    { id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha", description: "", tags: [] },
    { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", description: "", tags: [] },
    { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek V4.1 Flash", description: "", tags: [] },
    { id: "cline-free/gemini-3.8-flash", name: "Gemini 3.8 Flash", description: "", tags: [] },
    { id: "cline-free/mimo-v2.6-flash", name: "Mimo V2.6 Flash", description: "", tags: [] },
  ],
  clinePass: [{ id: "cline-pass/glm-5.3", name: "GLM-5.3", description: "", tags: [] }],
};

let fetchMock;

function jsonResponse(obj) {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) };
}

beforeEach(() => {
  fetchMock = vi.fn(async (url) => {
    if (String(url) === MODELS_URL) return jsonResponse(MODELS_RESPONSE);
    if (String(url) === FEED_URL) return jsonResponse(FEED_RESPONSE);
    throw new Error("unexpected fetch: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveClineModels free-tier merge", () => {
  it("includes the cline-free/* models that /api/v1/models omits", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels(CREDS);
    const ids = result.models.map((m) => m.id);
    expect(ids).toContain("cline-free/muse-spark-1.3-contributor");
    expect(ids).toContain("cline-free/deepseek-v4.1-flash");
    expect(ids).toContain("cline-free/gemini-3.8-flash");
    expect(ids).toContain("cline-free/mimo-v2.6-flash");
  });

  it("drops every paid /api/v1/models id (free-only picker)", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels(CREDS);
    const ids = result.models.map((m) => m.id);
    expect(ids).not.toContain("meta/muse-spark-1.3-contributor");
    expect(ids).not.toContain("deepseek/deepseek-v4.1-flash");
    expect(ids).toContain("google/gemma-4-31b-it:free");
  });

  it("deduplicates ids present in both sources", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels(CREDS);
    const ids = result.models.map((m) => m.id);
    expect(ids.filter((id) => id === "stealth/space-bunny-alpha")).toHaveLength(1);
  });

  it("returns {id, name} for feed entries", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels(CREDS);
    const entry = result.models.find((m) => m.id === "cline-free/muse-spark-1.3-contributor");
    expect(entry.name).toBe("Muse Spark 1.3 Contributor");
  });

  it("survives a failing feed and still returns the catalog :free variants", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url) === MODELS_URL) return jsonResponse(MODELS_RESPONSE);
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    });
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels(CREDS);
    expect(result.models.map((m) => m.id)).toEqual(["google/gemma-4-31b-it:free"]);
  });

  it("does not leak the cline-pass/ subscription tier into the cline list", async () => {
    const { resolveClineModels } = await import("../../open-sse/services/clinepassModels.js");
    const result = await resolveClineModels(CREDS);
    expect(result.models.map((m) => m.id)).not.toContain("cline-pass/glm-5.3");
  });
});

describe("cline-free namespace pricing", () => {
  it("bills cline-free/* at zero", async () => {
    const { getPricingForModel } = await import("../../open-sse/providers/pricing.js");
    const pricing = getPricingForModel("cline", "cline-free/deepseek-v4.1-flash");
    expect(pricing).toMatchObject({
      input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0,
    });
  });

  it("bills cline-free/* muse-spark at zero", async () => {
    const { getPricingForModel } = await import("../../open-sse/providers/pricing.js");
    expect(getPricingForModel("cline", "cline-free/muse-spark-1.3-contributor").input).toBe(0);
  });

  it("still bills the paid twin at its published rate", async () => {
    const { getPricingForModel } = await import("../../open-sse/providers/pricing.js");
    expect(getPricingForModel("cline", "deepseek/deepseek-v4.1-flash").input).toBe(0.14);
    // v0.5.95 ships the Meta Muse provider and seeds muse-spark contributor ids
    // into global MODEL_PRICING, so any namespace resolves them to the published
    // contributor rate (the cline-free alias above stays free).
    expect(getPricingForModel("cline", "meta/muse-spark-1.3-contributor").input).toBe(0.10);
    expect(getPricingForModel("cline", "meta/muse-spark-1.3-contributor").output).toBe(0.20);
  });

  it("zero price survives cost calculation over a large usage", async () => {
    const { getPricingForModel, calculateCostFromTokens } = await import("../../open-sse/providers/pricing.js");
    const pricing = getPricingForModel("cline", "cline-free/deepseek-v4.1-flash");
    const cost = calculateCostFromTokens(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, reasoning_tokens: 500_000 },
      pricing
    );
    expect(cost).toBe(0);
  });
});
