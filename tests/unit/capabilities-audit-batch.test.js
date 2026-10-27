import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Audit 27/10 (capability drift giữa khai báo và spec chính thức) — batch được duyệt:
// 1. minimax-m3 qua codebuddy dính wildcard *minimax-m3* (1M) trong khi MiniMax M3
//    thực tế 512K default theo mavis endpoint → cần flat entry 512K.
// 2. Wildcard *minimax-m3* khai 1M cho mọi biến thể free/preview chưa có exact
//    entry — mọi đường MiniMax đều 512K default (1M là opt-in higher_usage).
// 3. Pattern *kimi*k2* khai maxOutput 262144 — không model K2 nào xác nhận 256K
//    output (chuẩn OpenRouter K2 = 128K); khai cao gây request 400 khi client
//    đặt max_tokens theo khai.

describe("audit batch 2026-10-27: capabilities vs official specs", () => {
  it("minimax-m3 (codebuddy-intl lane) reports 512K/128K, not the 1M wildcard", () => {
    expect(getCapabilitiesForModel("codebuddy-intl", "minimax-m3")).toMatchObject({
      contextWindow: 512000,
      maxOutput: 128000,
    });
  });

  it("wildcard *minimax-m3* now defaults 512K so unlisted free/preview variants stay safe", () => {
    // cline free lane không có exact entry → rơi vào wildcard
    expect(getCapabilitiesForModel("cline", "cline-free/minimax-m3.1-flash")).toMatchObject({
      contextWindow: 512000,
    });
    // exact entry hiện có không bị ảnh hưởng
    expect(getCapabilitiesForModel("minimax-code-global", "MiniMax-M3.1-Flash")).toMatchObject({
      contextWindow: 512000,
      maxOutput: 128000,
    });
    expect(getCapabilitiesForModel("minimax-code-global", "MiniMax-M3")).toMatchObject({
      contextWindow: 512000,
      maxOutput: 128000,
    });
  });

  it("kimi-k2* maxOutput is 131072 (128K) per the K2 standard, context stays 262144", () => {
    const k26 = getCapabilitiesForModel("codebuddy-intl", "kimi-k2.6");
    expect(k26).toMatchObject({ contextWindow: 262144, maxOutput: 131072 });
    const k25 = getCapabilitiesForModel("codebuddy-intl", "kimi-k2.5");
    expect(k25).toMatchObject({ contextWindow: 262144, maxOutput: 131072 });
    // k2.7-code có entry riêng 64K output — không đổi
    expect(getCapabilitiesForModel("codebuddy-intl", "kimi-k2.7-code")).toMatchObject({
      contextWindow: 262144,
      maxOutput: 65536,
    });
  });

  it("deepseek-v4.1-flash-free stays 330K (probe 27/10: 400K bị từ chối context_length_exceeded)", () => {
    expect(getCapabilitiesForModel("opencode", "deepseek-v4.1-flash-free")).toMatchObject({
      contextWindow: 330000,
    });
  });
});
