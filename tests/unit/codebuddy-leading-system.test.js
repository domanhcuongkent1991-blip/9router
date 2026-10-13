// Hy3 / Step-5 on both CodeBuddy gateways reject bodies whose first message is
// not a system prompt (400 code 11128). The intl executor always injects its
// own leading system; the CN executor relies on the registry quirk
// requireLeadingSystemPromptModels in DefaultExecutor.
import { describe, expect, it } from "vitest";
import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const USER_ONLY = [{ role: "user", content: "hi" }];
const WITH_SYSTEM = [
  { role: "system", content: "You are terse." },
  { role: "user", content: "hi" },
];

describe("CodeBuddy CN leading system prompt quirk", () => {
  const ex = new CodeBuddyExecutor();

  it("prepends a system message for hy3 when the client sent none", () => {
    const out = ex.transformRequest("hy3", { messages: USER_ONLY }, true, {});
    expect(out.messages[0].role).toBe("system");
    expect(out.messages).toHaveLength(2);
  });

  it("prepends a system message for step-5-preview when the client sent none", () => {
    const out = ex.transformRequest("step-5-preview", { messages: USER_ONLY }, true, {});
    expect(out.messages[0].role).toBe("system");
  });

  it("keeps a client-provided leading system untouched (no duplicate)", () => {
    const out = ex.transformRequest("hy3", { messages: WITH_SYSTEM }, true, {});
    expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(out.messages[0].content).toBe("You are terse.");
  });

  it("does not touch models outside the quirk list", () => {
    const out = ex.transformRequest("glm-5.2", { messages: USER_ONLY }, true, {});
    expect(out.messages[0].role).toBe("user");
  });
});

describe("CodeBuddy intl leading system prompt", () => {
  const ex = new CodeBuddyIntlExecutor();

  it("always leads with its own system prompt for hy3", () => {
    const out = ex.transformRequest("hy3", { messages: USER_ONLY }, true, {});
    expect(out.messages[0].role).toBe("system");
    expect(out.stream).toBe(true);
  });

  it("always leads with its own system prompt for step-5-preview", () => {
    const out = ex.transformRequest("step-5-preview", { messages: USER_ONLY }, true, {});
    expect(out.messages[0].role).toBe("system");
  });
});
