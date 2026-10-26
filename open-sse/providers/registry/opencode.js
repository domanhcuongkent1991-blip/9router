export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      // The free lane's MiMo route (OpenRouter-backed) streams thinking as
      // `reasoning` + `reasoning_details[]`, not reasoning_content. stream.js lifts
      // the alias into reasoning_content for OpenAI-shaped clients; every other
      // model on the lane already emits reasoning_content, so the lift is a no-op.
      reasoningAliasFields: true,
    },
  },
  models: [
    // Static fallback for when the live /models fetch fails — the live catalog
    // replaces this list whenever it answers. Seeded 2026-10-26 from the live
    // free lane after a full smoke (the former muse-spark-1.2/1.3 + union-alpha
    // picks died upstream: 410 deprecated / 2× "Model is unavailable").
    { id: "big-pickle", name: "Big Pickle" },
    { id: "beam-free", name: "Beam (free)" },
    { id: "flint-40b-free", name: "Flint 40B (free)" },
    { id: "glm-5.3-flash-free", name: "GLM-5.3 Flash (free)" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash (free)" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview (free)" },
    { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash (free)" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (free)" },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL (free)" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/inference/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/1.18.31",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/inference/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
