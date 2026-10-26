// CodeBuddy international (codebuddy.ai) — mirrors codebuddy-cn registry shape,
// swapping the Tencent CN domain for the .ai endpoint set. All OAuth/plugin URLs
// use the /v2/plugin prefix with platform=ide (CN uses platform=CLI).
export default {
  id: "codebuddy-intl",
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Chat gateway is OpenAI-compatible SSE (same /v2/chat/completions path as CN).
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy intl speaks the same unified OpenAI reasoning_effort shape as CN.
    thinkingFormat: "openai",
    headers: {
      // Channel verification (400 code 11128, probed 2026-10-17) rejects the
      // generic IDE fingerprint; only the real WorkBuddy desktop identity
      // passes. Version mirrors %LOCALAPPDATA%\Programs\WorkBuddyAI
      // (app.asar buildVlmGatewayHeaders) and must track desktop releases.
      "User-Agent": "WorkBuddy/5.8.4 WorkBuddy/5.8.4",
      "X-Product": "SaaS",
      "X-IDE-Type": "WorkBuddy",
      "X-IDE-Name": "WorkBuddy",
      "X-IDE-Version": "5.8.4",
      "X-Private-Data": "true",
      "X-Agent-Intent": "craft",
      "X-Agent-Purpose": "conversation",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Intl billing endpoint mirrors CN shape (data.Response.Data.Accounts[]).
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
    // Hy3 / Step-5 reject bodies whose first message is not a system prompt
    // (400 code 11128, probed 2026-10-13); both ride the free quota (0 credits
    // consumed per billing meter).
    quirks: {
      requireLeadingSystemPromptModels: ["hy3", "step-5-preview"],
    },
  },
  // Same model lineup exposed by the CN gateway — intl backend is the same catalog.
  // Pruned 2026-10-26 after a full smoke: glm-5.0-turbo / glm-4.7 / minimax-m2.7 /
  // deepseek-v4-pro / deepseek-v3-2-volc all return 400 code 11102
  // "model service info not found" (retired upstream).
  models: [
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-5.0", name: "GLM-5.0" },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo" },
    { id: "minimax-m3", name: "MiniMax-M3" },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "kimi-k2.5", name: "Kimi-K2.5" },
    // Backend catalog id is "hy3" (probed 2026-10-13: "hy3-preview" → 400 11102).
    { id: "hy3", name: "Hy3" },
    // Not in the published catalog but the chat endpoint serves it (200, free
    // quota) — same id WorkBuddy desktop sends (sessions table, 2026-10-13).
    { id: "step-5-preview", name: "Step-5-Preview" },
    // deepseek-v4-flash replaced server-side by deepseek-v4.1-flash (same
    // catalog as CN; the old endpoint still answers 200 but the list is the contract).
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash" },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
