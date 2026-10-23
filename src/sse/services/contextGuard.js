// Pre-flight context guard for /v1 chat.
//
// The gateway used to forward a request no matter how large the prompt was, so
// an over-declared contextWindow in the client config could push a session far
// past what the model actually accepts: the upstream truncates or the request
// fails after the tokens are already billed. This check runs before dispatch and
// turns that into a cheap, explicit 413.
//
// Deliberately conservative: it only blocks when the window is KNOWN and the
// estimate crosses the threshold. A model with no known window always passes,
// because guessing would block legitimate traffic.
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// ~4 chars per token. Same rough factor as estimateInputTokens() and
// capacityAdapter, kept local so this module stays dependency-free.
const CHARS_PER_TOKEN = 4;

export const DEFAULT_CONTEXT_GUARD = {
  enabled: false,
  threshold: 0.9,
  warnRatio: 0.7,
};

/** Normalize the guard settings out of the settings blob. */
export function resolveContextGuard(settings) {
  const s = settings || {};
  const rawThreshold = Number(s.contextGuardThreshold);
  // A ratio above 1 means "never block"; clamp rather than discard it.
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0
    ? Math.min(rawThreshold, 1)
    : DEFAULT_CONTEXT_GUARD.threshold;
  const rawWarn = Number(s.contextGuardWarnRatio);
  const warnRatio = Number.isFinite(rawWarn) && rawWarn > 0 && rawWarn < threshold
    ? rawWarn
    : Math.min(DEFAULT_CONTEXT_GUARD.warnRatio, threshold);
  return {
    enabled: s.contextGuardEnabled === true,
    threshold,
    warnRatio,
  };
}

/**
 * Rough prompt size of a request body. Counts the whole body (messages, system,
 * tools, thinking config) because every one of them is billed as input.
 */
export function estimateRequestTokens(body) {
  if (!body || typeof body !== "object") return 0;
  try {
    return Math.ceil(JSON.stringify(body).length / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

/**
 * @returns {{ok: boolean, level: "ok"|"warn"|"over"|"unknown", estimatedTokens: number,
 *            contextWindow: number|null, ratio: number|null}}
 */
export function checkContextFit({ estimatedTokens, capabilities, guard }) {
  const g = guard || DEFAULT_CONTEXT_GUARD;
  const estimated = Math.max(0, Number(estimatedTokens) || 0);
  const window = Number(capabilities?.contextWindow) || 0;

  if (!g.enabled || !window || window <= 0) {
    return {
      ok: true,
      level: window > 0 ? "ok" : "unknown",
      estimatedTokens: estimated,
      contextWindow: window > 0 ? window : null,
      ratio: window > 0 ? estimated / window : null,
    };
  }

  const ratio = estimated / window;
  if (ratio >= g.threshold) {
    return { ok: false, level: "over", estimatedTokens: estimated, contextWindow: window, ratio };
  }
  return {
    ok: true,
    level: ratio >= g.warnRatio ? "warn" : "ok",
    estimatedTokens: estimated,
    contextWindow: window,
    ratio,
  };
}

export function contextGuardDeniedResponse({ modelLabel, estimatedTokens, contextWindow, threshold }) {
  const limit = Math.floor(contextWindow * (threshold ?? DEFAULT_CONTEXT_GUARD.threshold));
  return errorResponse(
    HTTP_STATUS.PAYLOAD_TOO_LARGE,
    `Context too large for ${modelLabel}: ~${estimatedTokens} tokens estimated, `
      + `model window ${contextWindow} (budget ${limit}). `
      + `Reduce the prompt or pick a model with a larger context window.`
  );
}
