import { describe, expect, it, vi } from "vitest";
import { Response as UndiciResponse } from "undici";

async function loadSubject() {
  const subject = await import("../../open-sse/compat/responses/handler.js").catch(() => ({}));
  expect(subject.createResponsesHandler).toBeTypeOf("function");
  return subject;
}

function requestFor(body, { headers = {}, signal } = {}) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer sk-secret-sentinel",
      "Content-Length": "9999",
      "X-Request-Id": "request-123",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Responses compatibility handler", () => {
  it("parses the incoming request exactly once at the boundary before initialization or dispatch", async () => {
    const { createResponsesHandler } = await loadSubject();
    const initialize = vi.fn();
    const dispatch = vi.fn();
    const request = requestFor({
      input: "hello",
      previous_response_id: "resp-secret-sentinel",
    });
    const parse = vi.spyOn(request, "json");

    const response = await createResponsesHandler({ initialize, dispatch })(request);

    expect(parse).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(400);
    expect(initialize).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("resp-secret-sentinel");
  });

  it("initializes once and forwards a normalized request with safe headers", async () => {
    const { createResponsesHandler } = await loadSubject();
    const initialize = vi.fn(async () => undefined);
    const dispatch = vi.fn(async (request) => new Response(await request.text()));
    const handler = createResponsesHandler({ initialize, dispatch });

    const first = await handler(requestFor({ input: "one" }));
    const second = await handler(requestFor({ input: "two" }));
    const forwarded = dispatch.mock.calls[0][0];

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(forwarded.method).toBe("POST");
    expect(forwarded.headers.get("authorization")).toBe("Bearer sk-secret-sentinel");
    expect(forwarded.headers.get("x-request-id")).toBe("request-123");
    expect(forwarded.headers.has("content-length")).toBe(false);
    expect(JSON.parse(await first.text())).toMatchObject({ input: "one", store: false });
    expect(JSON.parse(await second.text())).toMatchObject({ input: "two", store: false });
  });

  it("shares one pending initialization across concurrent valid requests", async () => {
    const { createResponsesHandler } = await loadSubject();
    const initialization = deferred();
    const started = deferred();
    const initialize = vi.fn(() => {
      started.resolve();
      return initialization.promise;
    });
    const dispatch = vi.fn(async () => new Response("ok"));
    const handler = createResponsesHandler({ initialize, dispatch });

    const pending = [
      handler(requestFor({ input: "first" })),
      handler(requestFor({ input: "second" })),
    ];
    await started.promise;

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();

    initialization.resolve();
    const responses = await Promise.all(pending);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("resets one concurrent initialization failure wave so a later request can recover", async () => {
    const { createResponsesHandler } = await loadSubject();
    const initialization = deferred();
    const started = deferred();
    const initialize = vi.fn()
      .mockImplementationOnce(() => {
        started.resolve();
        return initialization.promise;
      })
      .mockResolvedValueOnce(undefined);
    const dispatch = vi.fn(async () => new Response("ok"));
    const handler = createResponsesHandler({ initialize, dispatch });

    const failedWave = [
      handler(requestFor({ input: "first" })),
      handler(requestFor({ input: "second" })),
    ];
    await started.promise;
    expect(initialize).toHaveBeenCalledTimes(1);

    initialization.reject(new Error("init sk-secret-sentinel"));
    const failed = await Promise.all(failedWave);
    const recovered = await handler(requestFor({ input: "third" }));

    expect(failed.map((response) => response.status)).toEqual([500, 500]);
    expect(await failed[0].text()).not.toContain("sk-secret-sentinel");
    expect(recovered.status).toBe(200);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("propagates AbortError cancellation from a pending dispatcher", async () => {
    const { createResponsesHandler } = await loadSubject();
    const controller = new AbortController();
    const dispatchStarted = deferred();
    const handler = createResponsesHandler({
      dispatch: vi.fn(async (request) => {
        dispatchStarted.resolve();
        return new Promise((resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new DOMException("Request aborted", "AbortError"));
          }, { once: true });
        });
      }),
    });

    const handling = handler(requestFor({ input: "hello" }, { signal: controller.signal }));
    await dispatchStarted.promise;
    controller.abort();
    await expect(handling).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not disclose malformed JSON, dispatcher failures, or provider 5xx bodies", async () => {
    const { createResponsesHandler } = await loadSubject();
    const handler = createResponsesHandler({ dispatch: vi.fn(async () => new Response("ok")) });

    const malformed = await handler(requestFor("{not valid json"));
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("sk-secret-sentinel");

    const failingHandler = createResponsesHandler({
      dispatch: vi.fn(async () => {
        throw new Error("provider sk-secret-sentinel");
      }),
    });
    const failure = await failingHandler(requestFor({ input: "hello" }));
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("sk-secret-sentinel");

    const providerFailure = new Response("provider sk-secret-sentinel", { status: 503 });
    const cancel = vi.spyOn(providerFailure.body, "cancel");
    const providerFailureHandler = createResponsesHandler({
      dispatch: vi.fn(async () => providerFailure),
    });
    const contained = await providerFailureHandler(requestFor({ input: "hello" }));

    expect(contained.status).toBe(500);
    expect(await contained.text()).not.toContain("sk-secret-sentinel");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns a fixed 500 without waiting for a pending provider-body cancellation", async () => {
    const { createResponsesHandler } = await loadSubject();
    const cancellation = deferred();
    const cancelStarted = deferred();
    const responseLike = {
      [Symbol.toStringTag]: "Response",
      status: 503,
      headers: new Headers(),
      body: {
        cancel: vi.fn(() => {
          cancelStarted.resolve();
          return cancellation.promise;
        }),
      },
    };
    const handler = createResponsesHandler({
      dispatch: vi.fn(async () => responseLike),
    });
    let completed = false;
    const handling = handler(requestFor({ input: "hello" })).then((response) => {
      completed = true;
      return response;
    });

    try {
      await cancelStarted.promise;
      await Promise.resolve();
      expect(completed).toBe(true);
      expect((await handling).status).toBe(500);
    } finally {
      cancellation.resolve();
      await handling;
    }
  });

  it("passes through real cross-constructor responses while containing spoofed and invalid dispatch results", async () => {
    const { createResponsesHandler } = await loadSubject();
    const crossConstructorResponse = new UndiciResponse("ok", {
      status: 201,
      headers: { "Content-Type": "text/plain" },
    });
    const spoofedResponse = {
      [Symbol.toStringTag]: "Response",
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      body: null,
    };
    const passThrough = await createResponsesHandler({
      dispatch: vi.fn(async () => crossConstructorResponse),
    })(requestFor({ input: "hello" }));
    const spoofedResult = await createResponsesHandler({
      dispatch: vi.fn(async () => spoofedResponse),
    })(requestFor({ input: "hello" }));
    const undefinedResult = await createResponsesHandler({
      dispatch: vi.fn(async () => undefined),
    })(requestFor({ input: "hello" }));
    const plainResult = await createResponsesHandler({
      dispatch: vi.fn(async () => ({ status: 200, headers: new Headers(), body: null })),
    })(requestFor({ input: "hello" }));

    expect(passThrough).toBe(crossConstructorResponse);
    expect(passThrough.status).toBe(201);
    expect(await passThrough.text()).toBe("ok");
    expect(spoofedResult.status).toBe(500);
    expect(undefinedResult.status).toBe(500);
    expect(plainResult.status).toBe(500);
  });

  it("contains request reconstruction failures without dispatching or disclosing their cause", async () => {
    const { createResponsesHandler } = await loadSubject();
    const dispatch = vi.fn();
    const request = {
      url: "http://localhost/v1/responses",
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      signal: new AbortController().signal,
      json: vi.fn(async () => ({
        input: "hello",
        toJSON() {
          throw new Error("reconstruction sk-secret-sentinel");
        },
      })),
    };

    const response = await createResponsesHandler({ dispatch })(request);

    expect(response.status).toBe(500);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("sk-secret-sentinel");
  });
});
