// Session token-growth monitor.
//
// A single large request is easy to spot; the failure mode that burned 140M
// tokens on 2026-10-22 was different: each turn only added a little, so no one
// request looked wrong, and the prompt never came back down. Compaction should
// reset the curve — if it keeps climbing across N turns, context is broken
// (duplicated history, an ignored compact boundary, a client resending the
// whole transcript) and the session should be inspected before it gets expensive.
//
// This module only observes and warns. Blocking is the context guard's job.
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

export const DEFAULT_GROWTH_GUARD = {
  enabled: false,
  minSamples: 4,
  growthRatio: 1.5,
  windowSize: 8,
};

/** @type {Map<string, {samples: number[], warned: boolean}>} */
const growthStore = new Map();

export function resetGrowthStore() {
  growthStore.clear();
}

export function resolveGrowthGuard(settings) {
  const s = settings || {};
  const minSamples = Number(s.sessionGrowthMinSamples);
  const growthRatio = Number(s.sessionGrowthRatio);
  const windowSize = Number(s.sessionGrowthWindowSize);
  return {
    enabled: s.sessionGrowthGuardEnabled === true,
    minSamples: Number.isInteger(minSamples) && minSamples >= 2
      ? minSamples
      : DEFAULT_GROWTH_GUARD.minSamples,
    growthRatio: Number.isFinite(growthRatio) && growthRatio > 1
      ? growthRatio
      : DEFAULT_GROWTH_GUARD.growthRatio,
    windowSize: Number.isInteger(windowSize) && windowSize >= 2
      ? windowSize
      : DEFAULT_GROWTH_GUARD.windowSize,
  };
}

/**
 * Feed one turn's prompt size into the session's history.
 *
 * Warns once per session, when every sample in the window is strictly larger
 * than the one before it AND the last is `growthRatio` times the first. Strict
 * monotonicity is the point: any compaction or trimming shows up as a drop and
 * correctly silences the warning.
 */
export function observeSessionGrowth({ sessionId, promptTokens, guard, now = Date.now() }) {
  const g = guard || DEFAULT_GROWTH_GUARD;
  const tokens = Math.max(0, Number(promptTokens) || 0);
  const noop = { warning: null, samples: 0, growth: null };

  if (!g.enabled || !sessionId || tokens <= 0) return noop;

  const entry = growthStore.get(sessionId) || { samples: [], warned: false };
  entry.samples.push(tokens);
  if (entry.samples.length > g.windowSize) {
    entry.samples.splice(0, entry.samples.length - g.windowSize);
  }
  growthStore.set(sessionId, entry);

  if (entry.warned || entry.samples.length < g.minSamples) {
    return { warning: null, samples: entry.samples.length, growth: null };
  }

  const window = entry.samples.slice(-g.minSamples);
  const monotonic = window.every((v, i) => i === 0 || v > window[i - 1]);
  const first = window[0];
  const last = window[window.length - 1];
  const growth = first > 0 ? last / first : 0;

  if (!monotonic || growth < g.growthRatio) {
    return { warning: null, samples: entry.samples.length, growth };
  }

  entry.warned = true;
  return {
    warning: { kind: "monotonic-growth", sessionId, firstTokens: first, lastTokens: last, samples: window.length, growth },
    samples: entry.samples.length,
    growth,
  };
}

export function growthWarningMessage({ sessionId, firstTokens, lastTokens, samples }) {
  return `Session ${sessionId}: prompt grew from ${firstTokens} to ${lastTokens} tokens over `
    + `${samples} consecutive turns without shrinking. Context is likely not being compacted — `
    + `check for duplicated history or a client resending the whole transcript.`;
}

/** Report a session against its model window, for logs/dashboards. */
export function growthAgainstWindow({ promptTokens, provider, model }) {
  const window = Number(getCapabilitiesForModel(provider, model)?.contextWindow) || 0;
  if (!window) return null;
  return { ratio: Math.max(0, Number(promptTokens) || 0) / window, contextWindow: window };
}
