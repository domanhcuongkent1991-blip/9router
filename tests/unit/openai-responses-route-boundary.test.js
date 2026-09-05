import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(async (request) => new Response(await request.text())),
  initTranslators: vi.fn(async () => undefined),
}));

vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: mocks.handleChat }));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: mocks.initTranslators }));

async function loadRoute() {
  vi.resetModules();
  return import("../../src/app/api/v1/responses/route.js");
}

describe("POST /v1/responses compatibility wiring", () => {
  beforeEach(() => {
    mocks.handleChat.mockClear();
    mocks.initTranslators.mockClear();
  });

  it("rejects unsupported state before initialization and handleChat", async () => {
    const route = await loadRoute();
    const response = await route.POST(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "provider/model", input: "x", background: true }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.initTranslators).not.toHaveBeenCalled();
    expect(mocks.handleChat).not.toHaveBeenCalled();
  });

  it("initializes once and passes a normalized request to handleChat", async () => {
    const route = await loadRoute();
    const first = await route.POST(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "provider/model", input: "one" }),
    }));
    const second = await route.POST(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "provider/model", input: "two" }),
    }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.initTranslators).toHaveBeenCalledTimes(1);
    expect(mocks.handleChat).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await first.text())).toMatchObject({ input: "one", store: false });
  });

  it("advertises only POST and OPTIONS for CORS", async () => {
    const route = await loadRoute();
    const response = await route.OPTIONS();

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("*");
  });
});
