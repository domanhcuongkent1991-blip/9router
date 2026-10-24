// Regression: mapTokens used to store Cline's OAuth access token verbatim.
// Cline's API only accepts `Authorization: Bearer workos:<jwt>` — a bare JWT
// gets 401 "re-authenticate" even while still valid, and applyAuth overwrites
// the Authorization header the clineHeaders hook had already fixed up. The
// next OAuth login therefore reintroduced the 401 loop. mapTokens must
// normalize at the source.
import { describe, expect, it } from "vitest";
import cline from "../../src/lib/oauth/providers/cline.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sIgK-2nEEaC8uJlZQ0GkEw";

describe("cline mapTokens — workos prefix at the source", () => {
  it("prefixes a bare WorkOS JWT with workos:", () => {
    const out = cline.mapTokens({ access_token: JWT, refresh_token: "r1" });
    expect(out.accessToken).toBe(`workos:${JWT}`);
  });

  it("keeps an already-prefixed token as-is (no double prefix)", () => {
    const out = cline.mapTokens({ access_token: `workos:${JWT}`, refresh_token: "r1" });
    expect(out.accessToken).toBe(`workos:${JWT}`);
  });

  it("keeps non-JWT credentials (ClinePass api keys) verbatim", () => {
    const apiKey = "clp_live_abcd1234";
    const out = cline.mapTokens({ access_token: apiKey, refresh_token: "r1" });
    expect(out.accessToken).toBe(apiKey);
  });

  it("never touches the refresh token", () => {
    const out = cline.mapTokens({ access_token: JWT, refresh_token: "keep-me" });
    expect(out.refreshToken).toBe("keep-me");
  });
});
