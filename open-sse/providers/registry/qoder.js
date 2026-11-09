export default {
  id: "qoder",
  priority: 30,
  alias: "qd",
  uiAlias: "qd",
  display: {
    name: "Qoder",
    icon: "water_drop",
    color: "#EC4899",
    website: "https://qoder.com",
    notice: {
      signupUrl: "https://qoder.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Personal Access Token (pt-...) từ https://qoder.com/account/integrations",
  transport: {
    baseUrl: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://openapi.qoder.sh/api/v2/quota/usage",
    },
  },
  // Synced 2026-11-07 against the live per-account catalog + chat smoke:
  // catalog now enables only qfmodel/dfmodel/qmodel_38max/qmodel/qmodel_latest;
  // qmodel + qmodel_latest chat → 400 "model_config not yet known" (config
  // dead upstream) → dropped. The other 13 ids (ultimate/auto/performance/
  // efficient/lite/kmodel*/gmodel/gfmodel/dmodel/mmodel/smodel/cmodel) are no
  // longer enabled in the per-account catalog — kept out so the static
  // fallback stops advertising them. Live catalog remains the served list.
  models: [
    { id: "qfmodel", name: "Qwen3.8-Flash" },
    { id: "dfmodel", name: "DeepSeek-V4.1-Flash" },
    { id: "qmodel_38max", name: "Qwen3.8-Max" },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.sh",
    centerBaseUrl: "https://center.qoder.sh",
    chatBaseUrl: "https://api3.qoder.sh",
    deviceTokenUrl: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
    refreshUrl: "https://center.qoder.sh/algo/api/v3/user/refresh_token",
    userInfoUrl: "https://openapi.qoder.sh/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.sh/api/v2/quota/usage",
    loginUrl: "https://qoder.com/device/selectAccounts",
  },
  features: {
    usage: true,
    // PAT (apikey) connections also carry quota usage (via job-token exchange).
    usageApikey: true,
  },
};
