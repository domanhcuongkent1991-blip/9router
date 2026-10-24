export default {
  id: "cline",
  priority: 80,
  alias: "cl",
  uiAlias: "cl",
  display: {
    name: "Cline",
    icon: "smart_toy",
    color: "#5B9BD5",
    textIcon: "CL",
    website: "https://cline.bot",
    notice: {
      signupUrl: "https://cline.bot",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
    // Non-stream chat completions come back wrapped in {"success":true,"data":{...}}
    quirks: { clineEnvelope: true },
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: [
        "clineHeaders",
      ],
    },
  },
  // Free tier only (owner policy 2026-10-13): the live resolver filters the
  // catalog to `:free` variants plus the feed's free[] namespace; this static
  // fallback mirrors that set for when the live catalog is unreachable.
  // Synced 2026-10-24 against the live sources (catalog :free + recommended-
  // models free[]) with a real chat smoke per model. Excluded on purpose:
  // gemma-4-26b-a4b-it:free / gemma-4-31b-it:free / nemotron-3-super-120b:free
  // (upstream 500 "failed to invoke" on 2/2 tries) and the older retired ids
  // (muse-spark, step-5, mimo-v2.6-flash, apodex — 404 upstream).
  models: [
    { id: "cline-free/solar-mini4", name: "Solar Mini 4" },
    { id: "cline-free/nemotron-3.5-super-vl", name: "Nemotron 3.5 Super VL" },
    { id: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL (free)" },
    { id: "nvidia/nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning" },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (free)" },
    { id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1" },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (free)" },
    { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 (free)" },
    { id: "reflection/beam-free", name: "Beam" },
    { id: "recursive/flint-v1.0:free", name: "Flint 1.0 (free)" },
    { id: "xingchen-agi/xing4.0-29b-a4b:free", name: "Xing 4.0 29B A4B (free)" },
    { id: "cohere/north-mini-code:free", name: "North Mini Code (free)" },
    { id: "thinkingmachines/inkling:free", name: "Inkling (free)" },
    { id: "thinkingmachines/inkling-small:free", name: "Inkling Small (free)" },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note Preview (free)" },
    { id: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5 2.6B (free)" },
    { id: "nvidia/nemotron-3.5-content-safety:free", name: "Nemotron 3.5 Content Safety (free)" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (free)" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni 30B Reasoning (free)" },
  ],
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenExchangeUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
    // Cline free soft-blocks accounts that rotate tokens too often (401
    // "re-authenticate" on otherwise valid JWTs) — refresh only when the
    // token is actually near expiry (~5 min lead on a ~55 min token).
    refreshLeadMs: 5 * 60 * 1000,
    backgroundRefreshLeadMs: 5 * 60 * 1000,
  },
};
