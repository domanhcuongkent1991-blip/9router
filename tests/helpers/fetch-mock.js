// Shared fetch mock helper.
//
// Why this exists: `open-sse/utils/proxyFetch.js` installs `patchedFetch` onto
// `globalThis.fetch` at import time (idempotency guard, line ~541) and routes
// every outbound request through `rawFetch`, which calls the `undici` package's
// own `fetch` — NOT `globalThis.fetch`. Since v0.5.116 (commit 736be957,
// "survive DPI-shaped networks") that undici hop is unconditional, so a plain
// `vi.stubGlobal("fetch", …)` no longer intercepts anything once the import
// chain reaches proxyFetch.js:
//
//   - code calling bare `fetch`      -> patchedFetch -> rawFetch -> undici
//   - code reading `globalThis.fetch` -> patchedFetch -> rawFetch -> undici
//
// Both layers have to be mocked, and both must be mocked BEFORE the module
// under test is dynamically imported (a later re-stub only fixes layer 1).
//
// Usage:
//   const fetchMock = await installFetchMock({ ok: true, json: async () => payload });
//   const { resolveSomething } = await import("../../open-sse/services/thing.js");
//   expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ ... }));
//
// Call `vi.doUnmock("undici")` (and `vi.unstubAllGlobals()`) in afterEach.

import { vi } from "vitest";

/**
 * Install a fetch mock covering both the global and the undici layer.
 *
 * @param {Function|object} responder - `vi.fn()` implementation, or a plain
 *   response object used as the resolved value of every call.
 * @param {object} [options]
 * @param {boolean} [options.undici=true] - also mock the `undici` package.
 *   Pass false for code that is known to reach only `globalThis.fetch`.
 * @returns {import("vitest").Mock} the mock, for call assertions.
 */
export function installFetchMock(responder, { undici = true } = {}) {
  const fetchMock = typeof responder === "function" ? vi.fn(responder) : vi.fn().mockResolvedValue(responder);

  // Layer 1 — bare `fetch` and direct `globalThis.fetch` readers.
  vi.stubGlobal("fetch", fetchMock);

  // Layer 2 — `proxyFetch.rawFetch` imports the undici package directly.
  // Spread the real module so unrelated exports (Agent, ProxyAgent, …) keep
  // working for callers that build dispatchers.
  if (undici) {
    vi.doMock("undici", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, fetch: fetchMock };
    });
  }

  return fetchMock;
}

/**
 * Point both fetch layers at an existing mock, without replacing it.
 * Use when the test builds its own `vi.fn()` (e.g. a Response-shaped stub).
 *
 * @param {import("vitest").Mock} fetchMock
 * @param {object} [options]
 * @param {boolean} [options.undici=true] - also mock the `undici` package.
 * @returns {import("vitest").Mock} the same mock
 */
export function applyFetchMock(fetchMock, { undici = true } = {}) {
  vi.stubGlobal("fetch", fetchMock);

  if (undici) {
    vi.doMock("undici", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, fetch: fetchMock };
    });
  }

  return fetchMock;
}

/**
 * Queue the next response on an existing mock, keeping the same reference.
 * Handy for sequences: `queueResponse(fetchMock, a); queueResponse(fetchMock, b);`
 *
 * @param {import("vitest").Mock} fetchMock
 * @param {object} response
 * @returns {import("vitest").Mock} the same mock
 */
export function queueResponse(fetchMock, response) {
  fetchMock.mockResolvedValueOnce(response);
  return fetchMock;
}

/**
 * Wrap a JSON payload in the minimal Response shape the services read.
 *
 * @param {*} payload - value returned by `response.json()`
 * @param {object} [overrides] - e.g. `{ ok: false, status: 500 }`
 * @returns {{ok: boolean, status: number, json: () => Promise<*>}}
 */
export function jsonResponse(payload, overrides = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    ...overrides,
  };
}
