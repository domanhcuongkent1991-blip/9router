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
  // catalog to `:free` variants plus the feed's `cline-free/*` namespace; this
  // static fallback mirrors that set for when the live catalog is unreachable.
  models: [
    { id: "cline-free/step-5-preview", name: "Step 5 Preview" },
    { id: "cline-free/mimo-v2.6-flash", name: "Mimo V2.6 Flash" },
    { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
    { id: "cline-free/solar-mini4", name: "Solar Mini 4" },
    { id: "apodex/apodex-1.1-mini:free", name: "Apodex 1.1 Mini (free)" },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note Preview (free)" },
    { id: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5 2.6B (free)" },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (free)" },
    { id: "thinkingmachines/inkling-small:free", name: "Inkling Small (free)" },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (free)" },
    { id: "thinkingmachines/inkling:free", name: "Inkling (free)" },
    { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 (free)" },
    { id: "cohere/north-mini-code:free", name: "North Mini Code (free)" },
    { id: "nvidia/nemotron-3.5-content-safety:free", name: "Nemotron 3.5 Content Safety (free)" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (free)" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni 30B Reasoning (free)" },
    { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B A4B IT (free)" },
    { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B IT (free)" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B (free)" },
  ],
  oauth: {
    appBaseUrl: "https://app.cline.bot",
    apiBaseUrl: "https://api.cline.bot",
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenExchangeUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
};
